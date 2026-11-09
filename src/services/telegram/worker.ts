import cron from 'node-cron';
import { Prisma, type TelegramPost } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { env, type TelegramConfig } from '../../lib/env';
import { safeErrorLog } from '../../lib/httpErrors';
import { defaultEmailSender, isEmailConfigured, type EmailSender } from '../../lib/email';
import { isQuietHours } from '../../lib/quietHours';
import { isAllPushesCampaign, pushKey } from '../social/allPushes';
import { istDay } from '../whatsapp/queue';
import { pushOutOfQuietHours } from '../linkedin/worker';
import { fetchCmsArticle, type CmsArticle } from '../linkedin/post';
import { isAllowedImageUrl } from '../linkedin/image';
import { fetchArticlePage } from '../digest/articleImage';
import { fetchStorePage, type StorePageResult } from '../social/storePage';
import { campaignPicture, socialImageUrl } from '../social/picture';
import { COMPOSE_SKIP, telegramSkipKey } from '../social/pages';
import { composeSkippedPushes, skipRows } from '../social/composeSkip';
import { PAGE_PAUSED, getPause } from '../social/pause';
import { alertIfNeeded } from '../social/pageAlerts';
import { callTelegram, messageBody, photoBody, RETRY_AFTER_CAP_SEC, type TelegramFailure, type TelegramRequest, type TelegramResult } from './client';
import { PORTAL_TO_PAGE, telegramConfig } from './pages';
import { buildTelegramPost, captionOf, textOf, type TgPostPayload } from './post';

/**
 * The Telegram channel worker (brief 2026-11-09-telegram-channel, docs/TELEGRAM_POSTING.md). It mirrors the Facebook worker and READS
 * Campaign rows only (it never touches the send path).
 *
 * EVERY PUSH POSTS from TELEGRAM_POST_FROM (which is also the every-push time): articles, courses, products and any other allowed page
 * (the last from SOCIAL_ANY_LINK_FROM), one post per push, exact repeats included, never a test-segment-only send, never anything pushed
 * before go-live. The row key is the push's own (`push:<campaign id>:<send time ms>`), so a repeat is another row and a skip row can
 * never block another push. WHO sent the push never matters, and the channel's other posts (from another source) are not looked at.
 *
 *  - At most MAX_PER_TICK attempts per 1-minute tick, due retries first, then new pushes oldest first; NO age limit (only go-live is absolute).
 *    There is no gap or daily cap: Telegram's own limits are far above ~20 posts a day, and a 429 is honoured (`retry_after`).
 *  - 429 / 5xx / network: +1, +5, +15 min (a 429 never sooner than Telegram's `retry_after`), then FAILED. Retries never fall in quiet hours.
 *  - A CHANNEL STOP (401 token revoked, 403 bot removed or not an admin, 400 chat not found / not enough rights): persisted, so it survives a
 *    restart; no further attempts; ONE alert email per IST day; the screen shows a banner; only an ADMIN's Resume starts posting again. The
 *    row that hit it is kept as a retry that is due as soon as posting resumes (nothing is lost, nothing is counted as an attempt).
 *  - Any other 4xx: FAILED, no retry. A picture Telegram refuses (400 on `sendPhoto`) is repeated ONCE as a text post (`image=dropped`).
 * The `TelegramPost` row is created BEFORE the call; its unique (page, pushKey) makes a second tick a no-op. An attempt that dies without a
 * verdict is FAILED "unknown_outcome": the call may have gone out, so it is never re-posted automatically.
 *
 * PAUSED CHANNEL (brief 2026-11-09-social-page-alerts-pause). An ADMIN can pause the channel from its screen (`social:pause:telegram:<page>`):
 * while paused every push gets its row SKIPPED `page_paused` with NO API call (a manual immediate push included), rows waiting for a retry are
 * skipped too, nothing is ever posted later, and resume posts from the next push. It is checked BEFORE the channel stop, so a stop that
 * clears later never posts what a pause skipped. After a failed attempt the page-status helper decides about the alert email (`failing`,
 * once per IST day): see `services/social/pageAlerts.ts`.
 *
 * THE BOT TOKEN is in the Bot API URL path. It is never logged, stored in a column, returned by an API, put in an audit entry or an email:
 * the client returns fixed codes only, and every `console.*` of an error goes through `safeErrorLog`.
 */

export const MAX_PER_TICK = 3;
export const STALE_MS = 10 * 60_000;
/** Retry delays in minutes after attempt 1, 2, 3; a 4th failure is FAILED. A 429 waits at least Telegram's own `retry_after` too. */
export const RETRY_DELAYS_MIN = [1, 5, 15] as const;
export const UNKNOWN_ERROR = 'unknown_outcome';
export { COMPOSE_SKIP };

export type WorkerDeps = {
  now?: () => Date;
  /** The Bot API call (tests mock it; nothing in a test may reach api.telegram.org). */
  call?: (r: TelegramRequest) => Promise<TelegramResult>;
  fetchCms?: (slug: string) => Promise<CmsArticle | null>;
  /** An article page's picture (og:image on documents.taxscan.in). */
  fetchArticle?: (url: string) => Promise<{ image: string | null }>;
  /** A course / product / other page's og tags. */
  fetchStore?: (url: string) => Promise<StorePageResult>;
  /** SOCIAL_PICTURE_ENABLED override (tests). */
  socialPicture?: boolean;
  emailSender?: EmailSender;
  isEmailConfigured?: () => boolean;
  /** Active ADMIN emails; default reads the User table. */
  recipients?: () => Promise<string[]>;
  /** Campaign.portal → page. Default PORTAL_TO_PAGE. */
  portals?: Readonly<Record<string, string>>;
  /** The channel's config; undefined = the environment's. null = not configured. */
  config?: TelegramConfig | null;
  quiet?: { start: string; end: string };
};

const configOf = (d: WorkerDeps): TelegramConfig | null => (d.config === undefined ? telegramConfig() : d.config);

/* ------------------------------------------------------------------ */
/* The channel stop (persisted) and its once-a-day alert               */
/* ------------------------------------------------------------------ */

export const stopKey = (page: string): string => `telegram:stop:${page}`;
export const alertKey = (page: string): string => `telegram:alert:${page}`;

type StopState = { stoppedAt: string; status: number | null; error: string };
type AlertState = { day: string };

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

/** For the screen's red banner: Telegram refused the channel (bot removed, not an admin, token revoked) and posting is stopped. */
export async function channelStop(page: string): Promise<{ since: string; status: number | null; error: string } | null> {
  const s = await readSetting<StopState>(stopKey(page));
  return s ? { since: s.stoppedAt, status: s.status, error: s.error } : null;
}
/** ADMIN Resume: clears the stop (the route audits it). The once-a-day alert memory is NOT cleared. True when there was a stop. */
export async function resumeChannel(page: string): Promise<boolean> {
  const r = await prisma.digestSetting.deleteMany({ where: { key: stopKey(page) } });
  return r.count > 0;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const quietOf = (d: WorkerDeps) => d.quiet ?? { start: env.send.quietStart, end: env.send.quietEnd };
const log = (page: string, campaignId: string, outcome: string, extra = ''): void => {
  // eslint-disable-next-line no-console
  console.log(`[telegram] page=${page} campaign=${campaignId} outcome=${outcome}${extra ? ` ${extra}` : ''}`);
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
    console.error('[telegram] alert email failed', safeErrorLog(err));
  }
}

/** The channel was refused: persist the stop, and email the ADMINs once per IST day (a Resume followed by a new stop the same day is silent). */
async function handleStop(page: string, r: TelegramFailure, d: WorkerDeps, now: Date): Promise<void> {
  const prev = await readSetting<StopState>(stopKey(page));
  await writeSetting(stopKey(page), { stoppedAt: prev?.stoppedAt ?? now.toISOString(), status: r.status, error: r.error } satisfies StopState);
  const today = istDay(now);
  if ((await readSetting<AlertState>(alertKey(page)))?.day === today) return;
  await writeSetting(alertKey(page), { day: today } satisfies AlertState);
  await mailAdmins(
    `Telegram posting stopped — the ${page} channel refused a post`,
    `Taxscan Push could not post to the ${page} Telegram channel: Telegram answered ${r.error}. That usually means the bot was removed from the channel, ` +
      `is no longer an admin with the Post messages right, or its token was revoked.\n\n` +
      `No further posts are attempted until an ADMIN presses Resume on the Telegram screen in the admin (fix the bot first). ` +
      `Pushes made meanwhile are kept: they post once posting resumes.\n\n(${now.toISOString()})`,
    d,
  );
}

/** The picture for a post, or null (fail-open: any problem here means a text post). Compose picture, else the cover, else the page's og:image. */
async function pictureFor(campaign: { url: string; socialImageId?: string | null }, post: TgPostPayload, d: WorkerDeps): Promise<string | null> {
  const composed = await campaignPicture(campaign, d.socialPicture);
  if (composed) return socialImageUrl(composed);
  if (post.coverImageUrl && isAllowedImageUrl(post.coverImageUrl)) return post.coverImageUrl;
  try {
    const url = campaign.url.trim();
    if (post.kind === 'article') {
      const page = await (d.fetchArticle ?? ((u: string) => fetchArticlePage(u)))(url);
      return page.image && isAllowedImageUrl(page.image) ? page.image : null;
    }
    const page = await (d.fetchStore ?? ((u: string) => fetchStorePage(u)))(url);
    return page.ok && page.tags.imageUrl && isAllowedImageUrl(page.tags.imageUrl) ? page.tags.imageUrl : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* One attempt                                                         */
/* ------------------------------------------------------------------ */

type Attempted = 'posted' | 'retry' | 'failed' | 'stop';

/** ONE attempt for a row already claimed (PENDING, nextAttemptAt null, attempts counted). Writes the outcome, then lets the page-status helper decide about the alert. Never throws. */
async function attempt(row: TelegramPost, d: WorkerDeps, now: Date): Promise<Attempted> {
  const r = await attemptOnce(row, d, now);
  if (r === 'failed') await alertIfNeeded('telegram', row.page, now, d);
  return r;
}

async function attemptOnce(row: TelegramPost, d: WorkerDeps, now: Date): Promise<Attempted> {
  const page = row.page;
  const fail = (error: string) => prisma.telegramPost.update({ where: { id: row.id }, data: { status: 'FAILED', error, nextAttemptAt: null } });
  try {
    const cfg = configOf(d);
    const campaign = await prisma.campaign.findUnique({ where: { id: row.campaignId } });
    if (!cfg || !campaign) {
      await fail(cfg ? 'campaign_not_found' : 'not_configured');
      log(page, row.campaignId, 'failed', 'reason=config');
      return 'failed';
    }
    const post = await buildTelegramPost(campaign, d.fetchCms ?? ((s) => fetchCmsArticle(s)));
    if (!post) {
      await fail('link_not_allowed');
      log(page, row.campaignId, 'failed', 'reason=link');
      return 'failed';
    }
    const call = d.call ?? ((r: TelegramRequest) => callTelegram(r));
    const photo = await pictureFor(campaign, post, d);
    const sendText = () => call({ method: 'sendMessage', token: cfg.token, body: messageBody(cfg.channel, textOf(post), post.link) });
    let image: 'ok' | 'none' | 'dropped' = photo ? 'ok' : 'none';
    let result = photo ? await call({ method: 'sendPhoto', token: cfg.token, body: photoBody(cfg.channel, photo, captionOf(post)) }) : await sendText();
    // Telegram refused the picture (a 400 on the photo that is not a channel problem): ONE fallback to a text post with the preview on.
    if (photo && result.kind === 'failed' && result.status === 400) {
      image = 'dropped';
      result = await sendText();
    }
    if (result.kind === 'posted') {
      await prisma.telegramPost.update({
        where: { id: row.id },
        data: { status: 'POSTED', messageId: result.messageId, postedAt: now, error: result.messageId === null ? 'no_message_id' : image === 'dropped' ? 'image_dropped' : null, nextAttemptAt: null },
      });
      log(page, row.campaignId, 'posted', `image=${image} kind=${post.kind}`);
      return 'posted';
    }
    if (result.kind === 'stop') {
      // not a real attempt: back to a retry that is due as soon as posting resumes
      await prisma.telegramPost.update({ where: { id: row.id }, data: { attempts: Math.max(0, row.attempts - 1), nextAttemptAt: now, error: result.error } });
      await handleStop(page, result, d, now);
      log(page, row.campaignId, 'stop', `status=${result.status ?? ''}`);
      return 'stop';
    }
    if ((result.kind === 'rate' || result.kind === 'transient') && row.attempts <= RETRY_DELAYS_MIN.length) {
      const usual = RETRY_DELAYS_MIN[row.attempts - 1] * 60_000;
      const wait = result.kind === 'rate' ? Math.max(usual, Math.min(result.retryAfterSec ?? 0, RETRY_AFTER_CAP_SEC) * 1000) : usual;
      const due = pushOutOfQuietHours(new Date(now.getTime() + wait), quietOf(d));
      await prisma.telegramPost.update({ where: { id: row.id }, data: { nextAttemptAt: due, error: result.error } });
      log(page, row.campaignId, 'retry', `class=${result.kind} attempt=${row.attempts} next=${due.toISOString()}`);
      return 'retry';
    }
    await fail(result.error);
    log(page, row.campaignId, 'failed', `image=${image} attempts=${row.attempts}`);
    return 'failed';
  } catch (err) {
    console.error('[telegram] attempt failed', safeErrorLog(err));
    // the outcome is unknown (the call may have gone out): never re-post automatically
    await prisma.telegramPost.update({ where: { id: row.id }, data: { status: 'FAILED', nextAttemptAt: null, error: UNKNOWN_ERROR } }).catch(() => undefined);
    return 'failed';
  }
}

/* ------------------------------------------------------------------ */
/* The tick                                                            */
/* ------------------------------------------------------------------ */

export type TickResult = { posted: number; retried: number; failed: number; staleClosed: number; stopped: boolean; refused: string | null };

export async function runTelegramTick(d: WorkerDeps = {}): Promise<TickResult> {
  const now = (d.now ?? (() => new Date()))();
  const out: TickResult = { posted: 0, retried: 0, failed: 0, staleClosed: 0, stopped: false, refused: null };
  const cfg = configOf(d);
  if (!cfg) return { ...out, refused: 'the Telegram channel is not configured' };
  const portals = d.portals ?? PORTAL_TO_PAGE;
  const pages = [...new Set(Object.values(portals))];

  // 1. In-flight rows with no result after 10 minutes: unknown, never re-posted.
  const stale = await prisma.telegramPost.updateMany({
    where: { page: { in: pages }, status: 'PENDING', nextAttemptAt: null, updatedAt: { lt: new Date(now.getTime() - STALE_MS) } },
    data: { status: 'FAILED', error: UNKNOWN_ERROR },
  });
  out.staleClosed = stale.count;

  for (const page of pages) {
    let budget = MAX_PER_TICK;
    let pageStopped = false; // THIS channel hit a stop in this tick; another page's loop is not affected
    const note = (r: Attempted): void => {
      budget -= 1;
      if (r === 'posted') out.posted += 1;
      else if (r === 'retry') out.retried += 1;
      else if (r === 'failed') out.failed += 1;
      else {
        pageStopped = true;
        out.stopped = true;
      }
    };
    const pagePortals = Object.keys(portals).filter((p) => portals[p] === page);

    // COMPOSE SKIPS (brief 2026-11-09-compose-skip-pages): a push whose sender unticked THIS channel gets a SKIPPED row (reason `compose_skip`)
    // under its OWN push key and is nobody's candidate below. DB only, no call, not gated by the stop: the row exists at once.
    const composeSkipped = await composeSkippedPushes(pagePortals, telegramSkipKey(page), cfg.postFrom);
    if (composeSkipped.length > 0) {
      const wanted = skipRows(composeSkipped, cfg.postFrom);
      const have = new Set((await prisma.telegramPost.findMany({ where: { page, pushKey: { in: wanted.map((w) => w.key) } }, select: { pushKey: true } })).map((r) => r.pushKey));
      for (const w of wanted) {
        if (have.has(w.key)) continue;
        try {
          await prisma.telegramPost.create({ data: { page, pushKey: w.key, campaignId: w.campaignId, status: 'SKIPPED', attempts: 0, error: COMPOSE_SKIP } });
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue; // an overlapping tick created it first
          throw err;
        }
      }
    }
    const skippedIds = new Set(composeSkipped.map((c) => c.id));
    // PAUSED (brief 2026-11-09-social-page-alerts-pause): read once per page per tick. A paused channel makes no call: rows waiting for a retry
    // are skipped, every push below gets a SKIPPED `page_paused` row, and the channel stop does not gate that (no push may wait for it).
    const paused = (await getPause('telegram', page)) !== null;
    if (paused) {
      await prisma.telegramPost.updateMany({ where: { page, status: 'PENDING', nextAttemptAt: { not: null } }, data: { status: 'SKIPPED', nextAttemptAt: null, error: PAGE_PAUSED } });
    }
    if (!paused && (await channelStop(page))) {
      out.stopped = true;
      continue;
    }

    // 2. Retries that are due (never inside quiet hours: they were scheduled out of it, this guards a changed clock).
    if (!paused && !isQuietHours(now, quietOf(d).start, quietOf(d).end)) {
      const due = await prisma.telegramPost.findMany({ where: { page, status: 'PENDING', nextAttemptAt: { lte: now } }, orderBy: { nextAttemptAt: 'asc' }, take: budget });
      for (const r of due) {
        if (budget <= 0 || pageStopped) break;
        const claimed = await prisma.telegramPost.updateMany({ where: { id: r.id, status: 'PENDING', nextAttemptAt: { lte: now } }, data: { nextAttemptAt: null, attempts: { increment: 1 } } });
        if (claimed.count !== 1) continue; // another tick got it
        note(await attempt({ ...r, nextAttemptAt: null, attempts: r.attempts + 1 }, d, now));
      }
    }
    if (!paused && (budget <= 0 || pageStopped)) continue;

    // 3. New posts, oldest push first. NO age limit: the oldest SENT push since go-live that has no row yet posts, however long ago it was
    //    pushed. The list only grows (~20 a day) and is read every minute with `select` of just what the shared rule needs.
    const campaigns = await prisma.campaign.findMany({
      where: { portal: { in: pagePortals }, status: 'SENT', lastSentAt: { gte: cfg.postFrom } },
      select: { id: true, url: true, target: true, lastSentAt: true },
      orderBy: [{ lastSentAt: 'asc' }, { id: 'asc' }],
    });
    const have = new Set((await prisma.telegramPost.findMany({ where: { page }, select: { pushKey: true } })).map((r) => r.pushKey));
    for (const c of campaigns) {
      if (!paused && (budget <= 0 || pageStopped)) break;
      if (!c.lastSentAt || skippedIds.has(c.id) || !isAllPushesCampaign(c)) continue;
      const key = pushKey({ id: c.id, lastSentAt: c.lastSentAt });
      if (have.has(key)) continue;
      if (paused) {
        // Paused: NO call, a SKIPPED row, never posted later (every push, a manual immediate one included).
        try {
          await prisma.telegramPost.create({ data: { page, pushKey: key, campaignId: c.id, status: 'SKIPPED', attempts: 0, error: PAGE_PAUSED } });
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue; // an overlapping tick created it first
          throw err;
        }
        continue;
      }
      let row: TelegramPost;
      try {
        row = await prisma.telegramPost.create({ data: { page, pushKey: key, campaignId: c.id, status: 'PENDING', attempts: 1 } });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue; // an overlapping tick created it first
        throw err;
      }
      note(await attempt(row, d, now));
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Manual: Retry / Skip from the screen                                */
/* ------------------------------------------------------------------ */

/** Retry one FAILED row now: one post, then answer. Refused while the channel is stopped. */
export async function retryNow(
  id: string,
  d: WorkerDeps = {},
): Promise<{ ok: true; status: 'POSTED' | 'FAILED' | 'PENDING' } | { ok: false; reason: 'not_found' | 'not_failed' | 'not_configured' | 'stopped' }> {
  const now = (d.now ?? (() => new Date()))();
  const row = await prisma.telegramPost.findUnique({ where: { id } });
  if (!row) return { ok: false, reason: 'not_found' };
  if (await channelStop(row.page)) return { ok: false, reason: 'stopped' };
  if (!configOf(d)) return { ok: false, reason: 'not_configured' };
  const claimed = await prisma.telegramPost.updateMany({ where: { id, status: 'FAILED' }, data: { status: 'PENDING', nextAttemptAt: null, attempts: 1, error: null } });
  if (claimed.count !== 1) return { ok: false, reason: 'not_failed' };
  await attempt({ ...row, status: 'PENDING', nextAttemptAt: null, attempts: 1, error: null }, d, now);
  const after = await prisma.telegramPost.findUnique({ where: { id }, select: { status: true } });
  return { ok: true, status: after?.status === 'POSTED' ? 'POSTED' : after?.status === 'FAILED' ? 'FAILED' : 'PENDING' };
}

/** Skip a FAILED row, or one waiting for a retry. */
export async function skipPost(id: string): Promise<boolean> {
  const r = await prisma.telegramPost.updateMany({ where: { id, OR: [{ status: 'FAILED' }, { status: 'PENDING', nextAttemptAt: { not: null } }] }, data: { status: 'SKIPPED', nextAttemptAt: null } });
  return r.count === 1;
}

/* ------------------------------------------------------------------ */
/* Cron                                                                */
/* ------------------------------------------------------------------ */

let ticking = false;

/** Started like the other crons, only when the flag is on AND all four variables are valid. Otherwise one boot line, never a refusal to start. */
export function startTelegramWorker(): void {
  if (!env.telegram.enabled) {
    // eslint-disable-next-line no-console
    console.log('[telegram] disabled (set TELEGRAM_POSTING_ENABLED=true to start)');
    return;
  }
  const cfg = telegramConfig();
  if (!cfg) {
    // eslint-disable-next-line no-console
    console.log(`[telegram] not active, no posts: ${env.telegram.off ?? 'the configuration is incomplete'}`);
    return;
  }
  cron.schedule('* * * * *', async () => {
    if (ticking) return;
    ticking = true;
    try {
      await runTelegramTick();
    } catch (err) {
      console.error('[telegram] tick failed', safeErrorLog(err, { stack: true }));
    } finally {
      ticking = false;
    }
  });
  // eslint-disable-next-line no-console
  console.log(`[telegram] worker started (every push from ${cfg.postFrom.toISOString()})`);
}
