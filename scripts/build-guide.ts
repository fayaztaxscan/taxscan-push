/**
 * Regenerate the admin user-guide PDF from its HTML source.
 *
 * The guide is authored in `docs/Taxscan-Push-Admin-Guide.html` and served to
 * editors as `docs/Taxscan-Push-Admin-Guide.pdf` (see `/api/guide`). Run this
 * after editing the HTML so the served PDF can't drift from the source:
 *
 *   npm run build:guide
 *
 * Rendering uses headless Chrome's print-to-PDF (no extra dependency — the same
 * engine that produced the committed PDF). Point CHROME_BIN at a Chrome/Chromium
 * binary if it isn't auto-detected.
 */
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'docs', 'Taxscan-Push-Admin-Guide.html');
const OUT = path.join(ROOT, 'docs', 'Taxscan-Push-Admin-Guide.pdf');

/** Candidate Chrome/Chromium locations, in priority order. */
const CANDIDATES = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter((p): p is string => Boolean(p));

function findChrome(): string {
  const found = CANDIDATES.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      'No Chrome/Chromium binary found. Install Google Chrome or set CHROME_BIN to its path.',
    );
  }
  return found;
}

function main(): void {
  if (!existsSync(SRC)) throw new Error(`Guide source not found: ${SRC}`);
  const chrome = findChrome();
  // file:// URL so Chrome loads the local HTML; print-to-pdf writes OUT.
  const srcUrl = `file://${SRC}`;
  execFileSync(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-pdf-header-footer',
      `--print-to-pdf=${OUT}`,
      srcUrl,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  if (!existsSync(OUT)) throw new Error(`PDF was not produced at ${OUT}`);
  // eslint-disable-next-line no-console
  console.log(`[build:guide] wrote ${path.relative(ROOT, OUT)} using ${chrome}`);
}

try {
  main();
} catch (err) {
  // eslint-disable-next-line no-console
  console.error('[build:guide] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
}
