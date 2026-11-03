import cron from 'node-cron';
import { createHash } from 'node:crypto';
import { Prisma, type Campaign, type LinkedInPost } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { env } from '../../lib/env';
import { safeErrorLog } from '../../lib/httpErrors';
import { defaultEmailSender, isEmailConfigured, type EmailSender } from '../../lib/email';
import { isQuietHours } from '../../lib/quietHours';
import { articleKey } from '../reports';
import { isPublicArticleCampaign } from '../social/publicCampaign';
import { istDay } from '../whatsapp/queue';
import { isUnverifiedImage, postToLinkedIn, uploadImage, waitForImage, type LinkedInResult } from './client';
import { fetchCoverImage } from './image';
import { PORTAL_TO_PAGE, pageConfig } from './pages';
import { refreshActiveTokens } from './token';
import { buildPost, fetchCmsArticle, type CmsArticle } from './post';

/**
 * The LinkedIn posting worker (brief 2026-11-02-linkedin-page-posting, docs/LINKEDIN_POSTING.md).
 *
 * A 1-minute tick that READS Campaign rows (never touches the send path) and posts each pushed taxscan.in article to
 * its LinkedIn page, oldest first, at most 3 per tick. Safety rules, all enforced here:
 *  - the `LinkedInPost` row is created (PENDING, in flight = `nextAttemptAt` null) BEFORE the API call, one article at a
 *    time, and its unique (page, articleKey) makes a second tick (or a re-push / the morning-backfill clone) a no-op;
 *  - an in-flight row older than 10 min with no result becomes FAILED "unknown — check the page" and is never re-posted
 *    automatically (a crash mid-call may or may not have posted);
 *  - 429 / 5xx / network: retry at +1, +5, +15 min (a retry due in quiet hours waits for 07:00 IST), then FAILED;
 *  - 401 / 403: stop posting for the page until the token changes or the app restarts; one alert email per IST day;
 *  - nothing pushed before LINKEDIN_POST_FROM, or more than 24 h ago, is ever posted.
 */

export const MAX_PER_TICK = 3;
export const STALE_MS = 10 * 60_000;
/** Minutes to wait after failed attempt 1, 2, 3; attempt 4 failing = FAILED. */
export const RETRY_DELAYS_MIN = [1, 5, 15] as const;
export const MAX_ATTEMPTS = RETRY_DELAYS_MIN.length + 1;
const WINDOW_MS = 24 * 60 * 60_000;
/** How far before the window an earlier push of the same article is looked for. */
const EARLIER_LOOKBACK_MS = 14 * 24 * 60 * 60_000;
export const UNKNOWN_ERROR = 'unknown — check the page';
const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;

export type WorkerDeps = {
  now?: () => Date;
  /** The LinkedIn call (tests mock it). */
  post?: typeof postToLinkedIn;
  /** The cover-picture fetch and the Images API upload (tests mock them). */
  fetchImage?: typeof fetchCoverImage;
  uploadImage?: typeof uploadImage;
  /** Waits for the uploaded image to be AVAILABLE (tests mock it or pass a fake clock). */
  waitImage?: typeof waitForImage;
  fetchCms?: (slug: string) => Promise<CmsArticle | null>;
  emailSender?: EmailSender;
  isEmailConfigured?: () => boolean;
  /** Active ADMIN emails; default reads the User table. */
  recipients?: () => Promise<string[]>;
  /** Campaign.portal → page. Default PORTAL_TO_PAGE. */
  portals?: Readonly<Record<string, string>>;
  postFrom?: Date | null;
  /** Quiet hours window; default env.send.quietStart/quietEnd. */
  quiet?: { start: string; end: string };
};

/* ------------------------------------------------------------------ */
/* Login-stop state (in memory) + the persisted banner / alert day     */
/* ------------------------------------------------------------------ */

const stoppedFor = new Map<string, string>(); // page → token fingerprint it was stopped on
/** Test hook: forget every stop (a restart does the same). */
export function resetLinkedInStops(): void {
  stoppedFor.clear();
}
const fingerprint = (token: string): string => createHash('sha256').update(token).digest('hex').slice(0, 16);
export const authKey = (page: string): string => `linkedin:auth:${page}`;
type AuthState = { stoppedAt: string; alertedDay: string | null; status: number | null };

async function readAuthState(page: string): Promise<AuthState | null> {
  const row = await prisma.digestSetting.findUnique({ where: { key: authKey(page) } });
  if (!row) return null;
  try {
    return JSON.parse(row.value) as AuthState;
  } catch {
    return null;
  }
}
async function writeAuthState(page: string, s: AuthState): Promise<void> {
  const value = JSON.stringify(s);
  await prisma.digestSetting.upsert({ where: { key: authKey(page) }, create: { key: authKey(page), value }, update: { value } });
}
async function clearAuthState(page: string): Promise<void> {
  await prisma.digestSetting.deleteMany({ where: { key: authKey(page) } });
}
/** For the screen's banner: stopped and not yet recovered. */
export async function loginProblem(page: string): Promise<{ since: string; status: number | null } | null> {
  const s = await readAuthState(page);
  return s ? { since: s.stoppedAt, status: s.status } : null;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const quietOf = (d: WorkerDeps) => d.quiet ?? { start: env.send.quietStart, end: env.send.quietEnd };

/** The next 07:00-ish end of quiet hours at or after `t` (when `t` is inside quiet hours), else `t`. */
export function pushOutOfQuietHours(t: Date, q: { start: string; end: string }): Date {
  if (!isQuietHours(t, q.start, q.end)) return t;
  const [h, m] = q.end.split(':').map(Number);
  const ist = new Date(t.getTime() + IST_OFFSET_MS);
  let end = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), h, m) - IST_OFFSET_MS;
  if (end <= t.getTime()) end += 24 * 60 * 60_000;
  return new Date(end);
}

const clip = (s: string): string => (s.length > 240 ? `${s.slice(0, 239)}…` : s);
const log = (page: string, campaignId: string, outcome: string, extra = ''): void => {
  // eslint-disable-next-line no-console
  console.log(`[linkedin] page=${page} campaign=${campaignId} outcome=${outcome}${extra ? ` ${extra}` : ''}`);
};

async function alertAdmins(page: string, status: number | null, d: WorkerDeps, now: Date): Promise<void> {
  try {
    const configured = (d.isEmailConfigured ?? isEmailConfigured)();
    if (!configured) return;
    const to = await (d.recipients ?? defaultRecipients)();
    const send = d.emailSender ?? defaultEmailSender;
    const subject = `LinkedIn posting stopped — the ${page} page token was rejected`;
    const text =
      `Taxscan Push could not post to the ${page} LinkedIn page: LinkedIn answered ${status ?? 'an authorisation error'} (the access token expired, was revoked or lacks permission).\n\n` +
      `No further posts are attempted for this page until a new token is set in Railway (LINKEDIN_${page.toUpperCase()}_ACCESS_TOKEN) or the app restarts. ` +
      `Articles pushed meanwhile are kept: they post once posting resumes, if they are still within 24 hours of their push.\n\n` +
      `The LinkedIn screen in the admin shows this notice too. (${now.toISOString()})`;
    const html = `<p>${text.replace(/\n\n/g, '</p><p>')}</p>`;
    for (const addr of to) await send({ to: addr, subject, html, text });
  } catch (err) {
    console.error('[linkedin] alert email failed', safeErrorLog(err));
  }
}
async function defaultRecipients(): Promise<string[]> {
  const users = await prisma.user.findMany({ where: { isActive: true, role: 'ADMIN' }, select: { email: true } });
  return [...new Set(users.map((u) => u.email.trim().toLowerCase()))];
}

/** First 401/403: remember the stop, write the banner state, and email once per IST day. */
async function handleAuthStop(page: string, status: number | null, d: WorkerDeps, now: Date): Promise<void> {
  const cfg = pageConfig(page);
  if (cfg) stoppedFor.set(page, fingerprint(cfg.accessToken));
  const prev = await readAuthState(page);
  const today = istDay(now);
  const alreadyAlerted = prev?.alertedDay === today;
  await writeAuthState(page, { stoppedAt: prev?.stoppedAt ?? now.toISOString(), alertedDay: today, status });
  if (!alreadyAlerted) await alertAdmins(page, status, d, now);
}

const isStopped = (page: string): boolean => {
  const cfg = pageConfig(page);
  const fp = stoppedFor.get(page);
  return !!cfg && fp !== undefined && fp === fingerprint(cfg.accessToken);
};

/* ------------------------------------------------------------------ */
/* One attempt                                                         */
/* ------------------------------------------------------------------ */

type Attempted = 'posted' | 'retry' | 'failed' | 'auth_stop' | 'skipped';

/**
 * Runs ONE attempt for a row that is already claimed (in flight: PENDING, nextAttemptAt null, attempts counted).
 * Writes the outcome to the row. Never throws.
 */
async function attempt(row: LinkedInPost, d: WorkerDeps, now: Date): Promise<Attempted> {
  const page = row.page;
  try {
    const cfg = pageConfig(page);
    const campaign = await prisma.campaign.findUnique({ where: { id: row.campaignId } });
    if (!cfg || !campaign) {
      await prisma.linkedInPost.update({ where: { id: row.id }, data: { status: 'FAILED', error: cfg ? 'campaign not found' : 'page is not configured', nextAttemptAt: null } });
      log(page, row.campaignId, 'failed', 'reason=config');
      return 'failed';
    }
    const post = await buildPost(campaign, page, d.fetchCms ?? ((s) => fetchCmsArticle(s)));
    if (!post) {
      await prisma.linkedInPost.update({ where: { id: row.id }, data: { status: 'FAILED', error: 'not a taxscan.in article link, or the link is not allowed', nextAttemptAt: null } });
      log(page, row.campaignId, 'failed', 'reason=link');
      return 'failed';
    }
    // The card's picture (fail-open): any problem fetching or uploading it posts WITHOUT a thumbnail. Only a 401 / 403 from the
    // upload registration counts as a login error, exactly like the post's own, and then no post call is made.
    let thumbnail: string | undefined;
    let image = 'none:no_cover';
    let uploadAuth: LinkedInResult | null = null;
    if (post.coverImageUrl) {
      const img = await (d.fetchImage ?? fetchCoverImage)(post.coverImageUrl);
      if (!img.ok) image = `none:${img.reason}`;
      else {
        const up = await (d.uploadImage ?? uploadImage)({ orgUrn: cfg.orgUrn, accessToken: cfg.accessToken, bytes: img.bytes, contentType: img.contentType });
        if (up.kind === 'ok') {
          // The upload is asynchronous: only attach the picture once LinkedIn says it is AVAILABLE, else post without it.
          const ready = await (d.waitImage ?? waitForImage)({ urn: up.urn, accessToken: cfg.accessToken });
          if (ready.ok) {
            thumbnail = up.urn;
            image = 'ok';
          } else if (isUnverifiedImage(ready.reason)) {
            // The status call itself failed (not a PROCESSING_FAILED verdict): attach anyway; a post rejected for the picture is repeated without it.
            thumbnail = up.urn;
            image = 'ok:unverified';
          } else image = `none:${ready.reason}`;
        } else if (up.kind === 'auth') {
          uploadAuth = { kind: 'auth', status: up.status, error: up.error };
        } else image = `none:${up.reason}`;
      }
    }
    const send = (withThumbnail: boolean) =>
      (d.post ?? postToLinkedIn)({ orgUrn: cfg.orgUrn, accessToken: cfg.accessToken, commentary: post.commentary, title: post.title, link: post.link, description: post.description, ...(withThumbnail && thumbnail ? { thumbnail } : {}) });
    let result: LinkedInResult = uploadAuth ?? (await send(true));
    // A post REJECTED with a client error while it carried a thumbnail (a 4xx that is not 401 / 403 / 429: our `failed` verdict)
    // is repeated ONCE, right away, without the thumbnail. Safe: a 4xx means LinkedIn did not create the first post. A picture
    // must never stop a post. 2xx, 5xx, 429 and network errors are NOT repeated here (they follow the normal retry rules).
    if (thumbnail && result.kind === 'failed') {
      image = `dropped:${result.status ?? 'unknown'}`;
      result = await send(false);
    }
    if (result.kind === 'posted') {
      await prisma.linkedInPost.update({ where: { id: row.id }, data: { status: 'POSTED', linkedinPostId: result.postId === 'unknown' ? null : result.postId, postedAt: now, error: null, nextAttemptAt: null } });
      if (result.postId === 'unknown') await prisma.linkedInPost.update({ where: { id: row.id }, data: { error: 'posted, but LinkedIn returned no post id — check the page' } });
      log(page, row.campaignId, 'posted', `hashtags=${post.hashtagSource} image=${image}`);
      if (await readAuthState(page)) await clearAuthState(page); // it works again
      return 'posted';
    }
    if (result.kind === 'auth') {
      // not a real attempt: put the row back as a retry that is due as soon as posting resumes
      await prisma.linkedInPost.update({ where: { id: row.id }, data: { attempts: Math.max(0, row.attempts - 1), nextAttemptAt: now, error: clip(result.error) } });
      await handleAuthStop(page, result.status, d, now);
      log(page, row.campaignId, 'auth_stop', `status=${result.status ?? ''} image=${image}`);
      return 'auth_stop';
    }
    if (result.kind === 'retry' && row.attempts < MAX_ATTEMPTS) {
      const due = pushOutOfQuietHours(new Date(now.getTime() + RETRY_DELAYS_MIN[row.attempts - 1] * 60_000), quietOf(d));
      await prisma.linkedInPost.update({ where: { id: row.id }, data: { nextAttemptAt: due, error: clip(result.error) } });
      log(page, row.campaignId, 'retry', `attempt=${row.attempts} next=${due.toISOString()} image=${image}`);
      return 'retry';
    }
    await prisma.linkedInPost.update({ where: { id: row.id }, data: { status: 'FAILED', nextAttemptAt: null, error: clip(result.error) } });
    log(page, row.campaignId, 'failed', `attempts=${row.attempts} image=${image}`);
    return 'failed';
  } catch (err) {
    console.error('[linkedin] attempt failed', safeErrorLog(err));
    // the outcome is unknown (the call may have gone out): never re-post automatically
    await prisma.linkedInPost.update({ where: { id: row.id }, data: { status: 'FAILED', nextAttemptAt: null, error: UNKNOWN_ERROR } }).catch(() => undefined);
    return 'failed';
  }
}

/* ------------------------------------------------------------------ */
/* The tick                                                            */
/* ------------------------------------------------------------------ */

export type TickResult = { posted: number; retried: number; failed: number; staleClosed: number; authStopped: boolean; refused: string | null };

/** Why the worker must not run, or null. */
export function startupProblem(d: Pick<WorkerDeps, 'postFrom' | 'portals'> = {}): string | null {
  const from = d.postFrom === undefined ? env.linkedin.postFrom : d.postFrom;
  if (!from) return 'LINKEDIN_POST_FROM is missing or not a valid ISO time (nothing would be safe to post)';
  for (const page of new Set(Object.values(d.portals ?? PORTAL_TO_PAGE))) if (!pageConfig(page)) return `LINKEDIN_${page.toUpperCase()}_ORG_URN / _ACCESS_TOKEN are not both set`;
  return null;
}

export async function runLinkedInTick(d: WorkerDeps = {}): Promise<TickResult> {
  const now = (d.now ?? (() => new Date()))();
  const out: TickResult = { posted: 0, retried: 0, failed: 0, staleClosed: 0, authStopped: false, refused: null };
  await refreshActiveTokens().catch(() => undefined); // the renewed token, if any, is the one in use
  const problem = startupProblem(d);
  if (problem) return { ...out, refused: problem };
  const postFrom = (d.postFrom === undefined ? env.linkedin.postFrom : d.postFrom) as Date;
  const portals = d.portals ?? PORTAL_TO_PAGE;

  // 1. In-flight rows with no result after 10 minutes: unknown, never re-posted. Only the pages THIS tick handles: a row of a page
  //    it does not post for is not its to judge (in production that is every page; it matters when ticks of different pages overlap).
  const stale = await prisma.linkedInPost.updateMany({
    where: { page: { in: [...new Set(Object.values(portals))] }, status: 'PENDING', nextAttemptAt: null, updatedAt: { lt: new Date(now.getTime() - STALE_MS) } },
    data: { status: 'FAILED', error: UNKNOWN_ERROR },
  });
  out.staleClosed = stale.count;

  let budget = MAX_PER_TICK;
  const note = (r: Attempted) => {
    if (r === 'posted') out.posted += 1;
    else if (r === 'retry') out.retried += 1;
    else if (r === 'failed') out.failed += 1;
    else if (r === 'auth_stop') out.authStopped = true;
  };
  const pages = [...new Set(Object.values(portals))];

  for (const page of pages) {
    if (isStopped(page)) {
      out.authStopped = true;
      continue;
    }
    // 2. Retries that are due (never inside quiet hours: they were scheduled out of it, this guards a changed clock).
    if (!isQuietHours(now, quietOf(d).start, quietOf(d).end)) {
      const due = await prisma.linkedInPost.findMany({ where: { page, status: 'PENDING', nextAttemptAt: { lte: now } }, orderBy: { nextAttemptAt: 'asc' }, take: budget });
      for (const r of due) {
        if (budget <= 0 || out.authStopped) break;
        const claimed = await prisma.linkedInPost.updateMany({ where: { id: r.id, status: 'PENDING', nextAttemptAt: { lte: now } }, data: { nextAttemptAt: null, attempts: { increment: 1 } } });
        if (claimed.count !== 1) continue; // another tick got it
        budget -= 1;
        note(await attempt({ ...r, nextAttemptAt: null, attempts: r.attempts + 1 }, d, now));
      }
    }
    if (out.authStopped || budget <= 0) continue;

    // 3. New articles, oldest push first.
    const since = new Date(Math.max(postFrom.getTime(), now.getTime() - WINDOW_MS));
    const campaigns = await prisma.campaign.findMany({
      where: { portal: { in: Object.keys(portals).filter((p) => portals[p] === page) }, status: 'SENT', lastSentAt: { gte: since } },
      orderBy: [{ lastSentAt: 'asc' }, { id: 'asc' }],
    });
    const firstOf = new Map<string, Campaign>();
    for (const c of campaigns) {
      // WHO sent it never matters (pacer, Compose now / scheduled, Push now, Breaking all post); only a public article does.
      if (!isPublicArticleCampaign(c)) continue;
      const k = articleKey(c);
      if (!firstOf.has(k)) firstOf.set(k, c);
    }
    if (firstOf.size === 0) continue;
    // A re-push or the morning-backfill clone of an article first pushed BEFORE the window (before go-live, or more than
    // 24 h ago) is not new: never post it.
    const earlier = await prisma.campaign.findMany({
      where: { portal: { in: Object.keys(portals).filter((p) => portals[p] === page) }, status: 'SENT', lastSentAt: { gte: new Date(since.getTime() - EARLIER_LOOKBACK_MS), lt: since } },
      select: { id: true, url: true },
    });
    for (const c of earlier) firstOf.delete(articleKey(c));
    if (firstOf.size === 0) continue;
    const have = new Set((await prisma.linkedInPost.findMany({ where: { page, articleKey: { in: [...firstOf.keys()] } }, select: { articleKey: true } })).map((r) => r.articleKey));
    for (const [key, c] of firstOf) {
      if (budget <= 0 || out.authStopped) break;
      if (have.has(key)) continue;
      // An older push of the same article (before the window) already posted, or was before go-live: the row says so.
      let row: LinkedInPost;
      try {
        row = await prisma.linkedInPost.create({ data: { page, articleKey: key, campaignId: c.id, status: 'PENDING', attempts: 1 } });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue; // an overlapping tick created it first
        throw err;
      }
      budget -= 1;
      note(await attempt(row, d, now));
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Manual: Retry / Skip from the screen                                */
/* ------------------------------------------------------------------ */

/** Retry one FAILED row now: one post, then answer. */
export async function retryNow(id: string, d: WorkerDeps = {}): Promise<{ ok: true; status: 'POSTED' | 'FAILED' | 'PENDING' } | { ok: false; reason: 'not_found' | 'not_failed' | 'not_configured' }> {
  const now = (d.now ?? (() => new Date()))();
  await refreshActiveTokens().catch(() => undefined);
  const row = await prisma.linkedInPost.findUnique({ where: { id } });
  if (!row) return { ok: false, reason: 'not_found' };
  if (!pageConfig(row.page)) return { ok: false, reason: 'not_configured' };
  const claimed = await prisma.linkedInPost.updateMany({ where: { id, status: 'FAILED' }, data: { status: 'PENDING', nextAttemptAt: null, attempts: 1, error: null } });
  if (claimed.count !== 1) return { ok: false, reason: 'not_failed' };
  const r = await attempt({ ...row, status: 'PENDING', nextAttemptAt: null, attempts: 1, error: null }, d, now);
  const after = await prisma.linkedInPost.findUnique({ where: { id }, select: { status: true } });
  void r;
  return { ok: true, status: (after?.status === 'POSTED' ? 'POSTED' : after?.status === 'FAILED' ? 'FAILED' : 'PENDING') };
}

/** Skip a FAILED row, or one waiting for a retry. */
export async function skipPost(id: string): Promise<boolean> {
  const r = await prisma.linkedInPost.updateMany({ where: { id, OR: [{ status: 'FAILED' }, { status: 'PENDING', nextAttemptAt: { not: null } }] }, data: { status: 'SKIPPED', nextAttemptAt: null } });
  return r.count === 1;
}

/* ------------------------------------------------------------------ */
/* Cron                                                                */
/* ------------------------------------------------------------------ */

let ticking = false;

/** Started like the other crons, only when the flag is on and the config is sound. */
export function startLinkedInWorker(): void {
  if (!env.linkedin.enabled) {
    // eslint-disable-next-line no-console
    console.log('[linkedin] disabled (set LINKEDIN_POSTING_ENABLED=true to start)');
    return;
  }
  const problem = startupProblem();
  if (problem) {
    console.error(`[linkedin] refusing to start: ${problem}`);
    return;
  }
  cron.schedule('* * * * *', async () => {
    if (ticking) return;
    ticking = true;
    try {
      await runLinkedInTick();
    } catch (err) {
      console.error('[linkedin] tick failed', safeErrorLog(err, { stack: true }));
    } finally {
      ticking = false;
    }
  });
  // eslint-disable-next-line no-console
  console.log(`[linkedin] worker started (post from ${env.linkedin.postFrom!.toISOString()})`);
}
