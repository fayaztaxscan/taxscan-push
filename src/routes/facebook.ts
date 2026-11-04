import { Router } from 'express';
import { requireBearerOrUser, requireUser } from '../lib/auth';
import { env } from '../lib/env';
import { prisma } from '../lib/prisma';
import { recordAudit } from '../lib/audit';
import { requestClientIp } from '../lib/clientIp';
import { safeErrorLog } from '../lib/httpErrors';
import { articleKey } from '../services/reports';
import { isPublicArticleCampaign } from '../services/social/publicCampaign';
import { dayProblem, istDay, istDayBounds, istTime, MAX_DAYS_BACK } from '../services/whatsapp/queue';
import { PORTAL_TO_PAGE, PAGE_TAXSCAN, pageConfig, postUrlOf } from '../services/facebook/pages';
import { checkConnection } from '../services/facebook/client';
import { loginProblem, policyProblem, resumePolicy, retryNow, skipPost, type WorkerDeps } from '../services/facebook/worker';
import type { FetchLike } from '../services/linkedin/post';

/**
 * Facebook page posting screen API (brief 2026-11-03-facebook-page-posting). ADMIN or PUBLISHER (or the bearer); Check
 * connection and Resume are ADMIN only. Behind FACEBOOK_POSTING_ENABLED: off = 404 on every endpoint, before auth. The request
 * path reads Postgres only, except Retry (ONE Graph post) and Check connection (ONE Graph GET).
 *
 *   GET  /api/facebook/posts?date=YYYY-MM-DD    IST day, default today, up to 14 days back
 *   POST /api/facebook/posts/:id/retry          a FAILED row: post it now (409 policy_stop while stopped)
 *   POST /api/facebook/posts/:id/skip           a FAILED row, or one waiting for a retry
 *   POST /api/facebook/check                    ADMIN: "Connected to page: <name>" or the error class; posts nothing
 *   POST /api/facebook/resume                   ADMIN: clears a policy stop (audited)
 */
export type FacebookRouterOptions = {
  enabled?: () => boolean;
  clock?: () => Date;
  portals?: () => Readonly<Record<string, string>>;
  postFrom?: () => Date | null;
  worker?: WorkerDeps;
  /** The Graph fetch used by Check connection (tests inject a fake). */
  fetch?: FetchLike;
};

const STAFF = requireBearerOrUser(['ADMIN', 'PUBLISHER']);
const ADMIN = requireUser(['ADMIN']);

export type ScreenStatus = 'WAITING' | 'RETRYING' | 'POSTED' | 'FAILED' | 'SKIPPED' | 'NOT_POSTED';

export function createFacebookRouter(o: FacebookRouterOptions = {}): Router {
  const router = Router();
  const enabled = o.enabled ?? (() => env.facebook.enabled);
  const nowOf = o.clock ?? (() => new Date());
  const portalsOf = o.portals ?? (() => PORTAL_TO_PAGE);
  const postFromOf = o.postFrom ?? (() => env.facebook.postFrom);
  const pageOf = (): string => Object.values(portalsOf())[0] ?? PAGE_TAXSCAN;

  router.use((_req, res, next) => (enabled() ? next() : void res.status(404).json({ error: 'not_found' })));

  router.get('/posts', STAFF, async (req, res) => {
    try {
      const now = nowOf();
      const day = typeof req.query.date === 'string' && req.query.date !== '' ? req.query.date : istDay(now);
      const problem = dayProblem(day, now);
      if (problem) return res.status(400).json({ error: 'invalid_date', message: problem });
      const portals = portalsOf();
      const { start, end } = istDayBounds(day);
      const since = new Date(start.getTime() - MAX_DAYS_BACK * 24 * 60 * 60_000);
      const sent = await prisma.campaign.findMany({
        where: { portal: { in: Object.keys(portals) }, status: 'SENT', lastSentAt: { gte: since } },
        select: { id: true, title: true, url: true, target: true, lastSentAt: true },
        orderBy: [{ lastSentAt: 'asc' }, { id: 'asc' }],
      });
      const first = new Map<string, (typeof sent)[number]>();
      for (const c of sent) {
        if (!c.lastSentAt || !isPublicArticleCampaign(c)) continue;
        const k = articleKey(c);
        if (!first.has(k)) first.set(k, c);
      }
      const inDay = [...first.entries()].filter(([, c]) => c.lastSentAt! >= start && c.lastSentAt! < end);
      const posts = inDay.length ? await prisma.facebookPost.findMany({ where: { page: pageOf(), articleKey: { in: inDay.map(([k]) => k) } } }) : [];
      const byKey = new Map(posts.map((p) => [p.articleKey, p]));
      const postFrom = postFromOf();
      const rows = inDay.map(([k, c]) => {
        const p = byKey.get(k);
        let status: ScreenStatus;
        // No row yet: pushed since go-live → the worker will post it, however long ago (no age limit); before go-live → never.
        if (p) status = p.status === 'PENDING' ? (p.nextAttemptAt ? 'RETRYING' : 'WAITING') : (p.status as ScreenStatus);
        else status = postFrom && c.lastSentAt! >= postFrom ? 'WAITING' : 'NOT_POSTED';
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
          postUrl: p?.status === 'POSTED' && p.facebookPostId ? postUrlOf(p.facebookPostId) : null,
          /** Retry on this row needs "check the page first" (the outcome is unknown). */
          unknownOutcome: p?.status === 'FAILED' && (p.error ?? '').startsWith('unknown'),
        };
      });
      const n = (s: ScreenStatus) => rows.filter((r) => r.status === s).length;
      return res.json({
        date: day,
        page: pageOf(),
        rows,
        counts: { waiting: n('WAITING') + n('RETRYING'), posted: n('POSTED'), failed: n('FAILED'), skipped: n('SKIPPED'), notPosted: n('NOT_POSTED'), all: rows.length },
        /** Amber banner: the token was rejected (clears by itself once a post works / the token changes). */
        login: await loginProblem(pageOf()),
        /** Red banner: Facebook blocked a post; posting is stopped until an ADMIN presses Resume. */
        policy: await policyProblem(pageOf()),
      });
    } catch (err) {
      console.error('[facebook] list failed', safeErrorLog(err));
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  router.post('/posts/:id/retry', STAFF, async (req, res) => {
    try {
      const r = await retryNow(String(req.params.id), { now: nowOf, ...(o.worker ?? {}) });
      if (!r.ok) return res.status(r.reason === 'not_found' ? 404 : 409).json({ error: r.reason });
      return res.json({ ok: true, status: r.status });
    } catch (err) {
      console.error('[facebook] retry failed', safeErrorLog(err));
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  router.post('/posts/:id/skip', STAFF, async (req, res) => {
    try {
      return (await skipPost(String(req.params.id))) ? res.json({ ok: true, status: 'SKIPPED' }) : res.status(409).json({ error: 'not_skippable' });
    } catch (err) {
      console.error('[facebook] skip failed', safeErrorLog(err));
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  router.post('/check', ADMIN, async (_req, res) => {
    try {
      const cfg = pageConfig(pageOf());
      if (!cfg) return res.json({ ok: false, kind: 'not_configured', message: 'FACEBOOK page id / token are not set (or not valid) in Railway.' });
      const r = await checkConnection(cfg, o.fetch);
      if (r.kind === 'ok') return res.json({ ok: true, name: r.name, message: `Connected to page: ${r.name}` });
      return res.json({ ok: false, kind: r.kind, status: r.status, code: r.code, message: r.error });
    } catch (err) {
      console.error('[facebook] check failed', safeErrorLog(err));
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  router.post('/resume', ADMIN, async (req, res) => {
    try {
      const page = pageOf();
      const cleared = await resumePolicy(page);
      if (!cleared) return res.status(409).json({ error: 'not_stopped' });
      await recordAudit({ userId: req.user?.id ?? null, action: 'FACEBOOK_POSTING_RESUMED', resourceType: 'facebook_page', resourceId: page, metadata: { page }, ipAddress: requestClientIp(req) });
      return res.json({ ok: true });
    } catch (err) {
      console.error('[facebook] resume failed', safeErrorLog(err));
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  return router;
}
