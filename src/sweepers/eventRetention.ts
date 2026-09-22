/**
 * Event retention: bound the delivery log to a rolling window.
 *
 * WHY THIS EXISTS
 * `Event` is one row per thing that happened to one subscriber. At ~2,950
 * subscribers × ~21 pushes a day that is ~62,000 SENT rows a day, and by
 * 2026-09-22 the table held 6.4M rows (1.45 GB) with the 5 GB volume on course
 * to fill in ~4 months. Yet nothing reads a SENT row older than 7 days except
 * to COUNT it: per-campaign sent/clicked/failed, and the lifetime totals.
 *
 * THE RULE THIS ENFORCES
 * Every statistic is `rolled-up (deleted rows) + live (remaining rows)`:
 *   - per campaign → Campaign.rolledSent / rolledClicked / rolledFailed /
 *     rolledFirstSentAt, read by campaignStats() in src/services/metrics.ts
 *   - lifetime     → EventRollup(type).count, read by the metrics warmer
 * Both halves are written HERE, in the same transaction as the DELETE, so a
 * crash mid-run leaves counts consistent and a re-run is safe. The send path
 * never touches the roll-ups. Numbers users see must not change — the test
 * suite asserts parity before/after a sweep.
 *
 * WHAT IS PURGED
 *   - SENT / CLICKED / FAILED older than EVENT_RETENTION_DAYS (default 30).
 *     The longest any reader looks back is 7 days (recently-pushed); the
 *     per-subscriber cap and the pacer ceiling look at TODAY.
 *   - DISMISSED at ANY age. It has no reader anywhere in the codebase and was
 *     1.17M rows of pure cost; /api/track no longer records it either. This is
 *     the one deliberate exception to the window, and it is named as such.
 *
 * WHAT IS NEVER PURGED
 *   SUBSCRIBED / UNSUBSCRIBED / PROMPT_SHOWN / PROMPT_ACCEPTED. They are tiny
 *   (~45k rows total), they carry subscriber provenance, and the funnel and
 *   subscribers-by-source read them by content, not just count.
 *
 * Mirrors src/sweepers/auditRetention.ts: nightly cron, flag-gated,
 * transactional, one-line log. Batched (default 5,000 rows) so the first run
 * against a 6M-row backlog is many short transactions, not one giant one.
 */

import cron from 'node-cron';
import type { EventType, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { env } from '../lib/env';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The types the window applies to. Anything else is kept forever. */
export const WINDOWED_TYPES: EventType[] = ['SENT', 'CLICKED', 'FAILED'];
/** Purged at any age — no reader exists. */
export const UNWINDOWED_TYPES: EventType[] = ['DISMISSED'];

export type SweepDeps = {
  now?: Date;
  retentionDays?: number;
  batchSize?: number;
  /** Stop after this many batches; the next run continues. 0 = unbounded. */
  maxBatches?: number;
  dryRun?: boolean;
};

export type SweepResult = {
  cutoff: Date;
  dryRun: boolean;
  /** Rows deleted (or, on a dry run, rows that WOULD be), by type. */
  deleted: Partial<Record<EventType, number>>;
  batches: number;
  /** True when maxBatches stopped the run before the backlog was clear. */
  more: boolean;
  ms: number;
};

type BatchRow = { id: string; type: EventType; campaignId: string | null; createdAt: Date };

/** The next slice of purgeable rows, oldest first. Windowed types first, then DISMISSED. */
async function nextBatch(cutoff: Date, take: number): Promise<BatchRow[]> {
  const aged = await prisma.event.findMany({
    where: { type: { in: WINDOWED_TYPES }, createdAt: { lt: cutoff } },
    select: { id: true, type: true, campaignId: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
    take,
  });
  if (aged.length === take) return aged;
  const rest = await prisma.event.findMany({
    where: { type: { in: UNWINDOWED_TYPES } },
    select: { id: true, type: true, campaignId: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
    take: take - aged.length,
  });
  return [...aged, ...rest];
}

/**
 * Folds one batch into the roll-ups and deletes it — one transaction, so the
 * counts and the delete either both happen or neither does.
 */
async function foldAndDelete(tx: Prisma.TransactionClient, batch: BatchRow[]): Promise<void> {
  // Per-campaign increments, and the earliest SENT time per campaign.
  const perCampaign = new Map<string, { sent: number; clicked: number; failed: number; firstSent: Date | null }>();
  const perType = new Map<EventType, number>();

  for (const row of batch) {
    perType.set(row.type, (perType.get(row.type) ?? 0) + 1);
    if (!row.campaignId) continue;
    const c = perCampaign.get(row.campaignId) ?? { sent: 0, clicked: 0, failed: 0, firstSent: null };
    if (row.type === 'SENT') {
      c.sent += 1;
      if (!c.firstSent || row.createdAt < c.firstSent) c.firstSent = row.createdAt;
    } else if (row.type === 'CLICKED') c.clicked += 1;
    else if (row.type === 'FAILED') c.failed += 1;
    perCampaign.set(row.campaignId, c);
  }

  for (const [campaignId, c] of perCampaign) {
    if (c.sent === 0 && c.clicked === 0 && c.failed === 0) continue; // DISMISSED-only campaign
    // Typed Prisma, not raw SQL, on purpose: a first version passed the date
    // through `$executeRaw ... ::timestamp` and it came back shifted by the
    // session's IST offset (+05:30) — the parity test caught it. Prisma's
    // own date handling is timezone-correct for these columns.
    //
    // The earliest first-sent must survive across batches, so read-then-min
    // inside the transaction. updateMany rather than update: a campaign
    // deleted between select and fold must not abort the whole batch (its
    // events cascade-null and are simply counted into the lifetime roll-up).
    const current = await tx.campaign.findUnique({
      where: { id: campaignId },
      select: { rolledFirstSentAt: true },
    });
    if (!current) continue;
    const firstSent =
      c.firstSent && (!current.rolledFirstSentAt || c.firstSent < current.rolledFirstSentAt)
        ? c.firstSent
        : current.rolledFirstSentAt;
    await tx.campaign.updateMany({
      where: { id: campaignId },
      data: {
        rolledSent: { increment: c.sent },
        rolledClicked: { increment: c.clicked },
        rolledFailed: { increment: c.failed },
        rolledFirstSentAt: firstSent,
      },
    });
  }

  for (const [type, n] of perType) {
    await tx.eventRollup.upsert({
      where: { type },
      create: { type, count: n },
      update: { count: { increment: n } },
    });
  }

  await tx.event.deleteMany({ where: { id: { in: batch.map((r) => r.id) } } });
}

export async function sweepEventRetention(deps: SweepDeps = {}): Promise<SweepResult> {
  const startedAt = Date.now();
  const now = deps.now ?? new Date();
  const retentionDays = deps.retentionDays ?? env.eventRetention.days;
  const batchSize = deps.batchSize ?? env.eventRetention.batchSize;
  const maxBatches = deps.maxBatches ?? env.eventRetention.maxBatches;
  const dryRun = deps.dryRun ?? false;
  const cutoff = new Date(now.getTime() - retentionDays * MS_PER_DAY);

  const deleted: Partial<Record<EventType, number>> = {};
  const bump = (type: EventType, n: number) => {
    deleted[type] = (deleted[type] ?? 0) + n;
  };

  if (dryRun) {
    // Counts only — no batches, no writes, nothing touched.
    const aged = await prisma.event.groupBy({
      by: ['type'],
      where: { type: { in: WINDOWED_TYPES }, createdAt: { lt: cutoff } },
      _count: { _all: true },
    });
    for (const row of aged) bump(row.type, row._count._all);
    const rest = await prisma.event.groupBy({
      by: ['type'],
      where: { type: { in: UNWINDOWED_TYPES } },
      _count: { _all: true },
    });
    for (const row of rest) bump(row.type, row._count._all);
    return { cutoff, dryRun: true, deleted, batches: 0, more: false, ms: Date.now() - startedAt };
  }

  let batches = 0;
  let more = false;
  for (;;) {
    if (maxBatches > 0 && batches >= maxBatches) {
      more = true;
      break;
    }
    const batch = await nextBatch(cutoff, batchSize);
    if (batch.length === 0) break;
    await prisma.$transaction((tx) => foldAndDelete(tx, batch));
    for (const row of batch) bump(row.type, 1);
    batches += 1;
    if (batch.length < batchSize) break;
  }

  const ms = Date.now() - startedAt;
  const summary = Object.entries(deleted)
    .map(([t, n]) => `${t.toLowerCase()}=${n}`)
    .join(' ');
  // eslint-disable-next-line no-console
  console.log(
    `[event-retention] deleted ${summary || 'nothing'} batches=${batches} ms=${ms} ` +
      `(window=${retentionDays}d cutoff=${cutoff.toISOString()}${more ? ' MORE-REMAINING' : ''})`,
  );
  return { cutoff, dryRun: false, deleted, batches, more, ms };
}

let isSweeping = false;

export function startEventRetentionSweeper(): void {
  if (!env.eventRetention.enabled) {
    // eslint-disable-next-line no-console
    console.log('[event-retention] disabled (set EVENT_RETENTION_ENABLED=true to enable)');
    return;
  }
  if (!cron.validate(env.eventRetention.cron)) {
    throw new Error(`Invalid EVENT_RETENTION_CRON: ${env.eventRetention.cron}`);
  }
  cron.schedule(
    env.eventRetention.cron,
    async () => {
      if (isSweeping) {
        // eslint-disable-next-line no-console
        console.log('[event-retention] previous tick still running, skipping');
        return;
      }
      isSweeping = true;
      try {
        await sweepEventRetention();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[event-retention] tick failed', err);
      } finally {
        isSweeping = false;
      }
    },
    { timezone: env.rss.tz },
  );
  // eslint-disable-next-line no-console
  console.log(
    `[event-retention] scheduled cron="${env.eventRetention.cron}" window=${env.eventRetention.days}d batch=${env.eventRetention.batchSize} tz=${env.rss.tz}`,
  );
}
