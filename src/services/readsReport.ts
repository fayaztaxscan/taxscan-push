import cron from 'node-cron';
import { prisma } from '../lib/prisma';
import { env } from '../lib/env';
import { safeErrorLog } from '../lib/httpErrors';
import { benchRowKey, categoryRowKey, benchRank, istDateKey } from './reports';
import { Prisma } from '@prisma/client';
import { readsEnabled, readsSourceNote, readsWindowByPath, splitRange } from './reads';
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
  /** Only with READS_SOURCE=cms (absent = GA, the payload exactly as before): where the numbers came from. */
  source?: { mode: 'cms'; note: string; cmsFrom: string; usedGa: boolean };
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
        bump(byBench, benchRowKey(title), wi, views);
        bump(byCategory, categoryRowKey({ title, categories: [] }), wi, views);
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

/**
 * The CMS-mode build (READS_SOURCE=cms): per trailing window, GA for the days before READS_CMS_FROM (the Data API,
 * from this cron — never a request) and the CMS's rows from Postgres from that day on, merged per article path. The
 * CMS feed carries no headlines, so a story the GA part never saw is classified from its slug (`titleFromPath`, as the
 * email's reads section is): coarser content-type detection, same bench / category rules. A CMS row IS an article,
 * so the numeric-id test used for GA's whole-site rows does not apply to it (stories born on the new CMS have no id).
 * There is no site-wide total from the CMS, so `siteViews` here is the GA part's site total plus the CMS article views.
 * Without GA credentials the GA part is skipped and the note says "Reads: CMS".
 */
export async function buildReadsReportCms(opts: {
  creds?: GaCredentials | null;
  fetchImpl?: FetchLike;
  now?: Date;
  portal?: string;
  cmsFrom?: string;
}): Promise<ReadsPayload> {
  const now = opts.now ?? new Date();
  const portal = opts.portal ?? env.rss.portal;
  const cmsFrom = opts.cmsFrom ?? env.cmsViews.cmsFrom;
  const today = istDateKey(now);
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchLike);
  const token = opts.creds ? await getGaAccessToken(opts.creds, fetchImpl, now) : null;

  const byBench: Agg = new Map();
  const byCategory: Agg = new Map();
  const windows: ReadsPayload['windows'] = [];
  let usedGa = false;

  for (let wi = 0; wi < READ_WINDOWS.length; wi += 1) {
    const w = READ_WINDOWS[wi];
    const startKey = istDateKey(new Date(now.getTime() - w.days * 86_400_000));
    const split = splitRange({ from: startKey, to: today }, 'cms', cmsFrom);
    const merged = new Map<string, { views: number; title: string | null }>();
    let siteViews = 0;
    let cmsViews = 0;

    if (split.ga && token) {
      const base = {
        dateRanges: [{ startDate: split.ga.from ?? startKey, endDate: split.ga.to ?? today }],
        metrics: [{ name: 'screenPageViews' }],
      };
      const total = await runReport(fetchImpl, token, base);
      siteViews += Number(total.rows?.[0]?.metricValues[0].value ?? 0);
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
        usedGa = true;
        for (const r of rows) {
          const path = r.dimensionValues[0].value.replace(/\/+$/, '');
          const e = merged.get(path) ?? { views: 0, title: null };
          e.views += Number(r.metricValues[0].value) || 0;
          e.title ??= cleanPageTitle(r.dimensionValues[1].value);
          merged.set(path, e);
        }
      }
    }

    if (split.cms) {
      const lo = split.cms.from ? Prisma.sql`AND date >= ${split.cms.from}::date` : Prisma.empty;
      const hi = split.cms.to ? Prisma.sql`AND date <= ${split.cms.to}::date` : Prisma.empty;
      const rows = await prisma.$queryRaw<{ canonicalPath: string; views: bigint }[]>`
        SELECT "canonicalPath", SUM(views)::bigint AS views FROM "CmsArticleView"
         WHERE portal = ${portal} ${lo} ${hi} GROUP BY "canonicalPath"`;
      for (const r of rows) {
        const e = merged.get(r.canonicalPath) ?? { views: 0, title: null };
        e.views += Number(r.views);
        cmsViews += Number(r.views);
        merged.set(r.canonicalPath, e);
      }
    }

    let articleViews = 0;
    for (const [path, e] of merged) {
      articleViews += e.views;
      const title = e.title ?? titleFromPath(path);
      bump(byBench, benchRowKey(title), wi, e.views);
      bump(byCategory, categoryRowKey({ title, categories: [] }), wi, e.views);
    }
    windows.push({ label: w.label, days: w.days, siteViews: siteViews + cmsViews, articleViews, articlesRead: merged.size });
  }

  const payload = finishReadsPayload(windows, byBench, byCategory);
  return { ...payload, source: { mode: 'cms', note: readsSourceNote('cms', { ga: usedGa, cms: true }, cmsFrom), cmsFrom, usedGa } };
}

/** Rows for the two tables from the aggregates (shared by both builds' shape). */
function finishReadsPayload(windows: ReadsPayload['windows'], byBench: Agg, byCategory: Agg): ReadsPayload {
  const toRows = (agg: Agg): ReadsRow[] =>
    [...agg.entries()].map(([label, arr]) => ({
      label,
      cells: arr.map((c, wi) => {
        if (c.views === 0 && c.articles === 0) return null;
        const total = windows[wi].articleViews;
        return { views: c.views, articles: c.articles, share: total > 0 ? Number((c.views / total).toFixed(4)) : 0 };
      }),
    }));
  const last = READ_WINDOWS.length - 1;
  const categories = toRows(byCategory).sort((a, b) => (b.cells[last]?.views ?? 0) - (a.cells[last]?.views ?? 0));
  const benches = toRows(byBench).sort((a, b) => benchRank(a.label) - benchRank(b.label));
  return { windows, categories, benches };
}

/** Build (from GA, or from GA + the CMS with READS_SOURCE=cms) and upsert the per-portal cache row. */
export async function refreshReadsReport(
  deps: { fetchImpl?: FetchLike; now?: Date; creds?: GaCredentials; portal?: string } = {},
): Promise<{ windows: number; categories: number; benches: number }> {
  const portal = deps.portal ?? env.rss.portal;
  const creds = deps.creds ?? loadGaCredentials();
  if (!creds && env.cmsViews.source !== 'cms') throw new Error('GA credentials not configured (GA_SERVICE_ACCOUNT_JSON or key file)');
  const payload =
    env.cmsViews.source === 'cms'
      ? await buildReadsReportCms({ creds, fetchImpl: deps.fetchImpl, now: deps.now, portal })
      : await buildReadsReport({ creds: creds as GaCredentials, fetchImpl: deps.fetchImpl, now: deps.now });
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

// --- Reads summary for the emailed coverage report ---------------------------

export type ReadsEmailSummary = {
  /** Article reads (all traffic) counted so far in the window. */
  totalReads: number;
  /** The subset from sessions GA attributes to our push UTM. */
  pushReads: number;
  byCategory: { label: string; reads: number }[];
  topArticles: { title: string; reads: number; pushReads: number }[];
  /** Only with READS_SOURCE=cms: the source note for the email ("Reads: CMS from 29 Sep, GA4 before"). */
  sourceNote?: string;
};

/**
 * JS twin of ARTICLE_PATH_RE (which is a GA API filter string). Exported
 * because the Surfaces report needs the identical test: its rows are screened
 * by host only, so the homepage and section pages reach the table and would be
 * classified as if they were stories. Two copies of this would silently drift
 * the day taxscan's URL format changes.
 */
export const ARTICLE_PATH_JS_RE = /-\d{5,}$/;

/**
 * Readable pseudo-title from an article slug — used to classify paths whose
 * article we never captured, and as the display fallback when no campaign
 * title matches. The category regexes are case-insensitive, so slug text
 * ("gst"/"itat"/"income tax") classifies the same as a real headline.
 */
export function titleFromPath(p: string): string {
  const slug = (p.split('/').filter(Boolean).pop() ?? '').replace(/-\d+$/, '');
  const text = slug.replace(/-/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Reads during [start, end) for the coverage-report email, from ArticleReadStat
 * only (never GA at send time). Counts article pages only (slug ends in the
 * numeric id); categories are classified from the campaign-independent slug so
 * every read counts even when we never captured the article. Returns null when
 * the window has no read data at all (e.g. before tracking started).
 */
export async function readsSummaryForWindow(opts: {
  start: Date;
  end: Date; // exclusive, like reportWindow()
  portal?: string;
  topN?: number;
}): Promise<ReadsEmailSummary | null> {
  const portal = opts.portal ?? env.rss.portal;
  const topN = opts.topN ?? 10;
  // The one reads module: GA for dates before READS_CMS_FROM (all dates with READS_SOURCE=ga), the CMS from it.
  // ArticleReadStat.date is the UTC-midnight key of the GA (IST) calendar day; the report window is IST
  // midnights — compare by day key.
  const win = await readsWindowByPath(istDateKey(opts.start), istDateKey(opts.end), { portal });

  // Keep article pages only: GA's rows are every page of the site (a story's slug ends in its numeric id), while a CMS
  // row IS an article — and a story born on the new CMS has no numeric id in its URL.
  const byPath = new Map<string, { reads: number; pushReads: number }>();
  let usedGa = false;
  let usedCms = false;
  for (const [path, e] of win) {
    if (!e.usedCms && !ARTICLE_PATH_JS_RE.test(path)) continue;
    byPath.set(path, { reads: e.views, pushReads: e.pushViews ?? 0 });
    usedGa ||= e.usedGa;
    usedCms ||= e.usedCms;
  }
  if (byPath.size === 0) return null;

  let totalReads = 0;
  let pushReads = 0;
  const cat = new Map<string, number>();
  for (const [path, e] of byPath) {
    totalReads += e.reads;
    pushReads += e.pushReads;
    // Same row keys as the coverage heatmaps (Uncategorized splits into Other
    // News / Articles – General). Titles here are slug-derived, so content-type
    // detection is coarser and defaults safely to News.
    const label = categoryRowKey({ title: titleFromPath(path), categories: [] });
    cat.set(label, (cat.get(label) ?? 0) + e.reads);
  }
  const byCategory = [...cat.entries()]
    .map(([label, reads]) => ({ label, reads }))
    .sort((a, b) => b.reads - a.reads);

  const top = [...byPath.entries()].sort((a, b) => b[1].reads - a[1].reads).slice(0, topN);
  // Real headlines where we captured the article; slug-derived text otherwise.
  const campaigns = top.length
    ? await prisma.campaign.findMany({
        where: { OR: top.map(([path]) => ({ url: { contains: path } })) },
        select: { url: true, title: true },
      })
    : [];
  const titleByPath = new Map<string, string>();
  for (const c of campaigns) {
    try {
      titleByPath.set(new URL(c.url).pathname.replace(/\/+$/, ''), c.title);
    } catch {
      /* unparseable stored URL — fall back to the slug title */
    }
  }
  const topArticles = top.map(([path, e]) => ({
    title: titleByPath.get(path) ?? titleFromPath(path),
    reads: e.reads,
    pushReads: e.pushReads,
  }));

  return {
    totalReads,
    pushReads,
    byCategory,
    topArticles,
    ...(env.cmsViews.source === 'cms' ? { sourceNote: readsSourceNote('cms', { ga: usedGa, cms: usedCms }) } : {}),
  };
}

const STALE_MS = 12 * 60 * 60 * 1000;

let started = false;

export function startReadsReportCron(): void {
  if (!readsEnabled()) {
    // eslint-disable-next-line no-console
    console.log('[reads-report] disabled (set GA_READS_ENABLED=true to start)');
    return;
  }
  // GA credentials are required for the GA build; with READS_SOURCE=cms they only add the pre-cut-over days.
  if (!loadGaCredentials() && env.cmsViews.source !== 'cms') {
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
      console.error('[reads-report] build failed (last build keeps serving)', safeErrorLog(e, { stack: true }));
    }
  };

  cron.schedule(env.gaReads.reportCron, () => void run(), { timezone: env.rss.tz });
  // Boot pass only when the cache is missing or older than half a day, so
  // routine redeploys don't re-query GA every time.
  setTimeout(() => {
    void (async () => {
      const row = await getReadsReport(env.rss.portal).catch(() => null);
      // Also rebuild when the cached build is of the OTHER source (READS_SOURCE was flipped).
      const cachedMode = (row?.payload as ReadsPayload | undefined)?.source?.mode ?? 'ga';
      if (!row || Date.now() - row.generatedAt.getTime() > STALE_MS || cachedMode !== env.cmsViews.source) await run();
    })();
  }, 30_000).unref();
  // eslint-disable-next-line no-console
  console.log(`[reads-report] scheduled cron="${env.gaReads.reportCron}" tz=${env.rss.tz}`);
}
