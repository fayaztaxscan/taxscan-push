import { randomUUID } from 'node:crypto';
import { env } from '../../lib/env';
import { istDateKey } from '../reports';
import { acquireViewsLock, chunkRanges, releaseViewsLock, runViewsSync, type ViewsSyncDeps } from './sync';

/**
 * The one-off history backfill for CmsArticleView, shared by `scripts/cms-views-backfill.ts` and
 * `POST /api/admin/cms-views/backfill`. Chunks (≤30 days, oldest first) go through `runViewsSync`, so each chunk is
 * all-or-nothing and a pure upsert: earlier chunks stay written when a later one fails, and a rerun is idempotent.
 * The whole run holds the sync's own lock, so the routine cron (or a second backfill) can't interleave.
 * State is in memory only: an app restart mid-run loses it (and stops the run); rerun the same range.
 */

/** The CMS keeps history from 2026-09-28 (a partial day; see READS_CMS_FROM). */
export const BACKFILL_MIN_FROM = '2026-09-28';
const KEEP_RUNS = 20;

export type BackfillRun = {
  id: string;
  state: 'running' | 'done' | 'failed';
  from: string;
  to: string;
  dryRun: boolean;
  chunks: { from: string; to: string }[];
  chunksDone: number;
  rowsFetched: number;
  rowsInserted: number;
  /** Rows that were already stored (fetched − inserted); the upsert refreshed them. */
  rowsUpdated: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
};

const runs = new Map<string, BackfillRun>();
export const getBackfillRun = (id: string): BackfillRun | undefined => runs.get(id);
export const resetBackfillRuns = (): void => runs.clear();

const isDay = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

/** Date rules shared by the script and the endpoint. Returns the problem, or the resolved range. */
export function validateBackfillRange(from: unknown, to: unknown, now: Date = new Date()): { error: string } | { from: string; to: string } {
  const today = istDateKey(now);
  const end = to === undefined ? today : to;
  if (!isDay(from)) return { error: 'from must be YYYY-MM-DD' };
  if (!isDay(end)) return { error: 'to must be YYYY-MM-DD' };
  if (from < BACKFILL_MIN_FROM) return { error: `from must be ${BACKFILL_MIN_FROM} or later (the CMS has no earlier history)` };
  if (from > end) return { error: 'from is after to' };
  if (end > today) return { error: 'to is in the future (IST)' };
  return { from, to: end };
}

/** Why the backfill can't start now (config), or null. Mirrors what the script checks. */
export function backfillConfigProblem(): string | null {
  if (!env.cmsViews.enabled) return 'cms_views_disabled';
  if (env.cmsViews.problems.length > 0 || !env.cmsViews.secret || !env.audience.cms.baseUrl) return 'cms_views_config_invalid';
  return null;
}

export type BackfillOptions = { from: string; to: string; dryRun?: boolean; deps?: Omit<ViewsSyncDeps, 'from' | 'to' | 'lockHeld'> };

/**
 * Starts a backfill and returns at once with its run record (poll `getBackfillRun`); `done` resolves when the
 * run has finished. A dry run fetches and writes nothing: it only reports the chunk plan. Returns `null` when the
 * lock is taken (a routine sync or another backfill is running).
 */
export function startBackfill(o: BackfillOptions): { run: BackfillRun; done: Promise<void> } | null {
  const chunks = chunkRanges(o.from, o.to);
  const run: BackfillRun = {
    id: randomUUID(),
    state: 'running',
    from: o.from,
    to: o.to,
    dryRun: !!o.dryRun,
    chunks,
    chunksDone: 0,
    rowsFetched: 0,
    rowsInserted: 0,
    rowsUpdated: 0,
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  const log = o.deps?.log ?? ((line: string) => console.log(line)); // eslint-disable-line no-console
  if (run.dryRun) {
    run.state = 'done';
    run.finishedAt = run.startedAt;
    remember(run);
    log(`[cms-views] backfill dry run ${run.from}..${run.to} chunks=${chunks.length}`);
    return { run, done: Promise.resolve() };
  }
  if (!acquireViewsLock()) return null;
  remember(run);
  log(`[cms-views] backfill start ${run.from}..${run.to} chunks=${chunks.length}`);
  const done = (async () => {
    try {
      for (const c of chunks) {
        const r = await runViewsSync({ ...o.deps, from: c.from, to: c.to, lockHeld: true, log: () => undefined });
        if (!r.ok) {
          run.state = 'failed';
          run.error = r.error ?? 'failed';
          log(`[cms-views] backfill failed chunk=${run.chunksDone + 1}/${chunks.length} range=${c.from}..${c.to} (nothing written for it): ${run.error}`);
          return;
        }
        run.chunksDone += 1;
        run.rowsFetched += r.rows;
        run.rowsInserted += r.inserted;
        run.rowsUpdated += r.rows - r.inserted;
        log(`[cms-views] backfill chunk=${run.chunksDone}/${chunks.length} rows=${r.rows} new=${r.inserted} ms=${r.ms} range=${c.from}..${c.to}`);
      }
      run.state = 'done';
    } catch {
      run.state = 'failed';
      run.error = 'unexpected failure';
    } finally {
      run.finishedAt = new Date().toISOString();
      releaseViewsLock();
      log(`[cms-views] backfill ${run.state === 'done' ? 'done' : 'ended failed'} chunks=${run.chunksDone}/${chunks.length} rows=${run.rowsFetched} new=${run.rowsInserted} updated=${run.rowsUpdated}`);
    }
  })();
  return { run, done };
}

function remember(run: BackfillRun): void {
  runs.set(run.id, run);
  while (runs.size > KEEP_RUNS) runs.delete(runs.keys().next().value as string);
}
