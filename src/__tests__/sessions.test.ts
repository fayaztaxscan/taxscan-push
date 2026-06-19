/**
 * Phase 2 unit tests for the session helpers in src/lib/sessions.ts.
 *
 * Covers: create + DB row shape, lookup happy/invalid/expired/inactive,
 * sliding expiry, revoke single, revoke all for user.
 */

import type { User } from '@prisma/client';
import { prisma } from '../lib/prisma';
import {
  createSession,
  findValidSession,
  revokeAllSessionsForUser,
  revokeSession,
  SESSION_TTL_HOURS,
} from '../lib/sessions';

const userIds: string[] = [];

async function makeUser(suffix: string, opts: { isActive?: boolean } = {}): Promise<User> {
  const u = await prisma.user.create({
    data: {
      email: `sess-${suffix}-${Date.now()}-${Math.floor(Math.random() * 1e9)}@example.com`,
      passwordHash: 'unused-for-session-tests',
      role: 'PUBLISHER',
      isActive: opts.isActive ?? true,
    },
  });
  userIds.push(u.id);
  return u;
}

afterAll(async () => {
  if (userIds.length) {
    // Cascade clears UserSession rows; AuditLog rows have SetNull on userId
    // and there shouldn't be any from these tests anyway.
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await prisma.$disconnect();
});

describe('createSession', () => {
  it('returns a base64url token + expiresAt one TTL in the future', async () => {
    const u = await makeUser('create-token');
    const before = new Date();
    const { token, expiresAt } = await createSession(u.id);
    const ttlMs = expiresAt.getTime() - before.getTime();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/); // base64url charset
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(ttlMs).toBeGreaterThanOrEqual((SESSION_TTL_HOURS - 0.01) * 3600_000);
    expect(ttlMs).toBeLessThanOrEqual((SESSION_TTL_HOURS + 0.01) * 3600_000);
  });

  it('stores a SHA-256 hash, never the raw token', async () => {
    const u = await makeUser('hash');
    const { token } = await createSession(u.id);
    const row = await prisma.userSession.findFirst({
      where: { userId: u.id },
    });
    expect(row).not.toBeNull();
    // Hash is 64 hex chars; the raw token must not appear anywhere in the row.
    expect(row?.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(row?.tokenHash).not.toBe(token);
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it('persists userAgent and ipAddress when provided', async () => {
    const u = await makeUser('ua-ip');
    await createSession(u.id, { userAgent: 'test-agent/1.0', ipAddress: '10.0.0.7' });
    const row = await prisma.userSession.findFirst({ where: { userId: u.id } });
    expect(row?.userAgent).toBe('test-agent/1.0');
    expect(row?.ipAddress).toBe('10.0.0.7');
  });
});

describe('findValidSession', () => {
  it('returns the session + user for a valid token', async () => {
    const u = await makeUser('lookup');
    const { token } = await createSession(u.id);
    const found = await findValidSession(token);
    expect(found).not.toBeNull();
    expect(found?.user.id).toBe(u.id);
    expect(found?.userId).toBe(u.id);
  });

  it('returns null for an unknown token', async () => {
    const found = await findValidSession('not-a-real-token-just-some-string');
    expect(found).toBeNull();
  });

  it('returns null for empty token', async () => {
    const found = await findValidSession('');
    expect(found).toBeNull();
  });

  it('returns null when the underlying user is inactive', async () => {
    const u = await makeUser('inactive');
    const { token } = await createSession(u.id);
    await prisma.user.update({ where: { id: u.id }, data: { isActive: false } });
    const found = await findValidSession(token);
    expect(found).toBeNull();
  });

  it('returns null for an expired session and does NOT slide it forward', async () => {
    const u = await makeUser('expired');
    const { token } = await createSession(u.id);
    // Force the row's expiresAt into the past.
    const past = new Date(Date.now() - 60_000);
    await prisma.userSession.updateMany({
      where: { userId: u.id },
      data: { expiresAt: past },
    });
    const found = await findValidSession(token);
    expect(found).toBeNull();
    const row = await prisma.userSession.findFirst({ where: { userId: u.id } });
    expect(row?.expiresAt.getTime()).toBe(past.getTime());
  });

  it('slides expiresAt forward on a successful lookup', async () => {
    const u = await makeUser('slide');
    const { expiresAt: initialExpiry, token } = await createSession(u.id);
    // Roll the row backwards a bit so we can see the slide.
    const earlier = new Date(initialExpiry.getTime() - 2 * 3600_000);
    await prisma.userSession.updateMany({
      where: { userId: u.id },
      data: { expiresAt: earlier },
    });

    const found = await findValidSession(token);
    expect(found).not.toBeNull();
    // New expiry should be ~now + the TTL, comfortably beyond `earlier`.
    expect(found!.expiresAt.getTime()).toBeGreaterThan(earlier.getTime() + 3600_000);
  });
});

describe('revokeSession', () => {
  it('deletes the row for a known token', async () => {
    const u = await makeUser('revoke-one');
    const { token } = await createSession(u.id);
    await revokeSession(token);
    const found = await findValidSession(token);
    expect(found).toBeNull();
    const count = await prisma.userSession.count({ where: { userId: u.id } });
    expect(count).toBe(0);
  });

  it('is a no-op for an unknown token', async () => {
    await expect(revokeSession('not-a-real-token')).resolves.toBeUndefined();
  });

  it('is a no-op for an empty token', async () => {
    await expect(revokeSession('')).resolves.toBeUndefined();
  });
});

describe('revokeAllSessionsForUser', () => {
  it('deletes every session row for the user, leaving others alone', async () => {
    const target = await makeUser('revoke-all-target');
    const bystander = await makeUser('revoke-all-bystander');

    await createSession(target.id);
    await createSession(target.id);
    await createSession(target.id);
    await createSession(bystander.id);

    await revokeAllSessionsForUser(target.id);

    const targetRows = await prisma.userSession.count({ where: { userId: target.id } });
    const bystanderRows = await prisma.userSession.count({
      where: { userId: bystander.id },
    });
    expect(targetRows).toBe(0);
    expect(bystanderRows).toBe(1);
  });
});
