import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { env, type AudienceEnv } from '../../lib/env';

/**
 * The audience sync circuit breaker and its counters (docs/CMS_AUDIENCE_SYNC_DESIGN.md §8.2 "Blast
 * radius", §5.3, §10.2). All state lives on the one `AudienceSyncState` row per portal.
 *
 * Open = `breakerOpenAt` set: Mailercloud writes pause (task 6's writer reads it); ingest and pulls
 * keep landing data in Postgres; the send guard (task 7) holds Premium. Reasons:
 *  - `first_load`       — the first complete full load (also the first after a restore);
 *  - `scope_change`     — a complete full load more than twice the previous one and > 100 rows
 *                          larger: the CMS's allowlist → all switch (or a CMS bug);
 *  - `change_too_large` — one run changed the role of more than max(AUDIENCE_MAX_CHANGE_PCT % of
 *                          mailed members, 100);
 *  - `premium_removals` — more than max(3 % of Premium, 50) Premium removals in 24 h (any door);
 *  - `erasure_cap`      — more than AUDIENCE_MAX_ERASURES_PER_DAY erasures in an IST day (ingest);
 *  - `truncated_load`   — a full load that was not complete (§5.3).
 * Every reason but `truncated_load` needs an ADMIN Resume (`resumeBreaker`; the route is task 8).
 * `truncated_load` closes by itself when a later full load completes and passes every check — the
 * load that proves the data whole is the review.
 *
 * Opening never overwrites an open breaker's reason: the first reason is the one to review.
 * `pendingReview` holds counts only. Never logs.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export type BreakerReason = 'first_load' | 'scope_change' | 'change_too_large' | 'premium_removals' | 'erasure_cap' | 'truncated_load';

export const AUTO_CLOSE_REASONS: ReadonlySet<string> = new Set(['truncated_load']);
/** Absolute floor of the per-run role-change cap (design §8.2: max(5 %, 100)). */
export const CHANGE_MIN = 100;
/** Premium removals in 24 h: max(3 % of Premium, 50) (design §8.2). */
export const PREMIUM_REMOVAL_PCT = 3;
export const PREMIUM_REMOVAL_MIN = 50;
/** A complete full load this many times the previous one (and > SCOPE_JUMP_MIN rows more) is a scope change. */
export const SCOPE_JUMP_FACTOR = 2;
export const SCOPE_JUMP_MIN = 100;
/** A full load below this share of the previous complete one is treated as truncated (§5.3). */
export const MIN_FULL_SHARE = 0.9;

const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;
const DAY_MS = 24 * 3_600_000;

/** `YYYY-MM-DD` of `now` in IST. */
export function istDayKey(now: Date): string {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

export function changeLimit(mailedMembers: number, cfg: AudienceEnv = env.audience): number {
  return Math.max(Math.ceil((mailedMembers * cfg.thresholds.maxChangePct) / 100), CHANGE_MIN);
}

export function removalLimit(premiumBase: number): number {
  return Math.max(Math.ceil((premiumBase * PREMIUM_REMOVAL_PCT) / 100), PREMIUM_REMOVAL_MIN);
}

export type SyncCounters = {
  day?: string;
  seqConflict?: number;
  unknownStatus?: number;
  /** Premium removals, one entry per batch, pruned to the last 24 h. */
  removals?: { at: string; n: number }[];
};

function asCounters(v: unknown): SyncCounters {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as SyncCounters) : {};
}

async function ensureState(db: Db, portal: string, now: Date): Promise<void> {
  await db.$executeRaw`
    INSERT INTO "AudienceSyncState" (portal, "updatedAt")
    VALUES (${portal}, (${now.toISOString()}::timestamptz AT TIME ZONE 'UTC'))
    ON CONFLICT (portal) DO NOTHING`;
}

/**
 * Add to today's counters (`seqConflict`, `unknownStatus` reset at the IST day change) and record
 * Premium removals (kept 24 h). Call inside the transaction that made the change when there is one
 * (the webhook does); row-locked, so concurrent callers add up.
 */
export async function recordSyncActivity(
  tx: Prisma.TransactionClient,
  portal: string,
  delta: { seqConflict?: number; unknownStatus?: number; premiumRemovals?: number },
  now: Date,
): Promise<void> {
  if (!delta.seqConflict && !delta.unknownStatus && !delta.premiumRemovals) return;
  await ensureState(tx, portal, now);
  const rows = await tx.$queryRaw<{ counters: unknown }[]>`SELECT counters FROM "AudienceSyncState" WHERE portal = ${portal} FOR UPDATE`;
  const c = asCounters(rows[0]?.counters);
  const day = istDayKey(now);
  const sameDay = c.day === day;
  const cutoff = now.getTime() - DAY_MS;
  const removals = (c.removals ?? []).filter((r) => Date.parse(r.at) > cutoff);
  if (delta.premiumRemovals) removals.push({ at: now.toISOString(), n: delta.premiumRemovals });
  const next: SyncCounters = {
    day,
    seqConflict: (sameDay ? (c.seqConflict ?? 0) : 0) + (delta.seqConflict ?? 0),
    unknownStatus: (sameDay ? (c.unknownStatus ?? 0) : 0) + (delta.unknownStatus ?? 0),
    removals,
  };
  await tx.audienceSyncState.update({ where: { portal }, data: { counters: next as Prisma.InputJsonValue } });
}

/** Today's counters (zero on another day). */
export async function todaysCounters(db: Db, portal: string, now: Date): Promise<{ seqConflict: number; unknownStatus: number; removals24h: number }> {
  const st = await db.audienceSyncState.findUnique({ where: { portal }, select: { counters: true } });
  const c = asCounters(st?.counters);
  const same = c.day === istDayKey(now);
  const cutoff = now.getTime() - DAY_MS;
  return {
    seqConflict: same ? (c.seqConflict ?? 0) : 0,
    unknownStatus: same ? (c.unknownStatus ?? 0) : 0,
    removals24h: (c.removals ?? []).filter((r) => Date.parse(r.at) > cutoff).reduce((n, r) => n + r.n, 0),
  };
}

/** Open the breaker unless it is already open. True when THIS call opened it. */
export async function openBreaker(db: Db, portal: string, reason: BreakerReason, review: Record<string, unknown>, now: Date): Promise<boolean> {
  await ensureState(db, portal, now);
  const n = await db.audienceSyncState.updateMany({
    where: { portal, breakerOpenAt: null },
    data: { breakerOpenAt: now, breakerReason: reason, pendingReview: { reason, ...review } as Prisma.InputJsonValue },
  });
  return n.count === 1;
}

/** Close an AUTO-close breaker (truncated_load) after a complete, clean full load. True when closed. */
export async function closeAutoBreaker(db: Db, portal: string): Promise<boolean> {
  const n = await db.audienceSyncState.updateMany({
    where: { portal, breakerOpenAt: { not: null }, breakerReason: { in: [...AUTO_CLOSE_REASONS] } },
    data: { breakerOpenAt: null, breakerReason: null, pendingReview: Prisma.DbNull },
  });
  return n.count === 1;
}

export async function breakerState(db: Db, portal: string): Promise<{ open: boolean; reason: string | null }> {
  const st = await db.audienceSyncState.findUnique({ where: { portal }, select: { breakerOpenAt: true, breakerReason: true } });
  return { open: !!st?.breakerOpenAt, reason: st?.breakerReason ?? null };
}

/**
 * ADMIN "Resume sync" (design §3.1, §8.2; the route and its ConfirmPush are task 8). Clears the
 * breaker and writes `AUDIENCE_SYNC_RESUMED` with the reason and the reviewed counts. False when it
 * was not open.
 */
export async function resumeBreaker(portal: string, actorUserId: string | null, now: Date = new Date()): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ breakerOpenAt: Date | null; breakerReason: string | null; pendingReview: unknown }[]>`
      SELECT "breakerOpenAt", "breakerReason", "pendingReview" FROM "AudienceSyncState" WHERE portal = ${portal} FOR UPDATE`;
    const st = rows[0];
    if (!st?.breakerOpenAt) return false;
    await tx.audienceSyncState.update({ where: { portal }, data: { breakerOpenAt: null, breakerReason: null, pendingReview: Prisma.DbNull } });
    await tx.auditLog.create({
      data: {
        action: 'AUDIENCE_SYNC_RESUMED',
        resourceType: 'audience_sync',
        ...(actorUserId ? { userId: actorUserId } : {}),
        metadata: { portal, reason: st.breakerReason, review: (st.pendingReview ?? null) as Prisma.InputJsonValue, at: now.toISOString() },
      },
    });
    return true;
  });
}

/**
 * The 24 h Premium-removal check (any door: webhook or pull). Base = Premium now + removals since,
 * i.e. the Premium count before them. Opens `premium_removals` above the limit. True when opened now.
 */
export async function checkRemovalBreaker(portal: string, now: Date, db: Db = prisma): Promise<boolean> {
  const { removals24h } = await todaysCounters(db, portal, now);
  if (removals24h === 0) return false;
  const premium = await db.audienceMember.count({ where: { desiredRole: 'PREMIUM' } });
  const limit = removalLimit(premium + removals24h);
  if (removals24h <= limit) return false;
  return openBreaker(db, portal, 'premium_removals', { removals24h, limit, premiumNow: premium }, now);
}
