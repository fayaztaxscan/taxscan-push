import bcrypt from 'bcrypt';
import request from 'supertest';
import { randomBytes } from 'node:crypto';
import type { User, UserRole } from '@prisma/client';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { env, parseDigestEnv } from '../lib/env';
import type { PushPayload } from '../lib/push';
import { activeStaffDevices, pushToActiveStaff, type StaffPushTransport } from '../services/staffPush';
import { ensureRun } from '../services/digest/runner';
import { pushDigestAlerts } from '../services/digest/alerts';
import { validKeys } from './helpers';

/**
 * Brief 2026-11-02-social-menu-channels-nudge, acceptance 4: staff device KINDS. An existing device (the migration default)
 * keeps getting digest alerts and no nudges; a WhatsApp-only device gets nudges and no digest alerts; both kinds → both.
 */
jest.spyOn(console, 'log').mockImplementation(() => undefined);
jest.spyOn(console, 'warn').mockImplementation(() => undefined);

const RUN = `${Date.now()}-${randomBytes(3).toString('hex')}`;
const PASSWORD = 'kinds-test-pw-1';
const userIds: string[] = [];
const portals: string[] = [];
let n = 0;
const endpoints = new Set<string>();
const loginApp = createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 } });
const app = createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 }, staffPush: { enabled: true } });

async function makeUser(role: UserRole, isActive = true): Promise<User> {
  const u = await prisma.user.create({ data: { email: `kinds-${role.toLowerCase()}-${RUN}-${++n}@team.test`, passwordHash: await bcrypt.hash(PASSWORD, 4), role, isActive } });
  userIds.push(u.id);
  return u;
}
async function cookieFor(u: User): Promise<string> {
  const res = await request(loginApp).post('/api/auth/login').send({ email: u.email, password: PASSWORD });
  expect(res.status).toBe(200);
  const sc = res.headers['set-cookie'];
  return (Array.isArray(sc) ? sc : [sc as unknown as string]).map((l) => l.split(';')[0]).join('; ');
}
const ep = () => {
  const e = `https://kinds-test.example/send/${RUN}-${++n}`;
  endpoints.add(e);
  return e;
};
const mine = (ds: { endpoint: string }[]) => ds.filter((d) => endpoints.has(d.endpoint)).map((d) => d.endpoint);

let publisher: User;
let cookie: string;
beforeAll(async () => {
  publisher = await makeUser('PUBLISHER');
  cookie = await cookieFor(publisher);
});
afterAll(async () => {
  if (portals.length) await prisma.digestRun.deleteMany({ where: { portal: { in: portals } } });
  await prisma.staffPushSubscription.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL audit_log.allow_purge = 'true'`);
    await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "userId" = ANY(${userIds}::text[])`;
  });
  await prisma.userSession.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe('4. which devices get which alerts', () => {
  it('a device created with no kinds (every device before kinds, and the migration default) is a digest device only', async () => {
    const k = validKeys();
    const e = ep();
    const d = await prisma.staffPushSubscription.create({ data: { userId: publisher.id, endpoint: e, p256dh: k.p256dh, auth: k.auth } });
    expect(d.kinds).toEqual(['digest']);
    expect(mine(await activeStaffDevices('digest'))).toContain(e);
    expect(mine(await activeStaffDevices('whatsapp'))).not.toContain(e);
    expect(mine(await activeStaffDevices())).toContain(e); // the default kind is digest
  });
  it('digest alerts reach digest and both-kind devices, never a WhatsApp-only one; a nudge the reverse', async () => {
    const mk = async (kinds: string[]) => {
      const k = validKeys();
      const e = ep();
      await prisma.staffPushSubscription.create({ data: { userId: publisher.id, endpoint: e, p256dh: k.p256dh, auth: k.auth, kinds } });
      return e;
    };
    const digestOnly = await mk(['digest']);
    const waOnly = await mk(['whatsapp']);
    const both = await mk(['digest', 'whatsapp']);
    const got: Record<string, string[]> = { digest: [], whatsapp: [] };
    for (const kind of ['digest', 'whatsapp'] as const) {
      const transport: StaffPushTransport = async (sub: { endpoint: string }) => {
        if (endpoints.has(sub.endpoint)) got[kind].push(sub.endpoint);
        return { ok: true, statusCode: 201 };
      };
      await pushToActiveStaff({ title: 't', body: 'b' } as PushPayload, { transport, kind });
    }
    expect(got.digest).toEqual(expect.arrayContaining([digestOnly, both]));
    expect(got.digest).not.toContain(waOnly);
    expect(got.whatsapp).toEqual(expect.arrayContaining([waOnly, both]));
    expect(got.whatsapp).not.toContain(digestOnly);
  });
  it('the digest alert pass itself only pushes to digest devices', async () => {
    const k = validKeys();
    const waOnly = ep();
    await prisma.staffPushSubscription.create({ data: { userId: publisher.id, endpoint: waOnly, p256dh: k.p256dh, auth: k.auth, kinds: ['whatsapp'] } });
    const k2 = validKeys();
    const dig = ep();
    await prisma.staffPushSubscription.create({ data: { userId: publisher.id, endpoint: dig, p256dh: k2.p256dh, auth: k2.auth, kinds: ['digest'] } });
    const portal = `test-kinds-${RUN}`;
    portals.push(portal);
    const now = new Date(Date.UTC(2026, 9, 23, 1, 0));
    const cfg = parseDigestEnv({ DIGEST_ENABLED: 'true', DIGEST_SEND_LIVE: 'true', DIGEST_ASSET_BASE_URL: 'https://push.taxscan.in' });
    const run = await ensureRun({ portal, now, cfg });
    await prisma.digestRun.update({ where: { id: run.id }, data: { alerts: { ready_for_approval: { raisedAt: now.toISOString(), emailedAt: null, audiences: ['FREE', 'PREMIUM'] } } } });
    const reached: string[] = [];
    const transport: StaffPushTransport = async (sub) => {
      if (endpoints.has(sub.endpoint)) reached.push(sub.endpoint);
      return { ok: true, statusCode: 201 };
    };
    const pushed = await pushDigestAlerts(run.id, { cfg, now, enabled: true, transport });
    expect(pushed).toContain('ready_for_approval');
    expect(reached).toContain(dig);
    expect(reached).not.toContain(waOnly);
  });
});

describe('the device API: kind on subscribe, check and remove', () => {
  const sub = () => {
    const k = validKeys();
    return { endpoint: ep(), keys: { p256dh: k.p256dh, auth: k.auth } };
  };
  const post = (path: string, body: object) => request(app).post(`/api/staff-push/${path}`).set('Cookie', cookie).send(body);
  it('a device first enabled from the WhatsApp card holds [whatsapp] only; enabling digest later adds it; the Digests card (no kind) means digest', async () => {
    const s = sub();
    const a = await post('devices', { subscription: s, kind: 'whatsapp' });
    expect(a.status).toBe(201);
    expect(a.body.device.kinds).toEqual(['whatsapp']);
    const b = await post('devices', { subscription: s });
    expect(b.status).toBe(200);
    expect([...b.body.device.kinds].sort()).toEqual(['digest', 'whatsapp']);
    const s2 = sub();
    expect((await post('devices', { subscription: s2 })).body.device.kinds).toEqual(['digest']);
    expect((await post('devices', { subscription: sub(), kind: 'sms' })).status).toBe(400);
  });
  it('check says whether THAT kind is on; remove with a kind keeps the device while another kind remains, and deletes it when none is left', async () => {
    const s = sub();
    await post('devices', { subscription: s, kind: 'whatsapp' });
    await post('devices', { subscription: s, kind: 'digest' });
    expect((await post('devices/check', { endpoint: s.endpoint, kind: 'whatsapp' })).body.on).toBe(true);
    expect((await post('devices/check', { endpoint: s.endpoint })).body.on).toBe(true);
    const off = await post('devices/remove', { endpoint: s.endpoint, kind: 'digest' });
    expect(off.body).toMatchObject({ removed: true, kept: true });
    expect((await post('devices/check', { endpoint: s.endpoint, kind: 'digest' })).body.on).toBe(false);
    expect((await post('devices/check', { endpoint: s.endpoint, kind: 'whatsapp' })).body.on).toBe(true);
    expect(await prisma.staffPushSubscription.findUnique({ where: { endpoint: s.endpoint } })).toMatchObject({ kinds: ['whatsapp'] });
    const last = await post('devices/remove', { endpoint: s.endpoint, kind: 'whatsapp' });
    expect(last.body).toEqual({ removed: true });
    expect(await prisma.staffPushSubscription.findUnique({ where: { endpoint: s.endpoint } })).toBeNull();
    // no kind = the whole device, as before
    const s3 = sub();
    await post('devices', { subscription: s3, kind: 'whatsapp' });
    await post('devices', { subscription: s3 });
    expect((await post('devices/remove', { endpoint: s3.endpoint })).body).toEqual({ removed: true });
    expect(await prisma.staffPushSubscription.findUnique({ where: { endpoint: s3.endpoint } })).toBeNull();
  });
  it('status tells the WhatsApp card whether the nudge is running (queue + nudge + kill switch)', async () => {
    const was = { q: env.whatsapp.queueEnabled, n: env.whatsapp.nudgeEnabled };
    env.whatsapp.queueEnabled = true;
    env.whatsapp.nudgeEnabled = true;
    expect((await request(app).get('/api/staff-push/status').set('Cookie', cookie)).body.whatsappNudge).toBe(true);
    env.whatsapp.nudgeEnabled = false;
    expect((await request(app).get('/api/staff-push/status').set('Cookie', cookie)).body.whatsappNudge).toBe(false);
    env.whatsapp.nudgeEnabled = true;
    env.whatsapp.queueEnabled = false;
    expect((await request(app).get('/api/staff-push/status').set('Cookie', cookie)).body.whatsappNudge).toBe(false);
    Object.assign(env.whatsapp, { queueEnabled: was.q, nudgeEnabled: was.n });
  });
});
