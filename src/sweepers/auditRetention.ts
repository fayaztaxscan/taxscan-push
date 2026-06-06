/**
 * Phase 4 — daily retention sweep on the AuditLog table.
 *
 * Default schedule: 03:00 IST every day (off-peak). The trigger from
 * Phase 1 normally blocks DELETE on AuditLog; the sweeper opts in to
 * the carve-out by running its DELETE inside a single transaction that
 * sets the session variable `audit_log.allow_purge = 'true'` via
 * `SET LOCAL`. `SET LOCAL` is scoped to the surrounding transaction so
 * the carve-out cannot leak to other connections or queries.
 *
 * Two retention windows:
 *   - LOGIN_FAILED rows: AUDIT_LOG_FAILED_LOGIN_RETENTION_DAYS (default 30).
 *     These are noisier than other events; shorter retention keeps the
 *     table compact without losing the operational signal.
 *   - Everything else:   AUDIT_LOG_RETENTION_DAYS (default 90).
 *     Standard SOC-2 floor for internal operational logs.
 */

import cron from 'node-cron';
import { prisma } from '../lib/prisma';
import { env } from '../lib/env';

export type SweepDeps = {
  now?: Date;
  retentionDays?: number;
  failedLoginRetentionDays?: number;
};

export type SweepResult = {
  deletedFailedLogins: number;
  deletedOther: number;
  ms: number;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export async function sweepAuditRetention(
  deps: SweepDeps = {},
): Promise<SweepResult> {
  const startedAt = Date.now();
  const now = deps.now ?? new Date();
  const retentionDays = deps.retentionDays ?? env.audit.retentionDays;
  const failedLoginRetentionDays =
    deps.failedLoginRetentionDays ?? env.audit.failedLoginRetentionDays;
  const generalCutoff = new Date(now.getTime() - retentionDays * MS_PER_DAY);
  const failedLoginCutoff = new Date(
    now.getTime() - failedLoginRetentionDays * MS_PER_DAY,
  );

  // The DELETE is wrapped in a single transaction so SET LOCAL applies to
  // every statement inside it and dies at COMMIT. The two DELETEs go via
  // `$executeRaw` so the Prisma client extension (which blocks typed
  // auditLog.delete/deleteMany) doesn't see them.
  let deletedFailedLogins = 0;
  let deletedOther = 0;
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL audit_log.allow_purge = 'true'`);
    deletedFailedLogins = await tx.$executeRaw`
      DELETE FROM "AuditLog"
      WHERE "action" = 'LOGIN_FAILED' AND "createdAt" < ${failedLoginCutoff}
    `;
    deletedOther = await tx.$executeRaw`
      DELETE FROM "AuditLog"
      WHERE "action" <> 'LOGIN_FAILED' AND "createdAt" < ${generalCutoff}
    `;
  });

  const ms = Date.now() - startedAt;
  // eslint-disable-next-line no-console
  console.log(
    `[audit-sweep] deleted failed_logins=${deletedFailedLogins} other=${deletedOther} ms=${ms} ` +
      `(retention general=${retentionDays}d failed_login=${failedLoginRetentionDays}d)`,
  );
  return { deletedFailedLogins, deletedOther, ms };
}

let isSweeping = false;

export function startAuditRetentionSweeper(): void {
  if (!env.audit.sweeperEnabled) {
    // eslint-disable-next-line no-console
    console.log('[audit-sweep] disabled (set AUDIT_LOG_SWEEPER_ENABLED=true to enable)');
    return;
  }
  if (!cron.validate(env.audit.sweeperCron)) {
    throw new Error(`Invalid AUDIT_LOG_SWEEPER_CRON: ${env.audit.sweeperCron}`);
  }
  cron.schedule(
    env.audit.sweeperCron,
    async () => {
      if (isSweeping) {
        // eslint-disable-next-line no-console
        console.log('[audit-sweep] previous tick still running, skipping');
        return;
      }
      isSweeping = true;
      try {
        await sweepAuditRetention();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[audit-sweep] tick failed', err);
      } finally {
        isSweeping = false;
      }
    },
    { timezone: env.rss.tz },
  );
  // eslint-disable-next-line no-console
  console.log(
    `[audit-sweep] scheduled cron="${env.audit.sweeperCron}" tz=${env.rss.tz}`,
  );
}
