import { Router, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { env } from '../lib/env';
import { requireBearer } from '../lib/auth';
import { dispatchCampaign, type Sender } from '../services/send';

const SubscriptionSchema = z.object({
  endpoint: z.string().min(1),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});

const SubscribeSchema = z.object({
  subscription: SubscriptionSchema,
  portal: z.string().min(1),
  topics: z.array(z.string()).optional(),
  userAgent: z.string().optional(),
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
  url: z.string().min(1),
  icon: z.string().optional(),
  target: TargetSchema,
  breaking: z.boolean().optional(),
});

function badRequest(res: Response, err: z.ZodError) {
  return res.status(400).json({ error: 'invalid_request', issues: err.issues });
}

export function createApiRouter(opts: { sender?: Sender } = {}): Router {
  const router = Router();

  router.post('/subscribe', async (req, res, next) => {
    try {
      const parsed = SubscribeSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, parsed.error);
      const { subscription, portal, topics, userAgent } = parsed.data;

      const subscriber = await prisma.subscriber.upsert({
        where: { endpoint: subscription.endpoint },
        create: {
          endpoint: subscription.endpoint,
          p256dh: subscription.keys.p256dh,
          auth: subscription.keys.auth,
          portal,
          topics: topics ?? [],
          userAgent: userAgent ?? null,
          status: 'ACTIVE',
        },
        update: {
          p256dh: subscription.keys.p256dh,
          auth: subscription.keys.auth,
          portal,
          topics: topics ?? [],
          userAgent: userAgent ?? null,
          status: 'ACTIVE',
        },
      });

      await prisma.event.create({
        data: { type: 'SUBSCRIBED', subscriberId: subscriber.id },
      });

      return res.status(201).json({ id: subscriber.id });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/unsubscribe', async (req, res, next) => {
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

  router.post('/track', async (req, res, next) => {
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

  router.get('/config', (_req, res) => {
    return res.json({ vapidPublicKey: env.vapid.publicKey });
  });

  router.post('/send', requireBearer, async (req, res, next) => {
    try {
      const parsed = SendSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, parsed.error);

      const result = await dispatchCampaign(parsed.data, { sender: opts.sender });
      return res.status(200).json(result);
    } catch (err) {
      return next(err);
    }
  });

  return router;
}
