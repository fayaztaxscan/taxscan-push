/**
 * Phase 2 tests for the cookie-session auth routes (/api/auth/*).
 *
 * Covers: login happy path + sets cookie, wrong-password 401, verify-first
 * (a correct password is never locked out — the DoS-prone per-email lockout
 * was removed, M3), server-side passwordResetRequired enforcement (M2), /me
 * 401 without cookie, /me 200 with valid cookie, /logout 204 + subsequent
 * /me 401.
 */

import request from 'supertest';
import bcrypt from 'bcrypt';
import type { User, UserRole } from '@prisma/client';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { SESSION_TTL_HOURS } from '../lib/sessions';

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
  opts: { role?: UserRole; isActive?: boolean; passwordResetRequired?: boolean } = {},
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
      passwordResetRequired: opts.passwordResetRequired ?? false,
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

/** Every Set-Cookie line for the session cookie, in the order sent. */
function sessionCookieLines(setCookie: string | string[] | undefined): string[] {
  if (!setCookie) return [];
  const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
  return arr.filter((line) => line.startsWith('tx_push_session='));
}

function firstSessionCookieLine(setCookie: string | string[] | undefined): string | undefined {
  return sessionCookieLines(setCookie)[0];
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

  it('sets a cookie Max-Age that matches the server-side session TTL', async () => {
    // Regression guard: the cookie must not expire before the sliding session
    // does. When SESSION_TTL_HOURS went 8h → 7 days the cookie's Max-Age stayed
    // at 8h, so the browser dropped it first and the slide was unreachable —
    // every editor was logged out roughly daily.
    const user = await makeUser('maxage', 'CookieMaxAge123!');
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: 'CookieMaxAge123!' });

    expect(res.status).toBe(200);
    const setCookie = res.headers['set-cookie'];
    const cookieLine = Array.isArray(setCookie) ? setCookie[0] : (setCookie as string);
    const maxAge = Number(/Max-Age=(\d+)/i.exec(cookieLine)?.[1]);
    expect(maxAge).toBe(SESSION_TTL_HOURS * 3600);
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

  // M3: the former per-email lockout returned 423 and blocked the legitimate
  // owner too — a targeted account-lockout DoS. After the fix, repeated wrong
  // attempts never lock the account: a correct password still authenticates,
  // and every failure returns a generic 401 (never 423).
  it('verify-first: a correct password still logs in after repeated failures (no lockout DoS)', async () => {
    const user = await makeUser('lockout', 'RealPassword789');

    // 6 failures — more than the old MAX_FAILED_ATTEMPTS of 5.
    for (let i = 0; i < 6; i++) {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: user.email, password: 'NopeNopeNope' });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('invalid_credentials'); // never 423/'locked'
    }

    // The correct password STILL authenticates — the owner is not locked out.
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: 'RealPassword789' });
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(user.id);
    expect(res.headers['set-cookie']).toBeDefined();
  });

  it('returns 400 for invalid request body (missing email)', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ password: 'anything' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });
});

// M2: passwordResetRequired must be enforced server-side, not only by the SPA
// router guard. A session for a user who still owes a forced password change
// may reach change-password / logout / me, but is 403'd on every other route —
// so an admin-issued temp/reset password can't be used as a normal credential
// via the API (e.g. curl).
describe('passwordResetRequired server-side enforcement (M2)', () => {
  it('blocks a reset-required session from normal routes until the password is rotated', async () => {
    const user = await makeUser('reset', 'TempPassword12345', {
      passwordResetRequired: true,
    });

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: 'TempPassword12345' });
    expect(login.status).toBe(200);
    expect(login.body.user.passwordResetRequired).toBe(true);
    const cookie = setCookieToCookieHeader(login.headers['set-cookie']);

    // Allowlisted route still works so the SPA can read state and rotate.
    const me = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(me.status).toBe(200);

    // A normal requireUser route (any role) is blocked server-side.
    const blocked = await request(app).get('/api/audit').set('Cookie', cookie);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe('password_change_required');

    // Rotating the password clears the flag and unblocks the same session.
    const change = await request(app)
      .post('/api/auth/change-password')
      .set('Cookie', cookie)
      .send({ currentPassword: 'TempPassword12345', newPassword: 'BrandNewPass67890' });
    expect(change.status).toBe(204);

    const after = await request(app).get('/api/audit').set('Cookie', cookie);
    expect(after.status).toBe(200);
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

  it('slides the cookie forward on an authenticated request, same token', async () => {
    // The session row's expiry slides on every request (findValidSession); the
    // cookie has to move with it, or the browser copy keeps counting down from
    // login and expires mid-session on an actively-working editor.
    const user = await makeUser('slide', 'SlidingCookiePw123');
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: 'SlidingCookiePw123' });
    const loginLine = firstSessionCookieLine(login.headers['set-cookie']);
    const cookieHeader = setCookieToCookieHeader(login.headers['set-cookie']);

    const res = await request(app).get('/api/auth/me').set('Cookie', cookieHeader);
    expect(res.status).toBe(200);

    const refreshed = firstSessionCookieLine(res.headers['set-cookie']);
    expect(refreshed).toBeDefined();
    expect(Number(/Max-Age=(\d+)/i.exec(refreshed!)?.[1])).toBe(SESSION_TTL_HOURS * 3600);
    // Re-issued, not re-minted: a new token would invalidate requests already
    // in flight from the same browser.
    expect(refreshed!.split(';')[0]).toBe(loginLine!.split(';')[0]);
  });

  it('does not slide the cookie when the session is rejected', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Cookie', 'tx_push_session=s%3Atampered.value');
    expect(res.status).toBe(401);
    expect(firstSessionCookieLine(res.headers['set-cookie'])).toBeUndefined();
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

  it('sends only the clearing cookie — the slide header does not survive logout', async () => {
    // requireUser re-issues the cookie before the logout handler runs, so the
    // response must not carry both a fresh session cookie and the clear.
    const user = await makeUser('logout-clear', 'ClearCookiePw456');
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: 'ClearCookiePw456' });
    const cookieHeader = setCookieToCookieHeader(login.headers['set-cookie']);

    const logout = await request(app).post('/api/auth/logout').set('Cookie', cookieHeader);
    expect(logout.status).toBe(204);

    const lines = sessionCookieLines(logout.headers['set-cookie']);
    expect(lines).toHaveLength(1);
    // An expiry in the past is what tells the browser to drop it.
    expect(lines[0]).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/i);
  });

  it('returns 401 without a valid cookie', async () => {
    const res = await request(app).post('/api/auth/logout');
    expect(res.status).toBe(401);
  });
});
