/**
 * Off-platform disaster copy: gzipped NDJSON of the irreplaceable tables,
 * uploaded to S3-compatible object storage (Cloudflare R2).
 *
 * WHAT THIS PROTECTS THAT RAILWAY'S VOLUME BACKUPS DO NOT
 * Railway's snapshots are copy-on-write — they share blocks with the live
 * volume, "wiping a volume deletes all backups", and they restore only back
 * into the same Railway project. They are a rollback. This is the copy that
 * survives losing Railway, which on 2026-09-01 stopped every project on the
 * workspace for 2.5 days over an unpaid invoice, with the data healthy and
 * completely unreachable (it could not even be dumped).
 *
 * ⚠️ A RESTORE ALSO NEEDS THE VAPID KEYPAIR, WHICH IS NOT IN HERE AND MUST
 * NEVER BE. Push subscriptions are cryptographically bound to it, so these
 * rows are inert without it — see docs/BACKUPS.md. Keys belong in a password
 * manager, not in an object store next to the data they protect.
 *
 * Format is deliberately boring: one JSON object per line, preceded by a
 * header line. It restores with scripts/restore-backup.ts, with `psql`, or by
 * hand — a backup you can only read with the software that failed is not a
 * backup.
 */

import { gzipSync } from 'node:zlib';
import cron from 'node-cron';
import type { BackupRun } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { env } from '../lib/env';
import { deleteObject, isR2Configured, listObjects, putObject, type R2Config } from '../lib/r2';

/**
 * The tables that go in, and the reasoning for each. Order matters on restore:
 * nothing here has a foreign key onto anything else here, but Campaign is
 * referenced by Event (which is NOT exported), so campaigns come first anyway.
 *
 * DELIBERATELY EXCLUDED:
 * - `Event` (1.2 GB, 86% of the database) — delivery history. Losing it costs
 *   reporting depth, nothing operational, and including it would turn a 3 MB
 *   export into a gigabyte.
 * - `ArticleReadStat` / `ArticleSurfaceStat` (170 MB) — mirrors of GA and
 *   Search Console. Re-fetchable from the source; both syncs backfill.
 * - `GaReadsReport` / `ReportEmailRun` / `BackupRun` — derived caches and run
 *   logs; they rebuild themselves.
 * - `UserSession` / `UserInvite` — short-lived by design. Restoring sessions
 *   would resurrect logins that should have died with the incident.
 * - `AuditLog` — append-only compliance record with its own retention sweeper
 *   and an immutability trigger. Re-inserting it elsewhere would misrepresent
 *   when those rows were written.
 */
export const BACKUP_TABLES = [
  // The entire reason this exists. endpoint + p256dh + auth is exactly what
  // web-push needs, so these rows resume sending on any host — given the keys.
  'Subscriber',
  // Logins, so a restored deployment is usable instead of just populated.
  'User',
  // The report-only email list; tiny and not reconstructible from anywhere.
  'ReportRecipient',
  // Push history — and what the Campaigns screen and coverage reports read.
  'Campaign',
  // The GUID dedupe ledger. WITHOUT THIS a restored system treats every
  // article in the feeds as new and re-pushes articles subscribers already
  // received. It is small and it prevents a very loud failure.
  'FeedItem',
] as const;

export type BackupTable = (typeof BACKUP_TABLES)[number];

export type BackupResult = {
  objectKey: string | null;
  rows: number;
  bytes: number;
  tables: Record<string, number>;
};

/** Prisma delegates keyed by the table name, so the list above drives the export. */
function delegateFor(table: BackupTable) {
  switch (table) {
    case 'Subscriber':
      return prisma.subscriber;
    case 'User':
      return prisma.user;
    case 'ReportRecipient':
      return prisma.reportRecipient;
    case 'Campaign':
      return prisma.campaign;
    case 'FeedItem':
      return prisma.feedItem;
  }
}

export function r2ConfigFromEnv(): R2Config {
  return {
    accountId: env.backup.accountId,
    bucket: env.backup.bucket,
    accessKeyId: env.backup.accessKeyId,
    secretAccessKey: env.backup.secretAccessKey,
    endpoint: env.backup.endpoint || undefined,
  };
}

/**
 * Builds the export as an uncompressed NDJSON buffer.
 *
 * Rows are paged rather than loaded whole: Campaign and FeedItem are only a
 * few thousand today, but an export that quietly starts OOMing years from now
 * is the worst possible time to discover the shortcut.
 */
export async function buildBackup(opts?: { now?: Date }): Promise<{ body: Buffer; result: Omit<BackupResult, 'objectKey'> }> {
  const now = opts?.now ?? new Date();
  const lines: string[] = [];
  const tables: Record<string, number> = {};
  let rows = 0;

  // Header first: enough for a stranger to understand the file without us.
  lines.push(
    JSON.stringify({
      _format: 'taxscan-push-backup',
      version: 1,
      generatedAt: now.toISOString(),
      tables: BACKUP_TABLES,
      note:
        'One JSON object per line: {"_table":"<name>", ...row}. Restore with ' +
        'scripts/restore-backup.ts. Push subscriptions are useless without the ' +
        'VAPID keypair, which is deliberately NOT in this file.',
    }),
  );

  for (const table of BACKUP_TABLES) {
    const delegate = delegateFor(table);
    let count = 0;
    let cursor: string | undefined;
    for (;;) {
      const batch: Array<{ id: string }> = await (delegate as { findMany: (a: unknown) => Promise<Array<{ id: string }>> }).findMany({
        take: 1000,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: 'asc' },
      });
      if (batch.length === 0) break;
      for (const row of batch) lines.push(JSON.stringify({ _table: table, ...row }));
      count += batch.length;
      cursor = batch[batch.length - 1].id;
      if (batch.length < 1000) break;
    }
    tables[table] = count;
    rows += count;
  }

  const body = Buffer.from(lines.join('\n') + '\n', 'utf8');
  return { body, result: { rows, bytes: body.length, tables } };
}

/** `taxscan-push/2026/2026-09-08T06-55-00Z.ndjson.gz` — sorts chronologically. */
export function objectKeyFor(now: Date, prefix: string): string {
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
  return `${prefix}/${now.getUTCFullYear()}/${stamp}.ndjson.gz`;
}

/**
 * Deletes exports older than `keepDays`. Runs only AFTER a successful upload,
 * so a broken export can never prune the good copies that precede it.
 */
export async function pruneOldBackups(cfg: R2Config, prefix: string, keepDays: number, now: Date): Promise<number> {
  if (keepDays <= 0) return 0;
  const cutoff = now.getTime() - keepDays * 24 * 60 * 60 * 1000;
  const keys = await listObjects(cfg, `${prefix}/`);
  let deleted = 0;
  for (const key of keys) {
    const m = key.match(/(\d{4}-\d{2}-\d{2})T/);
    if (!m) continue; // Not ours, or hand-uploaded — leave it alone.
    if (Date.parse(`${m[1]}T00:00:00Z`) < cutoff) {
      await deleteObject(cfg, key);
      deleted += 1;
    }
  }
  return deleted;
}

/** The newest run, or null before the first one. */
export async function lastBackupRun(): Promise<BackupRun | null> {
  return prisma.backupRun.findFirst({ orderBy: { ranAt: 'desc' } });
}

/**
 * Builds, uploads and records one backup. Records the run whether it succeeded
 * or not — a failed backup that leaves no trace is exactly the hole this whole
 * change set exists to close.
 */
export async function runBackup(opts?: {
  now?: Date;
  cfg?: R2Config;
  upload?: (key: string, body: Buffer) => Promise<void>;
  record?: boolean;
}): Promise<BackupResult> {
  const now = opts?.now ?? new Date();
  const cfg = opts?.cfg ?? r2ConfigFromEnv();
  const upload = opts?.upload ?? ((key: string, body: Buffer) => putObject(cfg, key, body));

  let objectKey: string | null = null;
  let built: Awaited<ReturnType<typeof buildBackup>> | null = null;
  try {
    built = await buildBackup({ now });
    const gz = gzipSync(built.body, { level: 9 });
    objectKey = objectKeyFor(now, env.backup.prefix);
    await upload(objectKey, gz);

    if (opts?.record !== false) {
      await recordRun({ ranAt: now, objectKey, rows: built.result.rows, bytes: gz.length, tables: built.result.tables, ok: true, error: null });
    }
    return { objectKey, rows: built.result.rows, bytes: gz.length, tables: built.result.tables };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (opts?.record !== false) {
      await recordRun({
        ranAt: now,
        objectKey: null,
        rows: built?.result.rows ?? 0,
        bytes: 0,
        tables: built?.result.tables ?? {},
        ok: false,
        error: message,
      });
    }
    throw e;
  }
}

async function recordRun(input: {
  ranAt: Date;
  objectKey: string | null;
  rows: number;
  bytes: number;
  tables: Record<string, number>;
  ok: boolean;
  error: string | null;
}): Promise<void> {
  try {
    await prisma.backupRun.create({ data: { ...input, error: input.error ? input.error.slice(0, 500) : null } });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[backup] could not record the run', e);
  }
}

let started = false;

export function startBackupCron(): void {
  if (!env.backup.enabled) {
    // eslint-disable-next-line no-console
    console.log('[backup] disabled (set BACKUP_ENABLED=true to start)');
    return;
  }
  const cfg = r2ConfigFromEnv();
  if (!isR2Configured(cfg)) {
    // eslint-disable-next-line no-console
    console.warn('[backup] R2 not configured (R2_BUCKET / R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY) — not started');
    return;
  }
  if (!cron.validate(env.backup.cron)) throw new Error(`Invalid BACKUP_CRON: ${env.backup.cron}`);
  if (started) return;
  started = true;

  const run = async () => {
    try {
      const r = await runBackup();
      // eslint-disable-next-line no-console
      console.log(
        `[backup] uploaded key=${r.objectKey} rows=${r.rows} bytes=${r.bytes} subscribers=${r.tables.Subscriber ?? 0}`,
      );
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[backup] FAILED — the off-platform copy is now stale', e);
      return; // Nothing was written, so there is nothing to prune.
    }

    // Pruning is housekeeping, NOT protection, and is deliberately outside the
    // block above: on 2026-09-08 a failing prune made a perfectly good backup
    // log "FAILED — the off-platform copy is now stale", which is the opposite
    // of what had happened. A tidying error must never read as data loss.
    try {
      const pruned = await pruneOldBackups(r2ConfigFromEnv(), env.backup.prefix, env.backup.keepDays, new Date());
      if (pruned) {
        // eslint-disable-next-line no-console
        console.log(`[backup] pruned ${pruned} object(s) older than ${env.backup.keepDays}d`);
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(
        `[backup] copy uploaded fine, but pruning failed — retention (${env.backup.keepDays}d) was not enforced this run`,
        e,
      );
    }
  };

  cron.schedule(env.backup.cron, () => void run(), { timezone: env.rss.tz });
  // eslint-disable-next-line no-console
  console.log(`[backup] scheduled cron="${env.backup.cron}" bucket=${env.backup.bucket} keep=${env.backup.keepDays}d`);
}
