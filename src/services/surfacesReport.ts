import { prisma } from '../lib/prisma';
import { benchRank, benchRowKey, categoryRowKey, istDateKey } from './reports';
import { ARTICLE_PATH_JS_RE, READ_WINDOWS, titleFromPath } from './readsReport';
import { readsPath } from './metrics';
import { SURFACES } from './searchSurfaces';

/**
 * The "Surfaces" report: which articles Google Discover and Google News picked
 * up, by category and by bench, over the SAME trailing windows the Reads tab
 * uses (1 week / 1 / 3 / 6 / 12 months) so the two screens line up column for
 * column, and a top most-surfaced list per surface.
 *
 * CLICKS AND IMPRESSIONS, NEVER PAGEVIEWS. Nothing here is comparable with
 * ArticleReadStat.totalViews ("Reads") and the two must never be summed or put
 * in one cell — a Discover click is a tap on a card in a feed, a read is a
 * pageview. Clicks are the headline number; impressions are context.
 *
 * Unlike the Reads report — which had to be built into a cache row because its
 * source was a remote API — this aggregates ArticleSurfaceStat, already mirrored
 * into Postgres by the flag-gated cron in searchSurfaces.ts. So the invariant
 * "the request path NEVER calls Google" holds for free, and all that is needed
 * is the short-TTL cache the other report routes use.
 *
 * Two properties of Search Console shape the presentation and are not
 * negotiable: it settles 2-3 days late and returns NO rows at all (not partial
 * ones) for the newest days, and its calendar day is Google's property
 * timezone, not IST. A window ending "today" therefore always looks like a
 * collapse in pickup unless the reader is told how fresh the data really is —
 * hence `dataThrough`, and hence trailing windows only, never day-by-day.
 */

export type SurfaceKey = 'DISCOVER' | 'GOOGLE_NEWS';

/** null = this row had no pickup in this window (distinct from a synced zero). */
export type SurfaceCell = { clicks: number; impressions: number; articles: number } | null;

export type SurfaceRow = { label: string; cells: SurfaceCell[] };

export type SurfaceGrid = { surface: SurfaceKey; rows: SurfaceRow[] };

export type SurfaceTotals = { clicks: number; impressions: number; articles: number };

export type TopSurfacedArticle = {
  pagePath: string;
  title: string;
  clicks: number;
  impressions: number;
};

export type SurfacesPayload = {
  windows: { label: string; days: number; totals: Record<SurfaceKey, SurfaceTotals> }[];
  byCategory: SurfaceGrid[];
  byBench: SurfaceGrid[];
  topArticles: Record<SurfaceKey, TopSurfacedArticle[]>;
  /** IST day key of the most recent day carrying any synced row; null if none. */
  dataThrough: string | null;
  /**
   * IST day key of the EARLIEST synced day. The sync only fetches a rolling
   * lookback window, so on a fresh install the table holds days, not months —
   * and a column headed "12 months" would then be showing a week's data under a
   * year's label. The panel uses this to say how much history actually exists.
   */
  dataFrom: string | null;
};

// ARTICLE_PATH_JS_RE (imported above) keeps non-article rows out: the sync
// screens the HOST only, so the homepage and section pages do reach
// ArticleSurfaceStat and would otherwise be classified as if they were stories.

/** Top most-surfaced articles listed per surface. */
const TOP_N = 10;

/** The window the top list is drawn over — recent enough to act on. */
const TOP_WINDOW_DAYS = 30;

const emptyTotals = (): Record<SurfaceKey, SurfaceTotals> => ({
  DISCOVER: { clicks: 0, impressions: 0, articles: 0 },
  GOOGLE_NEWS: { clicks: 0, impressions: 0, articles: 0 },
});

type Cellish = { clicks: number; impressions: number; articles: number };
type Agg = Map<string, Cellish[]>;

function bump(agg: Agg, label: string, wi: number, clicks: number, impressions: number): void {
  let arr = agg.get(label);
  if (!arr) {
    arr = READ_WINDOWS.map(() => ({ clicks: 0, impressions: 0, articles: 0 }));
    agg.set(label, arr);
  }
  arr[wi].clicks += clicks;
  arr[wi].impressions += impressions;
  // One bump per distinct article path per window, so "articles" is a count of
  // pages that surfaced in that window — never a sum across windows.
  arr[wi].articles += 1;
}

const toRows = (agg: Agg): SurfaceRow[] =>
  [...agg.entries()].map(([label, arr]) => ({
    label,
    cells: arr.map((c) =>
      // Emptiness is decided on whether any row existed at all, NOT on clicks:
      // a page Google showed but nobody tapped is a real finding and must
      // render as a zero, not vanish into an em-dash.
      c.articles === 0 ? null : { clicks: c.clicks, impressions: c.impressions, articles: c.articles },
    ),
  }));

/**
 * Build the payload from Postgres. `dataThrough === null` means nothing has
 * ever been synced for the portal — the route turns that into `ready:false`,
 * which is the normal state for the first 2-3 days after enabling the flag.
 */
export async function buildSurfacesReport(opts: {
  portal: string;
  now?: Date;
}): Promise<SurfacesPayload> {
  const { portal } = opts;
  const now = opts.now ?? new Date();

  const [latest, earliest] = await Promise.all([
    prisma.articleSurfaceStat.findFirst({
      where: { portal },
      orderBy: { date: 'desc' },
      select: { date: true },
    }),
    prisma.articleSurfaceStat.findFirst({
      where: { portal },
      orderBy: { date: 'asc' },
      select: { date: true },
    }),
  ]);
  const empty: SurfacesPayload = {
    windows: READ_WINDOWS.map((w) => ({ label: w.label, days: w.days, totals: emptyTotals() })),
    byCategory: SURFACES.map(({ surface }) => ({ surface, rows: [] })),
    byBench: SURFACES.map(({ surface }) => ({ surface, rows: [] })),
    topArticles: { DISCOVER: [], GOOGLE_NEWS: [] },
    dataThrough: null,
    dataFrom: null,
  };
  if (!latest || !earliest) return empty;

  // ArticleSurfaceStat.date is the UTC-midnight key of a calendar day (Google's
  // property timezone). An IST midnight instant is 18:30 UTC of the PREVIOUS
  // day, so comparing raw instants shifts every window by one day — convert
  // through the IST day key first, exactly as readsSummaryForWindow does.
  const end = new Date(istDateKey(now));

  const byCategory: Record<SurfaceKey, Agg> = { DISCOVER: new Map(), GOOGLE_NEWS: new Map() };
  const byBench: Record<SurfaceKey, Agg> = { DISCOVER: new Map(), GOOGLE_NEWS: new Map() };
  const windows: SurfacesPayload['windows'] = [];
  let topByPath: Record<SurfaceKey, Map<string, SurfaceTotals>> | null = null;

  // Slug → row labels, memoised because the same path is classified once per
  // window. ArticleSurfaceStat has no title column, so classification runs on
  // the slug-derived pseudo-title with `categories: []` — the coverage report's
  // title rules as the only signal, which is what makes these rows identical to
  // the ones on the coverage and Reads tabs.
  const labelCache = new Map<string, { category: string; bench: string }>();
  const labelsFor = (path: string) => {
    let l = labelCache.get(path);
    if (!l) {
      const title = titleFromPath(path);
      l = { category: categoryRowKey({ title, categories: [] }), bench: benchRowKey(title) };
      labelCache.set(path, l);
    }
    return l;
  };

  for (let wi = 0; wi < READ_WINDOWS.length; wi += 1) {
    const w = READ_WINDOWS[wi];
    const start = new Date(istDateKey(new Date(now.getTime() - w.days * 86_400_000)));

    // Grouping BY surface as well as path is mandatory: the unique key is
    // [portal, pagePath, date, surface], so one article-day yields two rows and
    // a bare groupBy(['pagePath']) would silently merge Discover into News.
    const grouped = await prisma.articleSurfaceStat.groupBy({
      by: ['pagePath', 'surface'],
      where: { portal, date: { gte: start, lte: end } },
      _sum: { clicks: true, impressions: true },
    });

    const folded: Record<SurfaceKey, Map<string, SurfaceTotals>> = {
      DISCOVER: new Map(),
      GOOGLE_NEWS: new Map(),
    };
    for (const g of grouped) {
      const path = g.pagePath.replace(/\/+$/, '');
      if (!ARTICLE_PATH_JS_RE.test(path)) continue;
      const m = folded[g.surface as SurfaceKey];
      const e = m.get(path) ?? { clicks: 0, impressions: 0, articles: 1 };
      e.clicks += g._sum.clicks ?? 0;
      e.impressions += g._sum.impressions ?? 0;
      m.set(path, e);
    }

    const totals = emptyTotals();
    for (const { surface } of SURFACES) {
      for (const [path, e] of folded[surface]) {
        totals[surface].clicks += e.clicks;
        totals[surface].impressions += e.impressions;
        totals[surface].articles += 1;
        const l = labelsFor(path);
        bump(byCategory[surface], l.category, wi, e.clicks, e.impressions);
        bump(byBench[surface], l.bench, wi, e.clicks, e.impressions);
      }
    }
    windows.push({ label: w.label, days: w.days, totals });
    if (w.days === TOP_WINDOW_DAYS) topByPath = folded;
  }

  // Categories by widest-window clicks so row order stays put as the reader
  // scans the narrower columns; benches by the coverage report's judicial
  // hierarchy, never by volume.
  const last = READ_WINDOWS.length - 1;
  const grids = (agg: Record<SurfaceKey, Agg>, sort: (a: SurfaceRow, b: SurfaceRow) => number): SurfaceGrid[] =>
    SURFACES.map(({ surface }) => ({ surface, rows: toRows(agg[surface]).sort(sort) }));

  const payload: SurfacesPayload = {
    windows,
    byCategory: grids(byCategory, (a, b) => (b.cells[last]?.clicks ?? 0) - (a.cells[last]?.clicks ?? 0)),
    byBench: grids(byBench, (a, b) => benchRank(a.label) - benchRank(b.label)),
    topArticles: await topSurfacedArticles(topByPath),
    dataThrough: istDateKey(latest.date),
    dataFrom: istDateKey(earliest.date),
  };
  return payload;
}

/**
 * Top articles per surface, with the real headline where we captured the
 * article and the slug-derived text otherwise — the same resolution
 * readsSummaryForWindow does, and only for the shortlist (the campaign lookup
 * is one OR clause per path).
 *
 * Google attributes to the CANONICAL url, so a story the desk published twice
 * can legitimately appear as two near-identical rows. That is not a bug and is
 * deliberately NOT deduped by title: the split itself is the finding.
 */
async function topSurfacedArticles(
  byPath: Record<SurfaceKey, Map<string, SurfaceTotals>> | null,
): Promise<Record<SurfaceKey, TopSurfacedArticle[]>> {
  const out: Record<SurfaceKey, TopSurfacedArticle[]> = { DISCOVER: [], GOOGLE_NEWS: [] };
  if (!byPath) return out;

  const shortlist: Record<SurfaceKey, [string, SurfaceTotals][]> = {
    DISCOVER: [],
    GOOGLE_NEWS: [],
  };
  const paths = new Set<string>();
  for (const { surface } of SURFACES) {
    shortlist[surface] = [...byPath[surface].entries()]
      .sort((a, b) => b[1].clicks - a[1].clicks || b[1].impressions - a[1].impressions || a[0].localeCompare(b[0]))
      .slice(0, TOP_N);
    for (const [path] of shortlist[surface]) paths.add(path);
  }
  if (paths.size === 0) return out;

  const campaigns = await prisma.campaign.findMany({
    where: { OR: [...paths].map((path) => ({ url: { contains: path } })) },
    select: { url: true, title: true },
  });
  const titleByPath = new Map<string, string>();
  for (const c of campaigns) {
    // readsPath, not a hand-rolled parse, so the stored URL folds onto the same
    // key searchSurfaces wrote (and storefront links drop out).
    const p = readsPath(c.url);
    if (p) titleByPath.set(p, c.title);
  }

  for (const { surface } of SURFACES) {
    out[surface] = shortlist[surface].map(([pagePath, e]) => ({
      pagePath,
      title: titleByPath.get(pagePath) ?? titleFromPath(pagePath),
      clicks: e.clicks,
      impressions: e.impressions,
    }));
  }
  return out;
}

// The Reports screen re-fetches on open and on every "Refresh" click, and one
// build scans up to 365 days of ArticleSurfaceStat across five windows — the
// same reason the coverage report is cached. Deliberately a local twin of
// getReport's cache rather than a widening of it: that one is typed to Report
// and keyed on ReportPeriod.
let surfacesCache: Record<string, { at: number; data: SurfacesPayload }> = {};

function defaultSurfacesTtlMs(): number {
  const raw = process.env.REPORTS_CACHE_TTL_MS;
  if (raw !== undefined && raw !== '') return Number(raw);
  return process.env.NODE_ENV === 'test' ? 0 : 60_000;
}

/** Test hook — clears the in-process surfaces cache. */
export function __resetSurfacesCache(): void {
  surfacesCache = {};
}

/**
 * Cached wrapper around buildSurfacesReport. Keyed by portal + the IST day the
 * windows are measured back from, so the entry rolls over with the day instead
 * of serving yesterday's window boundaries.
 */
export async function getSurfacesReport(
  portal: string,
  cfg: { ttlMs?: number; now?: Date } = {},
): Promise<SurfacesPayload> {
  const now = cfg.now ?? new Date();
  const ttlMs = cfg.ttlMs ?? defaultSurfacesTtlMs();
  if (ttlMs <= 0) return buildSurfacesReport({ portal, now });

  const t = now.getTime();
  const key = `${portal}:${istDateKey(now)}`;
  const hit = surfacesCache[key];
  if (hit && t - hit.at < ttlMs) return hit.data;

  const data = await buildSurfacesReport({ portal, now });
  for (const k of Object.keys(surfacesCache)) {
    if (t - surfacesCache[k].at >= ttlMs) delete surfacesCache[k];
  }
  surfacesCache[key] = { at: t, data };
  return data;
}
