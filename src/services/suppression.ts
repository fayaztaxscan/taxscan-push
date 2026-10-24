import { Prisma, type EmailSuppression, type PrismaClient } from '@prisma/client';
import { emailHash, mergeSuppressionForRestore, normaliseEmail } from './digest/webhook';

/**
 * `EmailSuppression` — the ONE place that decides which rows match a reader
 * (docs/CMS_AUDIENCE_SYNC_DESIGN.md §4, §6.2 rule 4, §6.3; digest design §3).
 *
 * A row can be keyed three ways, and every reader matches on ANY of them:
 *  - `email` (normalised; null after a CMS erasure),
 *  - `emailHash` (sha256 of the normalised address; set by a DB trigger whenever `email` is set,
 *    migration 20261024120000; kept after an erasure, so the opt-out still matches),
 *  - `accountId` (the CMS account the opt-out follows across an email change).
 *
 * Never logs. Callers pass a transaction client when they are inside one.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export type SuppressionKey = {
  email?: string | null;
  emailHash?: string | null;
  accountIds?: readonly string[];
};

/** The OR filter for a key; null when the key names nothing (which matches no row, never every row). */
export function suppressionWhere(key: SuppressionKey): Prisma.EmailSuppressionWhereInput | null {
  const or: Prisma.EmailSuppressionWhereInput[] = [];
  const email = key.email ? normaliseEmail(key.email) : null;
  if (email) or.push({ email }, { emailHash: emailHash(email) });
  if (key.emailHash) or.push({ emailHash: key.emailHash });
  const ids = [...new Set((key.accountIds ?? []).filter((id) => typeof id === 'string' && id !== ''))];
  if (ids.length > 0) or.push({ accountId: { in: ids } });
  return or.length > 0 ? { OR: or } : null;
}

/** Every suppression row matching the key (by address, by hash, or by any account id). */
export async function findSuppressions(db: Db, key: SuppressionKey): Promise<EmailSuppression[]> {
  const where = suppressionWhere(key);
  if (!where) return [];
  return db.emailSuppression.findMany({ where, orderBy: { id: 'asc' } });
}

/** True when any row matches the key. */
export async function isSuppressed(db: Db, key: SuppressionKey): Promise<boolean> {
  const where = suppressionWhere(key);
  if (!where) return false;
  return (await db.emailSuppression.count({ where })) > 0;
}

/**
 * Restore one backed-up `EmailSuppression` row (scripts/restore-backup.ts). The live row is found by
 * address, then by hash (computed from the address when the backup predates the hash column), then
 * by id — a hash-only row (an erased address, `email` null) is matched too, and never crashes the
 * lookup. A row that already exists may only get STRONGER (`mergeSuppressionForRestore`), keeps its
 * own `email` (a restore never brings back an address an erasure removed) and gains the backup's
 * `accountId` only when it has none. A new row is created as backed up.
 */
export async function restoreSuppressionRow(db: Db, data: Record<string, unknown>): Promise<'created' | 'merged'> {
  const email = typeof data.email === 'string' && data.email !== '' ? data.email : null;
  const hash = typeof data.emailHash === 'string' && data.emailHash !== '' ? data.emailHash : email ? emailHash(email) : null;
  const id = typeof data.id === 'string' && data.id !== '' ? data.id : null;
  const existing =
    (email ? await db.emailSuppression.findUnique({ where: { email } }) : null) ??
    (hash ? await db.emailSuppression.findUnique({ where: { emailHash: hash } }) : null) ??
    (id ? await db.emailSuppression.findUnique({ where: { id } }) : null);
  if (!existing) {
    await db.emailSuppression.create({ data: { ...data, email, emailHash: hash } as never });
    return 'created';
  }
  const merged = mergeSuppressionForRestore(existing, data as unknown as Parameters<typeof mergeSuppressionForRestore>[1]);
  await db.emailSuppression.update({
    where: { id: existing.id },
    data: {
      ...merged,
      ...(existing.accountId === null && typeof data.accountId === 'string' && data.accountId !== '' ? { accountId: data.accountId } : {}),
    },
  });
  return 'merged';
}

/**
 * After suppression rows were written for these hashes (the Mailercloud webhook), inside the SAME
 * transaction:
 *  1. stamp `accountId` on a row that has none when exactly ONE live CMS account holds that address —
 *     the opt-out then follows the person across an email change (design §6.2 rule 4);
 *  2. mark the matching `AudienceMember` rows suppressed and due for the writer (add writes stop).
 * Lock order everywhere: EmailSuppression before AudienceMember (ingest does the same).
 */
export async function afterSuppressionWrite(tx: Prisma.TransactionClient, hashes: readonly string[], now: Date): Promise<void> {
  const list = [...new Set(hashes)].sort();
  if (list.length === 0) return;
  await tx.$executeRaw`
    UPDATE "EmailSuppression" s SET "accountId" = a."accountId"
    FROM (
      SELECT "emailHash", min("accountId") AS "accountId" FROM "CmsAccount"
      WHERE "emailHash" = ANY(${list}::text[]) AND "deletedAt" IS NULL
      GROUP BY "emailHash" HAVING count(*) = 1
    ) a
    WHERE s."emailHash" = a."emailHash" AND s."accountId" IS NULL`;
  await tx.$executeRaw`
    UPDATE "AudienceMember" SET suppressed = true, "nextAttemptAt" = (${now.toISOString()}::timestamptz AT TIME ZONE 'UTC'),
      "updatedAt" = (${now.toISOString()}::timestamptz AT TIME ZONE 'UTC')
    WHERE "emailHash" = ANY(${list}::text[]) AND suppressed = false`;
}
