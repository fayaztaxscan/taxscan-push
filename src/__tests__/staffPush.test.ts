import fs from 'fs';
import path from 'path';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';
import type { Subscriber, User, UserRole } from '@prisma/client';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { parseDigestEnv, type DigestEnv } from '../lib/env';
import type { EmailSender } from '../lib/email';
import type { PushPayload, SendOutcome } from '../lib/push';
import { dispatchCampaign, type Sender } from '../services/send';
import { ensureRun } from '../services/digest/runner';
import { buildStaffPushPayload, pushDigestAlerts, sendDigestAlerts } from '../services/digest/alerts';
import { activeStaffDevices, staffDeviceLabel, type StaffPushTransport } from '../services/staffPush';
import { validKeys } from './helpers';

/**
 * Digest task 14: staff push notifications for digest approval. Devices live under
 * `https://staff-push.test/…` endpoints and users under `staffpush-*@team.test`;
 * all removed afterwards. No real push service: every send goes to a recording
 * transport. Runs live under unique `test-staffpush-*` portals.
 */

const logs: string[] = [];
jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
jest.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));

const PASSWORD = 'StaffPushPassword123!';
const IST_OFFSET_MIN = 5 * 60 + 30;
const userIds: string[] = [];
const subscriberIds: string[] = [];
const campaignIds: string[] = [];
const portals: string[] = [];

function ist(h: number, min = 0, day = 23): Date {
  return new Date(Date.UTC(2026, 9, day, h, min) - IST_OFFSET_MIN * 60 * 1000);
}

function cfg(over: NodeJS.ProcessEnv = {}): DigestEnv {
  return parseDigestEnv({ DIGEST_ENABLED: 'true', DIGEST_SEND_LIVE: 'true', DIGEST_ASSET_BASE_URL: 'https://push.taxscan.in', ...over });
}

function endpoint(tag: string): string {
  return `https://staff-push.test/send/${tag}-${randomBytes(8).toString('hex')}`;
}

async function makeUser(tag: string, role: UserRole = 'PUBLISHER', isActive = true): Promise<User> {
  const u = await prisma.user.create({
    data: {
      email: `staffpush-${tag}-${Date.now()}-${randomBytes(3).toString('hex')}@team.test`,
      passwordHash: await bcrypt.hash(PASSWORD, 4),
      role,
      isActive,
    },
  });
  userIds.push(u.id);
  return u;
}

async function makeDevice(user: User, tag: string) {
  const k = validKeys();
  return prisma.staffPushSubscription.create({ data: { userId: user.id, endpoint: endpoint(tag), p256dh: k.p256dh, auth: k.auth, label: 'Chrome on Mac' } });
}

/** Only this file's devices (the real query, filtered to our users). */
const mine = async () => (await activeStaffDevices()).filter((d) => userIds.includes(d.userId));

type Sent = { endpoint: string; payload: PushPayload };
function recorder(answer: (endpoint: string) => SendOutcome = () => ({ ok: true, statusCode: 201 })) {
  const sent: Sent[] = [];
  const transport: StaffPushTransport = async (sub, payload) => {
    sent.push({ endpoint: sub.endpoint, payload });
    return answer(sub.endpoint);
  };
  return { sent, transport };
}

async function runWith(alerts: Record<string, unknown>) {
  const portal = `test-staffpush-${Date.now()}-${randomBytes(3).toString('hex')}`;
  portals.push(portal);
  const run = await ensureRun({ portal, now: ist(6, 30), cfg: cfg() });
  await prisma.digestRun.update({ where: { id: run.id }, data: { alerts: alerts as object } });
  return run;
}

async function marker(runId: string, kind: string): Promise<Record<string, unknown>> {
  const r = await prisma.digestRun.findUnique({ where: { id: runId }, select: { alerts: true } });
  return ((r?.alerts ?? {}) as Record<string, Record<string, unknown>>)[kind];
}

const ready = (at = ist(6, 30)) => ({ ready_for_approval: { raisedAt: at.toISOString(), emailedAt: null, audiences: ['FREE', 'PREMIUM'] } });

async function login(app: ReturnType<typeof createApp>, u: User): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ email: u.email, password: PASSWORD });
  expect(res.status).toBe(200);
  const sc = res.headers['set-cookie'];
  return (Array.isArray(sc) ? sc : [sc as string]).map((l) => l.split(';')[0]).join('; ');
}

afterAll(async () => {
  await prisma.staffPushSubscription.deleteMany({ where: { userId: { in: userIds } } });
  if (portals.length) await prisma.digestRun.deleteMany({ where: { portal: { in: portals } } });
  if (campaignIds.length || userIds.length) {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL audit_log.allow_purge = 'true'`);
      await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "userId" = ANY(${userIds}::text[])`;
      await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "resourceType" = 'campaign' AND "resourceId" = ANY(${campaignIds}::text[])`;
    });
  }
  if (campaignIds.length) {
    await prisma.event.deleteMany({ where: { campaignId: { in: campaignIds } } });
    await prisma.campaign.deleteMany({ where: { id: { in: campaignIds } } });
  }
  await prisma.event.deleteMany({ where: { subscriberId: { in: subscriberIds } } });
  await prisma.subscriber.deleteMany({ where: { id: { in: subscriberIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.staffPushSubscription.deleteMany({ where: { userId: { in: userIds } } });
  logs.length = 0;
});

/* ------------------------------------------------------------------ */

describe('subscribe / unsubscribe routes', () => {
  const app = createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 } });

  it('need a session (no bearer, no anonymous)', async () => {
    const sub = { subscription: { endpoint: endpoint('anon'), keys: validKeys() } };
    expect((await request(app).post('/api/staff-push/devices').send(sub)).status).toBe(401);
    expect((await request(app).post('/api/staff-push/devices').set('Authorization', `Bearer ${process.env.ADMIN_TOKEN}`).send(sub)).status).toBe(401);
    expect((await request(app).get('/api/staff-push/status')).status).toBe(401);
    expect((await request(app).post('/api/staff-push/devices/remove').send({ endpoint: sub.subscription.endpoint })).status).toBe(401);
  });

  it('a PUBLISHER opts in, re-subscribing updates the same row, and stops; audit rows carry no endpoint', async () => {
    const u = await makeUser('pub');
    const cookie = await login(app, u);
    const ep = endpoint('pub');
    const k1 = validKeys();
    const ua = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36';

    const first = await request(app).post('/api/staff-push/devices').set('Cookie', cookie).set('User-Agent', ua).send({ subscription: { endpoint: ep, keys: k1 } });
    expect(first.status).toBe(201);
    expect(first.body.device.label).toBe('Chrome on Android');
    expect(JSON.stringify(first.body)).not.toContain(ep);

    const k2 = validKeys();
    const again = await request(app).post('/api/staff-push/devices').set('Cookie', cookie).send({ subscription: { endpoint: ep, keys: k2 } });
    expect(again.status).toBe(200);
    const rows = await prisma.staffPushSubscription.findMany({ where: { endpoint: ep } });
    expect(rows).toHaveLength(1);
    expect(rows[0].p256dh).toBe(k2.p256dh);

    expect((await request(app).post('/api/staff-push/devices/check').set('Cookie', cookie).send({ endpoint: ep })).body.on).toBe(true);
    expect((await request(app).get('/api/staff-push/status').set('Cookie', cookie)).body.devices).toBe(1);

    const rm = await request(app).post('/api/staff-push/devices/remove').set('Cookie', cookie).send({ endpoint: ep });
    expect(rm.body.removed).toBe(true);
    expect(await prisma.staffPushSubscription.count({ where: { endpoint: ep } })).toBe(0);

    const audit = await prisma.auditLog.findMany({ where: { userId: u.id, action: { in: ['STAFF_PUSH_SUBSCRIBED', 'STAFF_PUSH_UNSUBSCRIBED'] } } });
    expect(audit.map((a) => a.action).sort()).toEqual(['STAFF_PUSH_SUBSCRIBED', 'STAFF_PUSH_UNSUBSCRIBED']); // the refresh is not audited
    for (const a of audit) {
      const text = JSON.stringify(a.metadata);
      expect(text).not.toContain(ep);
      expect(text).not.toContain('/send/');
      expect(text).toContain('staff-push.test'); // the push service's host only
    }
  });

  it("a user can neither see nor remove another user's device", async () => {
    const a = await makeUser('owner');
    const b = await makeUser('other');
    const d = await makeDevice(a, 'owned');
    const cookieB = await login(app, b);
    expect((await request(app).post('/api/staff-push/devices/check').set('Cookie', cookieB).send({ endpoint: d.endpoint })).body.on).toBe(false);
    expect((await request(app).post('/api/staff-push/devices/remove').set('Cookie', cookieB).send({ endpoint: d.endpoint })).body.removed).toBe(false);
    expect((await request(app).post('/api/staff-push/devices/test').set('Cookie', cookieB).send({ endpoint: d.endpoint })).status).toBe(404);
    expect(await prisma.staffPushSubscription.count({ where: { id: d.id } })).toBe(1);
  });

  it('refuses a non-https endpoint and junk', async () => {
    const u = await makeUser('bad');
    const cookie = await login(app, u);
    for (const body of [{}, { subscription: { endpoint: 'http://x.test/a', keys: validKeys() } }, { subscription: { endpoint: 'nope', keys: validKeys() } }]) {
      expect((await request(app).post('/api/staff-push/devices').set('Cookie', cookie).send(body)).status).toBe(400);
    }
  });

  it('the test notification goes to the caller’s device only; a 410 prunes it', async () => {
    const rec = recorder((ep) => (ep.includes('gone') ? { ok: false, expired: true, statusCode: 410 } : { ok: true, statusCode: 201 }));
    const app2 = createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 }, staffPush: { transport: rec.transport } });
    const u = await makeUser('tester');
    const other = await makeUser('bystander');
    await makeDevice(other, 'bystander');
    const ok = await makeDevice(u, 'ok');
    const gone = await makeDevice(u, 'gone');
    const cookie = await login(app2, u);
    expect((await request(app2).post('/api/staff-push/devices/test').set('Cookie', cookie).send({ endpoint: ok.endpoint })).status).toBe(200);
    expect(rec.sent.map((s) => s.endpoint)).toEqual([ok.endpoint]);
    expect(new URL(String(rec.sent[0].payload.url)).pathname).toBe('/admin/digests');
    expect((await request(app2).post('/api/staff-push/devices/test').set('Cookie', cookie).send({ endpoint: gone.endpoint })).status).toBe(410);
    expect(await prisma.staffPushSubscription.count({ where: { id: gone.id } })).toBe(0);
    expect((await prisma.staffPushSubscription.findUnique({ where: { id: ok.id } }))?.lastSuccessAt).toBeInstanceOf(Date);
  });

  it('admins see device counts on Users, remove a user’s devices (audited), and deactivation removes them', async () => {
    const admin = await makeUser('admin', 'ADMIN');
    const pub = await makeUser('listed');
    await makeDevice(pub, 'l1');
    const d2 = await makeDevice(pub, 'l2');
    await prisma.staffPushSubscription.update({ where: { id: d2.id }, data: { lastSuccessAt: ist(6, 31) } });
    const cookie = await login(app, admin);

    const list = await request(app).get('/api/users?limit=200').set('Cookie', cookie);
    const row = list.body.items.find((x: { id: string }) => x.id === pub.id);
    expect(row.pushDevices.count).toBe(2);
    expect(new Date(row.pushDevices.lastSuccessAt).toISOString()).toBe(ist(6, 31).toISOString());
    expect(JSON.stringify(list.body)).not.toContain('staff-push.test');

    const pubCookie = await login(app, pub);
    expect((await request(app).delete(`/api/users/${pub.id}/push-devices`).set('Cookie', pubCookie)).status).toBe(403);

    const del = await request(app).delete(`/api/users/${pub.id}/push-devices`).set('Cookie', cookie);
    expect(del.body.removed).toBe(2);
    const audit = await prisma.auditLog.findFirst({ where: { userId: admin.id, action: 'STAFF_PUSH_REMOVED', resourceId: pub.id } });
    expect(audit?.metadata).toMatchObject({ removed: 2 });

    await makeDevice(pub, 'l3');
    const patch = await request(app).patch(`/api/users/${pub.id}`).set('Cookie', cookie).send({ isActive: false });
    expect(patch.status).toBe(200);
    expect(await prisma.staffPushSubscription.count({ where: { userId: pub.id } })).toBe(0);
  });
});

/* ------------------------------------------------------------------ */

describe('kept apart from readers', () => {
  it('a reader campaign send never selects a staff device', async () => {
    const u = await makeUser('apart');
    const dev = await makeDevice(u, 'apart');
    const portal = `test-staffpush-send-${Date.now()}`;
    const k = validKeys();
    const sub: Subscriber = await prisma.subscriber.create({ data: { endpoint: endpoint('reader'), p256dh: k.p256dh, auth: k.auth, portal, topics: [] } });
    subscriberIds.push(sub.id);
    const seen: string[] = [];
    const sender: Sender = async (s) => {
      seen.push(s.endpoint);
      return { ok: true, statusCode: 201 };
    };
    const r = await dispatchCampaign(
      { portal, title: 't', body: 'b', url: 'https://taxscan.in/a-1', target: { type: 'all' } },
      { sender, now: ist(12, 0), cap: 100 },
    );
    campaignIds.push(r.campaignId);
    expect(seen).toEqual([sub.endpoint]);
    expect(seen).not.toContain(dev.endpoint);
  });

  it('only the staff-push code reads the StaffPushSubscription table (no door, metric or backup can)', () => {
    const root = path.resolve(__dirname, '..');
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, f.name);
        if (f.isDirectory()) {
          if (f.name !== '__tests__') walk(p);
        } else if (p.endsWith('.ts') && /staffPushSubscription|"StaffPushSubscription"/.test(fs.readFileSync(p, 'utf8'))) {
          hits.push(path.relative(root, p));
        }
      }
    };
    walk(root);
    expect(hits.sort()).toEqual(['routes/staffPush.ts', 'services/staffPush.ts'].sort());
  });
});

/* ------------------------------------------------------------------ */

describe('the digest alert pass pushes editor kinds', () => {
  it('payload: tap URL, per-day tag, brand icon; preview wording', () => {
    const p = buildStaffPushPayload('ready_for_approval', {}, ist(6, 30), cfg())!;
    expect(p.title).toBe("Today's digest is ready — tap to review");
    expect(new URL(p.url).pathname).toBe('/admin/digests'); // APP_BASE_URL's host; the worker opens it on its own origin
    expect(p.tag).toBe('taxscan-digest-2026-10-23');
    expect(p.renotify).toBe(true);
    expect(p.icon).toBe('https://push.taxscan.in/brand/taxscan-icon-192.png');
    expect(buildStaffPushPayload('ready_for_approval', { preview: true }, ist(6, 30), cfg())!.title).toBe("Today's digest is ready to review");
    const late = buildStaffPushPayload('not_approved_yet', {}, ist(8, 30), cfg())!;
    expect(late.title).toBe('Digest still waiting for approval');
    expect(late.tag).toBe(p.tag); // the reminder replaces the 06:30 notification
    expect(buildStaffPushPayload('fatal', {}, ist(6, 30), cfg())).toBeNull();
  });

  it('once per run across two concurrent processes and a restart; a deactivated user gets nothing', async () => {
    const a = await makeUser('a', 'ADMIN');
    const p = await makeUser('p');
    const gone = await makeUser('deact', 'PUBLISHER', false);
    const da = await makeDevice(a, 'a');
    const dp = await makeDevice(p, 'p');
    const dg = await makeDevice(gone, 'deact');
    const run = await runWith(ready());
    const rec = recorder();
    const deps = { enabled: true, transport: rec.transport, devices: mine, cfg: cfg(), now: ist(6, 31) };

    const [x, y] = await Promise.all([pushDigestAlerts(run.id, deps), pushDigestAlerts(run.id, deps)]);
    expect([...x, ...y]).toEqual(['ready_for_approval']);
    // A restart: a fresh pass finds the stamp and sends nothing.
    expect(await pushDigestAlerts(run.id, { ...deps, now: ist(6, 50) })).toEqual([]);

    expect(rec.sent.map((s) => s.endpoint).sort()).toEqual([da.endpoint, dp.endpoint].sort());
    expect(rec.sent.map((s) => s.endpoint)).not.toContain(dg.endpoint);
    const m = await marker(run.id, 'ready_for_approval');
    expect(m.pushedTo).toBe(2);
    expect(m.pushClaim).toBeUndefined();
    expect(m.emailedAt).toBeNull(); // the email's own fields are untouched
    for (const line of logs) expect(line).not.toContain('staff-push.test');
  });

  it('prunes a device on 410 and retries later when no device took it', async () => {
    const u = await makeUser('prune');
    const live = await makeDevice(u, 'live');
    const dead = await makeDevice(u, 'dead');
    const run = await runWith({ not_approved_yet: { raisedAt: ist(8, 30).toISOString(), emailedAt: null } });
    let down = true;
    const rec = recorder((ep) => (ep === dead.endpoint ? { ok: false, expired: true, statusCode: 410 } : down ? { ok: false, expired: false, failed: true, statusCode: 503 } : { ok: true, statusCode: 201 }));
    const deps = { enabled: true, transport: rec.transport, devices: mine, cfg: cfg() };

    expect(await pushDigestAlerts(run.id, { ...deps, now: ist(8, 30) })).toEqual([]);
    expect(await prisma.staffPushSubscription.count({ where: { id: dead.id } })).toBe(0);
    let m = await marker(run.id, 'not_approved_yet');
    expect(m.pushRetryAfter).toBeDefined();
    expect(String(m.pushError)).toContain(`${live.id}:503`);
    expect(String(m.pushError)).not.toContain('staff-push.test');

    down = false;
    expect(await pushDigestAlerts(run.id, { ...deps, now: ist(8, 35) })).toEqual([]); // inside the 10-minute wait
    expect(await pushDigestAlerts(run.id, { ...deps, now: ist(8, 41) })).toEqual(['not_approved_yet']);
    m = await marker(run.id, 'not_approved_yet');
    expect(m.pushedTo).toBe(1);
    expect((await prisma.staffPushSubscription.findUnique({ where: { id: live.id } }))?.failureCount).toBe(0);
  });

  it('nothing while the digest is off or the kill-switch is off; a stale marker is skipped; a non-editor kind is never pushed', async () => {
    const u = await makeUser('gates');
    await makeDevice(u, 'gates');
    const rec = recorder();
    const run = await runWith({ ...ready(), fatal: { raisedAt: ist(6, 30).toISOString(), emailedAt: null } });
    expect(await pushDigestAlerts(run.id, { enabled: true, transport: rec.transport, devices: mine, cfg: cfg({ DIGEST_ENABLED: 'false' }), now: ist(6, 31) })).toEqual([]);
    expect(await pushDigestAlerts(run.id, { enabled: false, transport: rec.transport, devices: mine, cfg: cfg(), now: ist(6, 31) })).toEqual([]);
    // Default from the environment: off in jest (setup.ts), like a kill-switched production.
    expect(await pushDigestAlerts(run.id, { transport: rec.transport, devices: mine, cfg: cfg(), now: ist(6, 31) })).toEqual([]);
    expect(rec.sent).toHaveLength(0);

    expect(await pushDigestAlerts(run.id, { enabled: true, transport: rec.transport, devices: mine, cfg: cfg(), now: ist(12, 0) })).toEqual([]);
    expect((await marker(run.id, 'ready_for_approval')).pushSkipped).toBe('stale');
    expect((await marker(run.id, 'fatal')).pushClaim).toBeUndefined();
    expect(rec.sent).toHaveLength(0);
  });

  it('a push failure never blocks the email, and an unconfigured email does not stop the push', async () => {
    const u = await makeUser('both', 'ADMIN');
    await makeDevice(u, 'both');
    const mails: string[] = [];
    const emailSender: EmailSender = async (m) => {
      mails.push(m.to);
      return { ok: true };
    };
    const run = await runWith(ready());
    const throwing: StaffPushTransport = async () => {
      throw new Error('push service exploded https://staff-push.test/send/secret');
    };
    const out = await sendDigestAlerts(run.id, {
      emailSender,
      isConfigured: () => true,
      recipients: async () => ['editor@team.test'],
      cfg: cfg(),
      now: ist(6, 31),
      staffPush: { enabled: true, transport: throwing, devices: mine },
    });
    expect(out.emailed).toEqual(['ready_for_approval']);
    expect(mails).toEqual(['editor@team.test']);
    for (const line of logs) expect(line).not.toContain('staff-push.test');

    const run2 = await runWith(ready());
    const rec = recorder();
    const out2 = await sendDigestAlerts(run2.id, { isConfigured: () => false, cfg: cfg(), now: ist(6, 31), staffPush: { enabled: true, transport: rec.transport, devices: mine } });
    expect(out2.notConfigured).toBe(true);
    expect(out2.pushed).toEqual(['ready_for_approval']);
    expect(rec.sent).toHaveLength(1);
  });
});

describe('the staff worker file', () => {
  const app = createApp();

  it('is served from /admin/ with no-cache, as JavaScript, same-origin only', async () => {
    const res = await request(app).get('/admin/sw-staff.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/javascript/);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(res.text).toContain("addEventListener('push'");
    expect(res.text).toContain('notificationclick');
    expect(res.text).not.toContain('/api/track'); // no reader click tracking
  });

  it('the reader worker is unchanged in what it serves', async () => {
    const res = await request(app).get('/sw.js');
    expect(res.status).toBe(200);
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(res.text).not.toContain('staff');
  });

  it('labels a user agent without identifying it', () => {
    expect(staffDeviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1')).toBe('Safari on iPhone');
    expect(staffDeviceLabel(undefined)).toBe('Browser on unknown device');
  });
});
