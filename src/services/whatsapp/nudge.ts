import cron from 'node-cron';
import { prisma } from '../../lib/prisma';
import { env } from '../../lib/env';
import { safeErrorLog } from '../../lib/httpErrors';
import { isQuietHours } from '../../lib/quietHours';
import { DEFAULT_NOTIFICATION_BADGE, DEFAULT_NOTIFICATION_ICON } from '../send';
import { activeStaffDevices, pushToStaffDevice, staffPushTransport, type StaffPushTransport } from '../staffPush';
import { getQueue, istDay, istDayBounds, type QueueRow } from './queue';

/**
 * The WhatsApp "articles waiting" nudge (brief 2026-11-02-social-menu-channels-nudge).
 *
 * WhatsApp posting is manual, so a 5-minute tick tells opted-in staff devices when new articles are waiting. It reads the
 * queue's own logic (`getQueue`), never Event, and sends ONE staff notification per nudge:
 *   title "WhatsApp: N articles waiting"   body = the newest waiting headline (≤ 100 chars)
 *   url /admin/whatsapp                    tag `whatsapp-queue` (a new nudge replaces the old one on the phone)
 *
 * Rules: a nudge only when a To-do article was pushed AFTER the last nudge (the watermark); at most one every 10 minutes
 * (a second article inside the window waits for the next tick and is counted in it); nothing 23:00–07:00 IST, and the first
 * tick after 07:00 nudges once for anything the night (Breaking) left waiting. The watermark and the last nudge time live
 * in `DigestSetting` under `whatsapp_nudge_watermark`, so a restart can't repeat a nudge.
 * Only devices that opted in to the 'whatsapp' kind (active ADMIN / PUBLISHER users) are told; a 404/410 device is pruned.
 */

export const NUDGE_KEY = 'whatsapp_nudge_watermark';
export const NUDGE_MIN_GAP_MS = 10 * 60_000;
export const NUDGE_HEADLINE_MAX = 100;
export const NUDGE_TAG = 'whatsapp-queue';
const NIGHT_START_MS_BEFORE_MIDNIGHT = 60 * 60_000; // 23:00 IST = 1 h before midnight

type State = { watermark: string; lastNudgeAt: string | null };

export type NudgeDeps = {
  now?: () => Date;
  portal?: () => string;
  transport?: StaffPushTransport;
  /** The devices to tell; default every active ADMIN / PUBLISHER device that opted in to 'whatsapp'. */
  devices?: () => ReturnType<typeof activeStaffDevices>;
  /** The staff-push kill switch (DIGEST_STAFF_PUSH_ENABLED); default env.staffPush.enabled. Off = the tick does nothing. */
  enabled?: boolean;
  /** Quiet hours; default env.send.quietStart / quietEnd. */
  quiet?: { start: string; end: string };
  /** Overrides for tests; default reads the Campaign queue. */
  queueFor?: (portal: string, day: string) => Promise<{ rows: QueueRow[] }>;
};

export type NudgeResult =
  | { sent: false; reason: 'disabled' | 'quiet' | 'nothing_new' | 'too_soon' | 'no_devices' }
  | { sent: true; waiting: number; devices: number; delivered: number; pruned: number; failed: number };

async function readState(): Promise<State | null> {
  const row = await prisma.digestSetting.findUnique({ where: { key: NUDGE_KEY } });
  if (!row) return null;
  try {
    const v = JSON.parse(row.value) as Partial<State>;
    return v.watermark ? { watermark: v.watermark, lastNudgeAt: v.lastNudgeAt ?? null } : null;
  } catch {
    return null;
  }
}
async function writeState(s: State): Promise<void> {
  const value = JSON.stringify(s);
  await prisma.digestSetting.upsert({ where: { key: NUDGE_KEY }, create: { key: NUDGE_KEY, value }, update: { value } });
}

const clip = (s: string): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > NUDGE_HEADLINE_MAX ? `${t.slice(0, NUDGE_HEADLINE_MAX - 1)}…` : t;
};
const plural = (n: number): string => `${n} article${n === 1 ? '' : 's'}`;

/** One tick. Never throws past the caller's try/catch; everything it needs is in Postgres. */
export async function runWhatsAppNudge(d: NudgeDeps = {}): Promise<NudgeResult> {
  const now = (d.now ?? (() => new Date()))();
  if (!(d.enabled ?? env.staffPush.enabled)) return { sent: false, reason: 'disabled' };
  const quiet = d.quiet ?? { start: env.send.quietStart, end: env.send.quietEnd };
  if (isQuietHours(now, quiet.start, quiet.end)) return { sent: false, reason: 'quiet' };

  const portal = (d.portal ?? (() => env.rss.portal))();
  const queueFor = d.queueFor ?? getQueue;
  const today = istDay(now);
  const todayStart = istDayBounds(today).start;
  const yesterday = istDay(new Date(todayStart.getTime() - 1));
  const nightStart = new Date(todayStart.getTime() - NIGHT_START_MS_BEFORE_MIDNIGHT);

  // Today's list, plus what yesterday's night (after 23:00) left waiting: a Breaking push at 23:30 is on yesterday's list.
  const [t, y] = await Promise.all([queueFor(portal, today), queueFor(portal, yesterday)]);
  const waiting = [...y.rows.filter((r) => Date.parse(r.pushedAt) >= nightStart.getTime()), ...t.rows].filter((r) => r.status === 'TODO');
  if (waiting.length === 0) return { sent: false, reason: 'nothing_new' };

  const state = await readState();
  // No stored watermark yet (first ever tick): what is waiting since last night's 23:00 counts as new.
  const watermark = state ? Date.parse(state.watermark) : nightStart.getTime();
  const fresh = waiting.filter((r) => Date.parse(r.pushedAt) > watermark);
  if (fresh.length === 0) return { sent: false, reason: 'nothing_new' };
  if (state?.lastNudgeAt && now.getTime() - Date.parse(state.lastNudgeAt) < NUDGE_MIN_GAP_MS) return { sent: false, reason: 'too_soon' };

  const devices = await (d.devices ?? (() => activeStaffDevices('whatsapp')))();
  if (devices.length === 0) return { sent: false, reason: 'no_devices' }; // nobody opted in: don't burn the watermark

  const newest = waiting.reduce((a, b) => (Date.parse(b.pushedAt) > Date.parse(a.pushedAt) ? b : a));
  const base = (env.appBaseUrl || 'https://push.taxscan.in').replace(/\/+$/, '');
  const payload = {
    title: `WhatsApp: ${plural(waiting.length)} waiting`,
    body: clip(newest.headline),
    url: `${base}/admin/whatsapp`,
    icon: DEFAULT_NOTIFICATION_ICON,
    badge: DEFAULT_NOTIFICATION_BADGE,
    tag: NUDGE_TAG,
    renotify: true,
    kind: 'whatsapp_nudge',
  };
  const transport = d.transport ?? staffPushTransport();
  const results = [];
  for (const dev of devices) results.push(await pushToStaffDevice(dev, payload, transport));
  const out = {
    waiting: waiting.length,
    devices: devices.length,
    delivered: results.filter((r) => r.outcome === 'delivered').length,
    pruned: results.filter((r) => r.outcome === 'pruned').length,
    failed: results.filter((r) => r.outcome === 'failed').length,
  };
  // The watermark moves to the newest fresh article, so a restart (or the next tick) can't tell about the same ones again.
  const newestFresh = fresh.reduce((a, b) => Math.max(a, Date.parse(b.pushedAt)), 0);
  await writeState({ watermark: new Date(newestFresh).toISOString(), lastNudgeAt: now.toISOString() });
  // eslint-disable-next-line no-console
  console.log(`[whatsapp-nudge] waiting=${out.waiting} devices=${out.devices} delivered=${out.delivered}`);
  return { sent: true, ...out };
}

let ticking = false;

/** Started like the other crons: only when WHATSAPP_NUDGE_ENABLED and WHATSAPP_QUEUE_ENABLED are on. */
export function startWhatsAppNudge(): void {
  if (!env.whatsapp.nudgeEnabled) {
    // eslint-disable-next-line no-console
    console.log('[whatsapp-nudge] disabled (set WHATSAPP_NUDGE_ENABLED=true to start)');
    return;
  }
  if (!env.whatsapp.queueEnabled) {
    console.error('[whatsapp-nudge] refusing to start: WHATSAPP_QUEUE_ENABLED is off (there is no queue to nudge about)');
    return;
  }
  cron.schedule('*/5 * * * *', async () => {
    if (ticking) return;
    ticking = true;
    try {
      await runWhatsAppNudge();
    } catch (err) {
      console.error('[whatsapp-nudge] tick failed', safeErrorLog(err));
    } finally {
      ticking = false;
    }
  });
  // eslint-disable-next-line no-console
  console.log('[whatsapp-nudge] started (every 5 minutes)');
}
