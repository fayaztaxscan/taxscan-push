/**
 * READ-ONLY lookup of a day's digest campaigns in Mailercloud (pilot runbook
 * check 2.2, and the after-restore step in docs/BACKUPS.md).
 *
 *   npm run digest:lookup -- --date 2026-10-24                  # both versions, portal from RSS_PORTAL
 *   npm run digest:lookup -- --date 2026-10-24 --audience FREE
 *   npm run digest:lookup -- --date 2026-10-24 --portal taxscan
 *
 * Prints, per name (TS-DIGEST-<date>-<AUDIENCE>): every campaign Mailercloud has
 * with exactly that name — id, Mailercloud's status word, our state and reach.
 * Two or more = a duplicate (delete the extra one). Never prints the API key or
 * an address. Uses MAILERCLOUD_API_KEY from the environment it runs in.
 *
 * Read-only by construction: the client is built with `readOnly: true` (every
 * write is refused before a request is made) and the lookup refuses to run with
 * any other client. It reads no database and writes nothing anywhere.
 */

import type { DigestAudience } from '@prisma/client';
import { env } from '../src/lib/env';
import { createReadOnlyLookupSender, formatLookup, lookupDigestCampaigns, parseLookupDate } from '../src/services/digest/lookup';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const runDate = parseLookupDate(arg('date'));
  if (!runDate) {
    console.error('Usage: npm run digest:lookup -- --date YYYY-MM-DD [--audience FREE|PREMIUM] [--portal taxscan]');
    process.exit(2);
  }
  const rawAudience = arg('audience')?.toUpperCase();
  if (rawAudience !== undefined && rawAudience !== 'FREE' && rawAudience !== 'PREMIUM') {
    console.error('--audience must be FREE or PREMIUM');
    process.exit(2);
  }
  const audiences: DigestAudience[] = rawAudience ? [rawAudience as DigestAudience] : ['FREE', 'PREMIUM'];
  if (!env.digest.mailercloud.apiKey.trim()) {
    console.error('MAILERCLOUD_API_KEY is not set in this environment.');
    process.exit(2);
  }
  const sender = createReadOnlyLookupSender(env.digest);
  if (sender.isReadOnly() !== true) {
    console.error('Refused: the Mailercloud client is not read-only.');
    process.exit(2);
  }
  console.log(`Mailercloud lookup (read-only) for ${runDate.toISOString().slice(0, 10)}, portal ${arg('portal') ?? env.rss.portal}`);
  const rows = await lookupDigestCampaigns(sender, { runDate, portal: arg('portal') ?? env.rss.portal, audiences });
  for (const line of formatLookup(rows)) console.log(line);
}

main().catch((e) => {
  console.error(`Lookup failed: ${e instanceof Error ? e.name : 'error'}`);
  process.exit(1);
});
