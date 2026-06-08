/**
 * Invite-token helpers (Phase 8 of USER_MANAGEMENT_PLAN.md — email invites).
 *
 * Same storage model as UserSession: the token handed to the recipient (in
 * the invite link) is a 256-bit crypto-random base64url string; only its
 * SHA-256 hash is persisted in `UserInvite.tokenHash`, so a DB read can't
 * forge a working invite link.
 */

import { createHash, randomBytes } from 'crypto';
import { env } from './env';

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Mints a fresh invite token. Returns the raw token (goes in the email link,
 * never stored), its hash (stored), and the expiry computed from
 * INVITE_TTL_HOURS.
 */
export function createInviteToken(now: Date = new Date()): {
  token: string;
  tokenHash: string;
  expiresAt: Date;
} {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashInviteToken(token);
  const expiresAt = new Date(now.getTime() + env.invite.ttlHours * 60 * 60 * 1000);
  return { token, tokenHash, expiresAt };
}

/**
 * Builds the absolute accept-invite link the recipient clicks. The admin SPA
 * is served under `/admin`, so the public-facing route is
 * `<APP_BASE_URL>/admin/accept-invite?token=…`. `baseOverride` lets the route
 * fall back to the request origin when APP_BASE_URL is unset (dev / preview).
 */
export function buildInviteUrl(token: string, baseOverride?: string): string {
  const base = (baseOverride ?? env.appBaseUrl).replace(/\/+$/, '');
  return `${base}/admin/accept-invite?token=${encodeURIComponent(token)}`;
}
