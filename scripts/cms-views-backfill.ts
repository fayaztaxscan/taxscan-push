/* eslint-disable no-console */
/**
 * History backfill for CmsArticleView (the CMS's Feed 2: per-article views by IST day).
 *
 *   npm run cms-views:backfill -- --from 2026-09-28 [--to 2026-10-29] [--yes]
 *
 * The CMS keeps history from 2026-09-28 (28 Sep is partial: taxscan.in switched over at ~22:00 IST that night;
 * the reads module does not use it by default, see READS_CMS_FROM). The CMS accepts at most 30 days between
 * `from` and `to`, so the range is split into 30-day chunks, oldest first. Each chunk is all-or-nothing and the
 * write is a pure upsert, so the script is idempotent: an interrupted run is simply started again.
 *
 * Needs CMS_VIEWS_ENABLED=true, CMS_FEED_VIEWS_SECRET and CMS_FEED_BASE_URL (the same variables the cron uses).
 * Without --yes it only prints the plan. Writes to whatever DATABASE_URL points at; never prints a secret.
 */
import { prisma } from '../src/lib/prisma';
import { env } from '../src/lib/env';
import { istDateKey } from '../src/services/reports';
import { chunkRanges, runViewsSync } from '../src/services/cmsViews/sync';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const isDay = (s: string | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

async function main(): Promise<void> {
  const from = arg('from');
  const to = arg('to') ?? istDateKey(new Date());
  if (!isDay(from)) throw new Error('--from YYYY-MM-DD is required');
  if (!isDay(to)) throw new Error('--to must be YYYY-MM-DD');
  if (from > to) throw new Error('--from is after --to');
  if (to > istDateKey(new Date())) throw new Error('--to is in the future (IST)');
  if (!env.cmsViews.enabled) throw new Error('CMS_VIEWS_ENABLED is not true: the backfill is off with the sync');
  if (!env.cmsViews.secret || !env.audience.cms.baseUrl) throw new Error('CMS_FEED_VIEWS_SECRET and CMS_FEED_BASE_URL must be set');

  const chunks = chunkRanges(from, to);
  console.log(`[cms-views] backfill ${from}..${to} in ${chunks.length} chunk(s): ${chunks.map((c) => `${c.from}..${c.to}`).join(', ')}`);
  if (!process.argv.includes('--yes')) {
    console.log('[cms-views] dry run — add --yes to write');
    return;
  }
  let failed = 0;
  for (const c of chunks) {
    const r = await runViewsSync({ from: c.from, to: c.to });
    if (!r.ok) {
      failed += 1;
      console.error(`[cms-views] chunk ${c.from}..${c.to} FAILED (nothing written for it): ${r.error}`);
      break; // stop at the first failure: rerun resumes safely
    }
  }
  console.log(failed ? '[cms-views] backfill stopped at a failed chunk — fix and run again (idempotent)' : '[cms-views] backfill done');
  process.exitCode = failed ? 1 : 0;
}

main()
  .catch((e) => {
    console.error(`[cms-views] ${e instanceof Error ? e.message : 'failed'}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
