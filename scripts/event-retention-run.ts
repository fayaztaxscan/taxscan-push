/**
 * Runs the Event retention sweep by hand.
 *
 *   npm run event-retention                         # DRY RUN: counts only, nothing written
 *   npm run event-retention -- --yes                # fold + delete, up to the batch cap
 *   npm run event-retention -- --yes --days 30 --batches 0   # window override; 0 = clear the whole backlog
 *
 * Runs against whatever DATABASE_URL points at and prints it first. The first
 * production run over a ~6M-row backlog is the one to watch: run it with
 * --batches 0 during a quiet hour, or let the nightly cron chip away at 2M
 * rows a night. Either is safe — every batch is its own transaction and the
 * counts are folded before the delete, so stopping at any point leaves the
 * numbers consistent.
 */

import { sweepEventRetention } from '../src/sweepers/eventRetention';
import { env } from '../src/lib/env';
import { prisma } from '../src/lib/prisma';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const has = (name: string) => process.argv.includes(`--${name}`);

async function main(): Promise<void> {
  const apply = has('yes');
  const days = arg('days') ? Number(arg('days')) : env.eventRetention.days;
  const maxBatches = arg('batches') !== undefined ? Number(arg('batches')) : env.eventRetention.maxBatches;

  const target = (process.env.DATABASE_URL ?? '').replace(/:\/\/[^@]*@/, '://***@');
  console.log(`Database : ${target || '(DATABASE_URL not set)'}`);
  console.log(`Window   : ${days} days (SENT/CLICKED/FAILED older than this; DISMISSED at any age)`);
  console.log(`Mode     : ${apply ? 'APPLY' : 'DRY RUN — counts only'}\n`);

  const before = await prisma.event.count();
  const r = await sweepEventRetention({ retentionDays: days, maxBatches, dryRun: !apply });

  const total = Object.values(r.deleted).reduce((a, b) => a + (b ?? 0), 0);
  console.log(`${apply ? 'Deleted' : 'Would delete'} ${total.toLocaleString()} row(s):`);
  for (const [t, n] of Object.entries(r.deleted)) console.log(`  ${t.padEnd(12)} ${n?.toLocaleString()}`);
  if (apply) {
    const after = await prisma.event.count();
    console.log(`\nEvent rows: ${before.toLocaleString()} → ${after.toLocaleString()}  (${r.batches} batches, ${r.ms} ms)`);
    if (r.more) console.log('Batch cap reached — more remains. Run again, or pass --batches 0 to finish.');
  } else {
    console.log(`\nEvent rows now: ${before.toLocaleString()}. Re-run with --yes to apply.`);
  }
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
