/**
 * Runs a backup on demand.
 *
 *   npm run backup:now                      # export + upload to R2
 *   npm run backup:now -- --out backup.gz   # write locally instead
 *   npm run backup:now -- --out backup.gz --upload   # both
 *
 * The local mode needs no R2 credentials at all, which makes it the escape
 * hatch: you can always take a copy from a laptop with DATABASE_PUBLIC_URL,
 * even before any of the cloud plumbing is configured.
 */

import { gzipSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { buildBackup, objectKeyFor, r2ConfigFromEnv, runBackup } from '../src/services/backup';
import { isR2Configured } from '../src/lib/r2';
import { env } from '../src/lib/env';
import { prisma } from '../src/lib/prisma';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const has = (name: string) => process.argv.includes(`--${name}`);

async function main(): Promise<void> {
  const out = arg('out');
  const alsoUpload = has('upload');
  const now = new Date();

  const target = (process.env.DATABASE_URL ?? '').replace(/:\/\/[^@]*@/, '://***@');
  console.log(`Source database : ${target || '(DATABASE_URL not set)'}`);

  if (out && !alsoUpload) {
    // Local-only: never touches R2, never records a run (a manual local dump
    // is not the scheduled off-platform copy and must not look like one).
    const { body, result } = await buildBackup({ now });
    const gz = gzipSync(body, { level: 9 });
    writeFileSync(out, gz);
    console.log(`\nWrote ${out} — ${gz.length} bytes gzipped, ${result.rows} rows`);
    for (const [t, n] of Object.entries(result.tables)) console.log(`  ${t.padEnd(16)} ${n}`);
    console.log(
      '\nThis file is sensitive: it contains push endpoints, which are delivery\n' +
        'keys for real people. It is NOT sufficient on its own — a restore also\n' +
        'needs the VAPID keypair, which is deliberately not included.',
    );
    await prisma.$disconnect();
    return;
  }

  if (!isR2Configured(r2ConfigFromEnv())) {
    console.error(
      'R2 is not configured. Set R2_BUCKET, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and\n' +
        'R2_SECRET_ACCESS_KEY, or pass --out <file> to write a local copy instead.',
    );
    process.exit(1);
  }

  const r = await runBackup({ now });
  console.log(`\nUploaded ${r.objectKey}`);
  console.log(`  ${r.rows} rows, ${r.bytes} bytes gzipped`);
  for (const [t, n] of Object.entries(r.tables)) console.log(`  ${t.padEnd(16)} ${n}`);

  if (out) {
    const { body } = await buildBackup({ now });
    writeFileSync(out, gzipSync(body, { level: 9 }));
    console.log(`  local copy: ${out}`);
  }
  console.log(`\nExpected key format: ${objectKeyFor(now, env.backup.prefix)}`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
