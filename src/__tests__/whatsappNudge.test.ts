import bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';
import type { User, UserRole } from '@prisma/client';
import cron from 'node-cron';
import { prisma } from '../lib/prisma';
import { env } from '../lib/env';
import type { PushPayload, SendOutcome } from '../lib/push';
import { activeStaffDevices, type StaffPushTransport } from '../services/staffPush';
import { runWhatsAppNudge, startWhatsAppNudge, NUDGE_KEY, NUDGE_TAG } from '../services/whatsapp/nudge';
import { istDay } from '../services/whatsapp/queue';
import { validKeys } from './helpers';

/**
 * Brief 2026-11-02-social-menu-channels-nudge, acceptance 5–7: the WhatsApp "articles waiting" nudge. A fake clock and a
 * fake queue drive the timing; devices and users are real rows (removed afterwards); the transport only records.
 */
const logs: string[] = [];
jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

const RUN = `${Date.now()}-${randomBytes(3).toString('hex')}`;
const PASSWORD = 'nudge-test-pw-1';
const IST_MS = (5 * 60 + 30) * 60_000;
const ist = (h: number, m = 0, day = 3) => new Date(Date.UTC(2026, 10, day, h, m) - IST_MS);
const PORTAL = 'taxscan';

const userIds: string[] = [];
let n = 0;
async function makeUser(role: UserRole, isActive = true): Promise<User> {
  const u = await prisma.user.create({ data: { email: `nudge-${role.toLowerCase()}-${RUN}-${++n}@team.test`, passwordHash: await bcrypt.hash(PASSWORD, 4), role, isActive } });
  userIds.push(u.id);
  return u;
}
const endpoints = new Set<string>();
async function device(u: User, kinds: string[]) {
  const k = validKeys();
  const endpoint = `https://nudge-test.example/send/${RUN}-${++n}`;
  endpoints.add(endpoint);
  return prisma.staffPushSubscription.create({ data: { userId: u.id, endpoint, p256dh: k.p256dh, auth: k.auth, label: 'Chrome on Android', kinds } });
}

type Row = { pushedAt: string; headline: string; status: 'TODO' | 'POSTED' | 'SKIPPED' };
let rows: Row[] = [];
const queueFor = async (_portal: string, day: string) => ({ rows: rows.filter((r) => istDay(new Date(r.pushedAt)) === day) as never[] });
const add = (at: Date, headline: string, status: Row['status'] = 'TODO') => rows.push({ pushedAt: at.toISOString(), headline, status });

let sent: { endpoint: string; payload: PushPayload }[] = [];
let answer: (endpoint: string) => SendOutcome = () => ({ ok: true, statusCode: 201 });
const transport: StaffPushTransport = async (sub, payload) => {
  if (endpoints.has(sub.endpoint)) sent.push({ endpoint: sub.endpoint, payload });
  return endpoints.has(sub.endpoint) ? answer(sub.endpoint) : { ok: true, statusCode: 201 };
};
const tick = (now: Date) => runWhatsAppNudge({ now: () => now, enabled: true, portal: () => PORTAL, transport, queueFor, devices: mineDevices, quiet: { start: '23:00', end: '07:00' } });
const mineSent = () => sent.map((s) => s.endpoint);

/** Only this file's devices (the real query, filtered to our users): other suites share the database. */
const mineDevices = async () => (await activeStaffDevices('whatsapp')).filter((x) => userIds.includes(x.userId));

let admin: User;
let publisher: User;
let devA: Awaited<ReturnType<typeof device>>;
beforeAll(async () => {
  admin = await makeUser('ADMIN');
  publisher = await makeUser('PUBLISHER');
});
beforeEach(async () => {
  rows = [];
  sent = [];
  answer = () => ({ ok: true, statusCode: 201 });
  logs.length = 0;
  await prisma.digestSetting.deleteMany({ where: { key: NUDGE_KEY } });
  await prisma.staffPushSubscription.deleteMany({ where: { userId: { in: userIds } } });
  devA = await device(publisher, ['whatsapp']);
});
afterAll(async () => {
  await prisma.digestSetting.deleteMany({ where: { key: NUDGE_KEY } });
  await prisma.staffPushSubscription.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL audit_log.allow_purge = 'true'`);
    await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "userId" = ANY(${userIds}::text[])`;
  });
  await prisma.userSession.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe('5. timing (fake clock)', () => {
  it('a new To-do article at 10:00 → one nudge: the count in the title, the newest headline as the body, the WhatsApp screen, one tag', async () => {
    add(ist(9, 58), 'Supreme Court holds the ITC claim valid');
    const r = await tick(ist(10, 0));
    expect(r).toMatchObject({ sent: true, waiting: 1, devices: 1, delivered: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0].payload).toMatchObject({ title: 'WhatsApp: 1 article waiting', body: 'Supreme Court holds the ITC claim valid', tag: NUDGE_TAG, renotify: true });
    expect(String(sent[0].payload.url)).toMatch(/\/admin\/whatsapp$/);
    expect(NUDGE_TAG).toBe('whatsapp-queue');
    expect(logs.join('\n')).toContain('[whatsapp-nudge] waiting=1 devices=1 delivered=1');
  });
  it('another at 10:04 → nothing until 10:10, then ONE nudge with N=2; marking everything Posted → no more', async () => {
    add(ist(9, 58), 'First story');
    expect((await tick(ist(10, 0))).sent).toBe(true);
    add(ist(10, 4), 'Second story');
    expect(await tick(ist(10, 5))).toEqual({ sent: false, reason: 'too_soon' });
    expect(await tick(ist(10, 9))).toEqual({ sent: false, reason: 'too_soon' });
    const r = await tick(ist(10, 10));
    expect(r).toMatchObject({ sent: true, waiting: 2 });
    expect(sent).toHaveLength(2);
    expect(sent[1].payload).toMatchObject({ title: 'WhatsApp: 2 articles waiting', body: 'Second story' });
    expect(await tick(ist(10, 25))).toEqual({ sent: false, reason: 'nothing_new' }); // nothing new since
    add(ist(10, 30), 'Third story');
    for (const r2 of rows) r2.status = 'POSTED';
    expect(await tick(ist(10, 40))).toEqual({ sent: false, reason: 'nothing_new' }); // all Posted: nothing waiting
    expect(sent).toHaveLength(2);
  });
  it('a long headline is cut to 100 characters', async () => {
    add(ist(9, 58), 'A'.repeat(130));
    await tick(ist(10, 0));
    expect(String(sent[0].payload.body)).toHaveLength(100);
    expect(String(sent[0].payload.body).endsWith('…')).toBe(true);
  });
  it('23:30 → nothing; at 07:00 a Breaking article from the night nudges once', async () => {
    add(ist(23, 28), 'Breaking: night ruling'); // pushed at night (Breaking only)
    expect(await tick(ist(23, 30))).toEqual({ sent: false, reason: 'quiet' });
    expect(await tick(ist(3, 0, 4))).toEqual({ sent: false, reason: 'quiet' });
    expect(sent).toHaveLength(0);
    const r = await tick(ist(7, 0, 4));
    expect(r).toMatchObject({ sent: true, waiting: 1 });
    expect(sent[0].payload).toMatchObject({ title: 'WhatsApp: 1 article waiting', body: 'Breaking: night ruling' });
    expect(await tick(ist(7, 5, 4))).toEqual({ sent: false, reason: 'nothing_new' });
  });
  it('a restart between ticks does not repeat a nudge (the watermark is in Postgres)', async () => {
    add(ist(9, 58), 'Story one');
    await tick(ist(10, 0));
    const row = await prisma.digestSetting.findUnique({ where: { key: NUDGE_KEY } });
    expect(row).not.toBeNull();
    expect(JSON.parse(row!.value)).toMatchObject({ watermark: ist(9, 58).toISOString(), lastNudgeAt: ist(10, 0).toISOString() });
    // "restart": nothing in memory survives; the same articles are still waiting
    expect(await tick(ist(10, 20))).toEqual({ sent: false, reason: 'nothing_new' });
    expect(await tick(ist(10, 25))).toEqual({ sent: false, reason: 'nothing_new' });
    expect(sent).toHaveLength(1);
  });
  it('an article from the evening before (already told about) is not nudged again at 07:00', async () => {
    add(ist(21, 0, 2), 'Yesterday evening story');
    add(ist(21, 5, 2), 'Another', 'TODO');
    await prisma.digestSetting.create({ data: { key: NUDGE_KEY, value: JSON.stringify({ watermark: ist(21, 5, 2).toISOString(), lastNudgeAt: ist(21, 10, 2).toISOString() }) } });
    expect(await tick(ist(7, 0, 3))).toEqual({ sent: false, reason: 'nothing_new' });
  });
});

describe('6. who gets a nudge', () => {
  it('only devices opted in to WhatsApp, of active ADMIN / PUBLISHER users; the digest-only device and an inactive user\'s device get nothing', async () => {
    const digestOnly = await device(publisher, ['digest']);
    const both = await device(admin, ['digest', 'whatsapp']);
    const inactive = await makeUser('PUBLISHER', false);
    const gone = await device(inactive, ['whatsapp']);
    add(ist(9, 58), 'Story');
    const r = await tick(ist(10, 0));
    expect(r).toMatchObject({ sent: true, devices: 2, delivered: 2 });
    expect(new Set(mineSent())).toEqual(new Set([devA.endpoint, both.endpoint]));
    expect(mineSent()).not.toContain(digestOnly.endpoint);
    expect(mineSent()).not.toContain(gone.endpoint);
  });
  it('a 410 device is pruned and the others are still told', async () => {
    const dead = await device(admin, ['whatsapp']);
    answer = (e) => (e === dead.endpoint ? { ok: false, expired: true, statusCode: 410 } : { ok: true, statusCode: 201 });
    add(ist(9, 58), 'Story');
    const r = await tick(ist(10, 0));
    expect(r).toMatchObject({ sent: true, devices: 2, delivered: 1, pruned: 1 });
    expect(await prisma.staffPushSubscription.findUnique({ where: { id: dead.id } })).toBeNull();
    expect(await prisma.staffPushSubscription.findUnique({ where: { id: devA.id } })).not.toBeNull();
  });
  it('with nobody opted in nothing is sent and the watermark is not burned (the first opt-in is told about what waits)', async () => {
    await prisma.staffPushSubscription.deleteMany({ where: { userId: { in: userIds } } });
    add(ist(9, 58), 'Story');
    expect(await tick(ist(10, 0))).toEqual({ sent: false, reason: 'no_devices' });
    expect(await prisma.digestSetting.findUnique({ where: { key: NUDGE_KEY } })).toBeNull();
    devA = await device(publisher, ['whatsapp']);
    expect(await tick(ist(10, 5))).toMatchObject({ sent: true, delivered: 1 });
  });
});

describe('7. the flag', () => {
  it('the staff-push kill switch off → the tick does nothing', async () => {
    add(ist(9, 58), 'Story');
    expect(await runWhatsAppNudge({ now: () => ist(10, 0), enabled: false, portal: () => PORTAL, transport, queueFor, devices: mineDevices })).toEqual({ sent: false, reason: 'disabled' });
    expect(sent).toHaveLength(0);
  });
  it('WHATSAPP_NUDGE_ENABLED off → no tick is scheduled; on without the queue flag → refuses and says why', () => {
    const schedule = jest.spyOn(cron, 'schedule');
    const was = { nudge: env.whatsapp.nudgeEnabled, queue: env.whatsapp.queueEnabled };
    env.whatsapp.nudgeEnabled = false;
    startWhatsAppNudge();
    expect(schedule).not.toHaveBeenCalled();
    env.whatsapp.nudgeEnabled = true;
    env.whatsapp.queueEnabled = false;
    startWhatsAppNudge();
    expect(schedule).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('refusing to start');
    env.whatsapp.queueEnabled = true;
    startWhatsAppNudge();
    expect(schedule).toHaveBeenCalledWith('*/5 * * * *', expect.any(Function));
    Object.assign(env.whatsapp, { nudgeEnabled: was.nudge, queueEnabled: was.queue });
    schedule.mockRestore();
  });
});

describe('the real queue feeds the nudge', () => {
  it('counts To-do articles from Campaign / WhatsAppPost via getQueue (no fake queue)', async () => {
    const url = `https://www.taxscan.in/gst/nudge-real-${RUN}`;
    const c = await prisma.campaign.create({ data: { portal: PORTAL, title: 'Real queue story', body: 'b', url, target: {}, status: 'SENT', lastSentAt: ist(9, 58) } });
    try {
      const r = await runWhatsAppNudge({ now: () => ist(10, 0), enabled: true, portal: () => PORTAL, transport, devices: mineDevices, quiet: { start: '23:00', end: '07:00' } });
      expect(r).toMatchObject({ sent: true });
      expect(sent[0].payload.body).toBe('Real queue story');
    } finally {
      await prisma.campaign.delete({ where: { id: c.id } });
    }
  });
});
