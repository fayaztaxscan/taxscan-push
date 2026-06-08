import { Router, type Response } from 'express';
import { z } from 'zod';
import bcrypt from 'bcrypt';
import { prisma } from '../lib/prisma';
import { env } from '../lib/env';
import { createSession, revokeSession } from '../lib/sessions';
import { requireUser, SESSION_COOKIE_NAME } from '../lib/auth';
import { makeLoginLimiter } from '../lib/rateLimit';
import { passwordIssue } from '../lib/passwordPolicy';
import { recordAudit } from '../lib/audit';
import { hashInviteToken } from '../lib/invites';

const BCRYPT_COST = 12;

const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(512),
  newPassword: z.string().min(1).max(512),
});

const AcceptInviteSchema = z.object({
  token: z.string().min(1).max(512),
  password: z.string().min(1).max(512),
});

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
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
          passwordResetRequired: user.passwordResetRequired,
        },
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
      passwordResetRequired: u.passwordResetRequired,
    });
  });

  /**
   * Change the calling user's password. Any role.
   *
   * Sliding session model: revokes every OTHER session for this user
   * (keeping the calling session live) so a stolen cookie elsewhere is
   * cut off as soon as the legitimate user changes their password. If
   * `passwordResetRequired` was true, this call clears it.
   */
  router.post('/change-password', requireUser(), async (req, res, next) => {
    try {
      const parsed = ChangePasswordSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: 'invalid_request', issues: parsed.error.issues });
      }
      const u = req.user!;
      const sessionId = req.session!.id;

      const currentOk = await bcrypt.compare(parsed.data.currentPassword, u.passwordHash);
      if (!currentOk) {
        return res.status(401).json({ error: 'invalid_current_password' });
      }

      const issue = passwordIssue(parsed.data.newPassword);
      if (issue) {
        return res.status(400).json({ error: 'invalid_password', message: issue });
      }

      const newHash = await bcrypt.hash(parsed.data.newPassword, BCRYPT_COST);
      await prisma.user.update({
        where: { id: u.id },
        data: {
          passwordHash: newHash,
          passwordResetRequired: false,
        },
      });
      // Revoke OTHER sessions; keep the calling one.
      await prisma.userSession.deleteMany({
        where: { userId: u.id, id: { not: sessionId } },
      });
      await recordAudit({
        userId: u.id,
        action: 'PASSWORD_CHANGED',
        ipAddress: req.ip ?? null,
      });

      return res.status(204).end();
    } catch (err) {
      return next(err);
    }
  });

  // ---- Invite acceptance (Phase 8) — public, token-gated ----

  /**
   * GET /api/auth/invite?token=… — validate an invite link and return who
   * it's for, so the accept page can render the email + role. Public: the
   * 256-bit token is the credential. Does not leak whether an email exists.
   */
  router.get('/invite', async (req, res, next) => {
    try {
      const token = typeof req.query.token === 'string' ? req.query.token : '';
      if (!token) return res.status(400).json({ error: 'missing_token' });
      const invite = await prisma.userInvite.findUnique({
        where: { tokenHash: hashInviteToken(token) },
      });
      if (!invite || invite.acceptedAt) {
        return res.status(404).json({ error: 'invalid_token' });
      }
      if (invite.expiresAt <= new Date()) {
        return res.status(410).json({ error: 'expired' });
      }
      return res.json({ email: invite.email, role: invite.role, expiresAt: invite.expiresAt });
    } catch (err) {
      return next(err);
    }
  });

  /**
   * POST /api/auth/accept-invite — body { token, password }. Consumes the
   * invite, creates the real User (active, no forced reset — they just chose
   * their own password), and logs them in by setting the session cookie.
   */
  router.post('/accept-invite', async (req, res, next) => {
    try {
      const parsed = AcceptInviteSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
      }
      const now = new Date();
      const ipAddress = req.ip ?? null;

      const invite = await prisma.userInvite.findUnique({
        where: { tokenHash: hashInviteToken(parsed.data.token) },
      });
      if (!invite || invite.acceptedAt) {
        return res.status(404).json({ error: 'invalid_token' });
      }
      if (invite.expiresAt <= now) {
        return res.status(410).json({ error: 'expired' });
      }

      const issue = passwordIssue(parsed.data.password);
      if (issue) {
        return res.status(400).json({ error: 'invalid_password', message: issue });
      }

      // Guard the race where someone was created with this email between
      // invite and accept (e.g. the admin also used Create user).
      const clash = await prisma.user.findUnique({ where: { email: invite.email } });
      if (clash) {
        return res.status(409).json({ error: 'email_exists' });
      }

      const passwordHash = await bcrypt.hash(parsed.data.password, BCRYPT_COST);
      const user = await prisma.user.create({
        data: {
          email: invite.email,
          passwordHash,
          role: invite.role,
          isActive: true,
          passwordResetRequired: false,
          lastLoginAt: now,
        },
      });

      await prisma.userInvite.update({
        where: { id: invite.id },
        data: { acceptedAt: now, acceptedUserId: user.id },
      });

      const { token } = await createSession(user.id, {
        userAgent: req.header('user-agent') ?? null,
        ipAddress,
      });
      setSessionCookie(res, token);

      await recordAudit({
        userId: user.id,
        action: 'USER_INVITE_ACCEPTED',
        resourceType: 'user_invite',
        resourceId: invite.id,
        metadata: { email: user.email, role: user.role, invitedByUserId: invite.invitedByUserId },
        ipAddress,
      });
      await recordAudit({
        userId: user.id,
        action: 'LOGIN_SUCCESS',
        metadata: { email: user.email, via: 'invite' },
        ipAddress,
      });

      return res.status(201).json({
        user: { id: user.id, email: user.email, role: user.role },
      });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}
