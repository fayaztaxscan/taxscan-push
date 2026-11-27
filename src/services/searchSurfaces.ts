import cron from 'node-cron';
import type { SearchSurface } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { env } from '../lib/env';
import { safeErrorLog } from '../lib/httpErrors';
import { readsPath } from './metrics';
import {
  loadGaCredentials,
  getGaAccessToken,
  SEARCH_CONSOLE_SCOPE,
  type FetchLike,
  type GaCredentials,
} from './gaReads';

/**
 * Google Discover / Google News / Google Search News-tab pickup, from the
 * Search Console Search Analytics API.
 *
 * WHY NOT GA4 (the question this module exists to answer): Discover is
 * invisible in GA4. A Discover click carries a plain `https://www.google.com/`
 * referrer, so GA4 files it under `google / organic`, indistinguishable from
 * ordinary search; when Discover opens inside the Google app's in-app browser
 * the referrer is stripped entirely and it lands in `(direct) / (none)`. No
 * GA4 dimension isolates it. Google News fares slightly better — news.google.com
 * referrals are visible — but that misses the Google News app (referrer-less)
 * and the News tab inside Search (`google / organic`), so GA4 undercounts by an
 * unknown margin. Search Console's `type` parameter (`discover` / `news` /
 * `googleNews`) is the only authoritative split, so that is what we sync.
 * `news` (the News tab in Google Search) and `googleNews` (the
 * Google News app and site) are DIFFERENT surfaces with similar names.
 *
 * Same invariant as the GA reads sync: a flag-gated cron mirrors Search Console
 * into Postgres and THE REQUEST PATH NEVER CALLS GOOGLE — an outage leaves the
 * last-synced numbers in place, stale but serving.
 *
 * Three properties of this data drive how it may be presented:
 *   - CLICKS AND IMPRESSIONS, not pageviews. Not comparable with, and never to
 *     be summed with, ArticleReadStat.totalViews.
 *   - Settles 2-3 days late (vs GA's ~48h refinement). For the first couple of
 *     days there is no data AT ALL, not partial data — which is why this is only
 *     ever surfaced in retrospective, trailing-window views and deliberately
 *     NOT as a column beside fresh campaign rows.
 *   - Attributed to the CANONICAL url. When the desk publishes a story twice,
 *     the two copies split their signals; deleting the copy Google surfaced
 *     forfeits the pickup outright (see docs/NOTE-TO-EDITORIAL-deleted-articles.md).
 */

/** Max rows per Search Analytics request (API hard limit). */
const ROW_LIMIT = 25_000;
/** Guards against an unbounded pagination loop if the API misbehaves. */
const MAX_PAGES = 40;

const API_ROOT = 'https://searchconsole.googleapis.com/webmasters/v3/sites';

/**
 * The surfaces we track, in the order the report shows them. `type` is the API's search type (also what a backfill is
 * asked for); `logName` is the count's name in log lines.
 */
export const SURFACES: { surface: SearchSurface; type: string; logName: string }[] = [
  { surface: 'DISCOVER', type: 'discover', logName: 'discover' },
  { surface: 'GOOGLE_SEARCH_NEWS', type: 'news', logName: 'searchNews' },
  { surface: 'GOOGLE_NEWS', type: 'googleNews', logName: 'googleNews' },
];

/** `discover=12 searchNews=3 googleNews=1`, naming only the surfaces that were fetched. */
export function surfaceCounts(bySurface: Record<string, number>): string {
  return SURFACES.filter((s) => bySurface[s.surface] !== undefined)
    .map((s) => `${s.logName}=${bySurface[s.surface]}`)
    .join(' ');
}

// One sync at a time in this process: the cron pass and a backfill both replace rows by date, so running them together
// could collide on the (portal, pagePath, date, surface) unique index.
let syncing = false;
/** Takes the lock; false if a sync or backfill holds it. Pair with `releaseSurfacesLock`. */
export function acquireSurfacesLock(): boolean {
  if (syncing) return false;
  syncing = true;
  return true;
}
export function releaseSurfacesLock(): void {
  syncing = false;
}

export type SurfaceRow = {
  date: Date;
  pagePath: string;
  surface: SearchSurface;
  clicks: number;
  impressions: number;
};

/** One row as the Search Analytics API returns it with dimensions [date, page]. */
export type SearchAnalyticsRow = {
  keys?: string[];
  clicks?: number;
  impressions?: number;
};

/** `YYYY-MM-DD` for the API's date range (UTC). */
export function apiDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` (API date-dimension value) → UTC-midnight Date, matching ArticleReadStat.date. */
export function parseApiDate(s: string): Date {
  return new Date(`${s}T00:00:00.000Z`);
}

/**
 * Normalise the API's `page` dimension — a full canonical URL — to the same
 * join key the reads columns use. Delegates to `readsPath` so the two datasets
 * can never drift apart on trailing slashes or host handling; returns null for
 * anything that isn't a taxscan.in article page (a domain-level property also
 * reports academy/shop URLs, which aren't editorial articles).
 */
export function surfacePagePath(pageUrl: string): string | null {
  return readsPath(pageUrl);
}

/**
 * Fetch every row for one surface over [startDate, endDate], following the
 * API's offset pagination. `dataState: 'all'` deliberately includes Google's
 * not-yet-finalised days: they arrive a day or so earlier than `final` and are
 * corrected on the next pass, because each sync replaces its window wholesale.
 */
export async function fetchSurface(opts: {
  creds: GaCredentials;
  surface: SearchSurface;
  type: string;
  startDate: string;
  endDate: string;
  siteUrl: string;
  fetchImpl?: FetchLike;
  now?: Date;
}): Promise<SurfaceRow[]> {
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchLike);
  const now = opts.now ?? new Date();
  const token = await getGaAccessToken(opts.creds, fetchImpl, now, SEARCH_CONSOLE_SCOPE);
  const url = `${API_ROOT}/${encodeURIComponent(opts.siteUrl)}/searchAnalytics/query`;

  // Keyed by date|path, not appended: Google reports the trailing-slash and bare
  // spellings of one URL as SEPARATE rows, and both normalise to the same
  // pagePath — so appending blindly trips the (portal, pagePath, date, surface)
  // unique index on write. Folding here also survives the same URL appearing on
  // two pagination pages. Found the hard way: an 8-day window never collided,
  // a 400-day backfill did.
  const out = new Map<string, SurfaceRow>();
  let startRow = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        startDate: opts.startDate,
        endDate: opts.endDate,
        dimensions: ['date', 'page'],
        type: opts.type,
        dataState: 'all',
        rowLimit: ROW_LIMIT,
        startRow,
      }),
    });
    const body = (await res.json()) as { rows?: SearchAnalyticsRow[]; error?: unknown };
    if (!res.ok) {
      throw new Error(
        `Search Console query failed for ${opts.type} (${res.status}): ${JSON.stringify(body.error ?? body)}`,
      );
    }
    const rows = body.rows ?? [];
    for (const r of rows) {
      const [date, pageUrl] = r.keys ?? [];
      if (!date || !pageUrl) continue;
      const pagePath = surfacePagePath(pageUrl);
      if (!pagePath) continue; // non-article host (academy/shop) or unparseable
      const key = `${date}|${pagePath}`;
      const existing = out.get(key);
      if (existing) {
        existing.clicks += Math.round(r.clicks ?? 0);
        existing.impressions += Math.round(r.impressions ?? 0);
      } else {
        out.set(key, {
          date: parseApiDate(date),
          pagePath,
          surface: opts.surface,
          clicks: Math.round(r.clicks ?? 0),
          impressions: Math.round(r.impressions ?? 0),
        });
      }
    }
    if (rows.length < ROW_LIMIT) return [...out.values()];
    startRow += rows.length;
  }
  // Rows come back by clicks, so a capped fetch is missing the long tail on
  // EVERY date — and the sync replaces each returned date wholesale, deleting
  // those rows. Fail instead: last good rows stay, and the operator shrinks
  // the span (backfill-surfaces already walks month by month).
  throw new Error(
    `Search Console ${opts.type} hit the ${MAX_PAGES}-page cap (${MAX_PAGES * ROW_LIMIT} rows) — nothing written; use a shorter span`,
  );
}

/**
 * One sync pass: pull every surface (or just the ones named) over the rolling
 * lookback window and mirror them into ArticleSurfaceStat.
 *
 * ALL fetches complete BEFORE anything is deleted, so a failure on a later
 * surface can't leave an earlier one's dates wiped. Each date the API returned
 * rows for is then replaced wholesale, exactly like the GA reads sync; dates it
 * returned nothing for keep their previously-synced rows. Only the fetched
 * surfaces' rows are ever replaced: a one-surface backfill leaves the others.
 *
 * ONLY CLICKED ROWS ARE WRITTEN (owner, 27 Nov 2026: most rows had no click and
 * filled the database). A row is a page on a day, judged after fetchSurface has
 * merged the URL spellings, so `impressions` counts clicked page-days only. A
 * date whose rows ALL had no click is still replaced, i.e. emptied. The returned
 * `rows` and `bySurface` count what was written; `dates` what was replaced.
 *
 * TWO WAYS TO PICK THE WINDOW, and the difference matters:
 *   - `lookbackDays` (the cron): [now - lookbackDays, now].
 *   - `startDate`/`endDate` (backfills): an explicit YYYY-MM-DD span.
 *
 * Reach for the explicit span for ANY historical fetch. `now` is not only the
 * window anchor — it is also the clock the service-account JWT is signed with,
 * so back-dating it to move the window back-dates the token too and Google
 * rejects the exchange outright ("Invalid JWT: Token must be a short-lived
 * token"). Found the hard way running the Jan-2026 backfill month by month.
 */
export async function syncSearchSurfaces(
  deps: {
    fetchImpl?: FetchLike;
    now?: Date;
    creds?: GaCredentials;
    portal?: string;
    siteUrl?: string;
    lookbackDays?: number;
    /** Explicit window (YYYY-MM-DD, inclusive). Both or neither; wins over lookbackDays. */
    startDate?: string;
    endDate?: string;
    /** Fetch and replace only these surfaces (a one-surface backfill). Default: all of them. */
    surfaces?: SearchSurface[];
  } = {},
): Promise<{ rows: number; dates: number; bySurface: Record<string, number> }> {
  const creds = deps.creds ?? loadGaCredentials();
  if (!creds) throw new Error('GA/Search Console credentials not configured');
  const siteUrl = deps.siteUrl ?? env.searchConsole.siteUrl;
  if (!siteUrl) throw new Error('SEARCH_CONSOLE_SITE_URL is not set');
  const portal = deps.portal ?? env.rss.portal;
  const now = deps.now ?? new Date();
  const lookbackDays = deps.lookbackDays ?? env.searchConsole.lookbackDays;

  if ((deps.startDate === undefined) !== (deps.endDate === undefined)) {
    throw new Error('syncSearchSurfaces: pass BOTH startDate and endDate, or neither');
  }
  const endDate = deps.endDate ?? apiDate(now);
  const startDate =
    deps.startDate ?? apiDate(new Date(now.getTime() - lookbackDays * 86_400_000));
  if (startDate > endDate) {
    throw new Error(`syncSearchSurfaces: startDate ${startDate} is after endDate ${endDate}`);
  }

  const wanted = SURFACES.filter((s) => !deps.surfaces || deps.surfaces.includes(s.surface));
  if (wanted.length === 0) throw new Error('syncSearchSurfaces: no known surface to fetch');

  const fetched: SurfaceRow[] = [];
  const rows: SurfaceRow[] = []; // what gets written: the clicked ones
  const bySurface: Record<string, number> = {};
  for (const { surface, type } of wanted) {
    const got = await fetchSurface({
      creds,
      surface,
      type,
      startDate,
      endDate,
      siteUrl,
      fetchImpl: deps.fetchImpl,
      now,
    });
    const clicked = got.filter((r) => r.clicks > 0);
    bySurface[surface] = clicked.length;
    for (const r of got) fetched.push(r);
    for (const r of clicked) rows.push(r);
  }

  // From everything fetched, not only what is written: an all-unclicked date must still lose its old rows.
  const dates = [...new Set(fetched.map((r) => r.date.getTime()))].map((t) => new Date(t));
  const CHUNK = 1000;
  const writes = [
    prisma.articleSurfaceStat.deleteMany({
      where: { portal, date: { in: dates }, surface: { in: wanted.map((s) => s.surface) } },
    }),
  ];
  for (let i = 0; i < rows.length; i += CHUNK) {
    writes.push(
      prisma.articleSurfaceStat.createMany({
        data: rows.slice(i, i + CHUNK).map((r) => ({ ...r, portal })),
      }),
    );
  }
  await prisma.$transaction(writes);
  return { rows: rows.length, dates: dates.length, bySurface };
}

/** The cron's pass: skipped while a backfill runs (the next one covers the same days); never throws. */
export async function runScheduledSync(deps: Parameters<typeof syncSearchSurfaces>[0] = {}): Promise<void> {
  if (!acquireSurfacesLock()) {
    // eslint-disable-next-line no-console
    console.log('[surfaces] sync skipped (another sync or a backfill is running)');
    return;
  }
  try {
    const r = await syncSearchSurfaces(deps);
    // eslint-disable-next-line no-console
    console.log(`[surfaces] synced rows=${r.rows} dates=${r.dates} ${surfaceCounts(r.bySurface)}`);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[surfaces] sync failed (last-synced counts stay in place)', safeErrorLog(e, { stack: true }));
  } finally {
    releaseSurfacesLock();
  }
}

let started = false;

export function startSearchSurfacesSync(): void {
  if (!env.searchConsole.enabled) {
    // eslint-disable-next-line no-console
    console.log('[surfaces] disabled (set SEARCH_CONSOLE_ENABLED=true to start)');
    return;
  }
  if (!loadGaCredentials()) {
    // eslint-disable-next-line no-console
    console.warn('[surfaces] no credentials (GA_SERVICE_ACCOUNT_JSON or key file) — sync not started');
    return;
  }
  if (!env.searchConsole.siteUrl) {
    // eslint-disable-next-line no-console
    console.warn('[surfaces] SEARCH_CONSOLE_SITE_URL not set — sync not started');
    return;
  }
  if (!cron.validate(env.searchConsole.cron)) {
    throw new Error(`Invalid SEARCH_CONSOLE_CRON: ${env.searchConsole.cron}`);
  }
  if (started) return;
  started = true;

  cron.schedule(env.searchConsole.cron, () => void runScheduledSync(), { timezone: env.rss.tz });
  // One pass shortly after boot so enabling the flag is verifiable without
  // waiting for the next slot. Delayed to let the deploy settle, and staggered
  // past the GA sync's own boot pass so the two don't contend.
  setTimeout(() => void runScheduledSync(), 45_000).unref();
  // eslint-disable-next-line no-console
  console.log(
    `[surfaces] scheduled cron="${env.searchConsole.cron}" site=${env.searchConsole.siteUrl} lookback=${env.searchConsole.lookbackDays}d`,
  );
}
