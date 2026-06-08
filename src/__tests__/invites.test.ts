/**
 * Phase 8 tests — email-invite flow.
 *
 *   POST   /api/users/invite              admin invites by email
 *   GET    /api/users/invites             list pending invites
 *   POST   /api/users/invites/:id/resend  regenerate + re-send
 *   DELETE /api/users/invites/:id         revoke
 *   GET    /api/auth/invite?token=…       validate a link (public)
 *   POST   /api/auth/accept-invite        consume the link, create + login
 *
 * The ElasticEmail provider is replaced by an in-memory sender injected via
 * createApp, so no network is touched and we can assert on what was "sent".
 */

import { randomBytes } from 'crypto';
import request from 'supertest';
import bcrypt from 'bcrypt';
import type { User, UserRole } from '@prisma/client';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { hashInviteToken } from '../lib/invites';
import type { EmailMessage, EmailSendResult } from '../lib/email';

// ---- in-memory email sender ----
const sentEmails: EmailMessage[] = [];
let emailShouldFail = false;
const mockEmailSender = async (msg: EmailMessage): Promise<EmailSendResult> => {
  sentEmails.push(msg);
  return emailShouldFail ? { ok: false, error: 'simulated failure' } : { ok: true };
};

const app = createApp({
  emailSender: mockEmailSender,
  rateLimit: { publicPerMin: 10000, loginPerMin: 10000 },
});

const userIds: string[] = [];
const inviteIds: string[] = [];
const emails: string[] = [];

function uniqueEmail(prefix: string): string {
  const e = `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e9)}@example.com`.toLowerCase();
  emails.push(e);
  return e;
}

async function makeUser(role: UserRole, password: string): Promise<User> {
  const email = uniqueEmail(`inv-${role.toLowerCase()}`);
  const passwordHash = await bcrypt.hash(password, 4);
  const u = await prisma.user.create({ data: { email, passwordHash, role, isActive: true } });
  userIds.push(u.id);
  return u;
}

async function loginAs(user: User, password: string): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ email: user.email, password });
  expect(res.status).toBe(200);
  const sc = res.headers['set-cookie'];
  const arr = Array.isArray(sc) ? sc : [sc as string];
  return arr.map((line) => line.split(';')[0]).join('; ');
}

function tokenFromUrl(url: string): string {
  return new URL(url).searchParams.get('token') ?? '';
}

beforeEach(() => {
  sentEmails.length = 0;
  emailShouldFail = false;
});

afterAll(async () => {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL audit_log.allow_purge = 'true'`);
    if (userIds.length) {
      await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "userId" = ANY(${userIds}::text[])`;
    }
    if (inviteIds.length) {
      await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "resourceType" = 'user_invite' AND "resourceId" = ANY(${inviteIds}::text[])`;
    }
    if (emails.length) {
      await tx.$executeRaw`DELETE FROM "AuditLog" WHERE (metadata->>'email') = ANY(${emails}::text[])`;
    }
  });
  if (emails.length) {
    await prisma.userInvite.deleteMany({ where: { email: { in: emails } } });
  }
  if (inviteIds.length) {
    await prisma.userInvite.deleteMany({ where: { id: { in: inviteIds } } });
  }
  if (userIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await prisma.$disconnect();
});

describe('POST /api/users/invite', () => {
  it('admin invites a new email: 201, invite row created, email sent, no User yet', async () => {
    const admin = await makeUser('ADMIN', 'InviteAdminPw1Aa');
    const cookie = await loginAs(admin, 'InviteAdminPw1Aa');
    const target = uniqueEmail('invitee');

    const res = await request(app)
      .post('/api/users/invite')
      .set('Cookie', cookie)
      .send({ email: target, role: 'PUBLISHER' });

    expect(res.status).toBe(201);
    expect(res.body.emailSent).toBe(true);
    expect(typeof res.body.inviteUrl).toBe('string');
    expect(res.body.inviteUrl).toContain('/admin/accept-invite?token=');
    inviteIds.push(res.body.invite.id);

    // Email actually handed to the sender, addressed to the invitee.
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].to).toBe(target);
    expect(sentEmails[0].html).toContain(tokenFromUrl(res.body.inviteUrl).slice(0, 8));

    // No User row exists yet — only the invite.
    const userRow = await prisma.user.findUnique({ where: { email: target } });
    expect(userRow).toBeNull();
    const inviteRow = await prisma.userInvite.findUnique({ where: { id: res.body.invite.id } });
    expect(inviteRow?.acceptedAt).toBeNull();

    // Audit.
    const audited = await prisma.auditLog.count({
      where: { userId: admin.id, action: 'USER_INVITED', resourceId: res.body.invite.id },
    });
    expect(audited).toBe(1);
  });

  it('falls back to a shareable link when the email send fails', async () => {
    const admin = await makeUser('ADMIN', 'InviteFailPw1Aa');
    const cookie = await loginAs(admin, 'InviteFailPw1Aa');
    emailShouldFail = true;

    const res = await request(app)
      .post('/api/users/invite')
      .set('Cookie', cookie)
      .send({ email: uniqueEmail('invitee-fail'), role: 'PUBLISHER' });

    expect(res.status).toBe(201);
    expect(res.body.emailSent).toBe(false);
    expect(res.body.emailError).toBe('simulated failure');
    expect(res.body.inviteUrl).toContain('token=');
    inviteIds.push(res.body.invite.id);
  });

  it('PUBLISHER cannot invite (403)', async () => {
    const pub = await makeUser('PUBLISHER', 'InvitePubPw1Aa');
    const cookie = await loginAs(pub, 'InvitePubPw1Aa');
    const res = await request(app)
      .post('/api/users/invite')
      .set('Cookie', cookie)
      .send({ email: uniqueEmail('nope'), role: 'PUBLISHER' });
    expect(res.status).toBe(403);
  });

  it('no session → 401', async () => {
    const res = await request(app)
      .post('/api/users/invite')
      .send({ email: uniqueEmail('nosession'), role: 'PUBLISHER' });
    expect(res.status).toBe(401);
  });

  it('409 when a real user already owns that email', async () => {
    const admin = await makeUser('ADMIN', 'InviteDupPw1Aa');
    const cookie = await loginAs(admin, 'InviteDupPw1Aa');
    const existing = await makeUser('PUBLISHER', 'ExistingPw1Aa');

    const res = await request(app)
      .post('/api/users/invite')
      .set('Cookie', cookie)
      .send({ email: existing.email, role: 'PUBLISHER' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('email_exists');
  });
});

describe('GET /api/users/invites', () => {
  it('lists pending invites with inviter email', async () => {
    const admin = await makeUser('ADMIN', 'InviteListPw1Aa');
    const cookie = await loginAs(admin, 'InviteListPw1Aa');
    const target = uniqueEmail('listed');

    const created = await request(app)
      .post('/api/users/invite')
      .set('Cookie', cookie)
      .send({ email: target, role: 'ADMIN' });
    inviteIds.push(created.body.invite.id);

    const res = await request(app).get('/api/users/invites').set('Cookie', cookie);
    expect(res.status).toBe(200);
    const row = res.body.items.find((i: { email: string }) => i.email === target);
    expect(row).toBeDefined();
    expect(row.role).toBe('ADMIN');
    expect(row.invitedByEmail).toBe(admin.email);
  });
});

describe('GET /api/auth/invite + POST /api/auth/accept-invite', () => {
  it('validates the token then accepts: creates an active user and logs them in', async () => {
    const admin = await makeUser('ADMIN', 'AcceptAdminPw1Aa');
    const cookie = await loginAs(admin, 'AcceptAdminPw1Aa');
    const target = uniqueEmail('accept-me');

    const invite = await request(app)
      .post('/api/users/invite')
      .set('Cookie', cookie)
      .send({ email: target, role: 'PUBLISHER' });
    inviteIds.push(invite.body.invite.id);
    const token = tokenFromUrl(invite.body.inviteUrl);

    // Public validation endpoint reports who it's for.
    const check = await request(app).get(`/api/auth/invite?token=${encodeURIComponent(token)}`);
    expect(check.status).toBe(200);
    expect(check.body.email).toBe(target);
    expect(check.body.role).toBe('PUBLISHER');

    // Accept with a compliant password.
    const accept = await request(app)
      .post('/api/auth/accept-invite')
      .send({ token, password: 'ChosenByMe123' });
    expect(accept.status).toBe(201);
    expect(accept.body.user.email).toBe(target);
    expect(accept.body.user.role).toBe('PUBLISHER');

    const created = await prisma.user.findUnique({ where: { email: target } });
    expect(created?.isActive).toBe(true);
    expect(created?.passwordResetRequired).toBe(false);
    if (created) userIds.push(created.id);

    // The accept set a session cookie → /me works.
    const sc = accept.headers['set-cookie'];
    const arr = Array.isArray(sc) ? sc : [sc as string];
    const acceptCookie = arr.map((l) => l.split(';')[0]).join('; ');
    const me = await request(app).get('/api/auth/me').set('Cookie', acceptCookie);
    expect(me.status).toBe(200);
    expect(me.body.email).toBe(target);

    // Invite marked accepted; audit rows written.
    const inviteRow = await prisma.userInvite.findUnique({ where: { id: invite.body.invite.id } });
    expect(inviteRow?.acceptedAt).not.toBeNull();
    expect(inviteRow?.acceptedUserId).toBe(created?.id);
    const accepted = await prisma.auditLog.count({
      where: { action: 'USER_INVITE_ACCEPTED', resourceId: invite.body.invite.id },
    });
    expect(accepted).toBe(1);

    // The chosen password also logs in normally.
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: target, password: 'ChosenByMe123' });
    expect(login.status).toBe(200);
  });

  it('rejects a password that fails policy (400)', async () => {
    const admin = await makeUser('ADMIN', 'AcceptPolicyPw1Aa');
    const cookie = await loginAs(admin, 'AcceptPolicyPw1Aa');
    const invite = await request(app)
      .post('/api/users/invite')
      .set('Cookie', cookie)
      .send({ email: uniqueEmail('weak-pw'), role: 'PUBLISHER' });
    inviteIds.push(invite.body.invite.id);

    const res = await request(app)
      .post('/api/auth/accept-invite')
      .send({ token: tokenFromUrl(invite.body.inviteUrl), password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_password');
  });

  it('invalid token → 404, expired token → 410', async () => {
    const bad = await request(app).post('/api/auth/accept-invite').send({
      token: 'not-a-real-token',
      password: 'Whatever123Ab',
    });
    expect(bad.status).toBe(404);

    // Seed an already-expired invite directly (raw token known to us).
    const rawToken = randomBytes(32).toString('base64url');
    const email = uniqueEmail('expired');
    const expired = await prisma.userInvite.create({
      data: {
        email,
        role: 'PUBLISHER',
        tokenHash: hashInviteToken(rawToken),
        expiresAt: new Date(Date.now() - 60_000),
      },
    });
    inviteIds.push(expired.id);

    const check = await request(app).get(`/api/auth/invite?token=${encodeURIComponent(rawToken)}`);
    expect(check.status).toBe(410);
    const res = await request(app)
      .post('/api/auth/accept-invite')
      .send({ token: rawToken, password: 'GoodEnoughPw1A' });
    expect(res.status).toBe(410);
  });
});

describe('resend + revoke', () => {
  it('resend invalidates the old link and issues a working new one', async () => {
    const admin = await makeUser('ADMIN', 'ResendAdminPw1Aa');
    const cookie = await loginAs(admin, 'ResendAdminPw1Aa');
    const target = uniqueEmail('resend');

    const first = await request(app)
      .post('/api/users/invite')
      .set('Cookie', cookie)
      .send({ email: target, role: 'PUBLISHER' });
    inviteIds.push(first.body.invite.id);
    const firstToken = tokenFromUrl(first.body.inviteUrl);

    const resend = await request(app)
      .post(`/api/users/invites/${first.body.invite.id}/resend`)
      .set('Cookie', cookie);
    expect(resend.status).toBe(200);
    inviteIds.push(resend.body.invite.id);
    const newToken = tokenFromUrl(resend.body.inviteUrl);
    expect(newToken).not.toBe(firstToken);

    // Old token is dead.
    const oldCheck = await request(app).get(
      `/api/auth/invite?token=${encodeURIComponent(firstToken)}`,
    );
    expect(oldCheck.status).toBe(404);

    // New token validates.
    const newCheck = await request(app).get(
      `/api/auth/invite?token=${encodeURIComponent(newToken)}`,
    );
    expect(newCheck.status).toBe(200);

    // Exactly one pending invite remains for this email.
    const list = await request(app).get('/api/users/invites').set('Cookie', cookie);
    const matches = list.body.items.filter((i: { email: string }) => i.email === target);
    expect(matches).toHaveLength(1);
  });

  it('revoke deletes the invite so the link no longer works', async () => {
    const admin = await makeUser('ADMIN', 'RevokeAdminPw1Aa');
    const cookie = await loginAs(admin, 'RevokeAdminPw1Aa');
    const invite = await request(app)
      .post('/api/users/invite')
      .set('Cookie', cookie)
      .send({ email: uniqueEmail('revoke'), role: 'PUBLISHER' });
    inviteIds.push(invite.body.invite.id);
    const token = tokenFromUrl(invite.body.inviteUrl);

    const del = await request(app)
      .delete(`/api/users/invites/${invite.body.invite.id}`)
      .set('Cookie', cookie);
    expect(del.status).toBe(204);

    const check = await request(app).get(`/api/auth/invite?token=${encodeURIComponent(token)}`);
    expect(check.status).toBe(404);
  });
});
