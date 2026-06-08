/**
 * Phase 3 — user management API. All routes require an ADMIN session.
 *
 *   POST   /api/users                       create user
 *   GET    /api/users                       paginated list
 *   GET    /api/users/:id                   get one
 *   PATCH  /api/users/:id                   update role / isActive
 *   POST   /api/users/:id/reset-password    generate temp password + revoke sessions
 *
 * Phase 4 will route the inline `recordAudit` calls in this file through
 * a centralised helper. Until then, each handler writes its own AuditLog
 * row inline — same shape as `src/routes/auth.ts`.
 */

import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcrypt';
import type { AuditAction, User, UserRole } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { env } from '../lib/env';
import { requireUser } from '../lib/auth';
import { revokeAllSessionsForUser } from '../lib/sessions';
import { generateTemporaryPassword, passwordIssue } from '../lib/passwordPolicy';
import { recordAudit } from '../lib/audit';
import { createInviteToken, buildInviteUrl } from '../lib/invites';
import { buildInviteEmail, defaultEmailSender, type EmailSender } from '../lib/email';

const BCRYPT_COST = 12;

const CreateUserSchema = z.object({
  email: z.string().email().max(320),
  // Password is optional. When the admin SPA's "Create user" modal omits
  // it, the server generates a 16-char temp password meeting policy and
  // returns it in the response so the admin can share it out-of-band.
  // Either way the created row carries passwordResetRequired = true, so
  // the new user has to change it on first login.
  password: z.string().min(1).max(512).optional(),
  role: z.enum(['ADMIN', 'PUBLISHER']),
});

const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  includeInactive: z
    .union([z.literal('true'), z.literal('false'), z.literal(true), z.literal(false)])
    .optional()
    .transform((v) => v === true || v === 'true'),
});

const InviteSchema = z.object({
  email: z.string().email().max(320),
  role: z.enum(['ADMIN', 'PUBLISHER']),
});

const PatchUserSchema = z
  .object({
    role: z.enum(['ADMIN', 'PUBLISHER']).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => v.role !== undefined || v.isActive !== undefined, {
    message: 'must include at least one of: role, isActive',
  });

function publicUserShape(u: User) {
  return {
    id: u.id,
    email: u.email,
    role: u.role,
    isActive: u.isActive,
    passwordResetRequired: u.passwordResetRequired,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
    lastLoginAt: u.lastLoginAt,
  };
}

/**
 * Returns true if the proposed change would leave zero active admins.
 * `targetId` is the row being changed; `newRole` / `newIsActive` reflect
 * the change. Either parameter may be undefined to mean "unchanged."
 */
async function wouldDropLastAdmin(
  targetId: string,
  newRole: UserRole | undefined,
  newIsActive: boolean | undefined,
): Promise<boolean> {
  // Resolve the target's role + isActive AFTER the proposed change.
  const target = await prisma.user.findUnique({ where: { id: targetId } });
  if (!target) return false;
  const willBeActive = newIsActive ?? target.isActive;
  const willBeRole = newRole ?? target.role;
  // If the target remains an active ADMIN after the change, no risk.
  if (willBeActive && willBeRole === 'ADMIN') return false;
  // Otherwise: count OTHER active admins. If there's at least one, safe.
  const others = await prisma.user.count({
    where: { id: { not: targetId }, role: 'ADMIN', isActive: true },
  });
  return others === 0;
}

function publicInviteShape(i: {
  id: string;
  email: string;
  role: UserRole;
  expiresAt: Date;
  createdAt: Date;
  invitedByUserId: string | null;
}) {
  return {
    id: i.id,
    email: i.email,
    role: i.role,
    expiresAt: i.expiresAt,
    createdAt: i.createdAt,
    invitedByUserId: i.invitedByUserId,
  };
}

export function createUsersRouter(
  opts: { emailSender?: EmailSender } = {},
): Router {
  const router = Router();
  const emailSender = opts.emailSender ?? defaultEmailSender;

  // Origin for invite links. Prefer the configured APP_BASE_URL; fall back to
  // the request's own origin (honours x-forwarded-proto behind the proxy).
  function originFor(req: { protocol: string; get(name: string): string | undefined }): string {
    if (env.appBaseUrl) return env.appBaseUrl;
    return `${req.protocol}://${req.get('host') ?? ''}`;
  }

  /**
   * Mints a fresh invite row for `email`/`role`, superseding any existing
   * pending invite for that email, sends the email best-effort, and records
   * the audit row. Shared by POST /invite and POST /invites/:id/resend.
   */
  async function issueInvite(
    email: string,
    role: UserRole,
    invitedByUserId: string,
    origin: string,
    ipAddress: string | null,
  ): Promise<{
    invite: ReturnType<typeof publicInviteShape>;
    inviteUrl: string;
    emailSent: boolean;
    emailError?: string;
  }> {
    const { token, tokenHash, expiresAt } = createInviteToken();

    // One live invite per email: drop any prior un-accepted invite so an old
    // link can't be used after a re-invite.
    await prisma.userInvite.deleteMany({ where: { email, acceptedAt: null } });

    const invite = await prisma.userInvite.create({
      data: { email, role, tokenHash, expiresAt, invitedByUserId },
    });

    const inviteUrl = buildInviteUrl(token, origin);

    // Always hand off to the sender. The default ElasticEmail sender reports
    // `ok: false, error: 'email provider not configured'` when unconfigured,
    // which surfaces as the manual-link fallback — no separate config gate.
    const inviter = await prisma.user.findUnique({
      where: { id: invitedByUserId },
      select: { email: true },
    });
    const mail = buildInviteEmail({
      inviteUrl,
      role,
      inviterEmail: inviter?.email ?? null,
      expiresAt,
    });
    const result = await emailSender({ to: email, ...mail });
    const emailSent = result.ok;
    const emailError = result.ok ? undefined : result.error;

    await recordAudit({
      userId: invitedByUserId,
      action: 'USER_INVITED',
      resourceType: 'user_invite',
      resourceId: invite.id,
      metadata: { email, role, emailSent },
      ipAddress,
    });

    return { invite: publicInviteShape(invite), inviteUrl, emailSent, emailError };
  }

  router.post('/', requireUser(['ADMIN']), async (req, res, next) => {
    try {
      const parsed = CreateUserSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
      }
      const email = parsed.data.email.toLowerCase().trim();
      const role = parsed.data.role;
      // Server-generated when missing. The temp password is returned in
      // the response only in that case; if the admin passed an explicit
      // password the response stays minimal (matches Phase 3's behaviour).
      const generatedTemp = parsed.data.password
        ? undefined
        : generateTemporaryPassword(16);
      const password = parsed.data.password ?? generatedTemp!;

      const pwIssue = passwordIssue(password);
      if (pwIssue) {
        return res.status(400).json({ error: 'invalid_password', message: pwIssue });
      }

      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) {
        return res.status(409).json({ error: 'email_exists' });
      }

      const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
      const created = await prisma.user.create({
        data: {
          email,
          passwordHash,
          role,
          isActive: true,
          // Admin-created accounts always need a password change on
          // first login — that's the OOB-share-then-rotate model the
          // plan baked in. The admin's own account (which is created
          // via the npm run create-admin CLI, not via this route) does
          // NOT get this flag.
          passwordResetRequired: true,
        },
      });

      await recordAudit({
        userId: req.user!.id,
        action: 'USER_CREATED',
        resourceType: 'user',
        resourceId: created.id,
        metadata: { createdUserId: created.id, role: created.role, email: created.email },
        ipAddress: req.ip ?? null,
      });

      return res.status(201).json({
        user: publicUserShape(created),
        ...(generatedTemp ? { temporaryPassword: generatedTemp } : {}),
      });
    } catch (err) {
      return next(err);
    }
  });

  // Minimal user list for any logged-in role — used by the Activity
  // page's user-filter dropdown. Returns only id + email + role + isActive
  // so it doesn't leak anything not already visible on the audit log.
  router.get('/picker', requireUser(), async (_req, res, next) => {
    try {
      const items = await prisma.user.findMany({
        orderBy: { email: 'asc' },
        select: { id: true, email: true, role: true, isActive: true },
      });
      return res.json({ items });
    } catch (err) {
      return next(err);
    }
  });

  router.get('/', requireUser(['ADMIN']), async (req, res, next) => {
    try {
      const parsed = ListQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
      }
      const limit = parsed.data.limit ?? 20;
      const offset = parsed.data.offset ?? 0;
      const includeInactive = parsed.data.includeInactive ?? false;

      const where = includeInactive ? {} : { isActive: true };
      const [items, total] = await Promise.all([
        prisma.user.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: offset,
          take: limit,
        }),
        prisma.user.count({ where }),
      ]);

      return res.json({
        items: items.map(publicUserShape),
        total,
      });
    } catch (err) {
      return next(err);
    }
  });

  // ---- Invite flow (Phase 8) ----
  // Registered BEFORE the `/:id` routes: `GET /invites` would otherwise be
  // captured by `GET /:id` (id="invites") and 404. Same reason `/picker` sits
  // ahead of `/:id` above.

  // POST /api/users/invite — admin invites a teammate by email. Creates a
  // single-use invite (no User row yet) and emails the accept link. If email
  // isn't configured, the link is returned so the admin can share it manually.
  router.post('/invite', requireUser(['ADMIN']), async (req, res, next) => {
    try {
      const parsed = InviteSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
      }
      const email = parsed.data.email.toLowerCase().trim();

      // A real account already owns this email — invites are for new people.
      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) {
        return res.status(409).json({ error: 'email_exists' });
      }

      const out = await issueInvite(
        email,
        parsed.data.role,
        req.user!.id,
        originFor(req),
        req.ip ?? null,
      );
      return res.status(201).json(out);
    } catch (err) {
      return next(err);
    }
  });

  // GET /api/users/invites — pending (un-accepted, un-expired) invites.
  router.get('/invites', requireUser(['ADMIN']), async (_req, res, next) => {
    try {
      const now = new Date();
      const invites = await prisma.userInvite.findMany({
        where: { acceptedAt: null, expiresAt: { gt: now } },
        orderBy: { createdAt: 'desc' },
        include: { invitedBy: { select: { email: true } } },
      });
      return res.json({
        items: invites.map((i) => ({
          ...publicInviteShape(i),
          invitedByEmail: i.invitedBy?.email ?? null,
        })),
      });
    } catch (err) {
      return next(err);
    }
  });

  // POST /api/users/invites/:id/resend — regenerate token + expiry, re-send.
  // The old link is invalidated (issueInvite deletes prior pending invites
  // for the email).
  router.post('/invites/:id/resend', requireUser(['ADMIN']), async (req, res, next) => {
    try {
      const invite = await prisma.userInvite.findUnique({ where: { id: req.params.id } });
      if (!invite || invite.acceptedAt) {
        return res.status(404).json({ error: 'not_found' });
      }
      const out = await issueInvite(
        invite.email,
        invite.role,
        req.user!.id,
        originFor(req),
        req.ip ?? null,
      );
      return res.json(out);
    } catch (err) {
      return next(err);
    }
  });

  // DELETE /api/users/invites/:id — revoke a pending invite.
  router.delete('/invites/:id', requireUser(['ADMIN']), async (req, res, next) => {
    try {
      const invite = await prisma.userInvite.findUnique({ where: { id: req.params.id } });
      if (!invite || invite.acceptedAt) {
        return res.status(404).json({ error: 'not_found' });
      }
      await prisma.userInvite.delete({ where: { id: invite.id } });
      return res.status(204).end();
    } catch (err) {
      return next(err);
    }
  });

  router.get('/:id', requireUser(['ADMIN']), async (req, res, next) => {
    try {
      const user = await prisma.user.findUnique({ where: { id: req.params.id } });
      if (!user) return res.status(404).json({ error: 'not_found' });
      return res.json({ user: publicUserShape(user) });
    } catch (err) {
      return next(err);
    }
  });

  router.patch('/:id', requireUser(['ADMIN']), async (req, res, next) => {
    try {
      const parsed = PatchUserSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
      }
      const target = await prisma.user.findUnique({ where: { id: req.params.id } });
      if (!target) return res.status(404).json({ error: 'not_found' });

      if (await wouldDropLastAdmin(target.id, parsed.data.role, parsed.data.isActive)) {
        return res.status(409).json({
          error: 'last_active_admin',
          message: 'cannot demote or deactivate the only remaining active admin',
        });
      }

      const before = { role: target.role, isActive: target.isActive };
      const updated = await prisma.user.update({
        where: { id: target.id },
        data: {
          role: parsed.data.role ?? undefined,
          isActive: parsed.data.isActive ?? undefined,
        },
      });

      // If the target was deactivated, revoke their sessions so the change
      // takes effect immediately (rather than waiting for sliding expiry).
      if (before.isActive && updated.isActive === false) {
        await revokeAllSessionsForUser(updated.id);
      }

      const actions: AuditAction[] = [];
      if (parsed.data.role !== undefined && parsed.data.role !== before.role) {
        actions.push('USER_ROLE_CHANGED');
      }
      if (parsed.data.isActive !== undefined && parsed.data.isActive !== before.isActive) {
        actions.push(parsed.data.isActive ? 'USER_REACTIVATED' : 'USER_DEACTIVATED');
      }
      for (const action of actions) {
        await recordAudit({
          userId: req.user!.id,
          action,
          resourceType: 'user',
          resourceId: updated.id,
          metadata: {
            targetUserId: updated.id,
            email: updated.email,
            before,
            after: { role: updated.role, isActive: updated.isActive },
          },
          ipAddress: req.ip ?? null,
        });
      }

      return res.json({ user: publicUserShape(updated) });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/:id/reset-password', requireUser(['ADMIN']), async (req, res, next) => {
    try {
      const target = await prisma.user.findUnique({ where: { id: req.params.id } });
      if (!target) return res.status(404).json({ error: 'not_found' });

      const temporaryPassword = generateTemporaryPassword(16);
      const passwordHash = await bcrypt.hash(temporaryPassword, BCRYPT_COST);

      await prisma.user.update({
        where: { id: target.id },
        data: { passwordHash, passwordResetRequired: true },
      });
      await revokeAllSessionsForUser(target.id);

      await recordAudit({
        userId: req.user!.id,
        action: 'USER_PASSWORD_RESET',
        resourceType: 'user',
        resourceId: target.id,
        metadata: { targetUserId: target.id, email: target.email },
        ipAddress: req.ip ?? null,
      });

      return res.json({ temporaryPassword });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}
