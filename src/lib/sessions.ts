/**
 * Session helpers for cookie-based auth (Phase 2 of USER_MANAGEMENT_PLAN.md).
 *
 * Storage model — the token shown to the client is a 256-bit (32-byte)
 * crypto-random base64url string. Only its SHA-256 hash is persisted in
 * `UserSession.tokenHash`, so a DB compromise doesn't expose live tokens.
 *
 * Sliding expiry — `findValidSession` updates `expiresAt` to now + the TTL on
 * every successful lookup. Active sessions stay live indefinitely; idle
 * sessions time out after the TTL. Set to 7 days so editors aren't logged out
 * between days (the earlier 8h window forced a re-login most mornings).
 */

import { createHash, randomBytes } from 'crypto';
import type { User, UserSession } from '@prisma/client';
import { prisma } from './prisma';

export const SESSION_TTL_HOURS = 24 * 7; // 7 days (sliding)
const SESSION_TTL_MS = SESSION_TTL_HOURS * 60 * 60 * 1000;

export type SessionWithUser = UserSession & { user: User };

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(
  userId: string,
  opts: { userAgent?: string | null; ipAddress?: string | null } = {},
  now: Date = new Date(),
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await prisma.userSession.create({
    data: {
      userId,
      tokenHash,
      expiresAt,
      userAgent: opts.userAgent ?? null,
      ipAddress: opts.ipAddress ?? null,
    },
  });
  return { token, expiresAt };
}

export async function findValidSession(
  token: string,
  now: Date = new Date(),
): Promise<SessionWithUser | null> {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const session = await prisma.userSession.findUnique({
    where: { tokenHash },
    include: { user: true },
  });
  if (!session) return null;
  if (session.expiresAt <= now) return null;
  if (!session.user.isActive) return null;

  // Slide expiry forward.
  const newExpiry = new Date(now.getTime() + SESSION_TTL_MS);
  const updated = await prisma.userSession.update({
    where: { id: session.id },
    data: { expiresAt: newExpiry },
    include: { user: true },
  });
  return updated;
}

export async function revokeSession(token: string): Promise<void> {
  if (!token) return;
  const tokenHash = hashToken(token);
  // deleteMany so a missing token is a no-op rather than throwing.
  await prisma.userSession.deleteMany({ where: { tokenHash } });
}

export async function revokeAllSessionsForUser(userId: string): Promise<void> {
  await prisma.userSession.deleteMany({ where: { userId } });
}
