/**
 * Phase 4 — GET /api/audit. Any logged-in user (ADMIN or PUBLISHER) can
 * read the audit log. The plan deliberately picks transparency over
 * secrecy: anyone on the team can see who did what. If a future op-sec
 * call wants this restricted to ADMINs, flip the middleware to
 * requireUser(['ADMIN']).
 *
 * Query params:
 *   action?         — exact match on AuditAction
 *   userId?         — exact match on actor's userId (nullable)
 *   since?, until?  — ISO timestamps; bounds on createdAt
 *   limit?          — default 50, max 200
 *   offset?         — default 0
 *
 * Joins the actor's email + role onto every row so the UI doesn't have
 * to do a second lookup per item.
 */

import { Router } from 'express';
import { z } from 'zod';
import type { AuditAction, AuditLog, User } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { requireUser } from '../lib/auth';

const AUDIT_ACTIONS = [
  'LOGIN_SUCCESS',
  'LOGIN_FAILED',
  'LOGOUT',
  'PASSWORD_CHANGED',
  'USER_CREATED',
  'USER_DEACTIVATED',
  'USER_REACTIVATED',
  'USER_ROLE_CHANGED',
  'USER_PASSWORD_RESET',
  'CAMPAIGN_DISPATCHED',
  'CAMPAIGN_DISPATCH_FAILED',
] as const satisfies readonly AuditAction[];

const QuerySchema = z.object({
  action: z.enum(AUDIT_ACTIONS).optional(),
  userId: z.string().min(1).optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

type WithUser = AuditLog & { user: Pick<User, 'id' | 'email' | 'role'> | null };

function shapeItem(row: WithUser) {
  return {
    id: row.id,
    userId: row.userId,
    user: row.user
      ? { id: row.user.id, email: row.user.email, role: row.user.role }
      : null,
    action: row.action,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    metadata: row.metadata,
    ipAddress: row.ipAddress,
    createdAt: row.createdAt,
  };
}

export function createAuditRouter(): Router {
  const router = Router();

  router.get('/', requireUser(), async (req, res, next) => {
    try {
      const parsed = QuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: 'invalid_request', issues: parsed.error.issues });
      }
      const limit = parsed.data.limit ?? 50;
      const offset = parsed.data.offset ?? 0;

      const where = {
        ...(parsed.data.action ? { action: parsed.data.action } : {}),
        ...(parsed.data.userId ? { userId: parsed.data.userId } : {}),
        ...(parsed.data.since || parsed.data.until
          ? {
              createdAt: {
                ...(parsed.data.since ? { gte: new Date(parsed.data.since) } : {}),
                ...(parsed.data.until ? { lte: new Date(parsed.data.until) } : {}),
              },
            }
          : {}),
      };

      const [items, total] = await Promise.all([
        prisma.auditLog.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: limit,
          skip: offset,
          include: {
            user: { select: { id: true, email: true, role: true } },
          },
        }),
        prisma.auditLog.count({ where }),
      ]);

      return res.json({
        items: (items as WithUser[]).map(shapeItem),
        total,
      });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}
