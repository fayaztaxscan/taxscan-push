import cron from 'node-cron';
import { createHash } from 'node:crypto';
import { Prisma, type LinkedInPost } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { env, parseLinkedInAcademyEnv, parseLinkedInShopscanEnv, parseLinkedInHeadroom, parseAllPushesFrom, ALL_PUSHES_FROM_VARS } from '../../lib/env';
import { safeErrorLog } from '../../lib/httpErrors';
import { defaultEmailSender, isEmailConfigured, type EmailSender } from '../../lib/email';
import { isQuietHours } from '../../lib/quietHours';
import { articleKey } from '../reports';
import { isPublicArticleCampaign } from '../social/publicCampaign';
import { fetchStorePage, type StorePageFetch } from '../social/storePage';
import { isAllPushesCampaign, pageLinkOf, pushedCampaignIds, pushKey, storeLinkOf } from '../social/allPushes';
import { istDay, istDayBounds } from '../whatsapp/queue';
import { isUnverifiedImage, postToLinkedIn, uploadImage, waitForImage, type LinkedInResult } from './client';
import { fetchCoverImage } from './image';
import { PAGE_ACADEMY, PAGE_SHOPSCAN, PAGE_TAXSCAN, academyActive, normalizePortals, pageAllPushesFrom, pageConfig, pageHeadroom, pagesOf, portalPages, portalsOfPage, postFromVarOf, resolveAllPushesFrom, resolvePostFrom, type PortalMap, type PostFromInput } from './pages';
import { refreshActiveTokens, tokenPageOf } from './token';
import { buildPagePost, buildPost, buildStorePost, commentaryWithLink, fetchCmsArticle, type CmsArticle } from './post';
import { campaignPicture } from '../social/picture';
import { COMPOSE_SKIP, linkedinSkipKey } from '../social/pages';
import { composeSkippedPushes, skipRows } from '../social/composeSkip';
import { ORG_DAILY_LIMIT, clearOrgHolds, holdOrgPage, isOrgHeld, nextUtcMidnight } from './orgHold';
import { PAGE_PAUSED, getPause } from '../social/pause';
import { alertIfNeeded } from '../social/pageAlerts';

/**
 * The LinkedIn posting worker (brief 2026-11-02-linkedin-page-posting, docs/LINKEDIN_POSTING.md).
 *
 * A 1-minute tick that READS Campaign rows (never touches the send path) and posts each pushed taxscan.in article to
 * its LinkedIn page(s), oldest first, at most 3 per tick across ALL pages (Taxscan first; the optional Academy page, brief
 * 2026-11-04-linkedin-academy-page, and then the optional Shopscan page, brief 2026-11-09-linkedin-shopscan-page, post the same
 * articles with their own rows, go-live times and org URNs, and the Taxscan token).
 * Safety rules, all enforced here, PER PAGE:
 *  - the `LinkedInPost` row is created (PENDING, in flight = `nextAttemptAt` null) BEFORE the API call, one article at a
 *    time, and its unique (page, articleKey) makes a second tick (or a re-push / the morning-backfill clone) a no-op;
 *  - an in-flight row older than 10 min with no result becomes FAILED "unknown — check the page" and is never re-posted
 *    automatically (a crash mid-call may or may not have posted);
 *  - 429 / 5xx / network: retry at +1, +5, +15 min (a retry due in quiet hours waits for 07:00 IST), then FAILED;
 *  - 401 / 403: stop posting for THAT page until the token changes or the app restarts; one alert email per page per IST day. A
 *    stop never gates another page, in the same tick or a later one;
 *  - nothing pushed before the page's go-live (LINKEDIN_POST_FROM; Academy: LINKEDIN_ACADEMY_POST_FROM) is ever posted to it.
 *    After it there is NO age limit: an article that has no row yet is posted however long ago it was pushed (brief
 *    2026-11-04-social-no-age-limit).
 *
 * LINKEDIN'S PER-PAGE DAILY LIMIT (brief 2026-11-09-small-fixes, found live 9 Nov: Shopscan posted 3 times, then every create was refused).
 * A create call answered with HTTP 429 and `Organization post creation limit reached` means LinkedIn will take no more posts for THAT page
 * until its day turns. The page is then HELD until the next 00:00 UTC (05:30 IST), in memory only (a restart forgets it and the next such
 * 429 sets it again): the row that met it is SKIPPED with the reason `org_daily_limit`, and every further push to that page, a retry
 * waiting for its turn included, is SKIPPED `org_daily_limit` with NO API call, never retried and never posted later (same rule as
 * `quota_headroom`; a manual immediate push is not exempt, LinkedIn would refuse it too). One log line per hold. Other pages are not
 * affected, and any OTHER 429 keeps the ordinary retry path above.
 *
 * PAUSED PAGES (brief 2026-11-09-social-page-alerts-pause). An ADMIN can pause ONE page from its screen (`social:pause:linkedin:<page>`):
 * while paused every push for it gets its row SKIPPED `page_paused` with NO API call (a manual immediate push included), rows waiting for a
 * retry are skipped too, nothing is ever posted later, and resume posts from the next push. Checked BEFORE the login stop, the quota guard and
 * the org hold, so a paused page never posts after any of them clears. After a failed attempt or a hold the page-status helper decides
 * whether to email the admins (`held` / `failing`, once per page per kind per IST day): see `services/social/pageAlerts.ts`.
 *
 * EVERY PUSH POSTS (brief 2026-11-04-academy-store-posts). A page with its own LINKEDIN_TAXSCAN_ALL_PUSHES_FROM /
 * LINKEDIN_ACADEMY_ALL_PUSHES_FROM posts, from that time on, EVERY push: taxscan.in articles, academy.taxscan.in courses and
 * shop.taxscan.in products, ONE POST PER PUSH, repeats included (a backfill clone, a resend). The row key is `push:<campaign id>:<send
 * time ms>`. A push sent before that time follows today's rule (one post per article, the `earlier` look-back) for good, so switching
 * on never floods the page with the past. The two kinds of candidate share everything above: the order (merged by send time, oldest
 * first), MAX_PER_TICK, the retries, the stale rule, the per-page login stop. A course / product post has its own builder (the push's
 * own title and body, the card from the page's og tags); an article post is built exactly as before. LinkedIn's duplicate answer
 * (422 DUPLICATE_POST) is a plain FAILED: no retry, no repeat without the picture, no stop, no alert. See src/services/social/allPushes.ts.
 * The Shopscan page is an every-push page from its first day (its go-live IS its all-pushes time).
 *
 * THE DAILY QUOTA GUARD (briefs 2026-11-09-linkedin-shopscan-page + Follow-up 1). Every page posts with ONE member token on the
 * Development tier: 100 `posts` CREATE calls per member per 24 h. At the start of each tick the worker reads how many create attempts
 * were made today (IST day) across ALL pages; Academy holds itself at LINKEDIN_ACADEMY_DAILY_HEADROOM (default 75), Shopscan at
 * LINKEDIN_SHOPSCAN_DAILY_HEADROOM (default 85), Taxscan never. A held page makes no API call: each push it would have posted gets a
 * SKIPPED row with the reason `quota_headroom`, which is never retried and never posted later (a late post of an old push is worse than
 * none). The count is taken ONCE per tick, before anything posts, so one push posts to every page the same way; a tick makes at most 3
 * posts, so a page can pass its number by at most 2.
 * A MANUAL IMMEDIATE PUSH IS NEVER HELD (Follow-up 2, owner 9 Nov: it may be viral, important news): Compose Send now, Breaking, and
 * Queue / Review Push now post on every page whatever today's count. See `isManualImmediatePush`. It still counts toward the day.
 */

export const MAX_PER_TICK = 3;
export const STALE_MS = 10 * 60_000;
/** Minutes to wait after failed attempt 1, 2, 3; attempt 4 failing = FAILED. */
export const RETRY_DELAYS_MIN = [1, 5, 15] as const;
export const MAX_ATTEMPTS = RETRY_DELAYS_MIN.length + 1;
/** How far before go-live (LINKEDIN_POST_FROM) an earlier push of the same article is looked for. */
const EARLIER_LOOKBACK_MS = 14 * 24 * 60 * 60_000;
export const UNKNOWN_ERROR = 'unknown — check the page';
export const DUPLICATE_ERROR = 'LinkedIn says this was already posted';
/** The reason on a row a held page SKIPPED (the daily quota guard). The screen turns it into words. */
export const QUOTA_HEADROOM = 'quota_headroom';
// LinkedIn's per-page daily limit hold lives in ./orgHold (brief 2026-11-09-social-page-alerts-pause: the page-status helper reads it too).
export { ORG_DAILY_LIMIT, isOrgHeld, nextUtcMidnight };
/** The reason on a row written for a push whose sender unticked this page on Compose (brief 2026-11-09-compose-skip-pages). */
export { COMPOSE_SKIP };
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
  /** SOCIAL_PICTURE_ENABLED (tests pass it; default the env). */
  socialPicture?: boolean;
  emailSender?: EmailSender;
  isEmailConfigured?: () => boolean;
  /** Active ADMIN emails; default reads the User table. */
  recipients?: () => Promise<string[]>;
  /** Campaign.portal → page(s): one page name or a list per portal, Taxscan first. Default `portalPages()` (Academy only while active). */
  portals?: PortalMap;
  /** Go-live: one time for every page, or one per page. Default: each page's own configured time. */
  postFrom?: PostFromInput;
  /** The time from which a page posts EVERY push (brief 2026-11-04-academy-store-posts): one time for every page, or one per page; null = today's rule. Default: each page's own variable. */
  allPushesFrom?: PostFromInput;
  /** A course / product page's og tags (tests mock it). */
  fetchStorePage?: StorePageFetch;
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
  holdLoggedDay.clear();
  clearOrgHolds();
}
const holdLoggedDay = new Map<string, string>(); // page → the IST day its quota_headroom line was last logged
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
    const lead = `Taxscan Push could not post to the ${page} LinkedIn page: LinkedIn answered ${status ?? 'an authorisation error'} (the access token expired, was revoked or lacks permission).`;
    const kept = 'Articles pushed meanwhile are kept: they post once posting resumes.';
    const screen = `The LinkedIn screen in the admin shows this notice too. (${now.toISOString()})`;
    // A page that posts with ANOTHER page's token (Academy → Taxscan) has no token variable of its own: say which one to change, and
    // that a 403 on it alone normally means the member who made the token has no role on THIS page.
    const owner = tokenPageOf(page);
    const text =
      owner === page
        ? [lead, `No further posts are attempted for this page until a new token is set in Railway (LINKEDIN_${page.toUpperCase()}_ACCESS_TOKEN) or the app restarts. ${kept}`, screen].join('\n\n')
        : [
            lead,
            `The ${page} page posts with the same LinkedIn token as the ${owner} page, so it has no token variable of its own: the one to change in Railway is LINKEDIN_${owner.toUpperCase()}_ACCESS_TOKEN (the automatic renewal replaces it too).` +
              (status === 403
                ? ` If the ${owner} page is still posting, a 403 here normally means the LinkedIn member who made that token has no admin role on the ${page} page: give that member the role in LinkedIn, then restart the app so posting resumes.`
                : ''),
            `No further posts are attempted for the ${page} page until the token changes or the app restarts. ${kept}`,
            screen,
          ].join('\n\n');
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
 * Runs ONE attempt for a row that is already claimed (in flight: PENDING, nextAttemptAt null, attempts counted), then, when it failed or the
 * page was held, lets the page-status helper decide about the alert email. Writes the outcome to the row. Never throws.
 */
async function attempt(row: LinkedInPost, d: WorkerDeps, now: Date): Promise<Attempted> {
  const r = await attemptOnce(row, d, now);
  if (r === 'failed' || r === 'skipped') await alertIfNeeded('linkedin', row.page, now, d);
  return r;
}

async function attemptOnce(row: LinkedInPost, d: WorkerDeps, now: Date): Promise<Attempted> {
  const page = row.page;
  try {
    const cfg = pageConfig(page);
    const campaign = await prisma.campaign.findUnique({ where: { id: row.campaignId } });
    if (!cfg || !campaign) {
      await prisma.linkedInPost.update({ where: { id: row.id }, data: { status: 'FAILED', error: cfg ? 'campaign not found' : 'page is not configured', nextAttemptAt: null } });
      log(page, row.campaignId, 'failed', 'reason=config');
      return 'failed';
    }
    // A course / product post (its LINK says so: under "every push posts" every kind of row has a `push:` key) has its own builder: the
    // push's own wording, UTMs and the page's og tags. An article is built exactly as before.
    // Brief 2026-11-07-social-every-link: a push to any OTHER allowed page (a shop collection, the pricing page, the home page) is a third
    // card post (`kind=page`), built like a course / product post. Which builder is decided by the LINK alone, never by the time switch:
    // a row that exists keeps being retried the same way after SOCIAL_ANY_LINK_FROM is removed.
    const store = storeLinkOf(campaign.url);
    const other = store ? null : pageLinkOf(campaign.url);
    const kind = store ? ` kind=${store.kind}` : other ? ' kind=page' : '';
    const fetchCard = d.fetchStorePage ?? ((u: string) => fetchStorePage(u));
    const post = store
      ? await buildStorePost(campaign, page, fetchCard)
      : other
        ? await buildPagePost(campaign, page, fetchCard)
        : await buildPost(campaign, page, d.fetchCms ?? ((s) => fetchCmsArticle(s)));
    if (!post) {
      await prisma.linkedInPost.update({
        where: { id: row.id },
        data: {
          status: 'FAILED',
          error: store ? 'not a course or shop product link, or the link is not allowed' : other ? 'not an allowed page link, or the link is not allowed' : 'not a taxscan.in article link, or the link is not allowed',
          nextAttemptAt: null,
        },
      });
      log(page, row.campaignId, 'failed', `reason=link${kind}`);
      return 'failed';
    }
    // The Compose picture (brief 2026-11-08-social-picture; SOCIAL_PICTURE_ENABLED): an IMAGE post with our own bytes and the
    // tagged link in the commentary. Fail-open to today's link post below: an upload that fails, a picture LinkedIn never makes
    // ready, a commentary that would grow too long or an image post refused with a 4xx (`failed`: LinkedIn made nothing) all post
    // the ordinary link post, and the row says why. A 401 / 403 from the upload is a login stop, as today.
    let pictureResult: LinkedInResult | null = null;
    let pictureFallback: string | null = null;
    const picture = await campaignPicture(campaign, d.socialPicture);
    if (picture) {
      const commentary = commentaryWithLink(post.commentary, post.link);
      if (!commentary) pictureFallback = 'commentary_too_long';
      else {
        const up = await (d.uploadImage ?? uploadImage)({ orgUrn: cfg.orgUrn, accessToken: cfg.accessToken, bytes: picture.bytes, contentType: picture.mime });
        if (up.kind === 'auth') pictureResult = { kind: 'auth', status: up.status, error: up.error };
        else if (up.kind === 'soft') pictureFallback = up.reason;
        else {
          const ready = await (d.waitImage ?? waitForImage)({ urn: up.urn, accessToken: cfg.accessToken });
          if (ready.ok || isUnverifiedImage(ready.reason)) {
            const r = await (d.post ?? postToLinkedIn)({ orgUrn: cfg.orgUrn, accessToken: cfg.accessToken, commentary, title: post.title, link: post.link, image: up.urn });
            if (r.kind === 'failed') pictureFallback = `rejected_${r.status ?? 'unknown'}`;
            else pictureResult = r;
          } else pictureFallback = ready.reason;
        }
      }
    }
    // The card's picture (fail-open): any problem fetching or uploading it posts WITHOUT a thumbnail. Only a 401 / 403 from the
    // upload registration counts as a login error, exactly like the post's own, and then no post call is made.
    let thumbnail: string | undefined;
    let image = pictureResult ? (pictureResult.kind === 'posted' ? 'picture' : 'picture_tried') : `none:${post.imageReason ?? 'no_cover'}`;
    let uploadAuth: LinkedInResult | null = null;
    if (!pictureResult && post.coverImageUrl) {
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
    let result: LinkedInResult = pictureResult ?? uploadAuth ?? (await send(true));
    // A post REJECTED with a client error while it carried a thumbnail (a 4xx that is not 401 / 403 / 429: our `failed` verdict)
    // is repeated ONCE, right away, without the thumbnail. Safe: a 4xx means LinkedIn did not create the first post. A picture
    // must never stop a post. 2xx, 5xx, 429 and network errors are NOT repeated here (they follow the normal retry rules), and
    // neither is a DUPLICATE answer (its own kind, never `failed`): that is not the picture's fault, and repeating a post LinkedIn
    // refused as a copy would only hide the reason.
    if (!pictureResult && thumbnail && result.kind === 'failed') {
      image = `dropped:${result.status ?? 'unknown'}`;
      result = await send(false);
    }
    if (result.kind === 'posted') {
      await prisma.linkedInPost.update({ where: { id: row.id }, data: { status: 'POSTED', linkedinPostId: result.postId === 'unknown' ? null : result.postId, postedAt: now, error: null, nextAttemptAt: null } });
      if (result.postId === 'unknown') await prisma.linkedInPost.update({ where: { id: row.id }, data: { error: 'posted, but LinkedIn returned no post id — check the page' } });
      else if (pictureFallback) {
        await prisma.linkedInPost.update({ where: { id: row.id }, data: { error: clip(`posted as a link post: the Compose picture could not be used (${pictureFallback})`) } });
      }
      log(page, row.campaignId, 'posted', `hashtags=${post.hashtagSource} image=${image}${pictureFallback ? ` picture=fallback:${pictureFallback}` : ''}${kind}`);
      if (await readAuthState(page)) await clearAuthState(page); // it works again
      return 'posted';
    }
    if (result.kind === 'auth') {
      // not a real attempt: put the row back as a retry that is due as soon as posting resumes
      await prisma.linkedInPost.update({ where: { id: row.id }, data: { attempts: Math.max(0, row.attempts - 1), nextAttemptAt: now, error: clip(result.error) } });
      await handleAuthStop(page, result.status, d, now);
      log(page, row.campaignId, 'auth_stop', `status=${result.status ?? ''} image=${image}${kind}`);
      return 'auth_stop';
    }
    if (result.kind === 'duplicate') {
      // LinkedIn already has this exact post (every push posts, so an identical repeat can happen). Not a fault of ours: FAILED with a
      // plain reason, and no retry, no login stop, no alert; the push behind it posts on the next tick.
      await prisma.linkedInPost.update({ where: { id: row.id }, data: { status: 'FAILED', nextAttemptAt: null, error: DUPLICATE_ERROR } });
      log(page, row.campaignId, 'failed', `reason=duplicate image=${image}${kind}`);
      return 'failed';
    }
    if (result.kind === 'org_limit') {
      // LinkedIn's per-page daily limit: not retried, not posted later. The row is SKIPPED, and the page is held until 00:00 UTC.
      await prisma.linkedInPost.update({ where: { id: row.id }, data: { status: 'SKIPPED', nextAttemptAt: null, error: ORG_DAILY_LIMIT } });
      holdOrgPage(page, now);
      return 'skipped';
    }
    if (result.kind === 'retry' && row.attempts < MAX_ATTEMPTS) {
      const due = pushOutOfQuietHours(new Date(now.getTime() + RETRY_DELAYS_MIN[row.attempts - 1] * 60_000), quietOf(d));
      await prisma.linkedInPost.update({ where: { id: row.id }, data: { nextAttemptAt: due, error: clip(result.error) } });
      log(page, row.campaignId, 'retry', `attempt=${row.attempts} next=${due.toISOString()} image=${image}${kind}`);
      return 'retry';
    }
    await prisma.linkedInPost.update({ where: { id: row.id }, data: { status: 'FAILED', nextAttemptAt: null, error: clip(result.error) } });
    log(page, row.campaignId, 'failed', `attempts=${row.attempts} image=${image}${kind}`);
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

/**
 * Why the worker must not run, or null. Checked for every page the worker handles, Taxscan first: an Academy or Shopscan page is
 * active only with its own two variables valid and borrows the Taxscan token, so once Taxscan itself is sound neither can be the reason.
 */
export function startupProblem(d: Pick<WorkerDeps, 'postFrom' | 'portals'> = {}): string | null {
  const pages = pagesOf(normalizePortals(d.portals ?? portalPages()));
  for (const page of pages) {
    if (!resolvePostFrom(d.postFrom, page)) return `${postFromVarOf(page)} is missing or not a valid ISO time (nothing would be safe to post)`;
  }
  for (const page of pages) if (!pageConfig(page)) return `LINKEDIN_${page.toUpperCase()}_ORG_URN / _ACCESS_TOKEN are not both set`;
  return null;
}

/**
 * How many `posts` CREATE attempts were made today (the IST day of `now`), across ALL pages: the sum of `attempts` over the rows
 * touched today. Nothing new is stamped for it. It counts attempts, not calls (a picture post repeated as a link post is one attempt and
 * two calls), and a row retried across midnight counts all its attempts: the margin below LinkedIn's 100 absorbs both.
 */
export async function postsCreatedToday(now: Date): Promise<number> {
  const { start, end } = istDayBounds(istDay(now));
  const r = await prisma.linkedInPost.aggregate({ _sum: { attempts: true }, where: { updatedAt: { gte: start, lt: end }, attempts: { gte: 1 } } });
  return r._sum.attempts ?? 0;
}

/**
 * A push a person sent RIGHT NOW from the admin: Compose Send now (also as Breaking), Queue Push now, Review Push now. The send path
 * records it without a new column: those four doors set `createdByUserId` and leave `scheduledAt` empty. Everything else is automatic
 * as far as the guard is concerned: the pacer, the morning-backfill clone (`cloneForResend` copies neither field), an RSS capture and a
 * bearer / curl send have no `createdByUserId`; a scheduled Compose send, and a Compose send the night rule deferred to 07:00, keep
 * their `scheduledAt` after the sweeper sends them. Pure; the worker reads both columns only for a held page.
 */
export const isManualImmediatePush = (c: { createdByUserId?: string | null; scheduledAt?: Date | null }): boolean => !!c.createdByUserId && !c.scheduledAt;

export async function runLinkedInTick(d: WorkerDeps = {}): Promise<TickResult> {
  const now = (d.now ?? (() => new Date()))();
  const out: TickResult = { posted: 0, retried: 0, failed: 0, staleClosed: 0, authStopped: false, refused: null };
  await refreshActiveTokens().catch(() => undefined); // the renewed token, if any, is the one in use
  const problem = startupProblem(d);
  if (problem) return { ...out, refused: problem };
  const portals = normalizePortals(d.portals ?? portalPages());
  const pages = pagesOf(portals); // Taxscan first: it is handled first, so a busy Taxscan page only delays the others to a later tick
  // The daily quota guard: today's create attempts across ALL pages, read ONCE, before anything in this tick posts.
  const createsToday = pages.some((p) => pageHeadroom(p) !== null) ? await postsCreatedToday(now) : 0;

  // 1. In-flight rows with no result after 10 minutes: unknown, never re-posted. Only the pages THIS tick handles: a row of a page
  //    it does not post for is not its to judge (in production that is every page; it matters when ticks of different pages overlap).
  const stale = await prisma.linkedInPost.updateMany({
    where: { page: { in: pages }, status: 'PENDING', nextAttemptAt: null, updatedAt: { lt: new Date(now.getTime() - STALE_MS) } },
    data: { status: 'FAILED', error: UNKNOWN_ERROR },
  });
  out.staleClosed = stale.count;

  // MAX_PER_TICK is shared by all pages. `note` counts an outcome and says whether it was a login error.
  let budget = MAX_PER_TICK;
  const note = (r: Attempted): boolean => {
    if (r === 'posted') out.posted += 1;
    else if (r === 'retry') out.retried += 1;
    else if (r === 'failed') out.failed += 1;
    else if (r === 'auth_stop') out.authStopped = true;
    return r === 'auth_stop';
  };

  for (const page of pages) {
    // COMPOSE SKIPS (brief 2026-11-09-compose-skip-pages): a push whose sender unticked THIS page gets a SKIPPED row (reason `compose_skip`)
    // under its OWN push key and is taken out of this page's candidates below. DB only: no call, no budget, and not gated by a login stop.
    const postFrom = resolvePostFrom(d.postFrom, page) as Date; // startupProblem has made sure every page has one
    // null = today's rule only. The read below starts at THIS page's own go-live, so the new rule can never reach back before it, whatever time is set.
    const pushesFrom = resolveAllPushesFrom(d.allPushesFrom, page);
    const pagePortals = portalsOfPage(portals, page);
    const composeSkipped = await composeSkippedPushes(pagePortals, linkedinSkipKey(page), postFrom);
    if (composeSkipped.length > 0) {
      const wanted = skipRows(composeSkipped, pushesFrom);
      const have = new Set((await prisma.linkedInPost.findMany({ where: { page, articleKey: { in: wanted.map((w) => w.key) } }, select: { articleKey: true } })).map((r) => r.articleKey));
      for (const w of wanted) {
        if (have.has(w.key)) continue;
        try {
          await prisma.linkedInPost.create({ data: { page, articleKey: w.key, campaignId: w.campaignId, status: 'SKIPPED', attempts: 0, error: COMPOSE_SKIP } });
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue; // an overlapping tick created it first
          throw err;
        }
      }
    }
    const skippedIds = new Set(composeSkipped.map((c) => c.id));
    // PAUSED (brief 2026-11-09-social-page-alerts-pause): read once per page per tick. A paused page makes no call: rows waiting for a retry
    // are skipped here, every push below gets a SKIPPED `page_paused` row, and the login stop does not gate that (no push may wait for it).
    const paused = (await getPause('linkedin', page)) !== null;
    if (paused) {
      await prisma.linkedInPost.updateMany({ where: { page, status: 'PENDING', nextAttemptAt: { not: null } }, data: { status: 'SKIPPED', nextAttemptAt: null, error: PAGE_PAUSED } });
    }
    if (!paused && isStopped(page)) {
      out.authStopped = true; // "some page is stopped": it never gates ANOTHER page
      continue;
    }
    // A login error (401 / 403) ends THIS page's turn only: the next page is still attempted in the same tick (a shared token will
    // fail it too, and it then stops itself with its own banner and alert), and a stopped page never holds back a later one.
    let stopped = false;
    // LinkedIn's daily limit for THIS page (brief 2026-11-09-small-fixes): while the page is held, a retry waiting for its turn is a push
    // like any other: SKIPPED `org_daily_limit`, no call, never posted later.
    if (isOrgHeld(page, now)) {
      await prisma.linkedInPost.updateMany({ where: { page, status: 'PENDING', nextAttemptAt: { not: null } }, data: { status: 'SKIPPED', nextAttemptAt: null, error: ORG_DAILY_LIMIT } });
    }
    // 2. Retries that are due (never inside quiet hours: they were scheduled out of it, this guards a changed clock).
    if (!paused && !isOrgHeld(page, now) && !isQuietHours(now, quietOf(d).start, quietOf(d).end)) {
      const due = await prisma.linkedInPost.findMany({ where: { page, status: 'PENDING', nextAttemptAt: { lte: now } }, orderBy: { nextAttemptAt: 'asc' }, take: budget });
      for (const r of due) {
        if (budget <= 0 || stopped) break;
        const claimed = await prisma.linkedInPost.updateMany({ where: { id: r.id, status: 'PENDING', nextAttemptAt: { lte: now } }, data: { nextAttemptAt: null, attempts: { increment: 1 } } });
        if (claimed.count !== 1) continue; // another tick got it
        budget -= 1;
        if (note(await attempt({ ...r, nextAttemptAt: null, attempts: r.attempts + 1 }, d, now))) stopped = true;
      }
    }
    if (stopped || budget <= 0) continue;

    // 3. New posts, oldest push first. NO age limit: every SENT push since THIS PAGE's go-live (Taxscan: LINKEDIN_POST_FROM;
    //    Academy: LINKEDIN_ACADEMY_POST_FROM) whose article has no row on THIS page yet is posted, however long ago it was pushed.
    //    That list only grows (~20 a day) and is read every minute, so it is read with `select` of just what the two shared rules
    //    need (isPublicArticleCampaign: url + target; articleKey: id + url), never whole rows; `attempt` loads the one full campaign
    //    it posts.
    //    EVERY PUSH POSTS (brief 2026-11-04-academy-store-posts): a page with an all-pushes time splits the pushes at that time.
    //    A push BEFORE it follows today's rule above for good (one post per article, the `earlier` look-back), so setting the time
    //    never floods the page with the past, and a pre-time article that has no row yet still gets its one post. A push AT or
    //    AFTER it follows the new rule: every qualifying push (article, course, product) is its own candidate, keyed
    //    `push:<campaign id>:<send time ms>`, repeats included. Both kinds are merged by the time of the push, oldest first.
    // The daily quota guard (see the header): is this page held by today's count? Decided here because a held page also needs to know
    // WHO sent each push (`createdByUserId`, `scheduledAt`), so a manual immediate push is not held; every other page reads exactly as before.
    const headroom = pageHeadroom(page);
    const held = headroom !== null && createsToday >= headroom;
    // The read stays `select`-narrow: only what the rules need, and `lastSentAt` too ONLY while the all-pushes time is set (it is what
    // splits the pushes at that time and merges the two rules by time). With the time unset the read is exactly today's.
    const campaigns: { id: string; url: string; target: unknown; lastSentAt?: Date | null; createdByUserId?: string | null; scheduledAt?: Date | null }[] = await prisma.campaign.findMany({
      where: { portal: { in: pagePortals }, status: 'SENT', lastSentAt: { gte: postFrom } },
      select: {
        id: true,
        url: true,
        target: true,
        ...(pushesFrom ? { lastSentAt: true } : {}),
        ...(held ? { createdByUserId: true, scheduledAt: true } : {}),
      },
      orderBy: [{ lastSentAt: 'asc' }, { id: 'asc' }],
    });
    const manualIds = new Set<string>(); // held page only: the pushes a person sent right now (never held)
    const firstOf = new Map<string, string>(); // post key → the id of the push it is posted for; both rules insert as the pushes come, oldest first
    // TODAY'S-RULE candidates (an article's oldest push) and, for each, the id of EVERY push of that article in this read: the guard
    // below needs them all (a repeat of an article can have a `push:` row while its oldest push does not).
    const idsOfArticle = new Map<string, string[]>();
    for (const c of campaigns) {
      if (skippedIds.has(c.id)) continue; // unticked on Compose for this page: its SKIPPED row is written above; it is nobody's candidate
      if (held && isManualImmediatePush(c)) manualIds.add(c.id);
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
      // A re-push or the morning-backfill clone of an article first pushed BEFORE go-live (looked up to 14 days before it) is
      // not new: never post it, at any age. (Only today's rule looks back; the new rule posts every push.)
      const earlier = await prisma.campaign.findMany({
        where: { portal: { in: pagePortals }, status: 'SENT', lastSentAt: { gte: new Date(postFrom.getTime() - EARLIER_LOOKBACK_MS), lt: postFrom } },
        select: { id: true, url: true },
      });
      for (const c of earlier) firstOf.delete(articleKey(c));
    }
    if (firstOf.size === 0) continue;
    // Which of them already have a row (POSTED, SKIPPED, FAILED or in flight)? The page's keys in ONE indexed read: an
    // `IN (…)` of every candidate would grow with the list above.
    const have = new Set((await prisma.linkedInPost.findMany({ where: { page }, select: { articleKey: true } })).map((r) => r.articleKey));
    // Follow-up 1: an article ANY of whose pushes already has a `push:` row on this page was handled by the new rule, so today's rule must
    // not post it again. That is what happens when the all-pushes time is removed or moved later: without this, every article pushed
    // while the new rule was on would be posted once more. The campaign id is in the key, so the `have` read above supplies the ids,
    // and the article keys come from the pushes already read: no extra query. Any status counts (POSTED, FAILED, SKIPPED, in flight).
    const handled = pushedCampaignIds(have);
    if (handled.size > 0) for (const [k, ids] of idsOfArticle) if (ids.some((id) => handled.has(id))) firstOf.delete(k);
    // The daily quota guard: a held page (Academy, Shopscan) makes NO call for an automatic push. Each one it would have posted gets a
    // SKIPPED row instead, reason `quota_headroom`: never retried, never posted later. That costs no budget, and ALL of its automatic
    // candidates are skipped in this tick, so none is left to post after midnight when the count resets (a late post of an old push is
    // worse than none). A MANUAL IMMEDIATE push (`manualIds`) is not held: it posts below like on any page, whatever the count.
    let heldCount = 0;
    // Oldest first across both rules: the read orders the pushes by send time (then id) and each rule inserts as it goes.
    for (const [key, campaignId] of firstOf) {
      if (have.has(key)) continue;
      // PAUSED, or held by LinkedIn's own daily limit (set earlier today, or by the attempt just made in this loop): NO call, a SKIPPED row,
      // for every push, a manual immediate one included (a paused page is quiet on purpose; LinkedIn would refuse the other too).
      if (paused || isOrgHeld(page, now)) {
        try {
          await prisma.linkedInPost.create({ data: { page, articleKey: key, campaignId, status: 'SKIPPED', attempts: 0, error: paused ? PAGE_PAUSED : ORG_DAILY_LIMIT } });
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue; // an overlapping tick created it first
          throw err;
        }
        continue;
      }
      if (held && !manualIds.has(campaignId)) {
        try {
          await prisma.linkedInPost.create({ data: { page, articleKey: key, campaignId, status: 'SKIPPED', attempts: 0, error: QUOTA_HEADROOM } });
          heldCount += 1;
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue; // an overlapping tick created it first
          throw err;
        }
        continue;
      }
      if (budget <= 0 || stopped) break;
      // No row: this article / push was never handled (an earlier push of it that was handled would have left its row).
      let row: LinkedInPost;
      try {
        row = await prisma.linkedInPost.create({ data: { page, articleKey: key, campaignId, status: 'PENDING', attempts: 1 } });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue; // an overlapping tick created it first
        throw err;
      }
      budget -= 1;
      if (note(await attempt(row, d, now))) stopped = true;
    }
    // ONE line per held page per IST day (the first tick that skipped something): how many it skipped in that tick.
    if (heldCount > 0 && holdLoggedDay.get(page) !== istDay(now)) {
      holdLoggedDay.set(page, istDay(now));
      // eslint-disable-next-line no-console
      console.log(`[linkedin] page=${page} ${QUOTA_HEADROOM} skipped=${heldCount}`);
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
  // The Academy page's ONE boot line (nothing else is logged about it while it is off): on with its own go-live, or off and why
  // (fixed words naming the variables, never their values).
  const academy = env.linkedin.sharedPages[PAGE_ACADEMY];
  // eslint-disable-next-line no-console
  console.log(academy ? `[linkedin] academy page on (post from ${academy.postFrom.toISOString()})` : `[linkedin] academy page off: ${parseLinkedInAcademyEnv(process.env).off ?? 'not configured'}`);
  // The Shopscan page's ONE boot line, worded like Academy's: on with its go-live (it posts every push from then), or off and why.
  const shopscan = env.linkedin.sharedPages[PAGE_SHOPSCAN];
  // eslint-disable-next-line no-console
  console.log(shopscan ? `[linkedin] shopscan page on (post from ${shopscan.postFrom.toISOString()}; every push from then)` : `[linkedin] shopscan page off: ${parseLinkedInShopscanEnv(process.env).off ?? 'not configured'}`);
  // The daily quota guard: which active pages hold themselves, at what number (names capitalised: the page lines above are the
  // lowercase ones). An invalid number says so and uses the default, active page or not (it was typed for a reason).
  const guarded = ([PAGE_ACADEMY, PAGE_SHOPSCAN] as const).filter((p) => env.linkedin.sharedPages[p]);
  if (guarded.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`[linkedin] daily quota guard: ${guarded.map((p) => `${p[0].toUpperCase()}${p.slice(1)} held at ${pageHeadroom(p)}`).join(', ')} posts a day, counted across all pages (Taxscan never held)`);
  }
  for (const p of [PAGE_ACADEMY, PAGE_SHOPSCAN] as const) {
    const bad = parseLinkedInHeadroom(process.env, p).note;
    // eslint-disable-next-line no-console
    if (bad) console.log(`[linkedin] quota guard: ${bad}`);
  }
  // "Every push posts" (brief 2026-11-04-academy-store-posts): ONE line per page, on with its time, or off (the page stays on today's
  // rule, one post per article) and why, in fixed words naming the variable, never its value. The line names the page through its
  // variable. The Academy page needs both its page and its own variable.
  for (const [page, name] of [
    [PAGE_TAXSCAN, ALL_PUSHES_FROM_VARS.linkedinTaxscan],
    [PAGE_ACADEMY, ALL_PUSHES_FROM_VARS.linkedinAcademy],
  ] as const) {
    const from = pageAllPushesFrom(page);
    const why = page === PAGE_ACADEMY && !academyActive() ? `${name} is ignored while the Academy page is off` : parseAllPushesFrom(process.env, name).off ?? `${name} is not set`;
    // eslint-disable-next-line no-console
    console.log(from ? `[linkedin] all pushes on for ${name} (from ${from.toISOString()})` : `[linkedin] all pushes off: ${why} (today's rule: one post per article)`);
  }
}
