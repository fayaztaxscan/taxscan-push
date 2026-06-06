/**
 * Phase 4 tests for the audit helper + GET /api/audit.
 *
 *   recordAudit:
 *     - writes the expected row
 *     - non-throwing on DB error (mocked via a stub that simulates a throw
 *       at the create site)
 *
 *   GET /api/audit:
 *     - 401 without a session
 *     - 200 for any logged-in role (ADMIN + PUBLISHER), joined user object,
 *       respects action/userId/since/until/limit/offset filters, pagination
 *       reports total separately from items.length
 */

import request from 'supertest';
import bcrypt from 'bcrypt';
import type { User, UserRole } from '@prisma/client';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { recordAudit } from '../lib/audit';

const app = createApp({
  rateLimit: { publicPerMin: 10000, loginPerMin: 10000 },
});

const userIds: string[] = [];
const emails: string[] = [];
const resourceIds: string[] = [];

async function makeUser(
  suffix: string,
  password: string,
  role: UserRole,
): Promise<User> {
  const email = `audit-${suffix}-${Date.now()}-${Math.floor(
    Math.random() * 1e9,
  )}@example.com`.toLowerCase();
  const passwordHash = await bcrypt.hash(password, 4);
  const u = await prisma.user.create({
    data: { email, passwordHash, role, isActive: true },
  });
  userIds.push(u.id);
  emails.push(email);
  return u;
}

async function loginAs(user: User, password: string): Promise<string> {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: user.email, password });
  expect(res.status).toBe(200);
  const sc = res.headers['set-cookie'];
  const arr = Array.isArray(sc) ? sc : [sc as string];
  return arr.map((line) => line.split(';')[0]).join('; ');
}

afterAll(async () => {
  // Cleanup uses the carve-out so we can sweep the audit rows these tests
  // wrote.
  if (emails.length || userIds.length || resourceIds.length) {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL audit_log.allow_purge = 'true'`);
      if (userIds.length) {
        await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "userId" = ANY(${userIds}::text[])`;
        await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "resourceType" = 'user' AND "resourceId" = ANY(${userIds}::text[])`;
      }
      if (resourceIds.length) {
        await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "resourceId" = ANY(${resourceIds}::text[])`;
      }
      if (emails.length) {
        await tx.$executeRaw`DELETE FROM "AuditLog" WHERE (metadata->>'email') = ANY(${emails}::text[])`;
      }
    });
  }
  if (userIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await prisma.$disconnect();
});

describe('recordAudit', () => {
  it('writes the expected row', async () => {
    const u = await makeUser('rec-happy', 'AuditPw1Aa', 'ADMIN');
    const marker = `helper-marker-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    resourceIds.push(marker);

    await recordAudit({
      userId: u.id,
      action: 'USER_CREATED',
      resourceType: 'user',
      resourceId: marker,
      metadata: { test: true, marker },
      ipAddress: '10.0.0.1',
    });

    const row = await prisma.auditLog.findFirst({ where: { resourceId: marker } });
    expect(row).not.toBeNull();
    expect(row?.userId).toBe(u.id);
    expect(row?.action).toBe('USER_CREATED');
    expect(row?.resourceType).toBe('user');
    expect(row?.ipAddress).toBe('10.0.0.1');
    expect((row?.metadata as { marker: string }).marker).toBe(marker);
  });

  it('is non-throwing on DB error (the underlying action must not be undone)', async () => {
    // Force a failure by passing an obviously-invalid action value that
    // Prisma's typed client would normally reject before the network round
    // trip. recordAudit must swallow the throw.
    await expect(
      recordAudit({
        userId: 'no-such-user',
        action: 'NOT_A_REAL_ACTION' as unknown as 'LOGIN_SUCCESS',
        metadata: { marker: 'never-stored' },
      }),
    ).resolves.toBeUndefined();
  });
});

describe('GET /api/audit', () => {
  it('returns 401 without a session', async () => {
    const res = await request(app).get('/api/audit');
    expect(res.status).toBe(401);
  });

  it('returns 200 with joined user info for an ADMIN', async () => {
    const admin = await makeUser('list-admin', 'AuditAdminPw1Aa', 'ADMIN');
    // Login itself writes a LOGIN_SUCCESS row attributed to admin.
    const cookie = await loginAs(admin, 'AuditAdminPw1Aa');

    const res = await request(app)
      .get(`/api/audit?userId=${admin.id}&limit=5`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(typeof res.body.total).toBe('number');
    expect(res.body.items.length).toBeGreaterThan(0);
    const first = res.body.items[0];
    expect(first.user).toEqual({
      id: admin.id,
      email: admin.email,
      role: admin.role,
    });
  });

  it('returns 200 for a PUBLISHER too (read is for everyone on the team)', async () => {
    const pub = await makeUser('list-pub', 'AuditPubPw1Aa', 'PUBLISHER');
    const cookie = await loginAs(pub, 'AuditPubPw1Aa');
    const res = await request(app).get('/api/audit?limit=1').set('Cookie', cookie);
    expect(res.status).toBe(200);
  });

  it('action filter narrows results', async () => {
    const u = await makeUser('filter-action', 'FilterActPw1Aa', 'PUBLISHER');
    const cookie = await loginAs(u, 'FilterActPw1Aa');

    const res = await request(app)
      .get(`/api/audit?action=LOGIN_SUCCESS&userId=${u.id}`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    for (const item of res.body.items) {
      expect(item.action).toBe('LOGIN_SUCCESS');
      expect(item.userId).toBe(u.id);
    }
  });

  it('since / until bounds the createdAt window', async () => {
    const u = await makeUser('filter-window', 'WindowPw1Aa', 'PUBLISHER');
    const cookie = await loginAs(u, 'WindowPw1Aa');
    // The login above happened well within the last hour.
    const oneHourAgo = new Date(Date.now() - 3600_000).toISOString();
    const inFiveMinutes = new Date(Date.now() + 300_000).toISOString();

    const inWindow = await request(app)
      .get(
        `/api/audit?userId=${u.id}&since=${encodeURIComponent(oneHourAgo)}&until=${encodeURIComponent(inFiveMinutes)}`,
      )
      .set('Cookie', cookie);
    expect(inWindow.status).toBe(200);
    expect(inWindow.body.items.length).toBeGreaterThan(0);

    const tenYearsAgo = new Date(Date.now() - 10 * 365 * 86400_000).toISOString();
    const tenYearsLess = new Date(Date.now() - 9 * 365 * 86400_000).toISOString();
    const outOfWindow = await request(app)
      .get(
        `/api/audit?userId=${u.id}&since=${encodeURIComponent(tenYearsAgo)}&until=${encodeURIComponent(tenYearsLess)}`,
      )
      .set('Cookie', cookie);
    expect(outOfWindow.status).toBe(200);
    expect(outOfWindow.body.items).toHaveLength(0);
  });

  it('returns 400 for an unknown action value', async () => {
    const u = await makeUser('bad-action', 'BadActPw1Aa', 'PUBLISHER');
    const cookie = await loginAs(u, 'BadActPw1Aa');
    const res = await request(app)
      .get('/api/audit?action=NOT_A_REAL_ACTION')
      .set('Cookie', cookie);
    expect(res.status).toBe(400);
  });

  it('paginates: limit + offset return different windows; total >= window', async () => {
    const u = await makeUser('paginate', 'PagePw1Aa', 'PUBLISHER');
    const cookie = await loginAs(u, 'PagePw1Aa');
    // Make a few additional rows attributed to this user.
    for (let i = 0; i < 4; i++) {
      await recordAudit({ userId: u.id, action: 'LOGOUT', metadata: { i } });
    }

    const page1 = await request(app)
      .get(`/api/audit?userId=${u.id}&limit=2&offset=0`)
      .set('Cookie', cookie);
    const page2 = await request(app)
      .get(`/api/audit?userId=${u.id}&limit=2&offset=2`)
      .set('Cookie', cookie);

    expect(page1.status).toBe(200);
    expect(page2.status).toBe(200);
    expect(page1.body.items.length).toBeLessThanOrEqual(2);
    expect(page2.body.items.length).toBeLessThanOrEqual(2);
    const ids1 = new Set(page1.body.items.map((r: { id: string }) => r.id));
    const ids2 = new Set(page2.body.items.map((r: { id: string }) => r.id));
    for (const id of ids2) {
      expect(ids1.has(id)).toBe(false);
    }
    expect(page1.body.total).toBe(page2.body.total);
    expect(page1.body.total).toBeGreaterThanOrEqual(
      page1.body.items.length + page2.body.items.length,
    );
  });
});
