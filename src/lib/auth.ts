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
