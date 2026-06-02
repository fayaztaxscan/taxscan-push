/**
 * Bulk-import subscribers from an iZooto CSV export.
 *
 * Usage:
 *   npm run import:izooto -- <file.csv>
 *   npm run import:izooto -- <file.csv> --dry-run
 *
 * CSV requirements:
 *   - Header row with at least `endpoint, p256dh, auth`
 *   - Optional `userAgent` column
 *   - Comma-separated, no embedded quoted commas (export from iZooto as plain CSV)
 *
 * Caveat (read the README "Cutover from iZooto" section):
 *   This only works if the iZooto endpoints were registered with the SAME
 *   VAPID public key that the backend now serves. If iZooto used its own
 *   VAPID keys, send attempts will fail at the push service. The Task 9
 *   FAILED-event tracking makes those failures visible without abort.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { prisma } from '../src/lib/prisma';

const SOURCE = 'import' as const;
const PORTAL = 'taxscan';

function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
  const rows = lines.slice(1).map((line) => {
    const cells = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = cells[i] ?? '';
    });
    return row;
  });
  return { headers, rows };
}

function base64urlByteLength(s: string): number {
  const padded = s + '='.repeat((4 - (s.length % 4)) % 4);
  const std = padded.replace(/-/g, '+').replace(/_/g, '/');
  try {
    return Buffer.from(std, 'base64').length;
  } catch {
    return -1;
  }
}

(async () => {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const fileArg = args.find((a) => !a.startsWith('--'));

  if (!fileArg) {
    // eslint-disable-next-line no-console
    console.error('Usage: npm run import:izooto -- <file.csv> [--dry-run]');
    process.exit(2);
  }

  const filePath = path.resolve(fileArg);
  // eslint-disable-next-line no-console
  console.log(`[import:izooto] reading ${filePath}`);

  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[import:izooto] cannot read file: ${err instanceof Error ? err.message : err}`);
    process.exit(2);
  }

  const { headers, rows } = parseCsv(text);
  const required = ['endpoint', 'p256dh', 'auth'];
  const missing = required.filter((r) => !headers.includes(r));
  if (missing.length) {
    // eslint-disable-next-line no-console
    console.error(`[import:izooto] CSV missing required columns: ${missing.join(', ')}`);
    // eslint-disable-next-line no-console
    console.error(`[import:izooto] found columns: ${headers.join(', ')}`);
    process.exit(2);
  }

  // eslint-disable-next-line no-console
  console.log(`[import:izooto] parsed ${rows.length} rows`);
  if (dryRun) {
    // eslint-disable-next-line no-console
    console.log(`[import:izooto] DRY-RUN — no rows will be written`);
  }

  let imported = 0;
  let skippedDuplicate = 0;
  let skippedBadKeys = 0;
  let errors = 0;

  for (const row of rows) {
    const endpoint = row.endpoint;
    const p256dh = row.p256dh;
    const auth = row.auth;
    const userAgent = row.userAgent || row.user_agent || null;

    if (!endpoint || !p256dh || !auth) {
      skippedBadKeys++;
      continue;
    }
    if (base64urlByteLength(p256dh) !== 65 || base64urlByteLength(auth) !== 16) {
      skippedBadKeys++;
      continue;
    }

    if (dryRun) {
      imported++;
      continue;
    }

    try {
      const existing = await prisma.subscriber.findUnique({ where: { endpoint } });
      if (existing) {
        skippedDuplicate++;
        continue;
      }
      const sub = await prisma.subscriber.create({
        data: {
          endpoint,
          p256dh,
          auth,
          portal: PORTAL,
          // Default to ['all'] per the Task 6 hardening rule — imported
          // subscribers won't have stored topic preferences locally.
          topics: ['all'],
          userAgent,
          status: 'ACTIVE',
        },
      });
      await prisma.event.create({
        data: {
          type: 'SUBSCRIBED',
          subscriberId: sub.id,
          meta: { source: SOURCE },
        },
      });
      imported++;
    } catch (err) {
      errors++;
      // eslint-disable-next-line no-console
      console.error(
        `[import:izooto] row failed (endpoint redacted) — ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  const total = rows.length;
  const pct = total > 0 ? ((imported / total) * 100).toFixed(1) : '0.0';

  // eslint-disable-next-line no-console
  console.log('');
  // eslint-disable-next-line no-console
  console.log('[import:izooto] === Summary ===');
  // eslint-disable-next-line no-console
  console.log(`  Total rows in file:        ${total}`);
  // eslint-disable-next-line no-console
  console.log(
    `  Successfully imported:     ${imported}${dryRun ? '  (DRY-RUN — would have)' : ''}`,
  );
  // eslint-disable-next-line no-console
  console.log(`  Skipped (already in DB):   ${skippedDuplicate}`);
  // eslint-disable-next-line no-console
  console.log(`  Skipped (bad/empty keys):  ${skippedBadKeys}`);
  // eslint-disable-next-line no-console
  console.log(`  Errors:                    ${errors}`);
  // eslint-disable-next-line no-console
  console.log('  ────────────────────────────────');
  // eslint-disable-next-line no-console
  console.log(`  Migrated ${imported} of ${total} (${pct}%)`);
  // eslint-disable-next-line no-console
  console.log('');
  if (!dryRun && imported > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `  These will appear in /api/metrics under subscribersBySource['import']=${imported}.`,
    );
  }
  if (errors > 0) {
    // eslint-disable-next-line no-console
    console.log('  Some rows failed. Address the errors above before re-running.');
  }
  // eslint-disable-next-line no-console
  console.log('');

  await prisma.$disconnect();
  process.exit(errors > 0 ? 1 : 0);
})().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
