/**
 * Runs the digest retention sweep by hand (src/sweepers/digestRetention.ts).
 *
 *   npm run digest-retention                              # DRY RUN: counts only, nothing written
 *   npm run digest-retention -- --yes                     # fold + delete EmailEvent, null old html
 *   npm run digest-retention -- --yes --events 90 --html 30 --batches 0   # window overrides; 0 = no batch cap
 *
 * Runs against whatever DATABASE_URL points at and prints it (credentials masked) first.
 * Every batch is its own transaction with the fold, so stopping at any point leaves the
 * numbers consistent. EmailSuppression is never touched.
 */

import { sweepDigestRetention } from '../src/sweepers/digestRetention';
import { env } from '../src/lib/env';
import { prisma } from '../src/lib/prisma';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const has = (name: string) => process.argv.includes(`--${name}`);

async function main(): Promise<void> {
  const apply = has('yes');
  const eventDays = arg('events') ? Number(arg('events')) : env.digest.emailEventRetentionDays;
  const htmlDays = arg('html') ? Number(arg('html')) : env.digest.htmlRetentionDays;
  const maxBatches = arg('batches') !== undefined ? Number(arg('batches')) : env.digestRetention.maxBatches;

  const target = (process.env.DATABASE_URL ?? '').replace(/:\/\/[^@]*@/, '://***@');
  console.log(`Database : ${target || '(DATABASE_URL not set)'}`);
  console.log(`Windows  : EmailEvent older than ${eventDays} days folded + deleted; digest html older than ${htmlDays} days nulled`);
  console.log(`Mode     : ${apply ? 'APPLY' : 'DRY RUN — counts only'}\n`);

  const before = await prisma.emailEvent.count();
  const suppressions = await prisma.emailSuppression.count();
  const r = await sweepDigestRetention({ eventDays, htmlDays, maxBatches, dryRun: !apply });

  const total = Object.values(r.deleted).reduce((a, b) => a + b, 0);
  console.log(`${apply ? 'Deleted' : 'Would delete'} ${total.toLocaleString()} EmailEvent row(s), ${r.folded} folded into DigestSend.rolled*:`);
  for (const [t, k] of Object.entries(r.deleted)) console.log(`  ${t.padEnd(16)} ${k.toLocaleString()}`);
  console.log(`${apply ? 'Nulled' : 'Would null'} the html of ${r.htmlNulled} digest send(s) (runs before ${r.htmlKeepFrom.toISOString().slice(0, 10)}).`);
  if (apply) {
    console.log(`Webhook proof stamped on ${r.proofStamped} send(s).`);
    console.log(`\nEmailEvent rows: ${before.toLocaleString()} → ${(await prisma.emailEvent.count()).toLocaleString()}  (${r.batches} batches, ${r.ms} ms)`);
    if (r.more) console.log('Batch cap reached — more remains. Run again, or pass --batches 0 to finish.');
  } else {
    console.log(`\nEmailEvent rows now: ${before.toLocaleString()}. Re-run with --yes to apply.`);
  }
  console.log(`EmailSuppression rows: ${suppressions.toLocaleString()} (never touched).`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : String(e));
  await prisma.$disconnect();
  process.exit(1);
});
