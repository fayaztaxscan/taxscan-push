/* eslint-disable no-console */
/**
 * One-off history backfill for ArticleSurfaceStat (Google Discover / News).
 *
 * WHY THIS EXISTS: the live sync fetches a rolling `SEARCH_CONSOLE_LOOKBACK_DAYS`
 * window (7), so a fresh install only ever holds a week — every trailing window
 * on the Surfaces tab then shows the same number. The documented alternative was
 * to raise that env var, let one sync run, and put it back; that leaves
 * production in a state where an interruption silently keeps re-fetching a huge
 * span every 6 hours (heavy query + large delete/insert). This script does the
 * same job as a bounded, resumable one-off instead.
 *
 * Search Console retains 16 months, so anything inside that is reachable.
 *
 * MONTH AT A TIME, deliberately: `syncSearchSurfaces` replaces every date it
 * fetched inside ONE transaction, so a single 200-day call would be one very
 * large delete+insert against the live DB. Chunking keeps each transaction to a
 * month and makes the run resumable — re-running a month is idempotent
 * (replace-by-date), so an interrupted backfill is simply restarted.
 *
 * Usage (from the repo root):
 *   DATABASE_URL=<target> \
 *   SEARCH_CONSOLE_SITE_URL=https://www.taxscan.in/ \
 *   npx ts-node-dev --transpile-only --no-notify --respawn=false \
 *     scripts/backfill-surfaces.ts --from 2026-01 --yes
 *
 * Flags:
 *   --from YYYY-MM   first month to fetch (required)
 *   --to   YYYY-MM   last month (default: the current month)
 *   --yes            actually write; without it the script only reports the plan
 *
 * Credentials come from the same place the cron uses: GA_SERVICE_ACCOUNT_JSON,
 * else the gitignored key file (GA_SERVICE_ACCOUNT_FILE). The service account
 * must be granted on the Search Console PROPERTY itself — permissions do not
 * inherit from GA or the GCP project.
 */

import { prisma } from '../src/lib/prisma';
import { syncSearchSurfaces } from '../src/services/searchSurfaces';

type Month = { year: number; month: number }; // month is 1-12

function parseMonth(s: string, flag: string): Month {
  const m = /^(\d{4})-(\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`${flag} must look like YYYY-MM (got "${s}")`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw new Error(`${flag} has no month ${month}`);
  return { year, month };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** Inclusive list of months from `from` to `to`. */
function monthsBetween(from: Month, to: Month): Month[] {
  const out: Month[] = [];
  for (let y = from.year, m = from.month; y < to.year || (y === to.year && m <= to.month); ) {
    out.push({ year: y, month: m });
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

const DAY_MS = 86_400_000;
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

/**
 * The explicit [from, to] span for this month, clipped to today — asking Search
 * Console for future dates is pointless, and its newest 2-3 days carry no rows.
 *
 * Deliberately an explicit span rather than a back-dated `now`: `now` is also
 * the clock the service-account JWT is signed with, so moving it into the past
 * to shift the window gets the token rejected as not short-lived. See the note
 * on syncSearchSurfaces.
 */
function windowFor(m: Month, today: Date): { from: string; to: string } {
  const first = utc(m.year, m.month, 1);
  const lastOfMonth = new Date(utc(m.year, m.month + 1, 1).getTime() - DAY_MS);
  const end = lastOfMonth > today ? today : lastOfMonth;
  return { from: first.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

function hostOf(url: string | undefined): string {
  if (!url) return '(DATABASE_URL not set)';
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port}${u.pathname}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

(async () => {
  const fromArg = arg('from');
  if (!fromArg) throw new Error('--from YYYY-MM is required');
  const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z');
  const from = parseMonth(fromArg, '--from');
  const to = arg('to')
    ? parseMonth(arg('to')!, '--to')
    : { year: today.getUTCFullYear(), month: today.getUTCMonth() + 1 };
  const write = process.argv.includes('--yes');

  const months = monthsBetween(from, to);
  if (months.length === 0) throw new Error('--from is after --to');

  console.log(`[backfill-surfaces] target DB  : ${hostOf(process.env.DATABASE_URL)}`);
  console.log(`[backfill-surfaces] property   : ${process.env.SEARCH_CONSOLE_SITE_URL ?? '(unset)'}`);
  console.log(
    `[backfill-surfaces] months     : ${months.length} (${fromArg} → ${to.year}-${String(to.month).padStart(2, '0')})`,
  );
  if (!write) {
    console.log('[backfill-surfaces] DRY RUN — pass --yes to write. Planned windows:');
    for (const m of months) {
      const w = windowFor(m, today);
      console.log(`  ${w.from} → ${w.to}`);
    }
    await prisma.$disconnect();
    return;
  }

  const before = await prisma.articleSurfaceStat.count();
  let rowsWritten = 0;
  const failed: string[] = [];

  for (const m of months) {
    const w = windowFor(m, today);
    const label = `${m.year}-${String(m.month).padStart(2, '0')}`;
    try {
      const r = await syncSearchSurfaces({ startDate: w.from, endDate: w.to });
      rowsWritten += r.rows;
      console.log(
        `[backfill-surfaces] ${label} (${w.from}→${w.to}) rows=${r.rows} dates=${r.dates} ` +
          `discover=${r.bySurface.DISCOVER ?? 0} googleNews=${r.bySurface.GOOGLE_NEWS ?? 0}`,
      );
    } catch (e) {
      // Keep going: one month failing (a rate limit, a transient 5xx) should not
      // cost the months already fetched. Re-running the script re-does only what
      // is listed at the end.
      failed.push(label);
      console.error(`[backfill-surfaces] ${label} FAILED — ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const after = await prisma.articleSurfaceStat.count();
  console.log(`[backfill-surfaces] done. table ${before} → ${after} rows (fetched ${rowsWritten})`);
  if (failed.length) {
    console.log(`[backfill-surfaces] re-run for: --from ${failed[0]} --to ${failed[failed.length - 1]}`);
    process.exitCode = 1;
  }
  await prisma.$disconnect();
})().catch(async (err) => {
  console.error('[backfill-surfaces]', err instanceof Error ? err.message : err);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
