/**
 * Centralised AuditLog writer. All routes that need to record an audit
 * event call this helper instead of touching prisma.auditLog directly.
 *
 * Key contract: **recordAudit never throws.** If the DB write fails for
 * any reason (connection blip, trigger conflict, transient timeout) we
 * console.warn and continue. The underlying business action (login,
 * dispatch, user creation, etc.) must never be undone by an audit-write
 * failure — every site that calls recordAudit treats the audit as
 * best-effort observability, not part of the transaction.
 */

import type { AuditAction, Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { safeErrorLog } from './httpErrors';

export type RecordAuditInput = {
  userId?: string | null;
  action: AuditAction;
  resourceType?: string | null;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
};

export async function recordAudit(input: RecordAuditInput): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId: input.userId ?? null,
        action: input.action,
        resourceType: input.resourceType ?? null,
        resourceId: input.resourceId ?? null,
        // Cast satisfies Prisma's InputJsonValue union; undefined ⇒ omit ⇒
        // NULL on the column.
        metadata: input.metadata as Prisma.InputJsonValue | undefined,
        ipAddress: input.ipAddress ?? null,
      },
    });
  } catch (err) {
    // Never the Prisma message: it quotes the row's `data`, and audit metadata can hold
    // an address (user invites, role changes). safeErrorLog keeps name/code/target only.
    // eslint-disable-next-line no-console
    console.warn(`[audit] failed to record ${input.action}`, safeErrorLog(err));
  }
}
