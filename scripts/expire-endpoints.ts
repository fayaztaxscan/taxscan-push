/**
 * Expire specific subscriber rows by EXACT push endpoint.
 *
 * Use this to remove known-bad individual subscriptions — e.g. leaked local-dev
 * / test-browser rows that show "localhost:3000" as the notification origin.
 * Origin is NOT stored on the Subscriber row (it lives only in the browser's
 * service-worker registration), so the ONLY collateral-free way to target these
 * is by the exact endpoint string. Get it from the offending browser's console:
 *
 *   await TaxscanPush.getState()   // -> { endpoint, ... }
 *
 * Usage (DRY-RUN by default — prints matches, writes nothing):
 *   npm run db:expire-endpoints -- "<endpoint1>" "<endpoint2>"
 *   npm run db:expire-endpoints -- --file ./endpoints.txt        (one per line)
 *   npm run db:expire-endpoints -- --contains "<substring>"      (substring match; review carefully)
 *
 * Add --commit to actually flip the matched ACTIVE rows to EXPIRED:
 *   npm run db:expire-endpoints -- "<endpoint>" --commit
 *
 * Safety:
 *   - Defaults to dry-run; nothing is written without --commit.
 *   - Only ACTIVE rows are matched/affected (EXPIRED rows are already inert).
 *   - Endpoints are masked in output (only host + a short prefix shown).
 *   - WARNING: this reads/writes whatever DATABASE_URL points at. To act on
 *     production, run with the prod DATABASE_URL explicitly, e.g.
 *       DATABASE_URL="<prod-url>" npm run db:expire-endpoints -- "<endpoint>" --commit
 */
import { promises as fs } from 'fs';
import { prisma } from '../src/lib/prisma';

/** Show host + a short prefix only — endpoints are a delivery secret. */
function maskEndpoint(endpoint: string): string {
  try {
    const u = new URL(endpoint);
    const tail = u.pathname.replace(/^\//, '').slice(0, 8);
    return `${u.host}/${tail}…`;
  } catch {
    return endpoint.slice(0, 24) + '…';
  }
}

(async () => {
  const argv = process.argv.slice(2);
  const commit = argv.includes('--commit');
  const containsIdx = argv.indexOf('--contains');
  const contains = containsIdx !== -1 ? argv[containsIdx + 1] : null;
  const fileIdx = argv.indexOf('--file');
  const filePath = fileIdx !== -1 ? argv[fileIdx + 1] : null;

  // Positional endpoints = any arg that isn't a flag or a flag's value.
  const consumed = new Set<number>();
  if (containsIdx !== -1) consumed.add(containsIdx).add(containsIdx + 1);
  if (fileIdx !== -1) consumed.add(fileIdx).add(fileIdx + 1);
  let endpoints = argv
    .filter((a, i) => !a.startsWith('--') && !consumed.has(i))
    .map((s) => s.trim())
    .filter(Boolean);

  if (filePath) {
    const text = await fs.readFile(filePath, 'utf8');
    endpoints = endpoints.concat(
      text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#')),
    );
  }

  if (!endpoints.length && !contains) {
    // eslint-disable-next-line no-console
    console.error(
      'Usage: npm run db:expire-endpoints -- "<endpoint>" [more…] [--file f.txt] [--contains substr] [--commit]',
    );
    process.exit(2);
  }

  // Build the match query. Exact endpoints via `in`; optional substring via `contains`.
  const where: {
    status: 'ACTIVE';
    OR: Array<{ endpoint: { equals?: string; contains?: string } }>;
  } = { status: 'ACTIVE', OR: [] };
  for (const e of endpoints) where.OR.push({ endpoint: { equals: e } });
  if (contains) where.OR.push({ endpoint: { contains } });

  const matches = await prisma.subscriber.findMany({
    where,
    select: { id: true, endpoint: true, portal: true, userAgent: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  // eslint-disable-next-line no-console
  console.log(
    `[expire-endpoints] ${endpoints.length} exact endpoint(s)` +
      (contains ? ` + contains="${contains}"` : '') +
      ` → matched ${matches.length} ACTIVE subscriber(s)`,
  );
  for (const m of matches) {
    // eslint-disable-next-line no-console
    console.log(
      `  ${m.id}  ${maskEndpoint(m.endpoint)}  portal=${m.portal}  ` +
        `created=${m.createdAt.toISOString().slice(0, 10)}  ua=${(m.userAgent || '').slice(0, 50)}`,
    );
  }

  if (!matches.length) {
    // eslint-disable-next-line no-console
    console.log('[expire-endpoints] nothing to do.');
    await prisma.$disconnect();
    return;
  }

  if (!commit) {
    // eslint-disable-next-line no-console
    console.log('\n[expire-endpoints] DRY-RUN — no rows written. Re-run with --commit to expire these.');
    await prisma.$disconnect();
    return;
  }

  const result = await prisma.subscriber.updateMany({
    where: { id: { in: matches.map((m) => m.id) } },
    data: { status: 'EXPIRED' },
  });
  // eslint-disable-next-line no-console
  console.log(`\n[expire-endpoints] flipped ${result.count} subscriber(s) to EXPIRED.`);
  await prisma.$disconnect();
})().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
