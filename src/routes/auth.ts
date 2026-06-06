import { Router, type Response } from 'express';
import { z } from 'zod';
import bcrypt from 'bcrypt';
import type { AuditAction, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { env } from '../lib/env';
import { createSession, revokeSession } from '../lib/sessions';
import { requireUser, SESSION_COOKIE_NAME } from '../lib/auth';
import { makeLoginLimiter } from '../lib/rateLimit';

const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 5;
const SESSION_COOKIE_MAX_AGE_MS = 8 * 60 * 60 * 1000;

const LoginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(512),
});

function cookieOptions() {
  return {
    httpOnly: true,
    secure: env.nodeEnv === 'production',
    sameSite: 'lax' as const,
    path: '/',
    signed: true,
  };
}

function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE_NAME, token, {
    ...cookieOptions(),
    maxAge: SESSION_COOKIE_MAX_AGE_MS,
  });
}

function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, cookieOptions());
}

async function recordAudit(args: {
  userId?: string | null;
  action: AuditAction;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
}): Promise<void> {
  await prisma.auditLog.create({
    data: {
      userId: args.userId ?? null,
      action: args.action,
      // Pass undefined when there's no metadata so Prisma omits the column
      // (defaults to NULL); otherwise pass the object. Cast to satisfy
      // Prisma's InputJsonValue union — `Record<string, unknown>` doesn't
      // narrow correctly against the array variant of the union.
      metadata: args.metadata as Prisma.InputJsonValue | undefined,
      ipAddress: args.ipAddress ?? null,
    },
  });
}

async function recentFailedAttempts(email: string, now: Date): Promise<number> {
  const since = new Date(now.getTime() - LOCKOUT_WINDOW_MS);
  return prisma.auditLog.count({
    where: {
      action: 'LOGIN_FAILED',
      createdAt: { gte: since },
      // Postgres JSONB path filter on metadata.email.
      metadata: { path: ['email'], equals: email },
    },
  });
}

export function createAuthRouter(
  opts: { loginPerMin?: number } = {},
): Router {
  const router = Router();
  const limiter = makeLoginLimiter(opts.loginPerMin ?? env.rateLimit.loginPerMin);

  router.post('/login', limiter, async (req, res, next) => {
    try {
      const parsed = LoginSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
      }
      const email = parsed.data.email.toLowerCase().trim();
      const password = parsed.data.password;
      const ipAddress = req.ip ?? null;
      const now = new Date();

      // Email-based throttle — independent of the per-IP rate limit above.
      // Stops slow brute-force from a rotating IP set.
      if ((await recentFailedAttempts(email, now)) >= MAX_FAILED_ATTEMPTS) {
        return res.status(423).json({ error: 'locked' });
      }

      const user = await prisma.user.findUnique({ where: { email } });
      if (!user || !user.isActive) {
        await recordAudit({
          action: 'LOGIN_FAILED',
          metadata: { email, reason: user ? 'inactive' : 'no_such_user' },
          ipAddress,
        });
        return res.status(401).json({ error: 'invalid_credentials' });
      }

      const passwordOk = await bcrypt.compare(password, user.passwordHash);
      if (!passwordOk) {
        await recordAudit({
          userId: user.id,
          action: 'LOGIN_FAILED',
          metadata: { email, reason: 'wrong_password' },
          ipAddress,
        });
        return res.status(401).json({ error: 'invalid_credentials' });
      }

      const { token } = await createSession(user.id, {
        userAgent: req.header('user-agent') ?? null,
        ipAddress,
      });
      setSessionCookie(res, token);

      await prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: now },
      });
      await recordAudit({
        userId: user.id,
        action: 'LOGIN_SUCCESS',
        metadata: { email },
        ipAddress,
      });

      return res.json({
        user: { id: user.id, email: user.email, role: user.role },
      });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/logout', requireUser(), async (req, res, next) => {
    try {
      // requireUser already validated the cookie — grab the raw token to
      // revoke its row.
      const raw = (req.signedCookies as Record<string, unknown> | undefined)?.[
        SESSION_COOKIE_NAME
      ];
      if (typeof raw === 'string') {
        await revokeSession(raw);
      }
      clearSessionCookie(res);
      await recordAudit({
        userId: req.user!.id,
        action: 'LOGOUT',
        ipAddress: req.ip ?? null,
      });
      return res.status(204).end();
    } catch (err) {
      return next(err);
    }
  });

  router.get('/me', requireUser(), (req, res) => {
    const u = req.user!;
    return res.json({
      id: u.id,
      email: u.email,
      role: u.role,
      lastLoginAt: u.lastLoginAt,
    });
  });

  return router;
}
