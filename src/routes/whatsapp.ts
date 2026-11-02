import { Router } from 'express';
import { z } from 'zod';
import { requireBearerOrUser } from '../lib/auth';
import { env } from '../lib/env';
import { safeErrorLog } from '../lib/httpErrors';
import { dayProblem, getQueue, istDay, markArticle } from '../services/whatsapp/queue';

/**
 * WhatsApp channel queue (brief 2026-11-02-whatsapp-channel-queue). Nothing posts to WhatsApp by itself: this lists the
 * pushed articles with a ready post, and the team marks each Posted or Skipped. ADMIN or PUBLISHER (or the bearer).
 * Behind WHATSAPP_QUEUE_ENABLED: off = 404 on both endpoints, before any auth.
 *
 *   GET  /api/whatsapp/queue?date=YYYY-MM-DD   IST day, default today, up to 14 days back
 *   POST /api/whatsapp/queue/:campaignId       {status: 'POSTED' | 'SKIPPED' | 'TODO'}
 */
export type WhatsAppRouterOptions = {
  enabled?: () => boolean;
  clock?: () => Date;
  portal?: () => string;
};

const STAFF = requireBearerOrUser(['ADMIN', 'PUBLISHER']);
const MarkSchema = z.object({ status: z.enum(['POSTED', 'SKIPPED', 'TODO']) }).strict();

export function createWhatsAppRouter(o: WhatsAppRouterOptions = {}): Router {
  const router = Router();
  const enabled = o.enabled ?? (() => env.whatsapp.queueEnabled);
  const nowOf = o.clock ?? (() => new Date());
  const portalOf = o.portal ?? (() => env.rss.portal);

  router.use((_req, res, next) => (enabled() ? next() : void res.status(404).json({ error: 'not_found' })));

  router.get('/queue', STAFF, async (req, res) => {
    try {
      const now = nowOf();
      const raw = typeof req.query.date === 'string' && req.query.date !== '' ? req.query.date : istDay(now);
      const problem = dayProblem(raw, now);
      if (problem) return res.status(400).json({ error: 'invalid_date', message: problem });
      return res.json(await getQueue(portalOf(), raw));
    } catch (err) {
      console.error('[whatsapp] queue failed', safeErrorLog(err));
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  router.post('/queue/:campaignId', STAFF, async (req, res) => {
    const parsed = MarkSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_request' });
    try {
      const r = await markArticle(portalOf(), String(req.params.campaignId), parsed.data.status, req.user?.id ?? null, nowOf());
      if (!r.ok) return res.status(404).json({ error: 'not_found' });
      return res.json({ ok: true, status: r.status });
    } catch (err) {
      console.error('[whatsapp] mark failed', safeErrorLog(err));
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  return router;
}
