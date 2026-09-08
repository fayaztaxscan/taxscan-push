/**
 * Downloads a backup out of R2 — the first step of any real recovery.
 *
 *   npm run backup:fetch                      # newest object, saved under its own name
 *   npm run backup:fetch -- --out latest.gz   # newest, to a chosen path
 *   npm run backup:fetch -- --list            # just show what is in the bucket
 *   npm run backup:fetch -- --key <object key>
 *
 * Object keys are ISO-timestamped, so lexical order is chronological order and
 * "newest" is simply the last one.
 *
 * This exists so recovery never depends on the Cloudflare dashboard being
 * reachable, or on anyone reconstructing an aws-cli command under pressure.
 */

import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { getObject, isR2Configured, listObjects } from '../src/lib/r2';
import { r2ConfigFromEnv } from '../src/services/backup';
import { env } from '../src/lib/env';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const has = (name: string) => process.argv.includes(`--${name}`);

async function main(): Promise<void> {
  const cfg = r2ConfigFromEnv();
  if (!isR2Configured(cfg)) {
    console.error(
      'R2 is not configured. Set R2_BUCKET, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and\n' +
        'R2_SECRET_ACCESS_KEY (they live on the Railway service).',
    );
    process.exit(1);
  }

  const keys = (await listObjects(cfg, `${env.backup.prefix}/`)).sort();
  if (keys.length === 0) {
    console.error(`No objects under "${env.backup.prefix}/" in bucket ${cfg.bucket}.`);
    process.exit(1);
  }

  if (has('list')) {
    console.log(`${keys.length} object(s) in ${cfg.bucket}:`);
    for (const k of keys) console.log(`  ${k}`);
    return;
  }

  const key = arg('key') ?? keys[keys.length - 1];
  const out = arg('out') ?? basename(key);
  const body = await getObject(cfg, key);
  writeFileSync(out, body);

  console.log(`Downloaded ${key}`);
  console.log(`  -> ${out} (${body.length} bytes)`);
  console.log(`  ${keys.length} backup(s) currently retained\n`);
  console.log('Next: npm run restore:backup -- --file ' + out + '   (add --yes to apply)');
  console.log(
    'Remember the restore also needs the ORIGINAL VAPID keypair, which is not\n' +
      'in this file. Without it the restored subscribers cannot be pushed to.',
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
