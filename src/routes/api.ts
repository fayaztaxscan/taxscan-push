import path from 'path';
import { Router, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { env } from '../lib/env';
import { requireBearerOrUser, requireUser } from '../lib/auth';
import type { Subscriber } from '@prisma/client';
import {
  dispatchCampaign,
  executeCampaign,
  DEFAULT_NOTIFICATION_ICON,
  type Sender,
} from '../services/send';
import { sendToSubscriber } from '../lib/push';
import { getMetrics, listCampaigns } from '../services/metrics';
import { buildReport, reportWindow } from '../services/reports';
import { sendScheduledReport } from '../services/reportScheduler';
import { pendingQueue } from '../services/pacer';
import { isAllowedPushUrl } from '../lib/urlAllowlist';
import { makePublicLimiter } from '../lib/rateLimit';
import { recordAudit } from '../lib/audit';

function base64urlByteLength(s: string): number {
  const padded = s + '='.repeat((4 - (s.length % 4)) % 4);
  const std = padded.replace(/-/g, '+').replace(/_/g, '/');
  try {
    return Buffer.from(std, 'base64').length;
  } catch {
    return -1;
  }
}

const SubscriptionSchema = z.object({
  endpoint: z.string().min(1),
  keys: z.object({
    p256dh: z
      .string()
      .min(1)
      .refine((s) => base64urlByteLength(s) === 65, {
        message: 'p256dh must base64url-decode to 65 bytes',
      }),
    auth: z
      .string()
      .min(1)
      .refine((s) => base64urlByteLength(s) === 16, {
        message: 'auth must base64url-decode to 16 bytes',
      }),
  }),
});

const SubscribeSchema = z.object({
  subscription: SubscriptionSchema,
  portal: z.string().min(1),
  topics: z.array(z.string()).optional(),
  userAgent: z.string().optional(),
  source: z.string().optional(),
});

const UnsubscribeSchema = z.object({
  endpoint: z.string().min(1),
});

const TRACK_TYPES = ['PROMPT_SHOWN', 'PROMPT_ACCEPTED', 'CLICKED', 'DISMISSED'] as const;
const TrackSchema = z.object({
  type: z.enum(TRACK_TYPES),
  endpoint: z.string().min(1).optional(),
  campaignId: z.string().min(1).optional(),
});

const TargetSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('all') }),
  z.object({ type: z.literal('topics'), topics: z.array(z.string().min(1)).min(1) }),
]);

const allowedHostsMessage =
  env.allowedPushHosts.length > 0
    ? `Click URL must link to one of these sites: ${env.allowedPushHosts.join(', ')}. Update ALLOWED_PUSH_HOSTS to add another.`
    : 'Invalid Click URL.';
const pushUrlField = z.string().min(1).refine(isAllowedPushUrl, { message: allowedHostsMessage });

const SendSchema = z.object({
  portal: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  url: pushUrlField,
  icon: z.string().optional(),
  target: TargetSchema,
  breaking: z.boolean().optional(),
  // Manual full-reach override: bypasses the daily cap + per-subscriber
  // cooldown so the send reaches every eligible subscriber. See CampaignInput.
  force: z.boolean().optional(),
  scheduledAt: z.string().datetime().optional(),
});

// Test-on-this-device: the admin's own browser subscribes (via the SPA) and
// posts its subscription here to receive a one-off preview of the composed
// notification. No DB row, no portal — it reaches ONLY the device that asked.
const TestDeviceSchema = z.object({
  subscription: z.object({
    endpoint: z.string().min(1),
    keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
  }),
  title: z.string().min(1),
  body: z.string().min(1),
  url: pushUrlField,
  icon: z.string().optional(),
});

function badRequest(res: Response, err: z.ZodError) {
  return res.status(400).json({ error: 'invalid_request', issues: err.issues });
}

export function createApiRouter(
  opts: { sender?: Sender; publicPerMin?: number } = {},
): Router {
  const router = Router();

  // Per-IP rate limiter for the four public endpoints (subscribe /
  // unsubscribe / track / config). The login limiter lives on the auth
  // router instead (src/routes/auth.ts).
  const publicLimiter = makePublicLimiter(opts.publicPerMin ?? env.rateLimit.publicPerMin);

  router.post('/subscribe', publicLimiter, async (req, res, next) => {
    try {
      const parsed = SubscribeSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, parsed.error);
      const { subscription, portal, topics, userAgent, source } = parsed.data;

      // Default-topics rule: no subscriber ends up receiving nothing. iZooto
      // migrants and brand-new subscribers landing through any code path get
      // ['all'] if they haven't actively narrowed. Existing subscribers keep
      // their previous choice on a no-topics recapture.
      const existing = await prisma.subscriber.findUnique({
        where: { endpoint: subscription.endpoint },
        select: { topics: true },
      });
      const explicit = topics && topics.length > 0;
      const preserved = !explicit && existing && existing.topics.length > 0;
      const finalTopics = explicit
        ? topics!
        : preserved
          ? existing!.topics
          : ['all'];

      const subscriber = await prisma.subscriber.upsert({
        where: { endpoint: subscription.endpoint },
        create: {
          endpoint: subscription.endpoint,
          p256dh: subscription.keys.p256dh,
          auth: subscription.keys.auth,
          portal,
          topics: finalTopics,
          userAgent: userAgent ?? null,
          status: 'ACTIVE',
        },
        update: {
          p256dh: subscription.keys.p256dh,
          auth: subscription.keys.auth,
          portal,
          topics: finalTopics,
          userAgent: userAgent ?? null,
          status: 'ACTIVE',
        },
      });

      await prisma.event.create({
        data: {
          type: 'SUBSCRIBED',
          subscriberId: subscriber.id,
          meta: source ? { source } : undefined,
        },
      });

      return res.status(201).json({ id: subscriber.id });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/unsubscribe', publicLimiter, async (req, res, next) => {
    try {
      const parsed = UnsubscribeSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, parsed.error);

      const sub = await prisma.subscriber.findUnique({
        where: { endpoint: parsed.data.endpoint },
      });
      if (sub) {
        await prisma.subscriber.update({
          where: { id: sub.id },
          data: { status: 'EXPIRED' },
        });
        await prisma.event.create({
          data: { type: 'UNSUBSCRIBED', subscriberId: sub.id },
        });
      }

      return res.status(200).json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/track', publicLimiter, async (req, res, next) => {
    try {
      const parsed = TrackSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, parsed.error);
      const { type, endpoint, campaignId } = parsed.data;

      let subscriberId: string | null = null;
      if (endpoint) {
        const sub = await prisma.subscriber.findUnique({ where: { endpoint } });
        if (sub) subscriberId = sub.id;
      }

      let resolvedCampaignId: string | null = null;
      if (campaignId) {
        const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
        if (campaign) resolvedCampaignId = campaign.id;
      }

      await prisma.event.create({
        data: { type, subscriberId, campaignId: resolvedCampaignId },
      });

      return res.status(204).end();
    } catch (err) {
      return next(err);
    }
  });

  router.get('/config', publicLimiter, (_req, res) => {
    return res.json({ vapidPublicKey: env.vapid.publicKey });
  });

  router.post('/send', requireBearerOrUser(), async (req, res, next) => {
    try {
      const parsed = SendSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, parsed.error);
      const { scheduledAt, ...input } = parsed.data;

      // `force` is only honored on immediate dispatch. A future-scheduled send
      // is persisted as a SCHEDULED Campaign and later run by the sweeper, which
      // has no `force` to read (it's not a Campaign column) — so it would
      // silently fall back to the normal cap/cooldown. Reject the combination
      // rather than mislead the sender.
      if (input.force && scheduledAt && new Date(scheduledAt).getTime() > Date.now()) {
        return res.status(400).json({
          error: 'invalid_request',
          message: 'force is only supported for immediate sends, not scheduled ones',
        });
      }
      // Bearer-authenticated requests have no req.user (intentional —
      // RSS poller / cron). Cookie-authenticated requests have it set
      // by requireUser inside requireBearerOrUser. Either way we just
      // forward the optional id; dispatchCampaign writes it onto
      // Campaign.createdByUserId and the audit row.
      const createdByUserId = req.user?.id ?? null;

      if (scheduledAt) {
        const when = new Date(scheduledAt);
        if (when.getTime() > Date.now()) {
          const campaign = await prisma.campaign.create({
            data: {
              portal: input.portal,
              title: input.title,
              body: input.body,
              url: input.url,
              icon: input.icon ?? null,
              target: input.target as object,
              status: 'SCHEDULED',
              scheduledAt: when,
              createdByUserId,
            },
          });
          return res.status(200).json({
            campaignId: campaign.id,
            status: 'SCHEDULED',
            sent: 0,
            capped: 0,
            cooled: 0,
            expiredPruned: 0,
            failed: 0,
            deferred: { scheduledAt: when.toISOString() },
          });
        }
      }

      const result = await dispatchCampaign(
        { ...input, createdByUserId },
        { sender: opts.sender },
      );
      return res.status(200).json(result);
    } catch (err) {
      return next(err);
    }
  });

  // Preview the composed notification on the caller's own device only. The SPA
  // subscribes the admin's browser and posts that subscription here; we push a
  // single notification straight to it — no subscriber row, no audience.
  router.post('/send/test-device', requireBearerOrUser(), async (req, res, next) => {
    try {
      const parsed = TestDeviceSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, parsed.error);
      const { subscription, title, body, url, icon } = parsed.data;
      const sender = opts.sender ?? sendToSubscriber;
      const device = {
        id: 'test-device',
        endpoint: subscription.endpoint,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
      } as Subscriber;
      const outcome = await sender(device, {
        title,
        body,
        url,
        icon: icon || DEFAULT_NOTIFICATION_ICON,
        badge: icon || DEFAULT_NOTIFICATION_ICON,
        tag: 'taxscan-test',
      });
      if (!outcome.ok) {
        return res.status(502).json({
          error: 'push_failed',
          message:
            'statusCode' in outcome
              ? `Push service returned ${outcome.statusCode}. Re-enable test notifications and try again.`
              : 'Could not deliver to this device. Re-enable test notifications and try again.',
        });
      }
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });

  // --- Editorial review queue (SEND_PACING_PLAN.md §6 / Stage 3) -------------
  // Unclassified (REVIEW) articles held by the poller surface here for an editor
  // to Approve (→ QUALIFIED, the pacer sends it on the next slot), Reject (drop,
  // never sent) or Push now (immediate full-reach send). A pending item is a
  // DRAFT campaign with sendQueue=REVIEW and reviewedAt=null.

  router.get('/review', requireBearerOrUser(), async (req, res, next) => {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      const items = await prisma.campaign.findMany({
        where: { status: 'DRAFT', sendQueue: 'REVIEW', reviewedAt: null },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: { id: true, title: true, body: true, url: true, authority: true, createdAt: true },
      });
      return res.json({ items });
    } catch (err) {
      return next(err);
    }
  });

  // Atomic claim helper: only acts on a still-pending REVIEW item, so two
  // editors (or an editor + a retry) can't double-handle the same row.
  async function claimReviewItem(id: string): Promise<boolean> {
    const claim = await prisma.campaign.updateMany({
      where: { id, status: 'DRAFT', sendQueue: 'REVIEW', reviewedAt: null },
      data: { reviewedAt: new Date() },
    });
    return claim.count > 0;
  }

  router.post('/review/:id/approve', requireBearerOrUser(), async (req, res, next) => {
    try {
      const userId = req.user?.id ?? null;
      const ok = await claimReviewItem(req.params.id);
      if (!ok) return res.status(404).json({ error: 'review_item_not_found' });
      // Promote into the QUALIFIED pool; the pacer ranks it in the regulatory
      // tier (null authority) and sends it on the next available slot.
      await prisma.campaign.update({
        where: { id: req.params.id },
        data: { sendQueue: 'QUALIFIED' },
      });
      await recordAudit({
        userId,
        action: 'REVIEW_APPROVED',
        resourceType: 'campaign',
        resourceId: req.params.id,
      });
      return res.json({ ok: true, id: req.params.id, queue: 'QUALIFIED' });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/review/:id/reject', requireBearerOrUser(), async (req, res, next) => {
    try {
      const userId = req.user?.id ?? null;
      const ok = await claimReviewItem(req.params.id);
      if (!ok) return res.status(404).json({ error: 'review_item_not_found' });
      // reviewedAt is now set, so it leaves the queue; it stays a REVIEW DRAFT
      // which the pacer never selects → effectively dropped, record preserved.
      await recordAudit({
        userId,
        action: 'REVIEW_REJECTED',
        resourceType: 'campaign',
        resourceId: req.params.id,
      });
      return res.json({ ok: true, id: req.params.id });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/review/:id/push', requireBearerOrUser(), async (req, res, next) => {
    try {
      const userId = req.user?.id ?? null;
      const ok = await claimReviewItem(req.params.id);
      if (!ok) return res.status(404).json({ error: 'review_item_not_found' });
      const campaign = await prisma.campaign.findUnique({ where: { id: req.params.id } });
      if (!campaign) return res.status(404).json({ error: 'review_item_not_found' });
      // Immediate full-reach send (bypasses the per-subscriber cap/cooldown,
      // like force). Its SENT events count toward the pacer's daily ceiling and
      // reset the spacing clock, exactly as a manual force push does.
      const result = await executeCampaign(campaign, {
        sender: opts.sender,
        cap: Infinity,
        minGapMinutes: 0,
      });
      await recordAudit({
        userId,
        action: 'REVIEW_PUSHED',
        resourceType: 'campaign',
        resourceId: campaign.id,
        metadata: { sent: result.sent, failed: result.failed, expiredPruned: result.expiredPruned },
      });
      return res.json({ ok: true, id: campaign.id, ...result });
    } catch (err) {
      return next(err);
    }
  });

  // --- Send queue (SEND_PACING_PLAN.md §5) -----------------------------------
  // The QUALIFIED/FALLBACK articles the poller has captured and the pacer will
  // release on its 45-min slots, listed in the exact order they will send. An
  // editor can "Push now" any of them to jump it ahead of its slot (a full-reach
  // force send, like the Review queue's Push-now).

  router.get('/queue', requireBearerOrUser(), async (_req, res, next) => {
    try {
      const items = await pendingQueue(env.rss.portal);
      return res.json({
        items: items.map((c) => ({
          id: c.id,
          title: c.title,
          body: c.body,
          url: c.url,
          authority: c.authority,
          sendQueue: c.sendQueue,
          createdAt: c.createdAt,
        })),
      });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/queue/:id/push', requireBearerOrUser(), async (req, res, next) => {
    try {
      const userId = req.user?.id ?? null;
      // Atomic claim: flip a still-pending auto-queue DRAFT to SCHEDULED, exactly
      // as the pacer does, so a concurrent pacer tick can't also send it.
      const claim = await prisma.campaign.updateMany({
        where: { id: req.params.id, status: 'DRAFT', sendQueue: { in: ['QUALIFIED', 'FALLBACK'] } },
        data: { status: 'SCHEDULED' },
      });
      if (claim.count === 0) return res.status(404).json({ error: 'queue_item_not_found' });
      const campaign = await prisma.campaign.findUnique({ where: { id: req.params.id } });
      if (!campaign) return res.status(404).json({ error: 'queue_item_not_found' });
      // Immediate full-reach send (bypasses the per-subscriber cap/cooldown). Its
      // SENT events count toward the pacer's daily ceiling and reset the spacing
      // clock, exactly like a manual force push or a Review "Push now".
      const result = await executeCampaign(campaign, {
        sender: opts.sender,
        cap: Infinity,
        minGapMinutes: 0,
      });
      await recordAudit({
        userId,
        action: 'CAMPAIGN_DISPATCHED',
        resourceType: 'campaign',
        resourceId: campaign.id,
        metadata: {
          sent: result.sent,
          failed: result.failed,
          expiredPruned: result.expiredPruned,
          source: 'queue_push',
        },
      });
      return res.json({ ok: true, id: campaign.id, ...result });
    } catch (err) {
      return next(err);
    }
  });

  // Admin user guide (PDF). Auth-gated so it is NOT public — the SPA's session
  // cookie satisfies requireBearerOrUser on a same-origin navigation. The file
  // is committed under <repo>/docs and ships with the deploy.
  // HTML version — the SPA's /guide route embeds this in an iframe so the guide
  // reads inline (the authored doc is self-contained with its own styles).
  router.get('/guide.html', requireBearerOrUser(), (_req, res) => {
    const htmlPath = path.resolve(__dirname, '..', '..', 'docs', 'Taxscan-Push-Admin-Guide.html');
    res.sendFile(htmlPath, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'guide_not_found' });
    });
  });

  // PDF version — opens inline by default, or forces a download with ?download.
  router.get('/guide', requireBearerOrUser(), (req, res) => {
    const pdfPath = path.resolve(__dirname, '..', '..', 'docs', 'Taxscan-Push-Admin-Guide.pdf');
    const disposition = req.query.download !== undefined ? 'attachment' : 'inline';
    res.setHeader('Content-Disposition', `${disposition}; filename="Taxscan-Push-Admin-Guide.pdf"`);
    res.sendFile(pdfPath, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'guide_not_found' });
    });
  });

  router.get('/campaigns', requireBearerOrUser(), async (req, res, next) => {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      // ?createdByUserId=<id> backs the Activity / "Show only mine" filter
      // in the SPA (Phase 7). Free-form string; non-matching values just
      // return an empty list rather than 400.
      const createdByUserId =
        typeof req.query.createdByUserId === 'string'
          ? req.query.createdByUserId
          : undefined;
      const campaigns = await listCampaigns(limit, { createdByUserId });
      return res.json({ campaigns });
    } catch (err) {
      return next(err);
    }
  });

  router.get('/metrics', requireBearerOrUser(), async (_req, res, next) => {
    try {
      const metrics = await getMetrics();
      return res.json(metrics);
    } catch (err) {
      return next(err);
    }
  });

  // Coverage & Quality report (weekly default; ?period=monthly). Counts every
  // captured article in the window — the basis for the in-app view + emails.
  router.get('/reports', requireBearerOrUser(), async (req, res, next) => {
    try {
      const period = req.query.period === 'monthly' ? 'monthly' : 'weekly';
      const { start, end } = reportWindow(period, new Date());
      const report = await buildReport({ portal: env.rss.portal, period, start, end });
      return res.json(report);
    } catch (err) {
      return next(err);
    }
  });

  // Preview the report email — sends it to the requesting user only, so they can
  // check how it looks before the scheduled run reaches everyone.
  router.post('/reports/test-email', requireUser(), async (req, res, next) => {
    try {
      const period = req.body?.period === 'monthly' ? 'monthly' : 'weekly';
      const u = req.user?.id
        ? await prisma.user.findUnique({ where: { id: req.user.id }, select: { email: true } })
        : null;
      if (!u?.email) return res.status(400).json({ error: 'no_email_for_user' });
      const result = await sendScheduledReport({ period, recipients: [u.email] });
      if (result.failed > 0) {
        return res.status(502).json({ error: 'email_failed', message: 'Email could not be sent — check email config.' });
      }
      return res.json({ ok: true, to: u.email, articles: result.total });
    } catch (err) {
      return next(err);
    }
  });

  // Report-only recipients (internal emails that get the weekly/monthly report
  // but have no login or push). Admin-managed. App users always receive it too.
  const ReportRecipientSchema = z.object({ email: z.string().email() });

  router.get('/report-recipients', requireUser(['ADMIN']), async (_req, res, next) => {
    try {
      const items = await prisma.reportRecipient.findMany({ orderBy: { createdAt: 'desc' } });
      return res.json({ items });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/report-recipients', requireUser(['ADMIN']), async (req, res, next) => {
    try {
      const parsed = ReportRecipientSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, parsed.error);
      const email = parsed.data.email.trim().toLowerCase();
      const item = await prisma.reportRecipient.upsert({
        where: { email },
        update: { active: true },
        create: { email },
      });
      return res.status(201).json({ item });
    } catch (err) {
      return next(err);
    }
  });

  router.delete('/report-recipients/:id', requireUser(['ADMIN']), async (req, res, next) => {
    try {
      await prisma.reportRecipient.delete({ where: { id: req.params.id } }).catch(() => undefined);
      return res.status(204).end();
    } catch (err) {
      return next(err);
    }
  });

  router.get('/admin/subscribers', requireBearerOrUser(), async (req, res, next) => {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);
      const subscribers = await prisma.subscriber.findMany({
        where: { status: 'ACTIVE' },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: {
          id: true,
          endpoint: true,
          topics: true,
          userAgent: true,
          createdAt: true,
          portal: true,
        },
      });
      return res.json({ subscribers, testSegmentTopic: env.testSegmentTopic });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/admin/subscribers/:id/test-segment', requireBearerOrUser(), async (req, res, next) => {
    try {
      const sub = await prisma.subscriber.findUnique({ where: { id: req.params.id } });
      if (!sub) return res.status(404).json({ error: 'subscriber_not_found' });
      const topic = env.testSegmentTopic;
      if (sub.topics.includes(topic)) {
        return res.json({ subscriber: { id: sub.id, topics: sub.topics }, added: false });
      }
      const updated = await prisma.subscriber.update({
        where: { id: sub.id },
        data: { topics: { push: topic } },
        select: { id: true, topics: true },
      });
      return res.json({ subscriber: updated, added: true });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}
