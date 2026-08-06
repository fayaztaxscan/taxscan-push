import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { benchRank, benchRowKey, categoryRowKey, istDateKey } from './reports';
import { ARTICLE_PATH_JS_RE, titleFromPath } from './readsReport';
import { readsPath } from './metrics';
import { SURFACES } from './searchSurfaces';

/**
 * The "Surfaces" report: which articles Google Discover and Google News picked
 * up, by category and by bench, plus a top most-picked-up list per surface.
 *
 * CLICKS AND IMPRESSIONS, NEVER PAGEVIEWS. Nothing here is comparable with
 * ArticleReadStat.totalViews ("Reads") and the two must never be summed or put
 * in one cell — a Discover click is a tap on a card in a feed, a read is a
 * pageview. Clicks are the headline number; impressions are context.
 *
 * TIME AXIS (changed 2026-08-06 on stakeholder request): columns are CALENDAR
 * MONTHS, not trailing windows. Trailing windows answered "how are we doing
 * lately"; months answer "is this rising or falling", which is the question
 * actually being asked of this data — and taxscan's Discover pickup fell ~85%
 * across the first seven months of 2026, a trend that cumulative trailing
 * windows structurally hide (every window contains the same recent days, so
 * they all move together and none isolates a month).
 *
 * A custom `range` mode answers the ad-hoc question instead: one column for the
 * chosen span and one for the equally-long span immediately before it, the same
 * comparison model the coverage report's Custom tab uses.
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
 * timezone, not IST. The current month is therefore always incomplete — flagged
 * `partial` so the UI can say so rather than let it read as a collapse.
 */

export type SurfaceKey = 'DISCOVER' | 'GOOGLE_NEWS';

/** null = this row had no pickup in this column (distinct from a synced zero). */
export type SurfaceCell = { clicks: number; impressions: number; articles: number } | null;

export type SurfaceRow = { label: string; cells: SurfaceCell[] };

export type SurfaceGrid = { surface: SurfaceKey; rows: SurfaceRow[] };

export type SurfaceTotals = { clicks: number; impressions: number; articles: number };

/**
 * One column of every grid. `key` is the aggregation bucket ('2026-01' in months
 * mode, 'current'/'previous' in range mode); `partial` marks a column Google has
 * not finished reporting, which is ALWAYS true of the current month.
 */
export type SurfaceColumn = {
  key: string;
  label: string;
  from: string;
  to: string;
  partial: boolean;
};

export type TopSurfacedArticle = {
  pagePath: string;
  title: string;
  clicks: number;
  impressions: number;
};

export type SurfacesMode = 'months' | 'range';

export type SurfacesPayload = {
  mode: SurfacesMode;
  columns: SurfaceColumn[];
  /**
   * Which two columns every "vs previous" figure compares, as indices into
   * `columns`. Stated here rather than left for the client to infer, because
   * the two modes order their columns differently — months run oldest-first and
   * end on a still-filling current month, while a range puts its subject FIRST
   * and its predecessor second. Inferring "newest is last" silently inverts
   * every delta in range mode, which reads as a rise when the truth is a fall.
   * `base` is -1 when there is nothing to compare against.
   */
  compare: { current: number; base: number };
  /** Per-column totals per surface, aligned to `columns`. */
  totals: Record<SurfaceKey, SurfaceTotals>[];
  byCategory: SurfaceGrid[];
  byBench: SurfaceGrid[];
  topArticles: Record<SurfaceKey, TopSurfacedArticle[]>;
  /** The span the top-articles lists cover — never assume it matches a column. */
  topWindow: { from: string; to: string; label: string };
  /** IST day key of the most recent day carrying any synced row; null if none. */
  dataThrough: string | null;
  /**
   * IST day key of the EARLIEST synced day. The live sync only fetches a rolling
   * lookback window, so without a backfill the table holds days, not months. The
   * panel uses this to say how much history actually exists.
   */
  dataFrom: string | null;
};

// ARTICLE_PATH_JS_RE (imported above) keeps non-article rows out: the sync
// screens the HOST only, so the homepage and section pages do reach
// ArticleSurfaceStat and would otherwise be classified as if they were stories.

/** Top most-surfaced articles listed per surface. */
const TOP_N = 10;

/** The window the top list is drawn over in months mode — recent enough to act on. */
const TOP_WINDOW_DAYS = 30;

/**
 * Widest the month grid gets before it starts scrolling off the point. At 18 the
 * newest month and the same month a year earlier are both on screen, which is
 * the seasonality comparison; beyond that the columns are too narrow to read.
 * Older months stay queryable through the custom range.
 */
export const MAX_MONTH_COLUMNS = 18;

/** Longest custom range: Search Console retains 16 months, so more cannot exist. */
export const MAX_SURFACES_RANGE_DAYS = 400;

const DAY_MS = 86_400_000;
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_LABELS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

const emptyTotals = (): Record<SurfaceKey, SurfaceTotals> => ({
  DISCOVER: { clicks: 0, impressions: 0, articles: 0 },
  GOOGLE_NEWS: { clicks: 0, impressions: 0, articles: 0 },
});

/** UTC-midnight Date for a day key — matches how ArticleSurfaceStat.date is stored. */
function dayStart(key: string): Date {
  return new Date(`${key}T00:00:00.000Z`);
}

function addDays(key: string, days: number): string {
  return new Date(dayStart(key).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((dayStart(to).getTime() - dayStart(from).getTime()) / DAY_MS) + 1;
}

/** Human range label: "1 Apr – 30 Jun 2026" (year dropped when both ends share it). */
export function rangeLabel(from: string, to: string): string {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const left = `${fd} ${MONTH_LABELS[fm - 1]}${fy === ty ? '' : ` ${fy}`}`;
  return `${left} – ${td} ${MONTH_LABELS[tm - 1]} ${ty}`;
}

/**
 * Calendar-month columns from the earliest synced month to the month containing
 * `now`, newest last and capped at MAX_MONTH_COLUMNS. A month is `partial` when
 * Google has not reported through its final day — always true of the current
 * month, and true of the newest month generally, since the data settles 2-3 days
 * late.
 */
export function monthColumns(dataFrom: string, dataThrough: string, now: Date): SurfaceColumn[] {
  const [fy, fm] = dataFrom.split('-').map(Number);
  const nowKey = istDateKey(now);
  const [ny, nm] = nowKey.split('-').map(Number);

  const all: SurfaceColumn[] = [];
  for (let y = fy, m = fm; y < ny || (y === ny && m <= nm); ) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    const from = `${key}-01`;
    const to = new Date(Date.UTC(y, m, 1) - DAY_MS).toISOString().slice(0, 10);
    all.push({
      key,
      label: `${MONTH_LABELS[m - 1]} ${y}`,
      from,
      to,
      // Clipped by how far Google has actually reported, not by the calendar.
      partial: to > dataThrough,
    });
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return all.slice(-MAX_MONTH_COLUMNS);
}

/**
 * The two columns of range mode: the chosen span, and the equally-long span
 * immediately before it. Throws with a human-readable message (surfaced as the
 * API's 400 body) when the range is malformed, reversed, in the future or longer
 * than MAX_SURFACES_RANGE_DAYS.
 */
export function customSurfacesWindow(from: string, to: string, now: Date = new Date()): SurfaceColumn[] {
  if (!DAY_KEY_RE.test(from) || !DAY_KEY_RE.test(to)) {
    throw new Error('Dates must be in YYYY-MM-DD format.');
  }
  if (Number.isNaN(dayStart(from).getTime()) || Number.isNaN(dayStart(to).getTime())) {
    throw new Error('That date does not exist on the calendar.');
  }
  // Round-trip to reject non-existent calendar dates (e.g. 2026-02-31), which
  // Date rolls over rather than refusing.
  if (dayStart(from).toISOString().slice(0, 10) !== from || dayStart(to).toISOString().slice(0, 10) !== to) {
    throw new Error('That date does not exist on the calendar.');
  }
  if (to < from) throw new Error('"From" must be on or before "To".');
  if (from > istDateKey(now)) throw new Error('The range cannot start in the future.');
  const days = daysBetween(from, to);
  if (days > MAX_SURFACES_RANGE_DAYS) {
    throw new Error(
      `The range is limited to ${MAX_SURFACES_RANGE_DAYS} days — this one spans ${days}.`,
    );
  }
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(prevTo, -(days - 1));
  return [
    { key: 'current', label: rangeLabel(from, to), from, to, partial: to >= istDateKey(now) },
    { key: 'previous', label: `Previous ${days} days`, from: prevFrom, to: prevTo, partial: false },
  ];
}

/**
 * The comparison pair for a set of columns. Months: the last COMPLETE month
 * against the one before it — comparing into the part-month that Google is
 * still filling would report a collapse every time. Range: the chosen span
 * (index 0) against its predecessor (index 1).
 */
export function comparePair(columns: SurfaceColumn[], mode: SurfacesMode): { current: number; base: number } {
  if (columns.length === 0) return { current: -1, base: -1 };
  if (mode === 'range') return { current: 0, base: columns.length > 1 ? 1 : -1 };
  const last = columns.length - 1;
  const current = columns[last].partial && last > 0 ? last - 1 : last;
  return { current, base: current - 1 };
}

type Cellish = { clicks: number; impressions: number; articles: number };
type Agg = Map<string, Cellish[]>;

function bump(agg: Agg, label: string, ci: number, columns: number, clicks: number, impressions: number): void {
  let arr = agg.get(label);
  if (!arr) {
    arr = Array.from({ length: columns }, () => ({ clicks: 0, impressions: 0, articles: 0 }));
    agg.set(label, arr);
  }
  arr[ci].clicks += clicks;
  arr[ci].impressions += impressions;
  // One bump per distinct article path per column, so "articles" is a count of
  // pages that surfaced in that column — never a sum across columns.
  arr[ci].articles += 1;
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

/** One grouped row as the SQL below returns it. */
type GroupedRow = {
  pagePath: string;
  surface: string;
  bucket: string;
  clicks: number;
  impressions: number;
};

/**
 * Grouped clicks/impressions per (article, surface, bucket).
 *
 * One raw query rather than a groupBy per column: months mode can ask for 18
 * columns, and 18 round-trips to aggregate the same table is the kind of thing
 * that turns a 200 ms screen into a 3-second one. `bucketSql` decides what a
 * bucket IS — the calendar month, or which side of a range boundary a day falls.
 *
 * Grouping BY surface as well as path is mandatory: the unique key is
 * [portal, pagePath, date, surface], so one article-day yields two rows and a
 * bare group by path would silently merge Discover into News.
 */
async function groupedRows(
  portal: string,
  from: string,
  to: string,
  bucketSql: Prisma.Sql,
): Promise<GroupedRow[]> {
  return prisma.$queryRaw<GroupedRow[]>`
    SELECT "pagePath",
           "surface"::text AS surface,
           ${bucketSql} AS bucket,
           SUM("clicks")::int AS clicks,
           SUM("impressions")::int AS impressions
    FROM "ArticleSurfaceStat"
    WHERE "portal" = ${portal}
      AND "date" >= ${from}::date
      AND "date" <= ${to}::date
    GROUP BY 1, 2, 3
  `;
}

/**
 * Build the payload from Postgres. `dataThrough === null` means nothing has ever
 * been synced for the portal — the route turns that into `ready:false`.
 */
export async function buildSurfacesReport(opts: {
  portal: string;
  now?: Date;
  /** Custom range [from, to] (IST day keys). Omit for the default months view. */
  range?: { from: string; to: string };
}): Promise<SurfacesPayload> {
  const { portal } = opts;
  const now = opts.now ?? new Date();

  const [latest, earliest] = await Promise.all([
    prisma.articleSurfaceStat.findFirst({ where: { portal }, orderBy: { date: 'desc' }, select: { date: true } }),
    prisma.articleSurfaceStat.findFirst({ where: { portal }, orderBy: { date: 'asc' }, select: { date: true } }),
  ]);
  const mode: SurfacesMode = opts.range ? 'range' : 'months';
  if (!latest || !earliest) {
    return {
      mode,
      columns: [],
      compare: { current: -1, base: -1 },
      totals: [],
      byCategory: SURFACES.map(({ surface }) => ({ surface, rows: [] })),
      byBench: SURFACES.map(({ surface }) => ({ surface, rows: [] })),
      topArticles: { DISCOVER: [], GOOGLE_NEWS: [] },
      topWindow: { from: istDateKey(now), to: istDateKey(now), label: '' },
      dataThrough: null,
      dataFrom: null,
    };
  }

  // ArticleSurfaceStat.date is the UTC-midnight key of a calendar day (Google's
  // property timezone). Everything below works in day KEYS rather than instants:
  // an IST midnight is 18:30 UTC of the previous day, so comparing raw instants
  // shifts every boundary by a day.
  const dataFrom = istDateKey(earliest.date);
  const dataThrough = istDateKey(latest.date);

  const columns = opts.range
    ? customSurfacesWindow(opts.range.from, opts.range.to, now)
    : monthColumns(dataFrom, dataThrough, now);

  // Span the WHOLE set of columns, min-from to max-to. Months run oldest-first
  // so the ends would do, but range mode puts `current` first and `previous`
  // second — taking first.from → last.to there yields a backwards span that
  // silently matches no rows and renders an empty grid.
  const queryFrom = columns.reduce((min, c) => (c.from < min ? c.from : min), columns[0]?.from ?? dataFrom);
  const queryTo = columns.reduce((max, c) => (c.to > max ? c.to : max), columns[0]?.to ?? dataThrough);
  const bucketSql = opts.range
    ? Prisma.sql`CASE WHEN "date" >= ${columns[0].from}::date THEN 'current' ELSE 'previous' END`
    : Prisma.sql`to_char("date", 'YYYY-MM')`;

  // The top list covers the trailing 30 days in months mode (the actionable
  // "what is working now"), or the chosen span in range mode. Deliberately its
  // own window: it must not silently become "the current month so far", which
  // on the 2nd of a month is two days of data under a month's heading.
  const topTo = opts.range ? columns[0].to : dataThrough;
  const topFrom = opts.range ? columns[0].from : addDays(topTo, -(TOP_WINDOW_DAYS - 1));

  const [rows, topRows] = await Promise.all([
    groupedRows(portal, queryFrom, queryTo, bucketSql),
    groupedRows(portal, topFrom, topTo, Prisma.sql`'top'`),
  ]);

  const colIndex = new Map(columns.map((c, i) => [c.key, i]));
  const byCategory: Record<SurfaceKey, Agg> = { DISCOVER: new Map(), GOOGLE_NEWS: new Map() };
  const byBench: Record<SurfaceKey, Agg> = { DISCOVER: new Map(), GOOGLE_NEWS: new Map() };
  const totals = columns.map(() => emptyTotals());

  // Slug → row labels, memoised because the same path recurs in every column.
  // ArticleSurfaceStat has no title column, so classification runs on the
  // slug-derived pseudo-title with `categories: []` — the coverage report's
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

  for (const r of rows) {
    const path = r.pagePath.replace(/\/+$/, '');
    if (!ARTICLE_PATH_JS_RE.test(path)) continue;
    const ci = colIndex.get(r.bucket);
    if (ci === undefined) continue;
    const surface = r.surface as SurfaceKey;
    if (!totals[ci][surface]) continue;
    totals[ci][surface].clicks += r.clicks;
    totals[ci][surface].impressions += r.impressions;
    totals[ci][surface].articles += 1;
    const l = labelsFor(path);
    bump(byCategory[surface], l.category, ci, columns.length, r.clicks, r.impressions);
    bump(byBench[surface], l.bench, ci, columns.length, r.clicks, r.impressions);
  }

  // Categories by total clicks across the shown columns, so row order stays put
  // as the reader scans across (sorting on the newest column would reshuffle the
  // grid every month, and that column is the partial one). Benches keep the
  // coverage report's judicial hierarchy, never volume.
  const sumCells = (r: SurfaceRow): number => r.cells.reduce((n, c) => n + (c?.clicks ?? 0), 0);
  const grids = (agg: Record<SurfaceKey, Agg>, sort: (a: SurfaceRow, b: SurfaceRow) => number): SurfaceGrid[] =>
    SURFACES.map(({ surface }) => ({ surface, rows: toRows(agg[surface]).sort(sort) }));

  return {
    mode,
    columns,
    compare: comparePair(columns, mode),
    totals,
    byCategory: grids(byCategory, (a, b) => sumCells(b) - sumCells(a) || a.label.localeCompare(b.label)),
    byBench: grids(byBench, (a, b) => benchRank(a.label) - benchRank(b.label)),
    topArticles: await topSurfacedArticles(topRows),
    topWindow: {
      from: topFrom,
      to: topTo,
      label: opts.range ? rangeLabel(topFrom, topTo) : `last ${TOP_WINDOW_DAYS} days`,
    },
    dataThrough,
    dataFrom,
  };
}

/**
 * Top articles per surface, with the real headline where we captured the article
 * and the slug-derived text otherwise — the same resolution readsSummaryForWindow
 * does, and only for the shortlist (the campaign lookup is one OR clause per path).
 *
 * Google attributes to the CANONICAL url, so a story the desk published twice can
 * legitimately appear as two near-identical rows. That is not a bug and is
 * deliberately NOT deduped by title: the split itself is the finding.
 */
async function topSurfacedArticles(
  rows: GroupedRow[],
): Promise<Record<SurfaceKey, TopSurfacedArticle[]>> {
  const out: Record<SurfaceKey, TopSurfacedArticle[]> = { DISCOVER: [], GOOGLE_NEWS: [] };
  const byPath: Record<SurfaceKey, Map<string, SurfaceTotals>> = {
    DISCOVER: new Map(),
    GOOGLE_NEWS: new Map(),
  };
  for (const r of rows) {
    const path = r.pagePath.replace(/\/+$/, '');
    if (!ARTICLE_PATH_JS_RE.test(path)) continue;
    const m = byPath[r.surface as SurfaceKey];
    if (!m) continue;
    const e = m.get(path) ?? { clicks: 0, impressions: 0, articles: 1 };
    e.clicks += r.clicks;
    e.impressions += r.impressions;
    m.set(path, e);
  }

  const shortlist: Record<SurfaceKey, [string, SurfaceTotals][]> = { DISCOVER: [], GOOGLE_NEWS: [] };
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
// build scans up to 18 months of ArticleSurfaceStat — the same reason the
// coverage report is cached. Deliberately a local twin of getReport's cache
// rather than a widening of it: that one is typed to Report and keyed on
// ReportPeriod.
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
 * Cached wrapper around buildSurfacesReport. Keyed by portal + mode/range + the
 * IST day the columns are measured from, so the entry rolls over with the day
 * instead of serving yesterday's boundaries, and each custom range caches
 * separately.
 */
export async function getSurfacesReport(
  portal: string,
  cfg: { ttlMs?: number; now?: Date; range?: { from: string; to: string } } = {},
): Promise<SurfacesPayload> {
  const now = cfg.now ?? new Date();
  const ttlMs = cfg.ttlMs ?? defaultSurfacesTtlMs();
  if (ttlMs <= 0) return buildSurfacesReport({ portal, now, range: cfg.range });

  const t = now.getTime();
  const key = `${portal}:${istDateKey(now)}:${cfg.range ? `${cfg.range.from}..${cfg.range.to}` : 'months'}`;
  const hit = surfacesCache[key];
  if (hit && t - hit.at < ttlMs) return hit.data;

  const data = await buildSurfacesReport({ portal, now, range: cfg.range });
  // Custom ranges mint a new key per distinct window — drop dead entries so the
  // cache can't grow without bound over a long uptime.
  for (const k of Object.keys(surfacesCache)) {
    if (t - surfacesCache[k].at >= ttlMs) delete surfacesCache[k];
  }
  surfacesCache[key] = { at: t, data };
  return data;
}
