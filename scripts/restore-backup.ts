/**
 * Restores a backup produced by src/services/backup.ts.
 *
 *   npm run restore:backup -- --file backup.ndjson.gz            # dry run
 *   npm run restore:backup -- --file backup.ndjson.gz --yes      # apply
 *   npm run restore:backup -- --file backup.ndjson.gz --only Subscriber --yes
 *
 * Writes to whatever DATABASE_URL points at. It prints that target and refuses
 * to do anything without --yes, because the realistic way to cause harm with
 * this script is to run it against the wrong database while panicking.
 *
 * Idempotent: every row is upserted on its natural key, so re-running it is
 * safe and a partial restore can simply be repeated.
 *
 * ⚠️ Restored subscribers can only be pushed to with the ORIGINAL VAPID
 * keypair. If VAPID_PUBLIC_KEY differs from the one these subscriptions were
 * created under, they are inert — this script warns but cannot detect it for
 * you, since the binding lives in each subscriber's browser.
 */

import { createReadStream, existsSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { prisma } from '../src/lib/prisma';

type Row = Record<string, unknown> & { _table?: string };

const RESTORABLE = ['Subscriber', 'User', 'ReportRecipient', 'Campaign', 'FeedItem'] as const;
type Restorable = (typeof RESTORABLE)[number];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const has = (name: string) => process.argv.includes(`--${name}`);

/** Dates arrive as ISO strings in JSON and must go back as Date objects. */
function revive(row: Row): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === '_table') continue;
    out[k] =
      typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v) ? new Date(v) : v;
  }
  return out;
}

async function upsert(table: Restorable, data: Record<string, unknown>): Promise<void> {
  const id = data.id as string;
  switch (table) {
    case 'Subscriber':
      // Keyed on endpoint, not id: the endpoint is the identity a push service
      // recognises, and it carries the unique index.
      await prisma.subscriber.upsert({
        where: { endpoint: data.endpoint as string },
        create: data as never,
        update: data as never,
      });
      return;
    case 'User':
      await prisma.user.upsert({ where: { email: data.email as string }, create: data as never, update: data as never });
      return;
    case 'ReportRecipient':
      await prisma.reportRecipient.upsert({ where: { email: data.email as string }, create: data as never, update: data as never });
      return;
    case 'Campaign':
      await prisma.campaign.upsert({ where: { id }, create: data as never, update: data as never });
      return;
    case 'FeedItem':
      await prisma.feedItem.upsert({ where: { guid: data.guid as string }, create: data as never, update: data as never });
      return;
  }
}

async function main(): Promise<void> {
  const file = arg('file');
  const only = arg('only') as Restorable | undefined;
  const apply = has('yes');

  if (!file || !existsSync(file)) {
    console.error('Usage: npm run restore:backup -- --file <backup.ndjson[.gz]> [--only <Table>] [--yes]');
    process.exit(1);
  }
  if (only && !RESTORABLE.includes(only)) {
    console.error(`--only must be one of: ${RESTORABLE.join(', ')}`);
    process.exit(1);
  }

  const target = (process.env.DATABASE_URL ?? '').replace(/:\/\/[^@]*@/, '://***@');
  console.log(`Restoring from : ${file}`);
  console.log(`Into database  : ${target || '(DATABASE_URL not set)'}`);
  console.log(apply ? 'Mode           : APPLY\n' : 'Mode           : DRY RUN (pass --yes to write)\n');

  const stream = file.endsWith('.gz') ? createReadStream(file).pipe(createGunzip()) : createReadStream(file);
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  const counts: Record<string, number> = {};
  let header: Row | null = null;
  let lineNo = 0;
  let skipped = 0;

  for await (const line of rl) {
    lineNo += 1;
    if (!line.trim()) continue;
    let row: Row;
    try {
      row = JSON.parse(line) as Row;
    } catch {
      console.error(`  line ${lineNo}: not valid JSON — skipped`);
      skipped += 1;
      continue;
    }
    if (row._format === 'taxscan-push-backup' || (lineNo === 1 && !row._table)) {
      header = row;
      continue;
    }
    const table = row._table as Restorable | undefined;
    if (!table || !RESTORABLE.includes(table)) {
      skipped += 1;
      continue;
    }
    if (only && table !== only) continue;

    counts[table] = (counts[table] ?? 0) + 1;
    if (apply) {
      try {
        await upsert(table, revive(row));
      } catch (e) {
        console.error(`  line ${lineNo} (${table}): ${e instanceof Error ? e.message : String(e)}`);
        skipped += 1;
      }
    }
  }

  if (header) {
    console.log(`Backup taken   : ${header.generatedAt ?? 'unknown'}`);
    console.log(`Format version : ${header.version ?? '?'}\n`);
  } else {
    console.log('No header line found — restoring anyway, but this may not be one of our exports.\n');
  }

  for (const t of RESTORABLE) {
    if (counts[t]) console.log(`  ${t.padEnd(16)} ${counts[t]}`);
  }
  if (skipped) console.log(`  ${'skipped'.padEnd(16)} ${skipped}`);

  const subs = counts.Subscriber ?? 0;
  console.log(
    apply
      ? `\nDone. ${subs} subscriber row(s) restored.`
      : '\nDry run only — nothing was written. Re-run with --yes to apply.',
  );
  if (subs) {
    console.log(
      'REMINDER: these subscriptions only work with the ORIGINAL VAPID keypair.\n' +
        'Check VAPID_PUBLIC_KEY matches the one they were created under before\n' +
        'concluding a restore succeeded — a mismatch fails silently at send time.',
    );
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
