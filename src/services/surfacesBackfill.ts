import { randomUUID } from 'node:crypto';
import { env } from '../lib/env';
import { safeErrorLog } from '../lib/httpErrors';
import { istDateKey } from './reports';
import { loadGaCredentials } from './gaReads';
import { SURFACES, acquireSurfacesLock, releaseSurfacesLock, syncSearchSurfaces } from './searchSurfaces';

/**
 * A history backfill of ONE surface for ArticleSurfaceStat, run inside the app (`POST /api/admin/surfaces/backfill`)
 * because production can be reached no other way. Calendar-month chunks, oldest first, each through
 * `syncSearchSurfaces` with an explicit span: a chunk is all-or-nothing and replaces only its own surface's rows, so
 * earlier chunks stay written when a later one fails and a rerun is idempotent. The whole run holds the sync's lock, so
 * the cron (or a second backfill) can't interleave. State is in memory only: an app restart mid-run loses it (and stops
 * the run); rerun the same range.
 */

/** Search Console keeps about 16 months; nothing older can be fetched. */
export const BACKFILL_MAX_MONTHS = 16;
const KEEP_RUNS = 20;

type Surface = (typeof SURFACES)[number];
export type DayRange = { from: string; to: string };

export type SurfacesBackfillRun = {
  id: string;
  state: 'running' | 'done' | 'failed';
  /** The Search Console search type asked for: `discover`, `news` or `googleNews`. */
  surface: string;
  from: string;
  to: string;
  chunks: DayRange[];
  chunksDone: number;
  rows: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
};

const runs = new Map<string, SurfacesBackfillRun>();
export const getSurfacesBackfillRun = (id: string): SurfacesBackfillRun | undefined => runs.get(id);
export const resetSurfacesBackfillRuns = (): void => runs.clear();

const isDay = (s: unknown): s is string =>
  typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

const utcKey = (y: number, monthIndex: number, d: number) => new Date(Date.UTC(y, monthIndex, d)).toISOString().slice(0, 10);

/** [from, to] cut at calendar-month boundaries, oldest first. */
export function monthChunks(from: string, to: string): DayRange[] {
  const out: DayRange[] = [];
  let start = from;
  while (start <= to) {
    const [y, m] = start.split('-').map(Number);
    const monthEnd = utcKey(y, m, 0); // day 0 of the next month
    out.push({ from: start, to: monthEnd < to ? monthEnd : to });
    start = utcKey(y, m, 1);
  }
  return out;
}

/** The request rules: a known surface, real days, in order, not in the future (IST), inside Search Console's history. */
export function validateSurfacesBackfill(
  input: { surface?: unknown; from?: unknown; to?: unknown },
  now: Date = new Date(),
): { error: 'invalid_surface' | 'invalid_range'; message: string } | { surface: Surface; from: string; to: string } {
  const surface = SURFACES.find((s) => s.type === input.surface);
  if (!surface) return { error: 'invalid_surface', message: `surface must be one of ${SURFACES.map((s) => s.type).join(', ')}` };
  const bad = (message: string) => ({ error: 'invalid_range' as const, message });
  const today = istDateKey(now);
  const to = input.to === undefined ? today : input.to;
  if (!isDay(input.from)) return bad('from must be YYYY-MM-DD');
  if (!isDay(to)) return bad('to must be YYYY-MM-DD');
  if (input.from > to) return bad('from is after to');
  if (to > today) return bad('to is in the future (IST)');
  const [y, m, d] = today.split('-').map(Number);
  const earliest = utcKey(y, m - 1 - BACKFILL_MAX_MONTHS, d);
  if (input.from < earliest) return bad(`from must be ${earliest} or later (Search Console keeps about ${BACKFILL_MAX_MONTHS} months)`);
  return { surface, from: input.from, to };
}

/** Why a backfill can't start now (config), or null. The same things the cron needs. */
export function surfacesBackfillConfigProblem(): 'search_console_disabled' | 'search_console_not_configured' | null {
  if (!env.searchConsole.enabled) return 'search_console_disabled';
  try {
    if (!env.searchConsole.siteUrl || !loadGaCredentials()) return 'search_console_not_configured';
  } catch {
    return 'search_console_not_configured'; // unreadable credentials — never echoed
  }
  return null;
}

/**
 * Starts a backfill and returns at once with its run record (poll `getSurfacesBackfillRun`); `done` resolves when the
 * run has finished. Returns `null` when the lock is taken (the routine sync or another backfill is running).
 */
export function startSurfacesBackfill(o: { surface: Surface; from: string; to: string }): { run: SurfacesBackfillRun; done: Promise<void> } | null {
  if (!acquireSurfacesLock()) return null;
  const run: SurfacesBackfillRun = {
    id: randomUUID(),
    state: 'running',
    surface: o.surface.type,
    from: o.from,
    to: o.to,
    chunks: monthChunks(o.from, o.to),
    chunksDone: 0,
    rows: 0,
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  remember(run);
  const log = (line: string) => console.log(line); // eslint-disable-line no-console
  log(`[surfaces] backfill start surface=${run.surface} ${run.from}..${run.to} chunks=${run.chunks.length}`);
  const done = (async () => {
    try {
      for (const c of run.chunks) {
        const r = await syncSearchSurfaces({ startDate: c.from, endDate: c.to, surfaces: [o.surface.surface] });
        run.chunksDone += 1;
        run.rows += r.rows;
        log(`[surfaces] backfill chunk=${run.chunksDone}/${run.chunks.length} rows=${r.rows} dates=${r.dates} range=${c.from}..${c.to}`);
      }
      run.state = 'done';
    } catch (e) {
      run.state = 'failed';
      // Through the shared redactor: the message can quote Google's response body.
      const safe = safeErrorLog(e);
      run.error = typeof safe.message === 'string' ? safe.message : 'unexpected failure';
      const c = run.chunks[run.chunksDone];
      log(`[surfaces] backfill failed chunk=${run.chunksDone + 1}/${run.chunks.length} range=${c.from}..${c.to} (nothing written for it): ${run.error}`);
    } finally {
      run.finishedAt = new Date().toISOString();
      releaseSurfacesLock();
      log(`[surfaces] backfill ${run.state === 'done' ? 'done' : 'ended failed'} surface=${run.surface} chunks=${run.chunksDone}/${run.chunks.length} rows=${run.rows}`);
    }
  })();
  return { run, done };
}

function remember(run: SurfacesBackfillRun): void {
  runs.set(run.id, run);
  while (runs.size > KEEP_RUNS) runs.delete(runs.keys().next().value as string);
}
