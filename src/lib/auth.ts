import { timingSafeEqual } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import type { User, UserRole } from '@prisma/client';
import { env } from './env';
import { findValidSession, type SessionWithUser } from './sessions';

// Augment Express's Request so handlers downstream of requireUser see typed
// req.user / req.session. Optional because most public routes never touch it.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
      session?: SessionWithUser;
    }
  }
}

export const SESSION_COOKIE_NAME = 'tx_push_session';

// Requests a user who still owes a forced password change (passwordResetRequired)
// is allowed to make. Everything else is blocked server-side so an admin-issued
// temp/reset password can't be used as a normal credential via the API. The SPA
// router guard (admin/src/router.ts) is a UX nicety, NOT the security control —
// a non-browser client (curl) ignores it.
const PASSWORD_RESET_ALLOWED_REQUESTS = new Set([
  'POST /api/auth/change-password',
  'POST /api/auth/logout',
  'GET /api/auth/me',
]);

function isPasswordResetAllowedRequest(req: Request): boolean {
  // originalUrl is the full path regardless of which router mounted this
  // middleware (req.path/req.url are stripped to the mount inside a sub-router).
  const path = (req.originalUrl ?? req.url).split('?')[0];
  return PASSWORD_RESET_ALLOWED_REQUESTS.has(`${req.method} ${path}`);
}

export function requireBearer(req: Request, res: Response, next: NextFunction): void {
  const header = req.header('authorization') ?? '';
  const match = /^Bearer (.+)$/.exec(header);
  if (!match || !env.adminToken) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const provided = Buffer.from(match[1]);
  const expected = Buffer.from(env.adminToken);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

function readSessionCookie(req: Request): string | null {
  // cookie-parser populates req.signedCookies[name] with the unsigned value
  // when the signature verifies, or `false` when it doesn't.
  const raw = (req.signedCookies as Record<string, unknown> | undefined)?.[SESSION_COOKIE_NAME];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/**
 * Requires a valid cookie session. Optionally constrains to one of the
 * given roles. Populates req.user / req.session on success.
 */
export function requireUser(roles?: UserRole[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const token = readSessionCookie(req);
      if (!token) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      const session = await findValidSession(token);
      if (!session) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      if (roles && roles.length > 0 && !roles.includes(session.user.role)) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      // Forced password rotation is enforced HERE (server-side), not only in the
      // SPA. A session for a user who still owes a password change may reach only
      // change-password / logout / me until they rotate — otherwise a leaked
      // temp/reset password is effectively a permanent full-access credential.
      // Inherited by requireBearerOrUser's cookie path; the bearer (service)
      // path never populates req.user, so cron/curl are unaffected.
      if (session.user.passwordResetRequired && !isPasswordResetAllowedRequest(req)) {
        res.status(403).json({ error: 'password_change_required' });
        return;
      }
      req.user = session.user;
      req.session = session;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Accepts either a valid ADMIN_TOKEN bearer (no req.user populated — preserves
 * the existing bearer-only behaviour) OR a valid cookie session (req.user is
 * populated, optionally role-gated). Used by Phase 4 to let admin endpoints
 * accept both the legacy bearer (RSS poller, cron, curl) and the new cookie
 * flow (admin SPA).
 */
export function requireBearerOrUser(roles?: UserRole[]) {
  const userMw = requireUser(roles);
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const header = req.header('authorization') ?? '';
    const match = /^Bearer (.+)$/.exec(header);
    if (match && env.adminToken) {
      const provided = Buffer.from(match[1]);
      const expected = Buffer.from(env.adminToken);
      if (provided.length === expected.length && timingSafeEqual(provided, expected)) {
        // Bearer matched — proceed without req.user. Bearer is the implicit
        // "service / cron" identity and bypasses per-user role checks by
        // design (RSS poller has no user to attribute to).
        next();
        return;
      }
    }
    await userMw(req, res, next);
  };
}
