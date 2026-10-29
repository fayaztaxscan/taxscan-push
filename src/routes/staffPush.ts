/**
 * Staff push devices — "Notify me on this device" (digest task 14).
 *
 *   GET  /api/staff-push/status          is sending on; the VAPID public key; how many devices I have
 *   POST /api/staff-push/devices         store / refresh THIS device's subscription (opt-in)
 *   POST /api/staff-push/devices/check   is this endpoint one of my devices?
 *   POST /api/staff-push/devices/remove  stop notifications on this device
 *   POST /api/staff-push/devices/test    one test notification to this device only
 *                                        (per user: 5 a minute, 20 an hour → 429)
 *
 * Cookie session only (both roles may approve the digest, so both may opt in);
 * a caller only ever sees or changes their OWN devices. Admins remove another
 * user's devices through `DELETE /api/users/:id/push-devices`. The endpoint is
 * POSTed, never put in a URL, and never logged or audited (device id, label
 * and the push service's host only).
 */
import { Router, type Request, type RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { requireUser } from '../lib/auth';
import { env, type DigestEnv } from '../lib/env';
import { recordAudit } from '../lib/audit';
import {
  findOwnDevice,
  MAX_DEVICES_PER_USER,
  pushServiceHost,
  pushToStaffDevice,
  staffDeviceLabel,
  staffPushTransport,
  upsertStaffDevice,
  type StaffPushTransport,
} from '../services/staffPush';
import { prisma } from '../lib/prisma';
import { DEFAULT_NOTIFICATION_BADGE, DEFAULT_NOTIFICATION_ICON } from '../services/send';

const endpointField = z
  .string()
  .min(1)
  .max(2048)
  .refine((v) => {
    try {
      return new URL(v).protocol === 'https:';
    } catch {
      return false;
    }
  }, 'endpoint must be an https URL');

const SubscribeSchema = z.object({
  subscription: z.object({
    endpoint: endpointField,
    keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
  }),
  // pushsubscriptionchange: the browser's previous endpoint for this device, removed if it is mine.
  replacesEndpoint: endpointField.optional(),
});
const EndpointSchema = z.object({ endpoint: endpointField });

export type StaffPushRouterOptions = {
  cfg?: DigestEnv;
  enabled?: boolean;
  transport?: StaffPushTransport;
  /** "Send a test" limits per signed-in user (tests lower them). */
  testLimits?: { perMinute?: number; perHour?: number };
};

/** "Send a test": at most this many per user per minute, and per hour. */
export const TEST_LIMIT_PER_MINUTE = 5;
export const TEST_LIMIT_PER_HOUR = 20;

/**
 * A per-USER limiter (keyed on the session's user id, not the IP: editors may share
 * an office IP, and one signed-in user must not be able to loop the test push).
 * Mounted after `requireUser()`, so `req.user` is always set. In-process memory
 * store, like the project's other limiters.
 */
function perUserLimiter(windowMs: number, max: number, message: string): RequestHandler {
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `staff-test:${req.user?.id ?? 'none'}`,
    message: { error: 'rate_limited', message },
  });
}

function publicDevice(d: { id: string; label: string | null; createdAt: Date; lastSuccessAt: Date | null }) {
  return { id: d.id, label: d.label, createdAt: d.createdAt, lastSuccessAt: d.lastSuccessAt };
}

function ip(req: Request): string | null {
  return req.ip ?? null;
}

export function createStaffPushRouter(opts: StaffPushRouterOptions = {}): Router {
  const router = Router();
  const cfg = () => opts.cfg ?? env.digest;
  const transport = () => opts.transport ?? staffPushTransport();
  const testPerMinute = perUserLimiter(
    60_000,
    opts.testLimits?.perMinute ?? TEST_LIMIT_PER_MINUTE,
    'Too many tests — try again in a minute.',
  );
  const testPerHour = perUserLimiter(
    60 * 60_000,
    opts.testLimits?.perHour ?? TEST_LIMIT_PER_HOUR,
    `Too many tests — at most ${opts.testLimits?.perHour ?? TEST_LIMIT_PER_HOUR} an hour. Try again later.`,
  );

  router.get('/status', requireUser(), async (req, res, next) => {
    try {
      const devices = await prisma.staffPushSubscription.count({ where: { userId: req.user!.id } });
      const killSwitch = opts.enabled ?? env.staffPush.enabled;
      return res.json({
        // Would a digest alert reach a device now? Both the digest and the kill-switch must be on.
        sending: cfg().enabled && killSwitch,
        digestEnabled: cfg().enabled,
        staffPushEnabled: killSwitch,
        vapidPublicKey: env.vapid.publicKey,
        devices,
      });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/devices', requireUser(), async (req, res, next) => {
    try {
      const parsed = SubscribeSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'invalid_request' });
      const userId = req.user!.id;
      const { subscription, replacesEndpoint } = parsed.data;
      const label = staffDeviceLabel(req.header('user-agent'));
      // Drop the caller's own dead row BEFORE storing the new one, so a user at the device
      // limit doesn't lose another (live) device to eviction for a row that is going anyway.
      let replaced = false;
      if (replacesEndpoint && replacesEndpoint !== subscription.endpoint) {
        const old = await findOwnDevice(userId, replacesEndpoint);
        if (old) {
          await prisma.staffPushSubscription.deleteMany({ where: { id: old.id } });
          replaced = true;
        }
      }
      const r = await upsertStaffDevice(userId, subscription, label);
      // A refresh of an unchanged device is not news; a new device (or one taken over
      // from another login on the same browser) is.
      if (r.created || r.movedFromUserId) {
        await recordAudit({
          userId,
          action: 'STAFF_PUSH_SUBSCRIBED',
          resourceType: 'staff_push_device',
          resourceId: r.device.id,
          metadata: {
            deviceId: r.device.id,
            label,
            pushService: pushServiceHost(subscription.endpoint),
            ...(r.movedFromUserId ? { movedFromUserId: r.movedFromUserId } : {}),
            ...(replaced ? { replacedOldEndpoint: true } : {}),
          },
          ipAddress: ip(req),
        });
      }
      // The per-user device limit dropped the least recently used device(s): say so in the
      // audit log and to the user, instead of silently (task 14 follow-up, 2026-10-23).
      for (const e of r.evicted) {
        await recordAudit({
          userId,
          action: 'STAFF_PUSH_REMOVED',
          resourceType: 'staff_push_device',
          resourceId: e.id,
          metadata: { reason: 'device_limit', deviceId: e.id, label: e.label, pushService: e.pushService, limit: MAX_DEVICES_PER_USER },
          ipAddress: ip(req),
        });
      }
      return res.status(r.created ? 201 : 200).json({
        device: publicDevice(r.device),
        ...(r.evicted.length ? { evicted: r.evicted.map((e) => ({ id: e.id, label: e.label })), deviceLimit: MAX_DEVICES_PER_USER } : {}),
      });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/devices/check', requireUser(), async (req, res, next) => {
    try {
      const parsed = EndpointSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'invalid_request' });
      const d = await findOwnDevice(req.user!.id, parsed.data.endpoint);
      return res.json(d ? { on: true, device: publicDevice(d) } : { on: false });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/devices/remove', requireUser(), async (req, res, next) => {
    try {
      const parsed = EndpointSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'invalid_request' });
      const d = await findOwnDevice(req.user!.id, parsed.data.endpoint);
      if (!d) return res.json({ removed: false });
      await prisma.staffPushSubscription.deleteMany({ where: { id: d.id } });
      await recordAudit({
        userId: req.user!.id,
        action: 'STAFF_PUSH_UNSUBSCRIBED',
        resourceType: 'staff_push_device',
        resourceId: d.id,
        metadata: { deviceId: d.id, label: d.label, pushService: pushServiceHost(d.endpoint) },
        ipAddress: ip(req),
      });
      return res.json({ removed: true });
    } catch (err) {
      return next(err);
    }
  });

  // One notification to the caller's own device, so they can see it works (and, on an
  // iPhone, that the Home Screen app is the one subscribed). Never reaches anyone else.
  router.post('/devices/test', requireUser(), testPerMinute, testPerHour, async (req, res, next) => {
    try {
      const parsed = EndpointSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'invalid_request' });
      const d = await findOwnDevice(req.user!.id, parsed.data.endpoint);
      if (!d) return res.status(404).json({ error: 'not_found', message: 'This device is not set up. Tap Notify me on this device first.' });
      const base = (env.appBaseUrl || cfg().assetBaseUrl || 'https://push.taxscan.in').replace(/\/+$/, '');
      const icon = DEFAULT_NOTIFICATION_ICON;
      const r = await pushToStaffDevice(
        d,
        {
          title: 'Notifications are on',
          body: 'This device will get the digest approval alerts.',
          url: `${base}/admin/digests`,
          icon,
          badge: DEFAULT_NOTIFICATION_BADGE,
          tag: 'taxscan-staff-test',
          kind: 'staff_test',
        },
        transport(),
      );
      if (r.outcome === 'delivered') return res.json({ ok: true });
      if (r.outcome === 'pruned') {
        return res.status(410).json({ error: 'device_gone', message: 'The browser no longer accepts notifications for this device. Tap Notify me on this device again.' });
      }
      return res.status(502).json({ error: 'push_failed', message: 'Could not reach this device. Try again in a minute.' });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}
