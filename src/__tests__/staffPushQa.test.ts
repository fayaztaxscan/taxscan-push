import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';
import type { User } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { parseDigestEnv, type DigestEnv } from '../lib/env';
import type { SendOutcome } from '../lib/push';
import { ensureRun } from '../services/digest/runner';
import { pushDigestAlerts } from '../services/digest/alerts';
import { activeStaffDevices, MAX_DEVICES_PER_USER, upsertStaffDevice, type StaffPushTransport } from '../services/staffPush';
import { validKeys } from './helpers';

/**
 * QA of 0032030 (digest task 14): guards that survived mutation testing with the
 * developer's suite — the per-user device cap and the 3-attempt limit — plus the
 * staff worker's tap-URL rule against crafted payloads (the VAPID private key is on
 * the Railway-breach rotation list, so a forged push is not hypothetical).
 * Users `staffpushqa-*@team.test`, devices under `https://staff-push-qa.test/…`,
 * portals `test-staffpushqa-*`; all removed afterwards. No audit rows are written.
 */

jest.spyOn(console, 'log').mockImplementation(() => undefined);
jest.spyOn(console, 'warn').mockImplementation(() => undefined);

const IST_OFFSET_MIN = 5 * 60 + 30;
const userIds: string[] = [];
const portals: string[] = [];

function ist(h: number, min = 0, day = 23): Date {
  return new Date(Date.UTC(2026, 9, day, h, min) - IST_OFFSET_MIN * 60 * 1000);
}
function cfg(): DigestEnv {
  return parseDigestEnv({ DIGEST_ENABLED: 'true', DIGEST_SEND_LIVE: 'true', DIGEST_ASSET_BASE_URL: 'https://push.taxscan.in' });
}
function endpoint(tag: string): string {
  return `https://staff-push-qa.test/send/${tag}-${randomBytes(8).toString('hex')}`;
}
async function makeUser(tag: string): Promise<User> {
  const u = await prisma.user.create({
    data: {
      email: `staffpushqa-${tag}-${Date.now()}-${randomBytes(3).toString('hex')}@team.test`,
      passwordHash: await bcrypt.hash('StaffPushQaPassword123!', 4),
      role: 'PUBLISHER',
      isActive: true,
    },
  });
  userIds.push(u.id);
  return u;
}
const mine = async () => (await activeStaffDevices()).filter((d) => userIds.includes(d.userId));

afterAll(async () => {
  await prisma.staffPushSubscription.deleteMany({ where: { userId: { in: userIds } } });
  if (portals.length) await prisma.digestRun.deleteMany({ where: { portal: { in: portals } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe('device lifecycle', () => {
  it(`the ${MAX_DEVICES_PER_USER + 1}th device drops the least recently refreshed one; the others stay`, async () => {
    const u = await makeUser('cap');
    const eps: string[] = [];
    for (let i = 0; i <= MAX_DEVICES_PER_USER; i += 1) {
      const ep = endpoint(`cap${i}`);
      eps.push(ep);
      await upsertStaffDevice(u.id, { endpoint: ep, keys: validKeys() }, 'Chrome on Mac');
      await new Promise((r) => setTimeout(r, 5)); // distinct updatedAt
    }
    const rows = await prisma.staffPushSubscription.findMany({ where: { userId: u.id }, select: { endpoint: true } });
    expect(rows).toHaveLength(MAX_DEVICES_PER_USER);
    expect(rows.map((r) => r.endpoint)).not.toContain(eps[0]);
    expect(rows.map((r) => r.endpoint).sort()).toEqual(eps.slice(1).sort());
  });
});

describe('the push pass gives up after 3 attempts', () => {
  it('a device that keeps failing is tried 3 times, 10 minutes apart, then never again', async () => {
    const u = await makeUser('attempts');
    await upsertStaffDevice(u.id, { endpoint: endpoint('attempts'), keys: validKeys() }, 'Chrome on Mac');
    const portal = `test-staffpushqa-${Date.now()}-${randomBytes(3).toString('hex')}`;
    portals.push(portal);
    const run = await ensureRun({ portal, now: ist(8, 30), cfg: cfg() });
    await prisma.digestRun.update({
      where: { id: run.id },
      data: { alerts: { not_approved_yet: { raisedAt: ist(8, 30).toISOString(), emailedAt: null } } },
    });
    let sent = 0;
    const transport: StaffPushTransport = async (): Promise<SendOutcome> => {
      sent += 1;
      return { ok: false, expired: false, failed: true, statusCode: 503 };
    };
    const devices = async () => (await mine()).filter((d) => d.userId === u.id);
    const deps = { enabled: true, transport, devices, cfg: cfg() };
    for (const [h, m] of [[8, 30], [8, 41], [8, 52], [9, 3], [9, 14]] as const) {
      expect(await pushDigestAlerts(run.id, { ...deps, now: ist(h, m) })).toEqual([]);
    }
    expect(sent).toBe(3);
    const r = await prisma.digestRun.findUnique({ where: { id: run.id }, select: { alerts: true } });
    expect((r!.alerts as Record<string, Record<string, unknown>>).not_approved_yet.pushAttempts).toBe(3);
  });
});

describe('the staff worker only ever opens its own /admin/ pages', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'public', 'admin', 'sw-staff.js'), 'utf8');
  type Handler = (e: unknown) => void;
  function load(origin = 'https://push.taxscan.in') {
    const handlers: Record<string, Handler> = {};
    const shown: { title: string; options: { data: { url: string } } }[] = [];
    const self = {
      location: { origin },
      addEventListener: (t: string, h: Handler) => void (handlers[t] = h),
      skipWaiting: () => undefined,
      registration: { showNotification: async (title: string, options: { data: { url: string } }) => void shown.push({ title, options }) },
      clients: { claim: async () => undefined },
    };
    const ctx = vm.createContext({ self, URL, atob });
    vm.runInContext(src, ctx);
    return { safe: (ctx as unknown as { safeAdminUrl: (u: unknown) => string }).safeAdminUrl, handlers, shown };
  }

  it.each([
    ['https://evil.example/admin/digests', 'https://push.taxscan.in/admin/digests'], // another host: own origin forced
    ['https://evil.example/phish', 'https://push.taxscan.in/admin/digests'],
    ['//evil.example/x', 'https://push.taxscan.in/admin/digests'],
    ['javascript:alert(1)', 'https://push.taxscan.in/admin/digests'],
    ['data:text/html,<script>alert(1)</script>', 'https://push.taxscan.in/admin/digests'],
    ['/admin/../api/staff-push/status', 'https://push.taxscan.in/admin/digests'], // dot-segments normalised away
    ['/admin/%2e%2e/api/x', 'https://push.taxscan.in/admin/digests'],
    ['/admin', 'https://push.taxscan.in/admin/digests'], // not under /admin/
    ['https://push.taxscan.in/admin/digests?day=2026-10-23#x', 'https://push.taxscan.in/admin/digests?day=2026-10-23'],
    ['not a url at all', 'https://push.taxscan.in/admin/digests'],
  ])('%s → %s', (input, want) => {
    expect(load().safe(input)).toBe(want);
  });

  it('a crafted push payload is shown with its url rewritten to the own-origin admin page', async () => {
    const w = load();
    let done: Promise<unknown> = Promise.resolve();
    w.handlers.push({ data: { json: () => ({ title: 'x', url: 'https://evil.example/admin/../../steal' }) }, waitUntil: (p: Promise<unknown>) => void (done = p) });
    await done;
    expect(w.shown[0].options.data.url).toBe('https://push.taxscan.in/admin/digests');
  });

  it('registers no fetch handler (the admin’s requests and caching are never intercepted)', () => {
    expect(Object.keys(load().handlers).sort()).toEqual(['activate', 'install', 'notificationclick', 'push', 'pushsubscriptionchange']);
  });
});
