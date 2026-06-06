/**
 * Phase 1 smoke test for the DB-level AuditLog immutability guarantee.
 *
 * The trigger in the Phase 1 migration enforces three invariants:
 *   1. UPDATE on AuditLog rows is always rejected.
 *   2. DELETE on AuditLog rows is rejected by default.
 *   3. DELETE succeeds only inside a transaction that sets the session
 *      variable `audit_log.allow_purge = 'true'` (used by the Phase 4
 *      retention sweeper).
 *
 * These tests use raw SQL via Prisma's $executeRaw / $executeRawUnsafe to
 * mirror what an out-of-band operator (or any code path that bypasses the
 * future Prisma client extension) could attempt. The trigger is the
 * load-bearing guarantee — code-level guards are defence in depth.
 */

import { randomBytes } from 'crypto';
import { prisma } from '../lib/prisma';

function smokeId(suffix: string): string {
  return `smoke-${suffix}-${Date.now()}-${randomBytes(4).toString('hex')}`;
}

const insertedIds: string[] = [];

async function insertOne(label: string): Promise<string> {
  const id = smokeId(label);
  // Raw INSERT — we don't go through Prisma's typed client here on purpose.
  // The trigger must fire regardless of how the row was written.
  await prisma.$executeRaw`
    INSERT INTO "AuditLog" ("id", "action", "resourceType", "resourceId")
    VALUES (${id}, 'LOGIN_SUCCESS'::"AuditAction", 'audit-immutability-smoke', ${label})
  `;
  insertedIds.push(id);
  return id;
}

afterAll(async () => {
  if (insertedIds.length) {
    // Use the carve-out the trigger allows: a single transaction with
    // the session variable set. afterAll runs even on failures, so this
    // cleans up any rows the individual tests left behind.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL audit_log.allow_purge = 'true'`);
      for (const id of insertedIds) {
        await tx.$executeRaw`DELETE FROM "AuditLog" WHERE id = ${id}`;
      }
    });
  }
  await prisma.$disconnect();
});

describe('AuditLog immutability — DB-level trigger', () => {
  it('forbids UPDATE on AuditLog rows', async () => {
    const id = await insertOne('update');
    await expect(
      prisma.$executeRaw`UPDATE "AuditLog" SET "resourceId" = 'tampered' WHERE id = ${id}`,
    ).rejects.toThrow(/AuditLog rows are immutable/);
  });

  it('forbids DELETE on AuditLog rows when the carve-out is not set', async () => {
    const id = await insertOne('delete-blocked');
    await expect(
      prisma.$executeRaw`DELETE FROM "AuditLog" WHERE id = ${id}`,
    ).rejects.toThrow(/can only be deleted by the retention sweeper/);
  });

  it('allows DELETE inside a transaction that sets audit_log.allow_purge = true', async () => {
    const id = await insertOne('delete-allowed');

    await prisma.$transaction(async (tx) => {
      // SET LOCAL is scoped to this transaction only — no leak to other
      // connections or the next transaction on the same connection.
      await tx.$executeRawUnsafe(`SET LOCAL audit_log.allow_purge = 'true'`);
      const affected = await tx.$executeRaw`
        DELETE FROM "AuditLog" WHERE id = ${id}
      `;
      expect(affected).toBe(1);
    });

    // The row should be gone.
    const remaining = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "AuditLog" WHERE id = ${id}
    `;
    expect(remaining).toHaveLength(0);
  });

  // The Prisma client extension added in Phase 4 throws BEFORE any SQL is
  // sent to the database, so we don't need to actually hit the trigger to
  // prove this guard works. Belt; the DB trigger is the suspenders.
  it('Prisma client extension blocks auditLog.update at the app layer', async () => {
    await expect(
      prisma.auditLog.update({
        where: { id: 'irrelevant' },
        data: { action: 'LOGIN_SUCCESS' },
      }),
    ).rejects.toThrow(/auditLog\.update is forbidden/);
  });

  it('Prisma client extension blocks auditLog.updateMany', async () => {
    await expect(
      prisma.auditLog.updateMany({ where: {}, data: { action: 'LOGIN_SUCCESS' } }),
    ).rejects.toThrow(/auditLog\.updateMany is forbidden/);
  });

  it('Prisma client extension blocks auditLog.delete', async () => {
    await expect(prisma.auditLog.delete({ where: { id: 'x' } })).rejects.toThrow(
      /auditLog\.delete is forbidden/,
    );
  });

  it('Prisma client extension blocks auditLog.deleteMany', async () => {
    await expect(prisma.auditLog.deleteMany({ where: {} })).rejects.toThrow(
      /auditLog\.deleteMany is forbidden/,
    );
  });

  it('Prisma client extension blocks auditLog.upsert', async () => {
    await expect(
      prisma.auditLog.upsert({
        where: { id: 'x' },
        update: { action: 'LOGIN_SUCCESS' },
        create: { action: 'LOGIN_SUCCESS' },
      }),
    ).rejects.toThrow(/auditLog\.upsert is forbidden/);
  });

  it('SET LOCAL carve-out does not leak across transactions', async () => {
    const id = await insertOne('leak-check');

    // Run the carve-out + a trivial DELETE in one transaction. The
    // SET LOCAL must NOT survive the COMMIT.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL audit_log.allow_purge = 'true'`);
      // No-op delete just to exercise the carve-out path.
      await tx.$executeRaw`
        DELETE FROM "AuditLog" WHERE id = 'does-not-exist'
      `;
    });

    // A separate transaction should now see the immutability guard again.
    await expect(
      prisma.$executeRaw`DELETE FROM "AuditLog" WHERE id = ${id}`,
    ).rejects.toThrow(/can only be deleted by the retention sweeper/);
  });
});
