import type { StaffPushSubscription } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { deliverPush, type DeliverOptions, type PushPayload, type SendOutcome } from '../lib/push';

/**
 * Staff push devices (docs/EMAIL_DIGEST_DESIGN.md §13 task 14): a staff member's
 * own browser or phone, opted in from the admin, gets the digest's approval
 * notifications. Generic plumbing only — what to send and when is decided by the
 * digest's alert pass (`digest/alerts.ts`, `pushDigestAlerts`).
 *
 * Kept apart from readers on purpose:
 *  - its own table (`StaffPushSubscription`), so no subscriber metric, backup or
 *    campaign send (pacer, /api/send, sweeper, Queue / Review Push now — they all
 *    select from `Subscriber`) can ever see one of these rows;
 *  - the same VAPID keypair and `web-push` library (`deliverPush`), but its own
 *    404/410 rule: the row is deleted (a reader row is marked EXPIRED instead);
 *  - only ACTIVE users' devices are sent to, and deactivation deletes them.
 *
 * Never logs an endpoint or a push-service reply body: only the device id and
 * the HTTP status.
 */

export type StaffPushTransport = (
  sub: { endpoint: string; p256dh: string; auth: string },
  payload: PushPayload,
  options?: DeliverOptions,
) => Promise<SendOutcome>;

let defaultTransport: StaffPushTransport = deliverPush;

/** E2E_MOCK_SENDER (src/index.ts): swap web-push for an in-memory success, like reader sends. */
export function setStaffPushTransport(t: StaffPushTransport): void {
  defaultTransport = t;
}

/** The transport used when a caller passes none. */
export function staffPushTransport(): StaffPushTransport {
  return defaultTransport;
}

/** How long a push service keeps an undelivered staff notification (phone off overnight). */
export const STAFF_PUSH_TTL_SECONDS = 4 * 60 * 60;
const STAFF_PUSH_TIMEOUT_MS = 10_000;
/** A user may have this many devices; the least recently updated beyond it is dropped. */
export const MAX_DEVICES_PER_USER = 10;

/** "Chrome on Android" — a short, non-identifying label from a user agent. */
export function staffDeviceLabel(userAgent: string | undefined | null): string {
  const ua = userAgent ?? '';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /CriOS\/|Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'Browser';
  const os = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Mac OS X|Macintosh/.test(ua)
            ? 'Mac'
            : /Linux/.test(ua)
              ? 'Linux'
              : 'unknown device';
  return `${browser} on ${os}`;
}

/** The push service's host only ("fcm.googleapis.com") — for audit rows; never the endpoint. */
export function pushServiceHost(endpoint: string): string {
  try {
    return new URL(endpoint).host || 'unknown';
  } catch {
    return 'unknown';
  }
}

export type StaffSubscriptionInput = { endpoint: string; keys: { p256dh: string; auth: string } };

/** A device dropped at the per-user limit: id, label and push-service host — never the endpoint. */
export type EvictedDevice = { id: string; label: string | null; pushService: string };

/**
 * Stores (or refreshes) a device for `userId`. One row per endpoint: the same
 * browser re-subscribing updates its row, and a browser now used under another
 * login moves to that user. Returns the row, whether it was new, and the
 * devices dropped to stay within MAX_DEVICES_PER_USER (least recently updated
 * first; normally none, at most one per new device) so the caller can audit
 * and tell the user.
 */
export async function upsertStaffDevice(
  userId: string,
  sub: StaffSubscriptionInput,
  label: string,
): Promise<{ device: StaffPushSubscription; created: boolean; movedFromUserId: string | null; evicted: EvictedDevice[] }> {
  const existing = await prisma.staffPushSubscription.findUnique({ where: { endpoint: sub.endpoint }, select: { userId: true } });
  const device = await prisma.staffPushSubscription.upsert({
    where: { endpoint: sub.endpoint },
    create: { userId, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, label },
    update: { userId, p256dh: sub.keys.p256dh, auth: sub.keys.auth, label, failureCount: 0 },
  });
  // Bound the rows per user (a browser that rotates its endpoint leaves the old one behind
  // until a send prunes it): keep the most recently updated MAX_DEVICES_PER_USER.
  const extra = await prisma.staffPushSubscription.findMany({
    where: { userId },
    orderBy: { updatedAt: 'desc' },
    skip: MAX_DEVICES_PER_USER,
    select: { id: true, label: true, endpoint: true, updatedAt: true },
  });
  let evicted: EvictedDevice[] = [];
  if (extra.length) {
    const r = await prisma.staffPushSubscription.deleteMany({ where: { id: { in: extra.map((x) => x.id) } } });
    // Oldest first. A concurrent delete may have removed one already; report what we found.
    if (r.count > 0) {
      evicted = extra
        .sort((x, y) => x.updatedAt.getTime() - y.updatedAt.getTime())
        .map((x) => ({ id: x.id, label: x.label, pushService: pushServiceHost(x.endpoint) }));
    }
  }
  return { device, created: existing === null, movedFromUserId: existing && existing.userId !== userId ? existing.userId : null, evicted };
}

/** The caller's own device by endpoint, or null (another user's device is never returned). */
export async function findOwnDevice(userId: string, endpoint: string): Promise<StaffPushSubscription | null> {
  const d = await prisma.staffPushSubscription.findUnique({ where: { endpoint } });
  return d && d.userId === userId ? d : null;
}

/** Deletes every device of a user (deactivation, or an admin's "Remove devices"). Returns the count. */
export async function removeAllStaffDevices(userId: string): Promise<number> {
  const r = await prisma.staffPushSubscription.deleteMany({ where: { userId } });
  return r.count;
}

export type DeviceSummary = { count: number; lastSuccessAt: Date | null };

/** Per user: how many devices, and the latest successful delivery to any of them. */
export async function staffDeviceSummaries(userIds: string[]): Promise<Map<string, DeviceSummary>> {
  const out = new Map<string, DeviceSummary>();
  if (userIds.length === 0) return out;
  const rows = await prisma.staffPushSubscription.groupBy({
    by: ['userId'],
    where: { userId: { in: userIds } },
    _count: { _all: true },
    _max: { lastSuccessAt: true },
  });
  for (const r of rows) out.set(r.userId, { count: r._count._all, lastSuccessAt: r._max.lastSuccessAt ?? null });
  return out;
}

/** Devices that may receive a staff push: their user is active (both roles may approve). */
export async function activeStaffDevices(): Promise<StaffPushSubscription[]> {
  return prisma.staffPushSubscription.findMany({
    where: { user: { isActive: true, role: { in: ['ADMIN', 'PUBLISHER'] } } },
    orderBy: { createdAt: 'asc' },
  });
}

export type DeviceResult = { deviceId: string; outcome: 'delivered' | 'pruned' | 'failed'; statusCode?: number };

/**
 * Sends one notification to one staff device and records the result on its row:
 * success → `lastSuccessAt`, failures reset; 404/410 → the row is deleted (the
 * hard rule: prune dead subscriptions); anything else → `failureCount` + 1.
 * Never throws.
 */
export async function pushToStaffDevice(
  device: Pick<StaffPushSubscription, 'id' | 'endpoint' | 'p256dh' | 'auth'>,
  payload: PushPayload,
  transport: StaffPushTransport = defaultTransport,
): Promise<DeviceResult> {
  let outcome: SendOutcome;
  try {
    outcome = await transport(device, payload, { TTL: STAFF_PUSH_TTL_SECONDS, urgency: 'high', timeout: STAFF_PUSH_TIMEOUT_MS });
  } catch {
    outcome = { ok: false, expired: false, failed: true };
  }
  const now = new Date();
  try {
    if (outcome.ok) {
      await prisma.staffPushSubscription.updateMany({ where: { id: device.id }, data: { lastSuccessAt: now, failureCount: 0 } });
      return { deviceId: device.id, outcome: 'delivered', statusCode: outcome.statusCode };
    }
    if (outcome.expired) {
      await prisma.staffPushSubscription.deleteMany({ where: { id: device.id } });
      return { deviceId: device.id, outcome: 'pruned', statusCode: outcome.statusCode };
    }
    await prisma.staffPushSubscription.updateMany({
      where: { id: device.id },
      data: { lastFailureAt: now, failureCount: { increment: 1 } },
    });
  } catch {
    // The bookkeeping is best-effort; the delivery result stands.
  }
  if (outcome.ok) return { deviceId: device.id, outcome: 'delivered', statusCode: outcome.statusCode };
  if (outcome.expired) return { deviceId: device.id, outcome: 'pruned', statusCode: outcome.statusCode };
  return { deviceId: device.id, outcome: 'failed', ...(outcome.statusCode !== undefined ? { statusCode: outcome.statusCode } : {}) };
}

export type FanOutResult = { devices: number; delivered: number; pruned: number; failed: number; results: DeviceResult[] };

/** One notification to every active staff device, one at a time (a handful of devices). */
export async function pushToActiveStaff(
  payload: PushPayload,
  opts: { transport?: StaffPushTransport; devices?: () => Promise<StaffPushSubscription[]> } = {},
): Promise<FanOutResult> {
  const devices = await (opts.devices ?? activeStaffDevices)();
  const results: DeviceResult[] = [];
  for (const d of devices) results.push(await pushToStaffDevice(d, payload, opts.transport ?? defaultTransport));
  return {
    devices: devices.length,
    delivered: results.filter((r) => r.outcome === 'delivered').length,
    pruned: results.filter((r) => r.outcome === 'pruned').length,
    failed: results.filter((r) => r.outcome === 'failed').length,
    results,
  };
}
