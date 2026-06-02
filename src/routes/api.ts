import { Router, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { env } from '../lib/env';
import { requireBearer } from '../lib/auth';
import { dispatchCampaign, type Sender } from '../services/send';
import { buildMetrics, listCampaigns } from '../services/metrics';
import { isAllowedPushUrl } from '../lib/urlAllowlist';
import { makeLoginLimiter, makePublicLimiter } from '../lib/rateLimit';
import { timingSafeEqual } from 'crypto';

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

const SendSchema = z.object({
  portal: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  url: z
    .string()
    .min(1)
    .refine(isAllowedPushUrl, {
      message: 'url host is not in ALLOWED_PUSH_HOSTS',
    }),
  icon: z.string().optional(),
  target: TargetSchema,
  breaking: z.boolean().optional(),
  scheduledAt: z.string().datetime().optional(),
});

const LoginSchema = z.object({
  password: z.string().min(1),
});

function badRequest(res: Response, err: z.ZodError) {
  return res.status(400).json({ error: 'invalid_request', issues: err.issues });
}

export function createApiRouter(
  opts: { sender?: Sender; publicPerMin?: number; loginPerMin?: number } = {},
): Router {
  const router = Router();

  // Per-IP rate limiters. The public limiter wraps the four public endpoints
  // (subscribe / unsubscribe / track / config). The login limiter is tighter,
  // gating brute-force on the admin password.
  const publicLimiter = makePublicLimiter(opts.publicPerMin ?? env.rateLimit.publicPerMin);
  const loginLimiter = makeLoginLimiter(opts.loginPerMin ?? env.rateLimit.loginPerMin);

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

  router.post('/send', requireBearer, async (req, res, next) => {
    try {
      const parsed = SendSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, parsed.error);
      const { scheduledAt, ...input } = parsed.data;

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
            },
          });
          return res.status(200).json({
            campaignId: campaign.id,
            status: 'SCHEDULED',
            sent: 0,
            capped: 0,
            expiredPruned: 0,
            failed: 0,
            deferred: { scheduledAt: when.toISOString() },
          });
        }
      }

      const result = await dispatchCampaign(input, { sender: opts.sender });
      return res.status(200).json(result);
    } catch (err) {
      return next(err);
    }
  });

  router.post('/auth/login', loginLimiter, (req, res) => {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error);
    if (!env.admin.password || !env.adminToken) {
      return res.status(503).json({ error: 'admin_unconfigured' });
    }
    const provided = Buffer.from(parsed.data.password);
    const expected = Buffer.from(env.admin.password);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      return res.status(401).json({ error: 'invalid_password' });
    }
    return res.json({ token: env.adminToken, testSegmentTopic: env.testSegmentTopic });
  });

  router.get('/campaigns', requireBearer, async (req, res, next) => {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      const campaigns = await listCampaigns(limit);
      return res.json({ campaigns });
    } catch (err) {
      return next(err);
    }
  });

  router.get('/metrics', requireBearer, async (_req, res, next) => {
    try {
      const metrics = await buildMetrics();
      return res.json(metrics);
    } catch (err) {
      return next(err);
    }
  });

  router.get('/admin/subscribers', requireBearer, async (req, res, next) => {
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

  router.post('/admin/subscribers/:id/test-segment', requireBearer, async (req, res, next) => {
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
