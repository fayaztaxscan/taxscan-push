import cron from 'node-cron';
import { createHash } from 'node:crypto';
import { Prisma, type FacebookPost } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { env, parseAllPushesFrom, ALL_PUSHES_FROM_VARS } from '../../lib/env';
import { safeErrorLog } from '../../lib/httpErrors';
import { defaultEmailSender, isEmailConfigured, type EmailSender } from '../../lib/email';
import { isQuietHours } from '../../lib/quietHours';
import { articleKey } from '../reports';
import { isPublicArticleCampaign } from '../social/publicCampaign';
import { isAllPushesCampaign, pageLinkOf, pushedCampaignIds, pushKey, storeLinkOf } from '../social/allPushes';
import { istDay, istDayBounds } from '../whatsapp/queue';
import { pushOutOfQuietHours } from '../linkedin/worker';
import type { CmsArticle } from '../linkedin/post';
import { fetchCmsArticle } from '../linkedin/post';
import { postToFacebook, type FacebookFailure } from './client';
import { PORTAL_TO_PAGE, pageConfig } from './pages';
import { buildFacebookPagePost, buildFacebookPost, buildFacebookStorePost, captionWithLink } from './post';
import { campaignPicture, socialImageUrl } from '../social/picture';
import { COMPOSE_SKIP, facebookSkipKey } from '../social/pages';
import { composeSkippedPushes, skipRows } from '../social/composeSkip';

/**
 * The Facebook posting worker (brief 2026-11-03-facebook-page-posting, docs/FACEBOOK_POSTING.md). It mirrors the LinkedIn worker
 * and READS Campaign rows only (never touches the send path). Account safety is the difference:
 *  - AT MOST ONE post attempt per tick, and at least FACEBOOK_MIN_GAP_MINUTES between two posts on the page;
 *  - at most FACEBOOK_DAILY_CAP posts per IST day (the rest wait for the next day, however old they are by then: there is NO age
 *    limit, brief 2026-11-04-social-no-age-limit; only FACEBOOK_POST_FROM is absolute);
 *  - a policy block from Facebook (code 368 etc.) STOPS the page for good: the stop is persisted and only an ADMIN's Resume
 *    clears it, even across a restart. Retry is refused while stopped;
 *  - a bad token (190 / permission / 401 / 403) stops the page until the token changes or the app restarts;
 *  - rate limits retry slowly (+15, +60 min), transient errors quickly (+1, +5, +15); retries never fall in quiet hours.
 * The `FacebookPost` row is created BEFORE the call; its unique (page, articleKey) makes a re-push a no-op.
 *
 * EVERY PUSH POSTS (brief 2026-11-04-academy-store-posts). Once FACEBOOK_ALL_PUSHES_FROM is set, the page posts, from that time on,
 * EVERY push: taxscan.in articles, academy.taxscan.in courses and shop.taxscan.in products, ONE POST PER PUSH, repeats included
 * (a backfill clone, a resend). The row key is `push:<campaign id>:<send time ms>`. A push sent before that time follows today's rule
 * (one post per article, the `earlier` look-back) for good, so switching on never floods the page with the past. The two kinds of
 * candidate share EVERYTHING above: the one-per-tick rule, the gap, the daily cap (every kind counts), the retries, both stops, and
 * the order (merged by send time, oldest first). A course / product post is the push's own title and body; an article post is built
 * exactly as before. Facebook's duplicate answer (code 506) is a plain FAILED: no retry, no stop, no alert.
 */

export const STALE_MS = 10 * 60_000;
export const RATE_DELAYS_MIN = [15, 60] as const;
export const TRANSIENT_DELAYS_MIN = [1, 5, 15] as const;
/** How far before go-live (FACEBOOK_POST_FROM) an earlier push of the same article is looked for. */
const EARLIER_LOOKBACK_MS = 14 * 24 * 60 * 60_000;
export const UNKNOWN_ERROR = 'unknown — check the page';
export const DUPLICATE_ERROR = 'Facebook says this was already posted';
/** The reason on a row written for a push whose sender unticked this page on Compose (brief 2026-11-09-compose-skip-pages). */
export { COMPOSE_SKIP };

export type WorkerDeps = {
  now?: () => Date;
  /** The Graph call (tests mock it). */
  post?: typeof postToFacebook;
  fetchCms?: (slug: string) => Promise<CmsArticle | null>;
  /** SOCIAL_PICTURE_ENABLED (tests pass it; default the env). */
  socialPicture?: boolean;
  emailSender?: EmailSender;
  isEmailConfigured?: () => boolean;
  /** Active ADMIN emails; default reads the User table. */
  recipients?: () => Promise<string[]>;
  /** Campaign.portal → page. Default PORTAL_TO_PAGE. */
  portals?: Readonly<Record<string, string>>;
  postFrom?: Date | null;
  /** The time from which the page posts EVERY push (brief 2026-11-04-academy-store-posts); null = today's rule. Default FACEBOOK_ALL_PUSHES_FROM. */
  allPushesFrom?: Date | null;
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
      `Articles pushed meanwhile are kept: they post once posting resumes.\n\n` +
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
    // A course / product post (its LINK says so: under "every push posts" every kind of row has a `push:` key) has its own builder: the
    // push's own wording, no CMS data. An article keeps the CMS one.
    // Brief 2026-11-07-social-every-link: a push to any OTHER allowed page is a third kind (`kind=page`), built like a course / product
    // post. The LINK alone decides the builder, never the time switch: a row that exists keeps being retried the same way.
    const link = storeLinkOf(campaign.url);
    const store = link !== null;
    const other = store ? null : pageLinkOf(campaign.url);
    const kind = link ? ` kind=${link.kind}` : other ? ' kind=page' : '';
    const post = store
      ? buildFacebookStorePost(campaign, page)
      : other
        ? buildFacebookPagePost(campaign, page)
        : await buildFacebookPost(campaign, page, d.fetchCms ?? ((s) => fetchCmsArticle(s)));
    if (!post) {
      await fail(
        store ? 'not a course or shop product link, or the link is not allowed' : other ? 'not an allowed page link, or the link is not allowed' : 'not a taxscan.in article link, or the link is not allowed',
      );
      log(page, row.campaignId, 'failed', `reason=link${kind}`);
      return 'failed';
    }
    // The Compose picture (brief 2026-11-08-social-picture): a photo post, Facebook fetching our public picture URL, the tagged link
    // in the caption. A photo post refused with a plain 4xx (`failed`: nothing was made, e.g. Facebook could not read the picture) is
    // repeated ONCE as today's link post; every other answer (posted, rate, transient, auth, policy, duplicate) is handled as today.
    const picture = await campaignPicture(campaign, d.socialPicture);
    let pictureNote = picture ? 'picture' : '';
    let result = picture
      ? await (d.post ?? postToFacebook)({ pageId: cfg.pageId, accessToken: cfg.accessToken, message: captionWithLink(post.message, post.link), link: post.link, photoUrl: socialImageUrl(picture) })
      : await (d.post ?? postToFacebook)({ pageId: cfg.pageId, accessToken: cfg.accessToken, message: post.message, link: post.link });
    let pictureFallback: string | null = null;
    if (picture && result.kind === 'failed') {
      pictureFallback = `rejected_${result.status ?? 'unknown'}${result.code !== null ? `_code_${result.code}` : ''}`;
      pictureNote = `picture=fallback:${pictureFallback}`;
      result = await (d.post ?? postToFacebook)({ pageId: cfg.pageId, accessToken: cfg.accessToken, message: post.message, link: post.link });
    }
    if (result.kind === 'posted') {
      await prisma.facebookPost.update({
        where: { id: row.id },
        data: {
          status: 'POSTED',
          facebookPostId: result.postId === 'unknown' ? null : result.postId,
          postedAt: now,
          error:
            result.postId === 'unknown'
              ? 'posted, but Facebook returned no post id — check the page'
              : pictureFallback
                ? clip(`posted as a link post: Facebook could not use the Compose picture (${pictureFallback})`)
                : null,
          nextAttemptAt: null,
        },
      });
      log(page, row.campaignId, 'posted', `hashtags=${post.hashtagSource}${pictureNote ? ` ${pictureNote === 'picture' ? 'image=picture' : pictureNote}` : ''}${kind}`);
      if (await readSetting(authKey(page))) await prisma.digestSetting.deleteMany({ where: { key: authKey(page) } }); // it works again
      return 'posted';
    }
    if (result.kind === 'auth') {
      // not a real attempt: back to a retry that is due as soon as posting resumes
      await prisma.facebookPost.update({ where: { id: row.id }, data: { attempts: Math.max(0, row.attempts - 1), nextAttemptAt: now, error: clip(result.error) } });
      await handleAuthStop(page, result.status, d, now);
      log(page, row.campaignId, 'auth_stop', `status=${result.status ?? ''} code=${result.code ?? ''}${kind}`);
      return 'auth_stop';
    }
    if (result.kind === 'policy') {
      // never retried into a block: FAILED, and the page stops until an ADMIN resumes
      await fail(clip(result.error));
      await handlePolicyStop(page, result, d, now);
      log(page, row.campaignId, 'policy_stop', `status=${result.status ?? ''} code=${result.code ?? ''} subcode=${result.subcode ?? ''}${kind}`);
      return 'policy_stop';
    }
    if (result.kind === 'duplicate') {
      await fail(DUPLICATE_ERROR);
      log(page, row.campaignId, 'failed', `reason=duplicate${kind}`);
      return 'failed';
    }
    if (result.kind === 'rate' || result.kind === 'transient') {
      const delays = result.kind === 'rate' ? RATE_DELAYS_MIN : TRANSIENT_DELAYS_MIN;
      if (row.attempts <= delays.length) {
        const due = pushOutOfQuietHours(new Date(now.getTime() + delays[row.attempts - 1] * 60_000), quietOf(d));
        await prisma.facebookPost.update({ where: { id: row.id }, data: { nextAttemptAt: due, error: clip(result.error) } });
        log(page, row.campaignId, 'retry', `class=${result.kind} attempt=${row.attempts} next=${due.toISOString()}${kind}`);
        return 'retry';
      }
    }
    await fail(clip(result.error));
    log(page, row.campaignId, 'failed', `attempts=${row.attempts}${kind}`);
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
    // COMPOSE SKIPS (brief 2026-11-09-compose-skip-pages): a push whose sender unticked THIS page gets a SKIPPED row (reason `compose_skip`)
    // under its OWN push key and is taken out of this page's candidates below. DB only: no call, no pacing (the gap and the daily cap
    // count posts), and not gated by a stop; so the row exists at once whatever the page is waiting for.
    // null = today's rule only (see step 3).
    const pushesFrom = d.allPushesFrom === undefined ? env.facebook.allPushesFrom : d.allPushesFrom;
    const pagePortals = Object.keys(portals).filter((p) => portals[p] === page);
    const composeSkipped = await composeSkippedPushes(pagePortals, facebookSkipKey(page), postFrom);
    if (composeSkipped.length > 0) {
      const wanted = skipRows(composeSkipped, pushesFrom);
      const have = new Set((await prisma.facebookPost.findMany({ where: { page, articleKey: { in: wanted.map((w) => w.key) } }, select: { articleKey: true } })).map((r) => r.articleKey));
      for (const w of wanted) {
        if (have.has(w.key)) continue;
        try {
          await prisma.facebookPost.create({ data: { page, articleKey: w.key, campaignId: w.campaignId, status: 'SKIPPED', attempts: 0, error: COMPOSE_SKIP } });
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue; // an overlapping tick created it first
          throw err;
        }
      }
    }
    const skippedIds = new Set(composeSkipped.map((c) => c.id));
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

    // 3. A new post, oldest push first. NO age limit: the oldest SENT push since go-live (FACEBOOK_POST_FROM) whose article has
    //    no row yet posts, however long ago it was pushed; the gap, the daily cap and the stops above still pace it. That list only
    //    grows (~20 a day) and is read every minute, so it is read with `select` of just what the two shared rules need
    //    (isPublicArticleCampaign: url + target; articleKey: id + url), never whole rows; `attempt` loads the one it posts.
    //    EVERY PUSH POSTS (brief 2026-11-04-academy-store-posts): with FACEBOOK_ALL_PUSHES_FROM set, the pushes split at that time.
    //    A push BEFORE it follows today's rule above for good (one post per article, the `earlier` look-back), so setting the time
    //    never floods the page with the past, and a pre-time article that has no row yet still gets its one post. A push AT or
    //    AFTER it follows the new rule: every qualifying push (article, course, product) is its own candidate, keyed
    //    `push:<campaign id>:<send time ms>`, repeats included. Both kinds are merged by the time of the push, oldest first.
    // null = today's rule only. The read below starts at the page's own go-live, so the new rule can never reach back before it, whatever time is set.
    // The read stays `select`-narrow: only what the rules need, and `lastSentAt` too ONLY while the all-pushes time is set (it is what
    // splits the pushes at that time and merges the two rules by time). With the time unset the read is exactly today's.
    const campaigns: { id: string; url: string; target: unknown; lastSentAt?: Date | null }[] = await prisma.campaign.findMany({
      where: { portal: { in: pagePortals }, status: 'SENT', lastSentAt: { gte: postFrom } },
      select: pushesFrom ? { id: true, url: true, target: true, lastSentAt: true } : { id: true, url: true, target: true },
      orderBy: [{ lastSentAt: 'asc' }, { id: 'asc' }],
    });
    const firstOf = new Map<string, string>(); // post key → the id of the push it is posted for; both rules insert as the pushes come, oldest first
    // TODAY'S-RULE candidates (an article's oldest push) and, for each, the id of EVERY push of that article in this read: the guard
    // below needs them all (a repeat of an article can have a `push:` row while its oldest push does not).
    const idsOfArticle = new Map<string, string[]>();
    for (const c of campaigns) {
      if (skippedIds.has(c.id)) continue; // unticked on Compose for this page: its SKIPPED row is written above; it is nobody's candidate
      const sentAt = c.lastSentAt ?? null; // only read while the all-pushes time is set
      const k = isPublicArticleCampaign(c) ? articleKey(c) : null; // null: not a public article
      if (k !== null) idsOfArticle.get(k)?.push(c.id); // a later push of an article that follows today's rule
      if (pushesFrom && sentAt && sentAt >= pushesFrom) {
        // THE NEW RULE: one candidate per push. WHO sent it never matters (pacer, backfill clone, Compose, Push now, Breaking).
        if (isAllPushesCampaign(c)) firstOf.set(pushKey({ id: c.id, lastSentAt: sentAt }), c.id);
        continue;
      }
      // TODAY'S RULE: only a public article, once per article (its oldest push). WHO sent it never matters.
      if (k === null || firstOf.has(k)) continue;
      firstOf.set(k, c.id);
      idsOfArticle.set(k, [c.id]);
    }
    if (idsOfArticle.size > 0) {
      // A re-push or backfill clone of an article first pushed BEFORE go-live (looked up to 14 days before it) is not new: never
      // post it, at any age. (Only today's rule looks back; the new rule posts every push.)
      const earlier = await prisma.campaign.findMany({
        where: { portal: { in: pagePortals }, status: 'SENT', lastSentAt: { gte: new Date(postFrom.getTime() - EARLIER_LOOKBACK_MS), lt: postFrom } },
        select: { id: true, url: true },
      });
      for (const c of earlier) firstOf.delete(articleKey(c));
    }
    if (firstOf.size === 0) continue;
    // Which of them already have a row (POSTED, SKIPPED, FAILED or in flight)? The page's keys in ONE indexed read: an
    // `IN (…)` of every candidate would grow with the list above.
    const have = new Set((await prisma.facebookPost.findMany({ where: { page }, select: { articleKey: true } })).map((r) => r.articleKey));
    // Follow-up 1: an article ANY of whose pushes already has a `push:` row on this page was handled by the new rule, so today's rule must
    // not post it again. That is what happens when the all-pushes time is removed or moved later: without this, every article pushed
    // while the new rule was on would be posted once more. The campaign id is in the key, so the `have` read above supplies the ids,
    // and the article keys come from the pushes already read: no extra query. Any status counts (POSTED, FAILED, SKIPPED, in flight).
    const handled = pushedCampaignIds(have);
    if (handled.size > 0) for (const [k, ids] of idsOfArticle) if (ids.some((id) => handled.has(id))) firstOf.delete(k);
    // Oldest first across both rules: the read orders the pushes by send time (then id) and each rule inserts as it goes.
    for (const [key, campaignId] of firstOf) {
      if (have.has(key)) continue;
      let row: FacebookPost;
      try {
        row = await prisma.facebookPost.create({ data: { page, articleKey: key, campaignId, status: 'PENDING', attempts: 1 } });
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
  // "Every push posts" (brief 2026-11-04-academy-store-posts): ONE line, on with its time, or off (the page stays on today's rule, one
  // post per article) and why, in fixed words naming the variable, never its value.
  const pushesFrom = env.facebook.allPushesFrom;
  // eslint-disable-next-line no-console
  console.log(
    pushesFrom
      ? `[facebook] all pushes on for ${ALL_PUSHES_FROM_VARS.facebook} (from ${pushesFrom.toISOString()})`
      : `[facebook] all pushes off: ${parseAllPushesFrom(process.env, ALL_PUSHES_FROM_VARS.facebook).off ?? `${ALL_PUSHES_FROM_VARS.facebook} is not set`} (today's rule: one post per article)`,
  );
}
