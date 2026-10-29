import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { env, type AudienceEnv } from '../../lib/env';
import { safeErrorLog } from '../../lib/httpErrors';
import { emailHash } from '../digest/webhook';
import { parseCmsListRow, isKnownStatus, type AccountSnapshot } from './snapshot';
import {
  applyAccountSnapshot,
  CONSENT_FUTURE_TOLERANCE_MS,
  LIFTABLE_REASONS,
  nextAccountState,
  recomputeMembers,
  sameAccountContent,
  type ApplyResult,
} from './ingest';
import { CMS_PAGE_LIMIT, CmsPullError, cmsErrorText, createCmsClient, type CmsCounts, type CmsListClient } from './cmsClient';
import {
  breakerState,
  changeLimit,
  checkRemovalBreaker,
  closeAutoBreaker,
  MIN_FULL_SHARE,
  openBreaker,
  recordSyncActivity,
  SCOPE_JUMP_FACTOR,
  SCOPE_JUMP_MIN,
  todaysCounters,
  type BreakerReason,
} from './breaker';
import { raiseAudienceAlert, sendAudienceAlerts, type AudienceAlertDeps } from './alerts';

/**
 * The CMS pulls (docs/CMS_AUDIENCE_SYNC_DESIGN.md §5.2–§5.4, §8.2, §11 task 5): the nightly FULL load
 * and the hourly INCREMENTAL one. Both page the signed list (`cmsClient.ts`), parse every row with
 * `parseCmsListRow` and apply it through the ONE door, `applyAccountSnapshot(tx, snap, 'pull_full' |
 * 'pull_incr')` — list rows apply at seq ≥ stored.
 *
 * Applying:
 *  - each page's stored accounts are pre-fetched; a row whose seq is lower than ours, a live row for
 *    an erased account, and an EQUAL-seq row whose content already matches are skipped without a
 *    transaction — except an equal-seq row with a consent lift due (the lift's retry path) or whose
 *    member row lost its address (after a restore: the full load refills addresses);
 *  - the rest go in chunked transactions with `{ timeout }`; a chunk that fails on a deadlock /
 *    serialization failure / P2002 (two first sightings racing) is retried once, then each of its
 *    rows is applied on its own (retried ×3). A row that still fails is counted, never aborts the
 *    page — and makes a full load incomplete.
 *
 * Acceptance (§5.3): a full load is COMPLETE only when every page answered, the last page had no
 * cursor, every row parsed and applied, and the row count is ≥ 90 % of the previous complete load.
 * Only a complete load applies the ABSENCE rule: a live account we hold that the load no longer lists
 * (and that did not change during the run) is marked out of scope (`outOfScopeAt`) — at its seq, so any
 * later snapshot brings it back — WITHOUT an `ACCOUNT_DELETED` suppression and without a No-marketing
 * exclusion: absence is inferred, not a CMS statement (a missed `account.deleted` arrives as a
 * tombstone row anyway, for 90 days). An incomplete load still applies its rows (real snapshots),
 * opens the breaker (`truncated_load`) and raises `audience_full_incomplete`.
 *
 * Watermarks: a complete full load stores `lastFullAsOf` (the FIRST page's `meta.as_of`),
 * `lastFullOkAt`, `lastFullRowCount` and `cmsCounts` (`meta.counts`, if the CMS sends it). An
 * incremental load pages from `updated_since = max(lastIncrAsOf, lastFullAsOf) − 10 min` and, when
 * every page answered, stores `lastIncrAsOf` / `lastIncrOkAt`; it needs a complete full load first.
 *
 * Single-flight: one pull at a time per process (`isPullRunning`; the writer waits for it). Logs one
 * line per run, counts only.
 */

export type PullMode = 'full' | 'incremental';

export const INCREMENTAL_OVERLAP_MS = 10 * 60_000;
export const CHUNK_SIZE = 250;
export const CHUNK_TIMEOUT_MS = 120_000;
export const ROW_TIMEOUT_MS = 20_000;
/** 85k accounts / 5,000 = 17 pages; this is a runaway guard, not a size limit. */
export const MAX_PAGES = 400;

export type PullReport = {
  mode: PullMode;
  /** Set when the run did not start ('busy' | 'not_configured' | 'no_full_load'). */
  skipped?: string;
  complete: boolean;
  incompleteReason?: string;
  pages: number;
  rows: number;
  invalid: number;
  applied: number;
  repaired: number;
  unchanged: number;
  stale: number;
  erased: number;
  rowErrors: number;
  seqConflict: number;
  unknownStatus: number;
  roleChanges: number;
  premiumRemovals: number;
  absent: number;
  asOf?: string;
  breakerOpened?: BreakerReason | null;
  breakerClosed?: boolean;
  ms: number;
};

export type PullDeps = {
  client?: CmsListClient;
  cfg?: AudienceEnv;
  portal?: string;
  now?: () => Date;
  pageLimit?: number;
  chunkSize?: number;
  /** false = do not email alerts after the run (tests). Markers are still recorded. */
  sendAlerts?: boolean;
  alertDeps?: AudienceAlertDeps;
};

let running: PullMode | null = null;

/** The pull in progress in this process, if any (the writer pauses meanwhile). */
export function isPullRunning(): PullMode | null {
  return running;
}

function emptyReport(mode: PullMode): PullReport {
  return {
    mode,
    complete: false,
    pages: 0,
    rows: 0,
    invalid: 0,
    applied: 0,
    repaired: 0,
    unchanged: 0,
    stale: 0,
    erased: 0,
    rowErrors: 0,
    seqConflict: 0,
    unknownStatus: 0,
    roleChanges: 0,
    premiumRemovals: 0,
    absent: 0,
    ms: 0,
  };
}

/** One pull, single-flight. Never throws (a failure is a report with `complete: false`). */
export async function runPull(mode: PullMode, deps: PullDeps = {}): Promise<PullReport> {
  if (running) return { ...emptyReport(mode), skipped: 'busy' };
  running = mode;
  try {
    return await pullOnce(mode, deps);
  } finally {
    running = null;
  }
}

type Ctx = {
  mode: PullMode;
  cfg: AudienceEnv;
  portal: string;
  now: () => Date;
  report: PullReport;
  chunkSize: number;
  changeLimit: number;
  breakerOpenedInRun: BreakerReason | null;
};

async function pullOnce(mode: PullMode, deps: PullDeps): Promise<PullReport> {
  const started = Date.now();
  const cfg = deps.cfg ?? env.audience;
  const portal = deps.portal ?? 'taxscan';
  const now = deps.now ?? (() => new Date());
  const report = emptyReport(mode);
  const log = (line: string) => {
    // eslint-disable-next-line no-console
    console.log(`[audience] pull=${mode} ${line}`);
  };

  if (!deps.client && (!cfg.cms.pullSecret || !cfg.cms.baseUrl)) {
    report.skipped = 'not_configured';
    log('skipped (CMS_FEED_PULL_SECRET / CMS_FEED_BASE_URL not set)');
    return report;
  }
  const client = deps.client ?? createCmsClient(cfg);
  const state = await prisma.audienceSyncState.findUnique({ where: { portal } });

  let updatedSince: Date | null = null;
  if (mode === 'incremental') {
    const base = [state?.lastIncrAsOf, state?.lastFullAsOf].filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0];
    if (!base || !state?.lastFullOkAt) {
      report.skipped = 'no_full_load';
      log('skipped (no complete full load yet)');
      return report;
    }
    updatedSince = new Date(base.getTime() - INCREMENTAL_OVERLAP_MS);
  }

  const runStartedAt = now();
  const mailedBefore = await prisma.audienceMember.count({ where: { desiredRole: { not: 'NONE' } } });
  const ctx: Ctx = {
    mode,
    cfg,
    portal,
    now,
    report,
    chunkSize: deps.chunkSize ?? CHUNK_SIZE,
    changeLimit: changeLimit(mailedBefore, cfg),
    breakerOpenedInRun: null,
  };
  const isFirstLoad = mode === 'full' && (state?.lastFullRowCount ?? null) === null;
  if (isFirstLoad) {
    // Design §8.2: the first load is always reviewed — pause writes BEFORE applying anything.
    if (await openBreaker(prisma, portal, 'first_load', { mailedBefore }, runStartedAt)) ctx.breakerOpenedInRun = 'first_load';
  }

  const seen = new Set<string>();
  let asOf: Date | null = null;
  let counts: CmsCounts | null = null;
  let cursor: string | null = null;
  const cursors = new Set<string>();
  let pageError: string | null = null;
  try {
    for (;;) {
      if (report.pages >= MAX_PAGES) {
        pageError = 'too_many_pages';
        break;
      }
      const page = await client.fetchPage({ updatedSince, cursor, limit: deps.pageLimit ?? CMS_PAGE_LIMIT });
      report.pages += 1;
      if (asOf === null) {
        asOf = page.asOf;
        counts = page.counts;
      }
      const snaps: AccountSnapshot[] = [];
      for (const raw of page.rows) {
        report.rows += 1;
        const id = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).account_id : undefined;
        if (typeof id === 'string') seen.add(id);
        const p = parseCmsListRow(raw);
        if (!p.ok) {
          report.invalid += 1;
          continue;
        }
        if (!isKnownStatus(p.snapshot.status)) report.unknownStatus += 1;
        snaps.push(p.snapshot);
      }
      await applySnapshots(snaps, ctx);
      cursor = page.nextCursor;
      if (cursor === null) break;
      if (cursors.has(cursor)) {
        pageError = 'cursor_loop';
        break;
      }
      cursors.add(cursor);
    }
  } catch (err) {
    pageError = err instanceof CmsPullError ? `page_failed${err.http ? `_${err.http}` : ''}` : 'apply_failed';
    if (!(err instanceof CmsPullError)) {
      // eslint-disable-next-line no-console
      console.error(`[audience] pull=${mode} failed`, safeErrorLog(err));
    } else {
      log(`page failed: ${cmsErrorText(err, cfg)}`);
    }
  }

  // Acceptance.
  let incompleteReason: string | undefined;
  if (pageError) incompleteReason = pageError;
  else if (report.invalid > 0) incompleteReason = 'invalid_rows';
  else if (report.rowErrors > 0) incompleteReason = 'row_errors';
  else if (mode === 'full' && state?.lastFullRowCount && report.rows < Math.ceil(state.lastFullRowCount * MIN_FULL_SHARE)) incompleteReason = 'short_load';
  report.complete = !incompleteReason;
  report.incompleteReason = incompleteReason;
  report.asOf = asOf?.toISOString();
  const end = now();

  if (mode === 'full') {
    if (report.complete && asOf) {
      await applyAbsence(seen, runStartedAt, ctx);
      await prisma.audienceSyncState.upsert({
        where: { portal },
        create: { portal, lastFullAsOf: asOf, lastFullOkAt: end, lastFullRowCount: report.rows, cmsCounts: (counts ?? {}) as Prisma.InputJsonValue },
        update: { lastFullAsOf: asOf, lastFullOkAt: end, lastFullRowCount: report.rows, cmsCounts: (counts ?? {}) as Prisma.InputJsonValue },
      });
      const prevRows = state?.lastFullRowCount ?? null;
      if (prevRows !== null && report.rows > prevRows * SCOPE_JUMP_FACTOR && report.rows - prevRows > SCOPE_JUMP_MIN) {
        await tryOpen(ctx, 'scope_change', { rows: report.rows, previousRows: prevRows }, end);
      }
    } else {
      await tryOpen(ctx, 'truncated_load', { reason: incompleteReason ?? 'unknown', rows: report.rows, pages: report.pages }, end);
      await raiseAudienceAlert(portal, 'audience_full_incomplete', { reason: incompleteReason ?? 'unknown', rows: report.rows, pages: report.pages }, end);
    }
    await prisma.auditLog
      .create({
        data: {
          action: 'AUDIENCE_FULL_LOAD',
          resourceType: 'audience_sync',
          metadata: {
            portal,
            complete: report.complete,
            ...(incompleteReason ? { reason: incompleteReason } : {}),
            pages: report.pages,
            rows: report.rows,
            applied: report.applied,
            repaired: report.repaired,
            unchanged: report.unchanged,
            absent: report.absent,
            roleChanges: report.roleChanges,
            seqConflict: report.seqConflict,
            unknownStatus: report.unknownStatus,
          },
        },
      })
      .catch(() => undefined);
  } else if (report.complete && asOf) {
    await prisma.audienceSyncState.upsert({
      where: { portal },
      create: { portal, lastIncrAsOf: asOf, lastIncrOkAt: end },
      update: { lastIncrAsOf: asOf, lastIncrOkAt: end },
    });
  }

  // Counters (daily alerts + the 24 h removal breaker), then the breakers that read them.
  await prisma.$transaction((tx) =>
    recordSyncActivity(tx, portal, { seqConflict: report.seqConflict, unknownStatus: report.unknownStatus, premiumRemovals: report.premiumRemovals }, end),
  );
  if (report.roleChanges > ctx.changeLimit) await tryOpen(ctx, 'change_too_large', { roleChanges: report.roleChanges, limit: ctx.changeLimit, mailedBefore }, end);
  if (await checkRemovalBreaker(portal, end)) ctx.breakerOpenedInRun ??= 'premium_removals';
  // A complete, clean full load is the review for a truncated one.
  if (mode === 'full' && report.complete && !ctx.breakerOpenedInRun) report.breakerClosed = await closeAutoBreaker(prisma, portal);
  report.breakerOpened = ctx.breakerOpenedInRun;

  await dailyAlerts(portal, end, ctx);
  if (deps.sendAlerts !== false) await sendAudienceAlerts(portal, { ...(deps.alertDeps ?? {}), now: end });

  report.ms = Date.now() - started;
  log(
    `complete=${report.complete ? 'yes' : `no(${incompleteReason})`} pages=${report.pages} rows=${report.rows} applied=${report.applied}` +
      ` repaired=${report.repaired} unchanged=${report.unchanged} stale=${report.stale} invalid=${report.invalid} rowErrors=${report.rowErrors}` +
      ` absent=${report.absent} roleChanges=${report.roleChanges} seqConflict=${report.seqConflict} unknownStatus=${report.unknownStatus}` +
      `${report.breakerOpened ? ` breaker=${report.breakerOpened}` : ''} ms=${report.ms}`,
  );
  return report;
}

async function tryOpen(ctx: Ctx, reason: BreakerReason, review: Record<string, unknown>, now: Date): Promise<void> {
  if (await openBreaker(prisma, ctx.portal, reason, review, now)) ctx.breakerOpenedInRun ??= reason;
}

async function dailyAlerts(portal: string, now: Date, ctx: Ctx): Promise<void> {
  const c = await todaysCounters(prisma, portal, now);
  if (c.seqConflict > 0) await raiseAudienceAlert(portal, 'seq_conflict', { count: c.seqConflict }, now);
  if (c.unknownStatus > 0) await raiseAudienceAlert(portal, 'unknown_status', { count: c.unknownStatus }, now);
  const b = await breakerState(prisma, portal);
  if (b.open && ctx.breakerOpenedInRun) await raiseAudienceAlert(portal, 'audience_breaker_open', { reason: b.reason ?? ctx.breakerOpenedInRun }, now);
}

// ─── applying rows ──────────────────────────────────────────────────────────

/** Tally one apply result into the run report. */
function tally(ctx: Ctx, r: ApplyResult): void {
  const rep = ctx.report;
  if (r.outcome === 'applied') rep.applied += 1;
  else if (r.outcome === 'repaired') rep.repaired += 1;
  else if (r.outcome === 'erased') rep.erased += 1;
  else rep.stale += 1;
  if (r.seqConflict) rep.seqConflict += 1;
  rep.roleChanges += r.roleChanges;
  rep.premiumRemovals += r.premiumRemovals;
}

/** Pre-fetch, skip what cannot change anything, apply the rest in chunks. */
async function applySnapshots(snaps: AccountSnapshot[], ctx: Ctx): Promise<void> {
  if (snaps.length === 0) return;
  const now = ctx.now();
  const source = ctx.mode === 'full' ? 'pull_full' : 'pull_incr';
  const ids = [...new Set(snaps.map((s) => s.accountId))];
  const stored = new Map((await prisma.cmsAccount.findMany({ where: { accountId: { in: ids } } })).map((a) => [a.accountId, a]));

  const hashOf = (s: AccountSnapshot) => (s.email ? emailHash(s.email) : null);
  const equalSeq = snaps.filter((s) => stored.get(s.accountId)?.seq === s.seq);
  const eqHashes = [...new Set(equalSeq.map(hashOf).filter((h): h is string => !!h))];
  const liftHashes = [...new Set(equalSeq.filter((s) => s.consentValue === true && s.consentAt).map(hashOf).filter((h): h is string => !!h))];
  const [addressless, liftable] = await Promise.all([
    eqHashes.length
      ? prisma.audienceMember.findMany({ where: { emailHash: { in: eqHashes }, email: null }, select: { emailHash: true } })
      : Promise.resolve([]),
    liftHashes.length
      ? prisma.emailSuppression.findMany({ where: { emailHash: { in: liftHashes }, reason: { in: [...LIFTABLE_REASONS] } }, select: { emailHash: true, lastSeenAt: true } })
      : Promise.resolve([]),
  ]);
  const refill = new Set(addressless.map((m) => m.emailHash));

  const todo: AccountSnapshot[] = [];
  for (const s of snaps) {
    const prev = stored.get(s.accountId);
    if (prev) {
      if (s.seq < prev.seq) {
        ctx.report.stale += 1;
        continue;
      }
      if (prev.erasedAt && !s.deleted) {
        ctx.report.erased += 1;
        continue;
      }
      if (s.seq === prev.seq && prev.outOfScopeAt === null && sameAccountContent(prev, nextAccountState(prev, s, now))) {
        const h = hashOf(s);
        const liftDue =
          !!h &&
          s.consentValue === true &&
          !!s.consentAt &&
          s.consentAt.getTime() <= now.getTime() + CONSENT_FUTURE_TOLERANCE_MS &&
          liftable.some((r) => r.emailHash === h && s.consentAt!.getTime() > r.lastSeenAt.getTime());
        if (!liftDue && !(h && refill.has(h))) {
          ctx.report.unchanged += 1;
          continue;
        }
      }
    }
    todo.push(s);
  }
  for (let i = 0; i < todo.length; i += ctx.chunkSize) {
    await applyChunk(todo.slice(i, i + ctx.chunkSize), source, ctx);
    if (ctx.report.roleChanges > ctx.changeLimit) {
      // Pause Mailercloud writes as soon as the run crosses the cap, not at its end.
      await tryOpen(ctx, 'change_too_large', { roleChanges: ctx.report.roleChanges, limit: ctx.changeLimit, partial: true }, ctx.now());
    }
  }
}

/** Deadlock, serialization failure, a unique race (P2002), a write conflict or a transaction timeout. */
export function isRetryableTxError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (['P2002', 'P2034', 'P2028'].includes(err.code)) return true;
    const meta = err.meta as Record<string, unknown> | undefined;
    const dbCode = typeof meta?.code === 'string' ? meta.code : '';
    if (['40P01', '40001'].includes(dbCode)) return true;
  }
  const msg = err instanceof Error ? err.message : '';
  return /40P01|40001|deadlock detected|could not serialize/i.test(msg);
}

async function applyChunk(snaps: AccountSnapshot[], source: 'pull_full' | 'pull_incr', ctx: Ctx): Promise<void> {
  const opts = { cfg: ctx.cfg, portal: ctx.portal };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const now = ctx.now();
      const results = await prisma.$transaction(
        async (tx) => {
          const out: ApplyResult[] = [];
          for (const s of snaps) out.push(await applyAccountSnapshot(tx, s, source, { ...opts, now }));
          return out;
        },
        { timeout: CHUNK_TIMEOUT_MS, maxWait: 15_000 },
      );
      for (const r of results) tally(ctx, r);
      return;
    } catch (err) {
      if (!isRetryableTxError(err)) break; // isolate the bad row below
    }
  }
  // Row by row: one failure never sinks the rest of the page.
  for (const s of snaps) {
    for (let attempt = 0; ; attempt++) {
      try {
        const now = ctx.now();
        const r = await prisma.$transaction((tx) => applyAccountSnapshot(tx, s, source, { ...opts, now }), { timeout: ROW_TIMEOUT_MS, maxWait: 15_000 });
        tally(ctx, r);
        break;
      } catch (err) {
        if (attempt < 2 && isRetryableTxError(err)) continue;
        ctx.report.rowErrors += 1;
        // eslint-disable-next-line no-console
        console.error(`[audience] pull=${ctx.mode} row failed`, safeErrorLog(err));
        break;
      }
    }
  }
}

/**
 * The absence rule (complete full loads only). Live, in-scope accounts we hold that the load did not
 * list, and that nothing touched since the run began, are marked out of scope at their seq; their
 * addresses are recomputed (role NONE → the writer removes our tags). No suppression, no exclusion.
 */
async function applyAbsence(seen: ReadonlySet<string>, runStartedAt: Date, ctx: Ctx): Promise<void> {
  const live = await prisma.cmsAccount.findMany({
    where: { portal: ctx.portal, deletedAt: null, outOfScopeAt: null, updatedAt: { lt: runStartedAt } },
    select: { accountId: true },
  });
  const absent = live.map((a) => a.accountId).filter((id) => !seen.has(id));
  for (let i = 0; i < absent.length; i += ctx.chunkSize) {
    const ids = absent.slice(i, i + ctx.chunkSize).sort();
    const now = ctx.now();
    const out = await prisma.$transaction(
      async (tx) => {
        const locked = await tx.$queryRaw<{ accountId: string; emailHash: string | null }[]>`
          SELECT "accountId", "emailHash" FROM "CmsAccount"
           WHERE "accountId" = ANY(${ids}::text[]) AND "deletedAt" IS NULL AND "outOfScopeAt" IS NULL
             AND "updatedAt" < (${runStartedAt.toISOString()}::timestamptz AT TIME ZONE 'UTC')
           ORDER BY "accountId" FOR UPDATE`;
        if (locked.length === 0) return { n: 0, roleChanges: 0, premiumRemovals: 0 };
        await tx.cmsAccount.updateMany({ where: { accountId: { in: locked.map((l) => l.accountId) } }, data: { outOfScopeAt: now, lastSource: 'pull_full' } });
        const hashes = locked.map((l) => l.emailHash).filter((h): h is string => !!h);
        const r = await recomputeMembers(tx, hashes, { now, cfg: ctx.cfg });
        return { n: locked.length, roleChanges: r.roleChanges, premiumRemovals: r.premiumRemovals };
      },
      { timeout: CHUNK_TIMEOUT_MS, maxWait: 15_000 },
    );
    ctx.report.absent += out.n;
    ctx.report.roleChanges += out.roleChanges;
    ctx.report.premiumRemovals += out.premiumRemovals;
  }
}
