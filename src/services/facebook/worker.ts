import cron from 'node-cron';
import { createHash } from 'node:crypto';
import { Prisma, type Campaign, type FacebookPost } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { env } from '../../lib/env';
import { safeErrorLog } from '../../lib/httpErrors';
import { defaultEmailSender, isEmailConfigured, type EmailSender } from '../../lib/email';
import { isQuietHours } from '../../lib/quietHours';
import { articleKey } from '../reports';
import { isPublicArticleCampaign } from '../social/publicCampaign';
import { istDay, istDayBounds } from '../whatsapp/queue';
import { pushOutOfQuietHours } from '../linkedin/worker';
import type { CmsArticle } from '../linkedin/post';
import { fetchCmsArticle } from '../linkedin/post';
import { postToFacebook, type FacebookFailure } from './client';
import { PORTAL_TO_PAGE, pageConfig } from './pages';
import { buildFacebookPost } from './post';

/**
 * The Facebook posting worker (brief 2026-11-03-facebook-page-posting, docs/FACEBOOK_POSTING.md). It mirrors the LinkedIn worker
 * and READS Campaign rows only (never touches the send path). Account safety is the difference:
 *  - AT MOST ONE post attempt per tick, and at least FACEBOOK_MIN_GAP_MINUTES between two posts on the page;
 *  - at most FACEBOOK_DAILY_CAP posts per IST day (the rest wait for the next day; the 24 h window then decides);
 *  - a policy block from Facebook (code 368 etc.) STOPS the page for good: the stop is persisted and only an ADMIN's Resume
 *    clears it, even across a restart. Retry is refused while stopped;
 *  - a bad token (190 / permission / 401 / 403) stops the page until the token changes or the app restarts;
 *  - rate limits retry slowly (+15, +60 min), transient errors quickly (+1, +5, +15); retries never fall in quiet hours.
 * The `FacebookPost` row is created BEFORE the call; its unique (page, articleKey) makes a re-push a no-op.
 */

export const STALE_MS = 10 * 60_000;
export const RATE_DELAYS_MIN = [15, 60] as const;
export const TRANSIENT_DELAYS_MIN = [1, 5, 15] as const;
const WINDOW_MS = 24 * 60 * 60_000;
const EARLIER_LOOKBACK_MS = 14 * 24 * 60 * 60_000;
export const UNKNOWN_ERROR = 'unknown — check the page';
export const DUPLICATE_ERROR = 'Facebook says this was already posted';

export type WorkerDeps = {
  now?: () => Date;
  /** The Graph call (tests mock it). */
  post?: typeof postToFacebook;
  fetchCms?: (slug: string) => Promise<CmsArticle | null>;
  emailSender?: EmailSender;
  isEmailConfigured?: () => boolean;
  /** Active ADMIN emails; default reads the User table. */
  recipients?: () => Promise<string[]>;
  /** Campaign.portal → page. Default PORTAL_TO_PAGE. */
  portals?: Readonly<Record<string, string>>;
  postFrom?: Date | null;
  quiet?: { start: string; end: string };
  minGapMinutes?: number;
  dailyCap?: number;
};

/* ------------------------------------------------------------------ */
/* Stops: auth (in memory + banner row) and policy (persisted)         */
/* ------------------------------------------------------------------ */

const stoppedFor = new Map<string, string>(); // page → token fingerprint it was stopped on
/** Test hook: forget every in-memory auth stop (a restart does the same). The policy stop is NOT forgotten: it is in Postgres. */
export function resetFacebookStops(): void {
  stoppedFor.clear();
}
const fingerprint = (token: string): string => createHash('sha256').update(token).digest('hex').slice(0, 16);
export const authKey = (page: string): string => `facebook:auth:${page}`;
export const policyKey = (page: string): string => `facebook:policy:${page}`;

type AuthState = { stoppedAt: string; alertedDay: string | null; status: number | null };
type PolicyState = { stoppedAt: string; status: number | null; code: number | null; subcode: number | null; message: string };

async function readSetting<T>(key: string): Promise<T | null> {
  const row = await prisma.digestSetting.findUnique({ where: { key } });
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}
async function writeSetting(key: string, v: unknown): Promise<void> {
  const value = JSON.stringify(v);
  await prisma.digestSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
}

/** For the screen's amber banner: stopped on a token problem and not yet recovered. */
export async function loginProblem(page: string): Promise<{ since: string; status: number | null } | null> {
  const s = await readSetting<AuthState>(authKey(page));
  return s ? { since: s.stoppedAt, status: s.status } : null;
}
/** For the screen's red banner: Facebook blocked a post; posting stays stopped until an ADMIN resumes. */
export async function policyProblem(page: string): Promise<{ since: string; code: number | null; subcode: number | null; message: string } | null> {
  const s = await readSetting<PolicyState>(policyKey(page));
  return s ? { since: s.stoppedAt, code: s.code, subcode: s.subcode, message: s.message } : null;
}
/** ADMIN Resume: clears the policy stop (the route audits it). True when there was one. */
export async function resumePolicy(page: string): Promise<boolean> {
  const r = await prisma.digestSetting.deleteMany({ where: { key: policyKey(page) } });
  return r.count > 0;
}

const isAuthStopped = (page: string): boolean => {
  const cfg = pageConfig(page);
  const fp = stoppedFor.get(page);
  return !!cfg && fp !== undefined && fp === fingerprint(cfg.accessToken);
};

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const quietOf = (d: WorkerDeps) => d.quiet ?? { start: env.send.quietStart, end: env.send.quietEnd };
const clip = (s: string): string => (s.length > 240 ? `${s.slice(0, 239)}…` : s);
const log = (page: string, campaignId: string, outcome: string, extra = ''): void => {
  // eslint-disable-next-line no-console
  console.log(`[facebook] page=${page} campaign=${campaignId} outcome=${outcome}${extra ? ` ${extra}` : ''}`);
};

async function defaultRecipients(): Promise<string[]> {
  const users = await prisma.user.findMany({ where: { isActive: true, role: 'ADMIN' }, select: { email: true } });
  return [...new Set(users.map((u) => u.email.trim().toLowerCase()))];
}

async function mailAdmins(subject: string, text: string, d: WorkerDeps): Promise<void> {
  try {
    if (!(d.isEmailConfigured ?? isEmailConfigured)()) return;
    const to = await (d.recipients ?? defaultRecipients)();
    const send = d.emailSender ?? defaultEmailSender;
    const html = `<p>${text.replace(/\n\n/g, '</p><p>')}</p>`;
    for (const addr of to) await send({ to: addr, subject, html, text });
  } catch (err) {
    console.error('[facebook] alert email failed', safeErrorLog(err));
  }
}

/** First auth failure: remember the stop, write the banner state, and email once per IST day. */
async function handleAuthStop(page: string, status: number | null, d: WorkerDeps, now: Date): Promise<void> {
  const cfg = pageConfig(page);
  if (cfg) stoppedFor.set(page, fingerprint(cfg.accessToken));
  const prev = await readSetting<AuthState>(authKey(page));
  const today = istDay(now);
  await writeSetting(authKey(page), { stoppedAt: prev?.stoppedAt ?? now.toISOString(), alertedDay: today, status } satisfies AuthState);
  if (prev?.alertedDay === today) return;
  await mailAdmins(
    `Facebook posting stopped — the ${page} page token was rejected`,
    `Taxscan Push could not post to the ${page} Facebook page: Facebook answered ${status ?? 'an authorisation error'} (the page access token is invalid, expired or lacks permission).\n\n` +
      `No further posts are attempted for this page until a new token is set in Railway (FACEBOOK_${page.toUpperCase()}_PAGE_TOKEN) or the app restarts. ` +
      `Articles pushed meanwhile are kept: they post once posting resumes, if they are still within 24 hours of their push.\n\n` +
      `The Facebook screen in the admin shows this notice too. (${now.toISOString()})`,
    d,
  );
}

/** A policy block: persist the stop (survives restarts) and email the ADMINs at once (only when the stop is new). */
async function handlePolicyStop(page: string, r: FacebookFailure, d: WorkerDeps, now: Date): Promise<void> {
  const prev = await readSetting<PolicyState>(policyKey(page));
  if (prev) return; // already stopped and already told
  await writeSetting(policyKey(page), { stoppedAt: now.toISOString(), status: r.status, code: r.code, subcode: r.subcode, message: r.error } satisfies PolicyState);
  await mailAdmins(
    `Facebook blocked a post — posting to the ${page} page is stopped`,
    `Facebook answered a post to the ${page} page with a policy / spam block (${r.error}).\n\n` +
      `Posting is STOPPED and will not resume by itself, not even after a restart. Open the page on Facebook and check it for notices first; ` +
      `only an ADMIN pressing Resume on the Facebook screen in the admin starts posting again.\n\n(${now.toISOString()})`,
    d,
  );
}

/* ------------------------------------------------------------------ */
/* One attempt                                                         */
/* ------------------------------------------------------------------ */

type Attempted = 'posted' | 'retry' | 'failed' | 'auth_stop' | 'policy_stop';

/** ONE attempt for a row already claimed (PENDING, nextAttemptAt null, attempts counted). Writes the outcome. Never throws. */
async function attempt(row: FacebookPost, d: WorkerDeps, now: Date): Promise<Attempted> {
  const page = row.page;
  const fail = (error: string) => prisma.facebookPost.update({ where: { id: row.id }, data: { status: 'FAILED', error, nextAttemptAt: null } });
  try {
    const cfg = pageConfig(page);
    const campaign = await prisma.campaign.findUnique({ where: { id: row.campaignId } });
    if (!cfg || !campaign) {
      await fail(cfg ? 'campaign not found' : 'page is not configured');
      log(page, row.campaignId, 'failed', 'reason=config');
      return 'failed';
    }
    const post = await buildFacebookPost(campaign, page, d.fetchCms ?? ((s) => fetchCmsArticle(s)));
    if (!post) {
      await fail('not a taxscan.in article link, or the link is not allowed');
      log(page, row.campaignId, 'failed', 'reason=link');
      return 'failed';
    }
    const result = await (d.post ?? postToFacebook)({ pageId: cfg.pageId, accessToken: cfg.accessToken, message: post.message, link: post.link });
    if (result.kind === 'posted') {
      await prisma.facebookPost.update({
        where: { id: row.id },
        data: {
          status: 'POSTED',
          facebookPostId: result.postId === 'unknown' ? null : result.postId,
          postedAt: now,
          error: result.postId === 'unknown' ? 'posted, but Facebook returned no post id — check the page' : null,
          nextAttemptAt: null,
        },
      });
      log(page, row.campaignId, 'posted', `hashtags=${post.hashtagSource}`);
      if (await readSetting(authKey(page))) await prisma.digestSetting.deleteMany({ where: { key: authKey(page) } }); // it works again
      return 'posted';
    }
    if (result.kind === 'auth') {
      // not a real attempt: back to a retry that is due as soon as posting resumes
      await prisma.facebookPost.update({ where: { id: row.id }, data: { attempts: Math.max(0, row.attempts - 1), nextAttemptAt: now, error: clip(result.error) } });
      await handleAuthStop(page, result.status, d, now);
      log(page, row.campaignId, 'auth_stop', `status=${result.status ?? ''} code=${result.code ?? ''}`);
      return 'auth_stop';
    }
    if (result.kind === 'policy') {
      // never retried into a block: FAILED, and the page stops until an ADMIN resumes
      await fail(clip(result.error));
      await handlePolicyStop(page, result, d, now);
      log(page, row.campaignId, 'policy_stop', `status=${result.status ?? ''} code=${result.code ?? ''} subcode=${result.subcode ?? ''}`);
      return 'policy_stop';
    }
    if (result.kind === 'duplicate') {
      await fail(DUPLICATE_ERROR);
      log(page, row.campaignId, 'failed', 'reason=duplicate');
      return 'failed';
    }
    if (result.kind === 'rate' || result.kind === 'transient') {
      const delays = result.kind === 'rate' ? RATE_DELAYS_MIN : TRANSIENT_DELAYS_MIN;
      if (row.attempts <= delays.length) {
        const due = pushOutOfQuietHours(new Date(now.getTime() + delays[row.attempts - 1] * 60_000), quietOf(d));
        await prisma.facebookPost.update({ where: { id: row.id }, data: { nextAttemptAt: due, error: clip(result.error) } });
        log(page, row.campaignId, 'retry', `class=${result.kind} attempt=${row.attempts} next=${due.toISOString()}`);
        return 'retry';
      }
    }
    await fail(clip(result.error));
    log(page, row.campaignId, 'failed', `attempts=${row.attempts}`);
    return 'failed';
  } catch (err) {
    console.error('[facebook] attempt failed', safeErrorLog(err));
    // the outcome is unknown (the call may have gone out): never re-post automatically
    await prisma.facebookPost.update({ where: { id: row.id }, data: { status: 'FAILED', nextAttemptAt: null, error: UNKNOWN_ERROR } }).catch(() => undefined);
    return 'failed';
  }
}

/* ------------------------------------------------------------------ */
/* The tick                                                            */
/* ------------------------------------------------------------------ */

export type TickResult = {
  posted: number;
  retried: number;
  failed: number;
  staleClosed: number;
  authStopped: boolean;
  policyStopped: boolean;
  /** Why this tick posted nothing although it could have: 'gap' | 'daily_cap'. */
  waited: 'gap' | 'daily_cap' | null;
  refused: string | null;
};

/** Why the worker must not run, or null. */
export function startupProblem(d: Pick<WorkerDeps, 'postFrom' | 'portals'> = {}): string | null {
  const from = d.postFrom === undefined ? env.facebook.postFrom : d.postFrom;
  if (!from) return 'FACEBOOK_POST_FROM is missing or not a valid ISO time (nothing would be safe to post)';
  for (const page of new Set(Object.values(d.portals ?? PORTAL_TO_PAGE))) if (!pageConfig(page)) return `FACEBOOK_${page.toUpperCase()}_PAGE_ID / _PAGE_TOKEN are not both set and valid`;
  return null;
}

export async function runFacebookTick(d: WorkerDeps = {}): Promise<TickResult> {
  const now = (d.now ?? (() => new Date()))();
  const out: TickResult = { posted: 0, retried: 0, failed: 0, staleClosed: 0, authStopped: false, policyStopped: false, waited: null, refused: null };
  const problem = startupProblem(d);
  if (problem) return { ...out, refused: problem };
  const postFrom = (d.postFrom === undefined ? env.facebook.postFrom : d.postFrom) as Date;
  const portals = d.portals ?? PORTAL_TO_PAGE;
  const gapMs = (d.minGapMinutes ?? env.facebook.minGapMinutes) * 60_000;
  const cap = d.dailyCap ?? env.facebook.dailyCap;
  const pages = [...new Set(Object.values(portals))];

  // 1. In-flight rows with no result after 10 minutes: unknown, never re-posted.
  const stale = await prisma.facebookPost.updateMany({
    where: { page: { in: pages }, status: 'PENDING', nextAttemptAt: null, updatedAt: { lt: new Date(now.getTime() - STALE_MS) } },
    data: { status: 'FAILED', error: UNKNOWN_ERROR },
  });
  out.staleClosed = stale.count;

  const note = (r: Attempted) => {
    if (r === 'posted') out.posted += 1;
    else if (r === 'retry') out.retried += 1;
    else if (r === 'failed') out.failed += 1;
    else if (r === 'auth_stop') out.authStopped = true;
    else if (r === 'policy_stop') out.policyStopped = true;
  };

  for (const page of pages) {
    if (await policyProblem(page)) {
      out.policyStopped = true;
      continue;
    }
    if (isAuthStopped(page)) {
      out.authStopped = true;
      continue;
    }
    // Pacing: the gap since the last post, and the IST day's cap.
    const last = await prisma.facebookPost.findFirst({ where: { page, status: 'POSTED', postedAt: { not: null } }, orderBy: { postedAt: 'desc' }, select: { postedAt: true } });
    if (last?.postedAt && now.getTime() - last.postedAt.getTime() < gapMs) {
      out.waited = 'gap';
      continue;
    }
    const day = istDayBounds(istDay(now));
    const today = await prisma.facebookPost.count({ where: { page, status: 'POSTED', postedAt: { gte: day.start, lt: day.end } } });
    if (today >= cap) {
      out.waited = 'daily_cap';
      continue;
    }

    // 2. A retry that is due (never inside quiet hours: they were scheduled out of it, this guards a changed clock).
    if (!isQuietHours(now, quietOf(d).start, quietOf(d).end)) {
      const due = await prisma.facebookPost.findMany({ where: { page, status: 'PENDING', nextAttemptAt: { lte: now } }, orderBy: { nextAttemptAt: 'asc' }, take: 3 });
      for (const r of due) {
        const claimed = await prisma.facebookPost.updateMany({ where: { id: r.id, status: 'PENDING', nextAttemptAt: { lte: now } }, data: { nextAttemptAt: null, attempts: { increment: 1 } } });
        if (claimed.count !== 1) continue; // another tick got it
        note(await attempt({ ...r, nextAttemptAt: null, attempts: r.attempts + 1 }, d, now));
        break; // at most one attempt per tick
      }
      if (out.posted + out.retried + out.failed > 0 || out.authStopped || out.policyStopped) continue;
    }

    // 3. A new article, oldest push first.
    const pagePortals = Object.keys(portals).filter((p) => portals[p] === page);
    const since = new Date(Math.max(postFrom.getTime(), now.getTime() - WINDOW_MS));
    const campaigns = await prisma.campaign.findMany({
      where: { portal: { in: pagePortals }, status: 'SENT', lastSentAt: { gte: since } },
      orderBy: [{ lastSentAt: 'asc' }, { id: 'asc' }],
    });
    const firstOf = new Map<string, Campaign>();
    for (const c of campaigns) {
      if (!isPublicArticleCampaign(c)) continue;
      const k = articleKey(c);
      if (!firstOf.has(k)) firstOf.set(k, c);
    }
    if (firstOf.size === 0) continue;
    // A re-push or backfill clone of an article first pushed BEFORE the window is not new: never post it.
    const earlier = await prisma.campaign.findMany({
      where: { portal: { in: pagePortals }, status: 'SENT', lastSentAt: { gte: new Date(since.getTime() - EARLIER_LOOKBACK_MS), lt: since } },
      select: { id: true, url: true },
    });
    for (const c of earlier) firstOf.delete(articleKey(c));
    if (firstOf.size === 0) continue;
    const have = new Set((await prisma.facebookPost.findMany({ where: { page, articleKey: { in: [...firstOf.keys()] } }, select: { articleKey: true } })).map((r) => r.articleKey));
    for (const [key, c] of firstOf) {
      if (have.has(key)) continue;
      let row: FacebookPost;
      try {
        row = await prisma.facebookPost.create({ data: { page, articleKey: key, campaignId: c.id, status: 'PENDING', attempts: 1 } });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue; // an overlapping tick created it first
        throw err;
      }
      note(await attempt(row, d, now));
      break; // at most one attempt per tick
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Manual: Retry / Skip from the screen                                */
/* ------------------------------------------------------------------ */

/** Retry one FAILED row now: one post, then answer. Refused while a policy stop is in force. */
export async function retryNow(
  id: string,
  d: WorkerDeps = {},
): Promise<{ ok: true; status: 'POSTED' | 'FAILED' | 'PENDING' } | { ok: false; reason: 'not_found' | 'not_failed' | 'not_configured' | 'policy_stop' }> {
  const now = (d.now ?? (() => new Date()))();
  const row = await prisma.facebookPost.findUnique({ where: { id } });
  if (!row) return { ok: false, reason: 'not_found' };
  if (await policyProblem(row.page)) return { ok: false, reason: 'policy_stop' };
  if (!pageConfig(row.page)) return { ok: false, reason: 'not_configured' };
  const claimed = await prisma.facebookPost.updateMany({ where: { id, status: 'FAILED' }, data: { status: 'PENDING', nextAttemptAt: null, attempts: 1, error: null } });
  if (claimed.count !== 1) return { ok: false, reason: 'not_failed' };
  await attempt({ ...row, status: 'PENDING', nextAttemptAt: null, attempts: 1, error: null }, d, now);
  const after = await prisma.facebookPost.findUnique({ where: { id }, select: { status: true } });
  return { ok: true, status: after?.status === 'POSTED' ? 'POSTED' : after?.status === 'FAILED' ? 'FAILED' : 'PENDING' };
}

/** Skip a FAILED row, or one waiting for a retry. */
export async function skipPost(id: string): Promise<boolean> {
  const r = await prisma.facebookPost.updateMany({ where: { id, OR: [{ status: 'FAILED' }, { status: 'PENDING', nextAttemptAt: { not: null } }] }, data: { status: 'SKIPPED', nextAttemptAt: null } });
  return r.count === 1;
}

/* ------------------------------------------------------------------ */
/* Cron                                                                */
/* ------------------------------------------------------------------ */

let ticking = false;

/** Started like the other crons, only when the flag is on and the config is sound. */
export function startFacebookWorker(): void {
  if (!env.facebook.enabled) {
    // eslint-disable-next-line no-console
    console.log('[facebook] disabled (set FACEBOOK_POSTING_ENABLED=true to start)');
    return;
  }
  const problem = startupProblem();
  if (problem) {
    console.error(`[facebook] refusing to start: ${problem}`);
    return;
  }
  cron.schedule('* * * * *', async () => {
    if (ticking) return;
    ticking = true;
    try {
      await runFacebookTick();
    } catch (err) {
      console.error('[facebook] tick failed', safeErrorLog(err, { stack: true }));
    } finally {
      ticking = false;
    }
  });
  // eslint-disable-next-line no-console
  console.log(`[facebook] worker started (post from ${env.facebook.postFrom!.toISOString()})`);
}
