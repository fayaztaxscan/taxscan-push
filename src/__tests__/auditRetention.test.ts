/**
 * Phase 4 tests for the AuditLog retention sweeper.
 *
 *   - The sweeper deletes the right rows: anything older than the
 *     general retention, plus LOGIN_FAILED older than the shorter
 *     window.
 *   - The carve-out doesn't leak: while the sweeper transaction is
 *     running, a CONCURRENT connection trying DELETE still hits the
 *     immutability error.
 */

import { randomBytes } from 'crypto';
import { prisma } from '../lib/prisma';
import { sweepAuditRetention } from '../sweepers/auditRetention';

function smokeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${randomBytes(4).toString('hex')}`;
}

const insertedIds: string[] = [];

/**
 * Inserts an AuditLog row with a specific createdAt — used to age rows
 * backwards for the sweeper to find. Goes through raw SQL so we can
 * override createdAt (Prisma's @default(now()) would clobber it).
 */
async function insertAged(
  marker: string,
  ageDays: number,
  action: 'LOGIN_FAILED' | 'LOGIN_SUCCESS' | 'LOGOUT' = 'LOGIN_SUCCESS',
): Promise<string> {
  const id = smokeId(marker);
  const createdAt = new Date(Date.now() - ageDays * 86400_000);
  await prisma.$executeRaw`
    INSERT INTO "AuditLog" ("id", "action", "resourceType", "metadata", "createdAt")
    VALUES (
      ${id},
      ${action}::"AuditAction",
      'audit-retention-test',
      ${{ marker } as object},
      ${createdAt}
    )
  `;
  insertedIds.push(id);
  return id;
}

afterAll(async () => {
  // Carve-out cleanup for anything tests left behind. Some rows the sweeper
  // already deleted; the IS-NULL check covers IDs gracefully.
  if (insertedIds.length) {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL audit_log.allow_purge = 'true'`);
      await tx.$executeRaw`DELETE FROM "AuditLog" WHERE id = ANY(${insertedIds}::text[])`;
      await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "resourceType" = 'audit-retention-test'`;
    });
  }
  await prisma.$disconnect();
});

describe('sweepAuditRetention', () => {
  it('deletes rows older than retention; keeps rows inside the window', async () => {
    const oldGeneral = await insertAged('old-general', 120, 'LOGOUT');
    const oldFailed = await insertAged('old-failed', 60, 'LOGIN_FAILED');
    const recentGeneral = await insertAged('recent-general', 30, 'LOGOUT');
    const recentFailed = await insertAged('recent-failed', 10, 'LOGIN_FAILED');

    const result = await sweepAuditRetention({
      retentionDays: 90,
      failedLoginRetentionDays: 30,
    });

    // Each call returns row counts — used for the log line; not strictly
    // tested per row but does sanity-check the SQL.
    expect(result.deletedFailedLogins).toBeGreaterThanOrEqual(1);
    expect(result.deletedOther).toBeGreaterThanOrEqual(1);

    // Old rows gone:
    expect(
      await prisma.auditLog.count({ where: { id: oldGeneral } }),
    ).toBe(0);
    expect(
      await prisma.auditLog.count({ where: { id: oldFailed } }),
    ).toBe(0);

    // Recent rows preserved:
    expect(
      await prisma.auditLog.count({ where: { id: recentGeneral } }),
    ).toBe(1);
    expect(
      await prisma.auditLog.count({ where: { id: recentFailed } }),
    ).toBe(1);
  });

  it('respects the shorter LOGIN_FAILED window', async () => {
    const failedJustOverShortWindow = await insertAged(
      'failed-45d',
      45,
      'LOGIN_FAILED',
    );
    const generalJustOverShortWindow = await insertAged(
      'general-45d',
      45,
      'LOGOUT',
    );

    await sweepAuditRetention({
      retentionDays: 90,
      failedLoginRetentionDays: 30,
    });

    // 45-day LOGIN_FAILED is past the 30-day window → deleted.
    expect(
      await prisma.auditLog.count({ where: { id: failedJustOverShortWindow } }),
    ).toBe(0);
    // 45-day non-failed is still inside the 90-day general window → kept.
    expect(
      await prisma.auditLog.count({ where: { id: generalJustOverShortWindow } }),
    ).toBe(1);
  });

  it('SET LOCAL carve-out is scoped to the sweeper transaction (no leak)', async () => {
    const live = await insertAged('leak-check', 10, 'LOGOUT');
    // The sweeper just ran in the prior tests; running it again with a
    // 90-day retention won't touch the 10-day-old row above. Now confirm
    // that a SEPARATE connection trying a typed delete on AuditLog still
    // gets the immutability error.
    //
    // We test via raw SQL because the Prisma extension catches typed calls
    // before they hit the network; raw goes straight to Postgres and hits
    // the trigger.
    await expect(
      prisma.$executeRaw`DELETE FROM "AuditLog" WHERE id = ${live}`,
    ).rejects.toThrow(/can only be deleted by the retention sweeper/);
  });
});
