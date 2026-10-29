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
 * The same code runs behind `POST /api/admin/cms-views/backfill` (an ADMIN, from inside the running app, for
 * when the shell can't reach the service); status at `GET /api/admin/cms-views/backfill/:id`.
 * Without --yes it only prints the plan. Writes to whatever DATABASE_URL points at; never prints a secret.
 */
import { prisma } from '../src/lib/prisma';
import { backfillConfigProblem, startBackfill, validateBackfillRange } from '../src/services/cmsViews/backfill';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const range = validateBackfillRange(arg('from'), arg('to'));
  if ('error' in range) throw new Error(range.error);
  const problem = backfillConfigProblem();
  if (problem) throw new Error(`${problem}: CMS_VIEWS_ENABLED, CMS_FEED_VIEWS_SECRET and CMS_FEED_BASE_URL must be set and valid`);

  const dryRun = !process.argv.includes('--yes');
  const started = startBackfill({ ...range, dryRun });
  if (!started) throw new Error('a sync is already running');
  console.log(`[cms-views] backfill ${range.from}..${range.to} in ${started.run.chunks.length} chunk(s): ${started.run.chunks.map((c) => `${c.from}..${c.to}`).join(', ')}`);
  if (dryRun) {
    console.log('[cms-views] dry run — add --yes to write');
    return;
  }
  await started.done;
  process.exitCode = started.run.state === 'done' ? 0 : 1;
}

main()
  .catch((e) => {
    console.error(`[cms-views] ${e instanceof Error ? e.message : 'failed'}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
