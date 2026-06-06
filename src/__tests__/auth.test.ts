/**
 * Phase 2 tests for the cookie-session auth routes (/api/auth/*).
 *
 * Covers: login happy path + sets cookie, wrong-password 401, email-based
 * throttle 423 after 5 fails, /me 401 without cookie, /me 200 with valid
 * cookie, /logout 204 + subsequent /me 401.
 */

import request from 'supertest';
import bcrypt from 'bcrypt';
import type { User, UserRole } from '@prisma/client';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';

const app = createApp({
  // Pin rate limits high so per-IP throttling isn't the cause of any 4xx;
  // the email-based throttle is what the tests exercise.
  rateLimit: { publicPerMin: 10000, loginPerMin: 10000 },
});

const userIds: string[] = [];
const emails: string[] = [];

async function makeUser(
  suffix: string,
  password: string,
  opts: { role?: UserRole; isActive?: boolean } = {},
): Promise<User> {
  const email = `auth-${suffix}-${Date.now()}-${Math.floor(
    Math.random() * 1e9,
  )}@example.com`.toLowerCase();
  const passwordHash = await bcrypt.hash(password, 4); // low cost = faster tests
  const u = await prisma.user.create({
    data: {
      email,
      passwordHash,
      role: opts.role ?? 'PUBLISHER',
      isActive: opts.isActive ?? true,
    },
  });
  userIds.push(u.id);
  emails.push(email);
  return u;
}

function setCookieToCookieHeader(setCookie: string | string[] | undefined): string {
  if (!setCookie) return '';
  const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
  // Set-Cookie lines look like "name=val; HttpOnly; ...; Path=/". Cookie
  // header just needs "name=val" pairs joined by ';'.
  return arr.map((line) => line.split(';')[0]).join('; ');
}

afterAll(async () => {
  // AuditLog rows touched by these tests are tracked by email (failed logins
  // against non-existent users) or userId (success + wrong-password). Purge
  // both via the immutability carve-out.
  if (emails.length || userIds.length) {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL audit_log.allow_purge = 'true'`);
      if (userIds.length) {
        await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "userId" = ANY(${userIds}::text[])`;
      }
      if (emails.length) {
        await tx.$executeRaw`DELETE FROM "AuditLog" WHERE (metadata->>'email') = ANY(${emails}::text[])`;
      }
    });
  }
  if (userIds.length) {
    // UserSession cascades on User delete.
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await prisma.$disconnect();
});

describe('POST /api/auth/login', () => {
  it('returns 200, sets the signed session cookie, returns user info', async () => {
    const user = await makeUser('happy', 'CorrectHorseBattery123!');
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: 'CorrectHorseBattery123!' });

    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({
      id: user.id,
      email: user.email,
      role: user.role,
      passwordResetRequired: false,
    });

    const setCookie = res.headers['set-cookie'];
    expect(setCookie).toBeDefined();
    const cookieLine = Array.isArray(setCookie) ? setCookie[0] : (setCookie as string);
    expect(cookieLine).toMatch(/tx_push_session=/);
    expect(cookieLine).toMatch(/HttpOnly/);
    expect(cookieLine).toMatch(/SameSite=Lax/i);

    // The cookie value is signed (prefix `s:` in the Set-Cookie line —
    // cookie-parser's signature format).
    expect(cookieLine).toMatch(/tx_push_session=s%3A/);

    // Session row landed.
    const sessions = await prisma.userSession.count({ where: { userId: user.id } });
    expect(sessions).toBe(1);

    // LOGIN_SUCCESS audit row written.
    const audit = await prisma.auditLog.count({
      where: { userId: user.id, action: 'LOGIN_SUCCESS' },
    });
    expect(audit).toBe(1);

    // lastLoginAt updated.
    const reloaded = await prisma.user.findUnique({ where: { id: user.id } });
    expect(reloaded?.lastLoginAt).not.toBeNull();
  });

  it('returns 401 for wrong password and records LOGIN_FAILED', async () => {
    const user = await makeUser('wrongpw', 'RealPasswordABC123');
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: 'WrongPasswordABC123' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_credentials');
    expect(res.headers['set-cookie']).toBeUndefined();

    const fail = await prisma.auditLog.count({
      where: { userId: user.id, action: 'LOGIN_FAILED' },
    });
    expect(fail).toBe(1);
  });

  it('returns 401 for an unknown email (still records LOGIN_FAILED with no userId)', async () => {
    const ghostEmail = `ghost-${Date.now()}@example.com`.toLowerCase();
    emails.push(ghostEmail);
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: ghostEmail, password: 'AnyPassword123' });

    expect(res.status).toBe(401);

    const fail = await prisma.auditLog.count({
      where: {
        action: 'LOGIN_FAILED',
        userId: null,
        metadata: { path: ['email'], equals: ghostEmail },
      },
    });
    expect(fail).toBe(1);
  });

  it('locks the account with 423 after 5 failed attempts in the window', async () => {
    const user = await makeUser('lockout', 'RealPassword789');

    // 5 failures.
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: user.email, password: 'NopeNopeNope' });
      expect(res.status).toBe(401);
    }

    // 6th attempt — even with the CORRECT password — locked out.
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: 'RealPassword789' });
    expect(res.status).toBe(423);
    expect(res.body.error).toBe('locked');
  });

  it('returns 400 for invalid request body (missing email)', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ password: 'anything' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });
});

describe('GET /api/auth/me', () => {
  it('returns 401 without a session cookie', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('returns user info with a valid session cookie', async () => {
    const user = await makeUser('me', 'AnotherPassword999');
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: 'AnotherPassword999' });
    expect(login.status).toBe(200);

    const cookieHeader = setCookieToCookieHeader(login.headers['set-cookie']);
    const res = await request(app).get('/api/auth/me').set('Cookie', cookieHeader);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(user.id);
    expect(res.body.email).toBe(user.email);
    expect(res.body.role).toBe(user.role);
  });

  it('returns 401 with a tampered (invalid signature) cookie', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Cookie', 'tx_push_session=s%3Atampered.value');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/auth/logout', () => {
  it('revokes the session: 204, subsequent /me returns 401', async () => {
    const user = await makeUser('logout', 'YetAnotherPw777');
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: 'YetAnotherPw777' });
    const cookieHeader = setCookieToCookieHeader(login.headers['set-cookie']);

    const logout = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', cookieHeader);
    expect(logout.status).toBe(204);

    // Audit row.
    const audit = await prisma.auditLog.count({
      where: { userId: user.id, action: 'LOGOUT' },
    });
    expect(audit).toBe(1);

    // Subsequent /me with the same cookie should fail — session row deleted.
    const me = await request(app).get('/api/auth/me').set('Cookie', cookieHeader);
    expect(me.status).toBe(401);

    const remaining = await prisma.userSession.count({ where: { userId: user.id } });
    expect(remaining).toBe(0);
  });

  it('returns 401 without a valid cookie', async () => {
    const res = await request(app).post('/api/auth/logout');
    expect(res.status).toBe(401);
  });
});
