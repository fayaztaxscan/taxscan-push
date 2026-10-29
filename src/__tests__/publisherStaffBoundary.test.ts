/**
 * Brief 2026-10-29-publisher-ads-templates, acceptance 3: opening Ads and Templates to a PUBLISHER
 * must not open anything else. Users, report-email recipients and the subscriber endpoints stay ADMIN-only
 * (and a request with no session is still 401). The Ads / Templates side is in digestAds.test.ts and
 * digestTemplates.test.ts.
 *
 * Brief 2026-10-29-activity-admin-only: the Activity (audit) log is ADMIN-only too — a PUBLISHER gets 403 on
 * GET /api/audit — while what a publisher does is still written to it, and an admin can read it.
 */
import request from 'supertest';
import bcrypt from 'bcrypt';
import type { User } from '@prisma/client';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { parseDigestEnv } from '../lib/env';
import { FakeSender } from './digestFakeSender';

const app = createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 } });
const RUN = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const PASSWORD = 'correct-horse-battery-staple';
let publisher: User;
let admin: User;
let cookie: string;
let adminCookie: string;
const portal = `test-staff-boundary-${RUN}`;

async function login(u: User): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ email: u.email, password: PASSWORD });
  expect(res.status).toBe(200);
  const sc = res.headers['set-cookie'];
  return (Array.isArray(sc) ? sc : [sc as unknown as string]).map((l) => l.split(';')[0]).join('; ');
}

beforeAll(async () => {
  publisher = await prisma.user.create({
    data: { email: `staff-boundary-${RUN}@team.test`, passwordHash: await bcrypt.hash(PASSWORD, 4), role: 'PUBLISHER', isActive: true },
  });
  admin = await prisma.user.create({
    data: { email: `staff-boundary-admin-${RUN}@team.test`, passwordHash: await bcrypt.hash(PASSWORD, 4), role: 'ADMIN', isActive: true },
  });
  cookie = await login(publisher);
  adminCookie = await login(admin);
});

afterAll(async () => {
  const ids = [publisher.id, admin.id];
  const adIds = (await prisma.digestAd.findMany({ where: { portal }, select: { id: true } })).map((a) => a.id);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL audit_log.allow_purge = 'true'`);
    await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "userId" = ANY(${ids}::text[])`;
    await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "resourceType" = 'user' AND "resourceId" = ANY(${ids}::text[])`;
    if (adIds.length) await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "resourceId" = ANY(${adIds}::text[])`;
    await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "metadata"->>'email' = ANY(${[publisher.email, admin.email]}::text[])`;
  });
  await prisma.digestAd.deleteMany({ where: { portal } });
  await prisma.userSession.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.$disconnect();
});

describe('a PUBLISHER is still kept out of everything that is ADMIN-only', () => {
  const calls: [string, (r: ReturnType<typeof request>) => request.Test][] = [
    ['GET /api/users', (r) => r.get('/api/users')],
    ['POST /api/users (invite)', (r) => r.post('/api/users').send({ email: `invitee-${RUN}@team.test`, role: 'PUBLISHER' })],
    ['GET /api/report-recipients', (r) => r.get('/api/report-recipients')],
    ['POST /api/report-recipients', (r) => r.post('/api/report-recipients').send({ email: `rr-${RUN}@team.test` })],
    ['DELETE /api/report-recipients/:id', (r) => r.delete('/api/report-recipients/nope')],
    ['GET /api/audit (the Activity log)', (r) => r.get('/api/audit')],
    ['GET /api/audit?limit=5', (r) => r.get('/api/audit?limit=5')],
    ['GET /api/admin/subscribers', (r) => r.get('/api/admin/subscribers')],
    ['POST /api/admin/subscribers/:id/test-segment', (r) => r.post('/api/admin/subscribers/nope/test-segment').send({})],
  ];

  it.each(calls)('%s → 403 for a publisher, 401 without a session', async (name, call) => {
    expect([name, (await call(request(app)).set('Cookie', cookie)).status]).toEqual([name, 403]);
    expect([name, (await call(request(app))).status]).toEqual([name, 401]);
  });

  it('and nothing was created by those refused calls', async () => {
    expect(await prisma.user.count({ where: { email: `invitee-${RUN}@team.test` } })).toBe(0);
    expect(await prisma.reportRecipient.count({ where: { email: `rr-${RUN}@team.test` } })).toBe(0);
  });
});

describe('the Activity log: ADMIN reads it; a publisher\'s actions are still written to it', () => {
  it('ADMIN → 200 on GET /api/audit; PUBLISHER → 403; no session → 401', async () => {
    expect((await request(app).get('/api/audit').set('Cookie', adminCookie)).status).toBe(200);
    const forbidden = await request(app).get('/api/audit').set('Cookie', cookie);
    expect(forbidden.status).toBe(403);
    expect(JSON.stringify(forbidden.body)).not.toContain('"items"'); // no rows leak in the refusal
    expect((await request(app).get('/api/audit')).status).toBe(401);
  });

  it('a publisher creating an ad writes the audit row (actor = the publisher) and an admin can read it', async () => {
    const digestApp = createApp({
      rateLimit: { publicPerMin: 10000, loginPerMin: 10000 },
      digest: {
        cfg: parseDigestEnv({
          DIGEST_ENABLED: 'true',
          DIGEST_SEND_LIVE: 'true',
          DIGEST_APPROVAL_REQUIRED: 'false',
          DIGEST_FREE_LIST_IDS: 'list-free',
          DIGEST_FREE_EXCLUDE_LIST_IDS: 'list-premium',
          DIGEST_PREMIUM_LIST_IDS: 'list-premium',
          DIGEST_POSTAL_ADDRESS: 'Taxscan Media, Kochi, Kerala 682001, India',
        }),
        portal,
        clock: () => new Date('2026-10-29T01:00:00Z'),
        sender: new FakeSender(),
        alerts: false,
      },
    });
    const made = await request(digestApp)
      .post('/api/digest/ads')
      .set('Cookie', cookie)
      .send({
        name: 'Boundary ad',
        kind: 'HOUSE',
        headline: 'Master GST appeals',
        altText: 'GST appeals course banner',
        body: 'Six weeks, live.',
        ctaText: 'Enrol now',
        linkUrl: 'https://academy.taxscan.in/gst-appeals',
        audience: 'ALL',
        slots: [1, 3],
        priority: 10,
        isSlotDefault: false,
        startsAt: null,
        endsAt: null,
        status: 'ACTIVE',
      });
    expect(made.status).toBe(201);
    const id = made.body.id as string;
    const read = await request(app).get(`/api/audit?userId=${publisher.id}&limit=200`).set('Cookie', adminCookie);
    expect(read.status).toBe(200);
    const mine = (read.body.items as { action: string; resourceId: string | null; userId: string | null }[]).filter((r) => r.resourceId === id);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((r) => r.userId === publisher.id)).toBe(true);
    expect(mine.some((r) => r.action.startsWith('DIGEST_AD'))).toBe(true);
  });
});
