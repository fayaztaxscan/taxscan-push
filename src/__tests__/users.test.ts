/**
 * Phase 3 tests for the user management API (/api/users/*) + the
 * change-password endpoint (/api/auth/change-password) that lives on
 * the auth router.
 */

import request from 'supertest';
import bcrypt from 'bcrypt';
import type { User, UserRole } from '@prisma/client';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';

const app = createApp({
  rateLimit: { publicPerMin: 10000, loginPerMin: 10000 },
});

const userIds: string[] = [];
const emails: string[] = [];

async function makeUser(
  suffix: string,
  password: string,
  opts: { role?: UserRole; isActive?: boolean } = {},
): Promise<User> {
  const email = `users-${suffix}-${Date.now()}-${Math.floor(
    Math.random() * 1e9,
  )}@example.com`.toLowerCase();
  const passwordHash = await bcrypt.hash(password, 4);
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
  if (emails.length || userIds.length) {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL audit_log.allow_purge = 'true'`);
      if (userIds.length) {
        await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "userId" = ANY(${userIds}::text[])`;
        await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "resourceType" = 'user' AND "resourceId" = ANY(${userIds}::text[])`;
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

describe('POST /api/users', () => {
  it('admin can create a PUBLISHER (201, no passwordHash in response)', async () => {
    const admin = await makeUser('create-admin', 'AdminPassword123!', { role: 'ADMIN' });
    const cookie = await loginAs(admin, 'AdminPassword123!');

    const newEmail = `created-pub-${Date.now()}-${Math.floor(
      Math.random() * 1e9,
    )}@example.com`.toLowerCase();
    emails.push(newEmail);

    const res = await request(app)
      .post('/api/users')
      .set('Cookie', cookie)
      .send({ email: newEmail, password: 'BrandNewPass987!', role: 'PUBLISHER' });

    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe(newEmail);
    expect(res.body.user.role).toBe('PUBLISHER');
    expect(res.body.user.isActive).toBe(true);
    expect(res.body.user.passwordHash).toBeUndefined();
    // Phase 6 invariant: admin-created users always start with the forced-
    // change-on-first-login flag, regardless of whether the admin passed
    // an explicit password or let the server generate one.
    expect(res.body.user.passwordResetRequired).toBe(true);
    // No temporaryPassword in the response when the admin supplied one.
    expect(res.body.temporaryPassword).toBeUndefined();

    // Track for cleanup.
    userIds.push(res.body.user.id);

    // Audit row.
    const audit = await prisma.auditLog.count({
      where: { userId: admin.id, action: 'USER_CREATED', resourceId: res.body.user.id },
    });
    expect(audit).toBe(1);
  });

  it('admin can create a user without supplying a password — server generates a temp one', async () => {
    const admin = await makeUser('gen-admin', 'GenAdminPw1Aa', { role: 'ADMIN' });
    const cookie = await loginAs(admin, 'GenAdminPw1Aa');

    const newEmail = `created-gen-${Date.now()}-${Math.floor(
      Math.random() * 1e9,
    )}@example.com`.toLowerCase();
    emails.push(newEmail);

    const res = await request(app)
      .post('/api/users')
      .set('Cookie', cookie)
      .send({ email: newEmail, role: 'PUBLISHER' });

    expect(res.status).toBe(201);
    expect(res.body.user.passwordResetRequired).toBe(true);
    expect(typeof res.body.temporaryPassword).toBe('string');
    // Same shape as the reset-password temp: 16 chars, all four classes.
    expect(res.body.temporaryPassword.length).toBe(16);
    expect(/[a-z]/.test(res.body.temporaryPassword)).toBe(true);
    expect(/[A-Z]/.test(res.body.temporaryPassword)).toBe(true);
    expect(/[0-9]/.test(res.body.temporaryPassword)).toBe(true);

    userIds.push(res.body.user.id);

    // The new user can log in with the temp password right away.
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: newEmail, password: res.body.temporaryPassword });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.user.passwordResetRequired).toBe(true);
  });

  it('PUBLISHER is forbidden (403)', async () => {
    const pub = await makeUser('pub-cannot-create', 'PubPassword456!', { role: 'PUBLISHER' });
    const cookie = await loginAs(pub, 'PubPassword456!');

    const res = await request(app)
      .post('/api/users')
      .set('Cookie', cookie)
      .send({ email: `would-create-${Date.now()}@example.com`, password: 'X123abc456def', role: 'PUBLISHER' });

    expect(res.status).toBe(403);
  });

  it('no session → 401', async () => {
    const res = await request(app)
      .post('/api/users')
      .send({ email: 'someone@example.com', password: 'Whatever123Abc', role: 'PUBLISHER' });
    expect(res.status).toBe(401);
  });

  it('returns 409 on duplicate email', async () => {
    const admin = await makeUser('dup-admin', 'AdminDupPw123A', { role: 'ADMIN' });
    const cookie = await loginAs(admin, 'AdminDupPw123A');
    const taken = await makeUser('taken', 'TakenPw123Abc', { role: 'PUBLISHER' });

    const res = await request(app)
      .post('/api/users')
      .set('Cookie', cookie)
      .send({ email: taken.email, password: 'AnotherPass123A', role: 'PUBLISHER' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('email_exists');
  });

  it('returns 400 when password fails policy', async () => {
    const admin = await makeUser('pwpolicy-admin', 'AdminPwPolicy789B', { role: 'ADMIN' });
    const cookie = await loginAs(admin, 'AdminPwPolicy789B');

    const res = await request(app)
      .post('/api/users')
      .set('Cookie', cookie)
      .send({
        email: `pw-${Date.now()}@example.com`,
        password: 'short',
        role: 'PUBLISHER',
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_password');
  });
});

describe('GET /api/users', () => {
  it('admin gets a paginated list with total count', async () => {
    const admin = await makeUser('list-admin', 'ListAdminPass1Aa', { role: 'ADMIN' });
    const cookie = await loginAs(admin, 'ListAdminPass1Aa');

    const res = await request(app)
      .get('/api/users?limit=5')
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(typeof res.body.total).toBe('number');
    expect(res.body.items.length).toBeLessThanOrEqual(5);
    // No passwordHash anywhere.
    for (const u of res.body.items) {
      expect(u.passwordHash).toBeUndefined();
    }
  });

  it('PUBLISHER is forbidden', async () => {
    const pub = await makeUser('list-pub', 'ListPubPass1Aa', { role: 'PUBLISHER' });
    const cookie = await loginAs(pub, 'ListPubPass1Aa');
    const res = await request(app).get('/api/users').set('Cookie', cookie);
    expect(res.status).toBe(403);
  });

  it('excludes inactive users by default; includeInactive=true brings them back', async () => {
    const admin = await makeUser('inactive-list-admin', 'ListInaPw1Aa', { role: 'ADMIN' });
    const cookie = await loginAs(admin, 'ListInaPw1Aa');
    const inactive = await makeUser('inactive-target', 'IgnoredPw1Aa', {
      role: 'PUBLISHER',
      isActive: false,
    });

    const defaultRes = await request(app)
      .get('/api/users?limit=200')
      .set('Cookie', cookie);
    expect(defaultRes.status).toBe(200);
    expect(defaultRes.body.items.find((u: { id: string }) => u.id === inactive.id)).toBeUndefined();

    const allRes = await request(app)
      .get('/api/users?limit=200&includeInactive=true')
      .set('Cookie', cookie);
    expect(allRes.status).toBe(200);
    expect(allRes.body.items.find((u: { id: string }) => u.id === inactive.id)).toBeDefined();
  });
});

describe('GET /api/users/:id', () => {
  it('returns the user, no passwordHash', async () => {
    const admin = await makeUser('get-admin', 'GetAdminPw1Aa', { role: 'ADMIN' });
    const cookie = await loginAs(admin, 'GetAdminPw1Aa');
    const target = await makeUser('get-target', 'AnyPw1Aa', { role: 'PUBLISHER' });

    const res = await request(app)
      .get(`/api/users/${target.id}`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(target.id);
    expect(res.body.user.passwordHash).toBeUndefined();
  });

  it('returns 404 for an unknown id', async () => {
    const admin = await makeUser('get-404-admin', 'Get404Pw1Aa', { role: 'ADMIN' });
    const cookie = await loginAs(admin, 'Get404Pw1Aa');
    const res = await request(app)
      .get('/api/users/this-id-does-not-exist')
      .set('Cookie', cookie);
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/users/:id — last-active-admin guard', () => {
  it('admin can update another user freely', async () => {
    const admin = await makeUser('patch-admin', 'PatchAdminPw1Aa', { role: 'ADMIN' });
    const cookie = await loginAs(admin, 'PatchAdminPw1Aa');
    const pub = await makeUser('patch-pub', 'PatchPubPw1Aa', { role: 'PUBLISHER' });

    const res = await request(app)
      .patch(`/api/users/${pub.id}`)
      .set('Cookie', cookie)
      .send({ role: 'ADMIN' });
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('ADMIN');
  });

  /**
   * Helper: temporarily make `onlyAdmin` the genuinely-sole active admin
   * by deactivating every other active admin in the DB, run `fn`, then
   * restore. Other tests' admin rows are touched but only for the duration
   * of this assertion; isolation is restored before we return.
   */
  async function withSoleActiveAdmin(
    onlyAdminId: string,
    fn: () => Promise<void>,
  ): Promise<void> {
    const others = await prisma.user.findMany({
      where: { id: { not: onlyAdminId }, role: 'ADMIN', isActive: true },
      select: { id: true },
    });
    if (others.length > 0) {
      await prisma.user.updateMany({
        where: { id: { in: others.map((o) => o.id) } },
        data: { isActive: false },
      });
    }
    try {
      await fn();
    } finally {
      if (others.length > 0) {
        await prisma.user.updateMany({
          where: { id: { in: others.map((o) => o.id) } },
          data: { isActive: true },
        });
      }
    }
  }

  it('refuses to deactivate the last active admin (yourself) with 409', async () => {
    const onlyAdmin = await makeUser('only-admin-deactivate', 'OnlyAdminPw1Aa', { role: 'ADMIN' });
    const cookie = await loginAs(onlyAdmin, 'OnlyAdminPw1Aa');

    await withSoleActiveAdmin(onlyAdmin.id, async () => {
      const res = await request(app)
        .patch(`/api/users/${onlyAdmin.id}`)
        .set('Cookie', cookie)
        .send({ isActive: false });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('last_active_admin');
    });
  });

  it('refuses to demote the last active admin (yourself) to PUBLISHER with 409', async () => {
    const lastAdmin = await makeUser('only-admin-demote', 'OnlyDemotePw1Aa', { role: 'ADMIN' });
    const cookie = await loginAs(lastAdmin, 'OnlyDemotePw1Aa');

    await withSoleActiveAdmin(lastAdmin.id, async () => {
      const res = await request(app)
        .patch(`/api/users/${lastAdmin.id}`)
        .set('Cookie', cookie)
        .send({ role: 'PUBLISHER' });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('last_active_admin');
    });
  });

  it('deactivating a user also revokes their active sessions', async () => {
    const admin = await makeUser('revoke-admin', 'RevokeAdminPw1A', { role: 'ADMIN' });
    const target = await makeUser('revoke-target', 'RevokeTargetPw1A', { role: 'PUBLISHER' });
    const cookie = await loginAs(admin, 'RevokeAdminPw1A');
    await loginAs(target, 'RevokeTargetPw1A'); // creates a session

    const before = await prisma.userSession.count({ where: { userId: target.id } });
    expect(before).toBeGreaterThan(0);

    const res = await request(app)
      .patch(`/api/users/${target.id}`)
      .set('Cookie', cookie)
      .send({ isActive: false });
    expect(res.status).toBe(200);

    const after = await prisma.userSession.count({ where: { userId: target.id } });
    expect(after).toBe(0);
  });
});

describe('POST /api/users/:id/reset-password', () => {
  it('returns a temp password meeting policy, revokes target sessions, allows login with it', async () => {
    const admin = await makeUser('reset-admin', 'ResetAdminPw1Aa', { role: 'ADMIN' });
    const target = await makeUser('reset-target', 'OriginalPw1Aa', { role: 'PUBLISHER' });
    await loginAs(target, 'OriginalPw1Aa'); // seed a session that should be revoked

    const cookie = await loginAs(admin, 'ResetAdminPw1Aa');
    const res = await request(app)
      .post(`/api/users/${target.id}/reset-password`)
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    const temp: string = res.body.temporaryPassword;
    expect(typeof temp).toBe('string');
    expect(temp.length).toBe(16);
    expect(/[a-z]/.test(temp)).toBe(true);
    expect(/[A-Z]/.test(temp)).toBe(true);
    expect(/[0-9]/.test(temp)).toBe(true);
    expect(/[!@#$%^&*]/.test(temp)).toBe(true);

    // Old sessions revoked.
    const remaining = await prisma.userSession.count({ where: { userId: target.id } });
    expect(remaining).toBe(0);

    // passwordResetRequired set.
    const reloaded = await prisma.user.findUnique({ where: { id: target.id } });
    expect(reloaded?.passwordResetRequired).toBe(true);

    // The target can log in with the temp password.
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: target.email, password: temp });
    expect(login.status).toBe(200);
  });

  it('returns 404 for an unknown target', async () => {
    const admin = await makeUser('reset-404-admin', 'Reset404Pw1Aa', { role: 'ADMIN' });
    const cookie = await loginAs(admin, 'Reset404Pw1Aa');
    const res = await request(app)
      .post('/api/users/does-not-exist/reset-password')
      .set('Cookie', cookie);
    expect(res.status).toBe(404);
  });
});

describe('POST /api/auth/change-password', () => {
  it('rejects wrong currentPassword with 401', async () => {
    const u = await makeUser('chg-wrong', 'OldPassword1Aa', { role: 'PUBLISHER' });
    const cookie = await loginAs(u, 'OldPassword1Aa');

    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Cookie', cookie)
      .send({ currentPassword: 'NotTheRight1A', newPassword: 'TotallyNewPw2B' });
    expect(res.status).toBe(401);
  });

  it('rejects new password that fails policy with 400', async () => {
    const u = await makeUser('chg-policy', 'OldPassword1Bb', { role: 'PUBLISHER' });
    const cookie = await loginAs(u, 'OldPassword1Bb');

    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Cookie', cookie)
      .send({ currentPassword: 'OldPassword1Bb', newPassword: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_password');
  });

  it('success: clears passwordResetRequired, keeps caller session, revokes others, old password no longer works', async () => {
    const u = await makeUser('chg-success', 'OldPassword1Cc', { role: 'PUBLISHER' });
    // Pretend this user was reset by an admin earlier.
    await prisma.user.update({
      where: { id: u.id },
      data: { passwordResetRequired: true },
    });

    const callerCookie = await loginAs(u, 'OldPassword1Cc');
    // A second login from a different "device" → a second session that
    // should be revoked.
    await loginAs(u, 'OldPassword1Cc');
    const sessionsBefore = await prisma.userSession.count({ where: { userId: u.id } });
    expect(sessionsBefore).toBe(2);

    const change = await request(app)
      .post('/api/auth/change-password')
      .set('Cookie', callerCookie)
      .send({ currentPassword: 'OldPassword1Cc', newPassword: 'BrandNewPw2Dd' });
    expect(change.status).toBe(204);

    // The flag is now cleared.
    const reloaded = await prisma.user.findUnique({ where: { id: u.id } });
    expect(reloaded?.passwordResetRequired).toBe(false);

    // The OTHER session is revoked; the caller's session survives.
    const sessionsAfter = await prisma.userSession.count({ where: { userId: u.id } });
    expect(sessionsAfter).toBe(1);

    // Caller can still hit /me.
    const me = await request(app).get('/api/auth/me').set('Cookie', callerCookie);
    expect(me.status).toBe(200);

    // Old password no longer logs in.
    const oldLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: u.email, password: 'OldPassword1Cc' });
    expect(oldLogin.status).toBe(401);

    // New password works.
    const newLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: u.email, password: 'BrandNewPw2Dd' });
    expect(newLogin.status).toBe(200);
  });
});
