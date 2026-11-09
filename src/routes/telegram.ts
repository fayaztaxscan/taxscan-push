import { Router } from 'express';
import { requireBearerOrUser, requireUser } from '../lib/auth';
import { prisma } from '../lib/prisma';
import { recordAudit } from '../lib/audit';
import { requestClientIp } from '../lib/clientIp';
import { safeErrorLog } from '../lib/httpErrors';
import { isAllPushesCampaign, pushKey } from '../services/social/allPushes';
import { dayProblem, istDay, istDayBounds, istTime, MAX_DAYS_BACK } from '../services/whatsapp/queue';
import { PAGE_TAXSCAN, PORTAL_TO_PAGE, messageUrlOf, telegramActive, telegramConfig } from '../services/telegram/pages';
import { checkTelegram } from '../services/telegram/client';
import { COMPOSE_SKIP, UNKNOWN_ERROR, channelStop, resumeChannel, retryNow, skipPost, type WorkerDeps } from '../services/telegram/worker';
import { isComposeSkipped, telegramSkipKey } from '../services/social/pages';
import type { FetchLike } from '../services/linkedin/post';

/**
 * Telegram channel screen API (brief 2026-11-09-telegram-channel). ADMIN or PUBLISHER (or the bearer); Check connection and Resume are
 * ADMIN only. Behind the channel being ACTIVE (flag on and all four variables valid): otherwise 404 on every endpoint, before auth. The
 * request path reads Postgres only, except Retry (ONE Bot API post) and Check connection (ONE `getChat`).
 *
 *   GET  /api/telegram/posts?date=YYYY-MM-DD    IST day, default today, up to 14 days back
 *   POST /api/telegram/posts/:id/retry          a FAILED row: post it now (409 `stopped` while the channel is stopped)
 *   POST /api/telegram/posts/:id/skip           a FAILED row, or one waiting for a retry
 *   POST /api/telegram/check                    ADMIN: "Connected to channel: <title>" or the error class; posts nothing
 *   POST /api/telegram/resume                   ADMIN: clears a channel stop (audited)
 *
 * EVERY PUSH is its own row (a repeat is another row, with its own Retry and Skip). The reply never holds the bot token; the channel's
 * public name (`@taxscan_in`) is shown so staff can see where posts go.
 */
export type TelegramRouterOptions = {
  enabled?: () => boolean;
  clock?: () => Date;
  portals?: () => Readonly<Record<string, string>>;
  worker?: WorkerDeps;
  /** The Bot API fetch used by Check connection (tests inject a fake). */
  fetch?: FetchLike;
};

const STAFF = requireBearerOrUser(['ADMIN', 'PUBLISHER']);
const ADMIN = requireUser(['ADMIN']);

export type ScreenStatus = 'WAITING' | 'RETRYING' | 'POSTED' | 'FAILED' | 'SKIPPED' | 'NOT_POSTED';

export function createTelegramRouter(o: TelegramRouterOptions = {}): Router {
  const router = Router();
  const enabled = o.enabled ?? telegramActive;
  const nowOf = o.clock ?? (() => new Date());
  const portalsOf = o.portals ?? (() => PORTAL_TO_PAGE);
  const pageOf = (): string => Object.values(portalsOf())[0] ?? PAGE_TAXSCAN;
  const configOf = () => (o.worker?.config === undefined ? telegramConfig(pageOf()) : o.worker.config);

  router.use((_req, res, next) => (enabled() ? next() : void res.status(404).json({ error: 'not_found' })));

  router.get('/posts', STAFF, async (req, res) => {
    try {
      const now = nowOf();
      const day = typeof req.query.date === 'string' && req.query.date !== '' ? req.query.date : istDay(now);
      const problem = dayProblem(day, now);
      if (problem) return res.status(400).json({ error: 'invalid_date', message: problem });
      const cfg = configOf();
      const { start, end } = istDayBounds(day);
      const sent = await prisma.campaign.findMany({
        where: { portal: { in: Object.keys(portalsOf()) }, status: 'SENT', lastSentAt: { gte: start, lt: end } },
        select: { id: true, title: true, url: true, target: true, lastSentAt: true, socialSkip: true },
        orderBy: [{ lastSentAt: 'asc' }, { id: 'asc' }],
      });
      const skipKey = telegramSkipKey(pageOf());
      // Every push the channel's rule covers is a row: a test-segment-only send, a link that is not allowed, or another page before
      // SOCIAL_ANY_LINK_FROM is not (it never posts, so there is nothing to wait for).
      const pushes = sent.filter((c) => c.lastSentAt && isAllPushesCampaign(c));
      const keys = pushes.map((c) => pushKey({ id: c.id, lastSentAt: c.lastSentAt! }));
      const posts = keys.length ? await prisma.telegramPost.findMany({ where: { page: pageOf(), pushKey: { in: keys } } }) : [];
      const byKey = new Map(posts.map((p) => [p.pushKey, p]));
      const rows = pushes.map((c) => {
        const p = byKey.get(pushKey({ id: c.id, lastSentAt: c.lastSentAt! }));
        const afterGoLive = !!cfg && c.lastSentAt! >= cfg.postFrom;
        // An unticked Compose push is skipped whether or not the worker has written its row yet (and only after go-live: before it nothing posts).
        const composeSkipped = afterGoLive && isComposeSkipped(c, skipKey);
        let status: ScreenStatus;
        if (composeSkipped) status = 'SKIPPED';
        else if (p) status = p.status === 'PENDING' ? (p.nextAttemptAt ? 'RETRYING' : 'WAITING') : (p.status as ScreenStatus);
        else status = afterGoLive ? 'WAITING' : 'NOT_POSTED';
        return {
          id: p?.id ?? null,
          campaignId: c.id,
          pushedAt: c.lastSentAt!.toISOString(),
          pushedTime: istTime(c.lastSentAt!),
          headline: c.title,
          status,
          error: p && (p.status === 'FAILED' || p.status === 'PENDING') ? p.error : null,
          attempts: p?.attempts ?? 0,
          nextAttemptAt: p?.nextAttemptAt ? p.nextAttemptAt.toISOString() : null,
          nextAttemptTime: p?.nextAttemptAt ? istTime(p.nextAttemptAt) : null,
          postedAt: p?.postedAt ? p.postedAt.toISOString() : null,
          postUrl: p?.status === 'POSTED' && p.messageId !== null && cfg ? messageUrlOf(cfg.channel, p.messageId) : null,
          /** Retry on this row needs "check the channel first" (the outcome is unknown). */
          unknownOutcome: p?.status === 'FAILED' && p.error === UNKNOWN_ERROR,
          // `compose_skip`: the sender unticked this channel on Compose for this push. Present only on such a row.
          ...(composeSkipped || (p?.status === 'SKIPPED' && p.error === COMPOSE_SKIP) ? { skipReason: COMPOSE_SKIP } : {}),
        };
      });
      const n = (s: ScreenStatus) => rows.filter((r) => r.status === s).length;
      return res.json({
        date: day,
        page: pageOf(),
        channel: cfg?.channel ?? null,
        rows,
        counts: { waiting: n('WAITING') + n('RETRYING'), posted: n('POSTED'), failed: n('FAILED'), skipped: n('SKIPPED'), notPosted: n('NOT_POSTED'), all: rows.length },
        /** Red banner: Telegram refused the channel (bot removed / not an admin / token revoked); posting is stopped until an ADMIN presses Resume. */
        stop: await channelStop(pageOf()),
        /** The channel posts EVERY push from this time (its go-live). */
        everyPushFrom: cfg?.postFrom.toISOString() ?? null,
        maxDaysBack: MAX_DAYS_BACK,
      });
    } catch (err) {
      console.error('[telegram] list failed', safeErrorLog(err));
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  router.post('/posts/:id/retry', STAFF, async (req, res) => {
    try {
      const r = await retryNow(String(req.params.id), { now: nowOf, ...(o.worker ?? {}) });
      if (!r.ok) return res.status(r.reason === 'not_found' ? 404 : 409).json({ error: r.reason });
      return res.json({ ok: true, status: r.status });
    } catch (err) {
      console.error('[telegram] retry failed', safeErrorLog(err));
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  router.post('/posts/:id/skip', STAFF, async (req, res) => {
    try {
      return (await skipPost(String(req.params.id))) ? res.json({ ok: true, status: 'SKIPPED' }) : res.status(409).json({ error: 'not_skippable' });
    } catch (err) {
      console.error('[telegram] skip failed', safeErrorLog(err));
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  router.post('/check', ADMIN, async (_req, res) => {
    try {
      const cfg = configOf();
      if (!cfg) return res.json({ ok: false, kind: 'not_configured', message: 'The Telegram variables are not all set (or not valid) in Railway.' });
      const r = await checkTelegram(cfg, o.fetch);
      if (r.kind === 'ok') return res.json({ ok: true, name: r.title, message: `Connected to channel: ${r.title}` });
      return res.json({ ok: false, kind: r.kind, status: r.status, message: r.error });
    } catch (err) {
      console.error('[telegram] check failed', safeErrorLog(err));
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  router.post('/resume', ADMIN, async (req, res) => {
    try {
      const page = pageOf();
      const cleared = await resumeChannel(page);
      if (!cleared) return res.status(409).json({ error: 'not_stopped' });
      await recordAudit({ userId: req.user?.id ?? null, action: 'TELEGRAM_POSTING_RESUMED', resourceType: 'telegram_channel', resourceId: page, metadata: { page }, ipAddress: requestClientIp(req) });
      return res.json({ ok: true });
    } catch (err) {
      console.error('[telegram] resume failed', safeErrorLog(err));
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  return router;
}
