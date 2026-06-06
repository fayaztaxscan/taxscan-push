import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function makeClient(): PrismaClient {
  const base = new PrismaClient();
  // Defence in depth on top of the DB trigger from Phase 1: refuse every
  // typed `auditLog.update/updateMany/delete/deleteMany` call at the
  // application layer, so accidental usage in PRs is caught at code-review
  // / static-analysis time. The retention sweeper bypasses this by going
  // through `$executeRaw`, which the extension does not see.
  return base.$extends({
    query: {
      auditLog: {
        update() {
          throw new Error(
            '[audit] auditLog.update is forbidden — rows are append-only',
          );
        },
        updateMany() {
          throw new Error(
            '[audit] auditLog.updateMany is forbidden — rows are append-only',
          );
        },
        delete() {
          throw new Error(
            '[audit] auditLog.delete is forbidden — use the retention sweeper with the SET LOCAL carve-out',
          );
        },
        deleteMany() {
          throw new Error(
            '[audit] auditLog.deleteMany is forbidden — use the retention sweeper with the SET LOCAL carve-out',
          );
        },
        upsert() {
          throw new Error(
            '[audit] auditLog.upsert is forbidden — rows are append-only',
          );
        },
      },
    },
  }) as unknown as PrismaClient;
}

export const prisma = globalForPrisma.prisma ?? makeClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
