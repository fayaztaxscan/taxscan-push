import cron from 'node-cron';
import { prisma } from '../lib/prisma';
import { env } from '../lib/env';
import { detectBench, reportCategory, benchRank } from './reports';
import {
  loadGaCredentials,
  getGaAccessToken,
  type FetchLike,
  type GaCredentials,
  type GaReport,
} from './gaReads';

/**
 * The "Reads" report: article pageviews aggregated by bench and by category
 * over trailing windows (1 week / 1 / 3 / 6 / 12 months), classified from the
 * article headline with the SAME rules as the coverage report (detectBench +
 * reportCategory), so its rows match the weekly/monthly heatmaps.
 *
 * Built from the GA4 Data API by a daily cron (plus a stale-aware pass at
 * boot) and cached whole in the GaReadsReport table — GET /api/reports/reads
 * serves that row and NEVER calls GA, so the screen loads instantly and a GA
 * outage only means the report stays at its last successful build.
 */

export const READ_WINDOWS = [
  { label: '1 week', days: 7 },
  { label: '1 month', days: 30 },
  { label: '3 months', days: 90 },
  { label: '6 months', days: 180 },
  { label: '12 months', days: 365 },
] as const;

/** Article pages: the slug ends in the numeric article id (…-scheme-2026-1448729). */
const ARTICLE_PATH_RE = '-\\d{5,}/?$';

export type ReadsCell = { views: number; articles: number; share: number } | null;
export type ReadsRow = { label: string; cells: ReadsCell[] };
export type ReadsPayload = {
  windows: { label: string; days: number; siteViews: number; articleViews: number; articlesRead: number }[];
  categories: ReadsRow[];
  benches: ReadsRow[];
};

/** GA pageTitle carries the site suffix ("… - Taxscan") — strip before classifying. */
export function cleanPageTitle(t: string): string {
  return t.replace(/\s*[-|–]\s*Taxscan.*$/i, '').trim();
}

type Agg = Map<string, { views: number; articles: number }[]>;

function bump(agg: Agg, label: string, windowIdx: number, views: number): void {
  let arr = agg.get(label);
  if (!arr) {
    arr = READ_WINDOWS.map(() => ({ views: 0, articles: 0 }));
    agg.set(label, arr);
  }
  arr[windowIdx].views += views;
  arr[windowIdx].articles += 1;
}

async function runReport(
  fetchImpl: FetchLike,
  token: string,
  request: object,
): Promise<GaReport> {
  const res = await fetchImpl(
    `https://analyticsdata.googleapis.com/v1beta/properties/${env.gaReads.propertyId}:runReport`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    },
  );
  const body = (await res.json()) as GaReport & { error?: unknown };
  if (!res.ok) throw new Error(`GA runReport failed (${res.status}): ${JSON.stringify(body.error ?? body)}`);
  return body;
}

/** Build the full payload from GA (one site-total + paginated article rows per window). */
export async function buildReadsReport(opts: {
  creds: GaCredentials;
  fetchImpl?: FetchLike;
  now?: Date;
}): Promise<ReadsPayload> {
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchLike);
  const now = opts.now ?? new Date();
  const token = await getGaAccessToken(opts.creds, fetchImpl, now);

  const byBench: Agg = new Map();
  const byCategory: Agg = new Map();
  const windows: ReadsPayload['windows'] = [];

  for (let wi = 0; wi < READ_WINDOWS.length; wi += 1) {
    const w = READ_WINDOWS[wi];
    const base = {
      dateRanges: [{ startDate: `${w.days}daysAgo`, endDate: 'today' }],
      metrics: [{ name: 'screenPageViews' }],
    };
    const total = await runReport(fetchImpl, token, base); // no dimensions = site-wide
    const siteViews = Number(total.rows?.[0]?.metricValues[0].value ?? 0);

    let articleViews = 0;
    let articlesRead = 0;
    let offset = 0;
    let rowCount = Infinity;
    while (offset < rowCount) {
      const page = await runReport(fetchImpl, token, {
        ...base,
        dimensions: [{ name: 'pagePath' }, { name: 'pageTitle' }],
        dimensionFilter: {
          filter: { fieldName: 'pagePath', stringFilter: { matchType: 'PARTIAL_REGEXP', value: ARTICLE_PATH_RE } },
        },
        limit: 100000,
        offset,
      });
      rowCount = page.rowCount ?? 0;
      const rows = page.rows ?? [];
      if (rows.length === 0) break;
      offset += rows.length;
      for (const r of rows) {
        const title = cleanPageTitle(r.dimensionValues[1].value);
        const views = Number(r.metricValues[0].value) || 0;
        articleViews += views;
        articlesRead += 1;
        bump(byBench, detectBench(title), wi, views);
        bump(byCategory, reportCategory([], title), wi, views);
      }
    }
    windows.push({ label: w.label, days: w.days, siteViews, articleViews, articlesRead });
  }

  const toRows = (agg: Agg): ReadsRow[] =>
    [...agg.entries()].map(([label, arr]) => ({
      label,
      cells: arr.map((c, wi) => {
        if (c.views === 0 && c.articles === 0) return null;
        const total = windows[wi].articleViews;
        return { views: c.views, articles: c.articles, share: total > 0 ? Number((c.views / total).toFixed(4)) : 0 };
      }),
    }));

  // Categories: largest 12-month reads first. Benches: the coverage report's
  // own order (SC → priority HC → other HC → tribunals → Unspecified last).
  const last = READ_WINDOWS.length - 1;
  const categories = toRows(byCategory).sort(
    (a, b) => (b.cells[last]?.views ?? 0) - (a.cells[last]?.views ?? 0),
  );
  const benches = toRows(byBench).sort((a, b) => benchRank(a.label) - benchRank(b.label));

  return { windows, categories, benches };
}

/** Build from GA and upsert the per-portal cache row. */
export async function refreshReadsReport(
  deps: { fetchImpl?: FetchLike; now?: Date; creds?: GaCredentials; portal?: string } = {},
): Promise<{ windows: number; categories: number; benches: number }> {
  const creds = deps.creds ?? loadGaCredentials();
  if (!creds) throw new Error('GA credentials not configured (GA_SERVICE_ACCOUNT_JSON or key file)');
  const portal = deps.portal ?? env.rss.portal;
  const payload = await buildReadsReport({ creds, fetchImpl: deps.fetchImpl, now: deps.now });
  await prisma.gaReadsReport.upsert({
    where: { portal },
    create: { portal, payload: payload as object },
    update: { payload: payload as object },
  });
  return { windows: payload.windows.length, categories: payload.categories.length, benches: payload.benches.length };
}

/** The cached report row, or null when it hasn't been built yet. */
export async function getReadsReport(
  portal: string,
): Promise<{ payload: ReadsPayload; generatedAt: Date } | null> {
  const row = await prisma.gaReadsReport.findUnique({ where: { portal } });
  if (!row) return null;
  return { payload: row.payload as unknown as ReadsPayload, generatedAt: row.generatedAt };
}

const STALE_MS = 12 * 60 * 60 * 1000;

let started = false;

export function startReadsReportCron(): void {
  if (!env.gaReads.enabled) {
    // eslint-disable-next-line no-console
    console.log('[reads-report] disabled (set GA_READS_ENABLED=true to start)');
    return;
  }
  if (!loadGaCredentials()) {
    // eslint-disable-next-line no-console
    console.warn('[reads-report] no GA credentials — cron not started');
    return;
  }
  if (!cron.validate(env.gaReads.reportCron)) {
    throw new Error(`Invalid GA_READS_REPORT_CRON: ${env.gaReads.reportCron}`);
  }
  if (started) return;
  started = true;

  const run = async () => {
    try {
      const r = await refreshReadsReport();
      // eslint-disable-next-line no-console
      console.log(`[reads-report] built windows=${r.windows} categories=${r.categories} benches=${r.benches}`);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[reads-report] build failed (last build keeps serving)', e);
    }
  };

  cron.schedule(env.gaReads.reportCron, () => void run(), { timezone: env.rss.tz });
  // Boot pass only when the cache is missing or older than half a day, so
  // routine redeploys don't re-query GA every time.
  setTimeout(() => {
    void (async () => {
      const row = await getReadsReport(env.rss.portal).catch(() => null);
      if (!row || Date.now() - row.generatedAt.getTime() > STALE_MS) await run();
    })();
  }, 30_000).unref();
  // eslint-disable-next-line no-console
  console.log(`[reads-report] scheduled cron="${env.gaReads.reportCron}" tz=${env.rss.tz}`);
}
