/**
 * Brief 2026-10-29-publisher-ads-templates, acceptance 3: opening Ads and Templates to a PUBLISHER
 * must not open anything else. Users, report-email recipients and the subscriber endpoints stay ADMIN-only
 * (and a request with no session is still 401). The Ads / Templates side is in digestAds.test.ts and
 * digestTemplates.test.ts.
 */
import request from 'supertest';
import bcrypt from 'bcrypt';
import type { User } from '@prisma/client';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';

const app = createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 } });
const RUN = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const PASSWORD = 'correct-horse-battery-staple';
let publisher: User;
let cookie: string;

beforeAll(async () => {
  publisher = await prisma.user.create({
    data: { email: `staff-boundary-${RUN}@team.test`, passwordHash: await bcrypt.hash(PASSWORD, 4), role: 'PUBLISHER', isActive: true },
  });
  const res = await request(app).post('/api/auth/login').send({ email: publisher.email, password: PASSWORD });
  expect(res.status).toBe(200);
  const sc = res.headers['set-cookie'];
  cookie = (Array.isArray(sc) ? sc : [sc as unknown as string]).map((l) => l.split(';')[0]).join('; ');
});

afterAll(async () => {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL audit_log.allow_purge = 'true'`);
    await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "userId" = ${publisher.id}`;
    await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "resourceType" = 'user' AND "resourceId" = ${publisher.id}`;
    await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "metadata"->>'email' = ${publisher.email}`;
  });
  await prisma.userSession.deleteMany({ where: { userId: publisher.id } });
  await prisma.user.deleteMany({ where: { id: publisher.id } });
  await prisma.$disconnect();
});

describe('a PUBLISHER is still kept out of everything that is ADMIN-only', () => {
  const calls: [string, (r: ReturnType<typeof request>) => request.Test][] = [
    ['GET /api/users', (r) => r.get('/api/users')],
    ['POST /api/users (invite)', (r) => r.post('/api/users').send({ email: `invitee-${RUN}@team.test`, role: 'PUBLISHER' })],
    ['GET /api/report-recipients', (r) => r.get('/api/report-recipients')],
    ['POST /api/report-recipients', (r) => r.post('/api/report-recipients').send({ email: `rr-${RUN}@team.test` })],
    ['DELETE /api/report-recipients/:id', (r) => r.delete('/api/report-recipients/nope')],
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
