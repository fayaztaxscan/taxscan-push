import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { env } from '../lib/env';

/**
 * THE reads implementation (brief 2026-10-29-cms-reads): every screen, report, email and ranking that shows or
 * uses "reads" calls this module, so no screen mixes sources ad hoc. Postgres only: GA is mirrored into
 * `ArticleReadStat` and the CMS's Feed 2 into `CmsArticleView` by crons; nothing here (and nothing on a request
 * path) calls Google or the CMS.
 *
 * Source rule (READS_SOURCE=cms): dates >= READS_CMS_FROM (default 2026-09-29, the first FULL day on the new CMS)
 * come from the CMS; dates before it come from GA4. READS_SOURCE=ga (the default) reads GA for every date,
 * exactly as before. Every result says which source(s) it used.
 *
 * Matching a taxscan URL to CMS rows: first by `canonicalPath` (the path of the CMS's `canonical_url`; a
 * migrated story keeps its old address, so its path is the same), then by the old trailing numeric id (the
 * `-<id>` at the end of the slug, the same rule as `articleKey()`) = the CMS's `external_id`. A URL with neither
 * has no CMS row: no data ("—"), never 0.
 *
 * Push-views: GA's are known numbers. The CMS's `push_views` is NULL before 2026-10-15 (no source was recorded
 * then): that is "unknown", not 0. A result whose CMS rows include ANY null push count has `pushViews: null`.
 */

export type ReadsMode = 'ga' | 'cms';
/** IST day keys, inclusive: `YYYY-MM-DD`. */
export type ReadsRange = { from?: string | null; to?: string | null };

export type PathReads = {
  views: number;
  /** null = unknown (a contributing CMS day has no push count). Never silently 0. */
  pushViews: number | null;
  usedGa: boolean;
  usedCms: boolean;
};

export type ReadsOpts = {
  range?: ReadsRange;
  portal?: string;
  mode?: ReadsMode;
  /** First IST day read from the CMS (default READS_CMS_FROM). */
  cmsFrom?: string;
};

const TAXSCAN_HOSTS = new Set(['taxscan.in', 'www.taxscan.in']);
/** The old CMS's numeric news id at the end of a slug: the same rule as `ARTICLE_ID` in reports.ts. */
const TRAILING_ID = /-(\d{4,})$/;

/**
 * The ArticleReadStat / CmsArticleView join key for a campaign URL: the taxscan.in path with
 * any trailing slash dropped. null for non-taxscan URLs (academy/shop) — read data only exists
 * for the taxscan.in property.
 */
export function readsPath(url: string): string | null {
  try {
    const u = new URL(url);
    if (!TAXSCAN_HOSTS.has(u.hostname.toLowerCase())) return null;
    return u.pathname.replace(/\/+$/, '') || '/';
  } catch {
    return null;
  }
}

/** The old numeric news id of a path (`/gst/some-title-1452345` → `1452345`), or null. */
export function externalIdOfPath(path: string): string | null {
  return TRAILING_ID.exec(path.replace(/\/+$/, ''))?.[1] ?? null;
}

const dayDate = (key: string) => new Date(`${key}T00:00:00Z`);
const minKey = (a: string, b: string) => (a < b ? a : b);
const maxKey = (a: string, b: string) => (a > b ? a : b);
const dayBefore = (key: string) => new Date(Date.parse(`${key}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/** The `date` filter for a source: [lo, hi] inclusive, either end optional. null = an empty range. */
function dateFilter(lo: string | null, hi: string | null): Prisma.DateTimeFilter | null | undefined {
  if (lo && hi && lo > hi) return null;
  if (!lo && !hi) return undefined;
  return { ...(lo ? { gte: dayDate(lo) } : {}), ...(hi ? { lte: dayDate(hi) } : {}) };
}

/** The part of `range` GA answers and the part the CMS answers, per source rule. */
export function splitRange(range: ReadsRange | undefined, mode: ReadsMode, cmsFrom: string): { ga: ReadsRange | null; cms: ReadsRange | null } {
  const from = range?.from ?? null;
  const to = range?.to ?? null;
  if (mode === 'ga') return { ga: { from, to }, cms: null };
  const gaTo = to ? minKey(to, dayBefore(cmsFrom)) : dayBefore(cmsFrom);
  const cmsLo = from ? maxKey(from, cmsFrom) : cmsFrom;
  return {
    ga: from && from > gaTo ? null : { from, to: gaTo },
    cms: to && to < cmsLo ? null : { from: cmsLo, to },
  };
}

/* ------------------------------------------------------------------ */
/* GA                                                                  */
/* ------------------------------------------------------------------ */

/**
 * Sum ArticleReadStat (totalViews/pushViews) per taxscan URL path. GA may
 * report the path with or without a trailing slash, so both spellings are
 * queried and folded onto the normalized key. Dates: all, unless `range` is given.
 */
export async function readsByPath(
  paths: string[],
  portal: string = env.rss.portal,
  range?: ReadsRange,
): Promise<Map<string, { reads: number; pushReads: number }>> {
  const out = new Map<string, { reads: number; pushReads: number }>();
  if (paths.length === 0) return out;
  const date = dateFilter(range?.from ?? null, range?.to ?? null);
  if (date === null) return out;
  const rows = await prisma.articleReadStat.groupBy({
    by: ['pagePath'],
    where: {
      portal,
      pagePath: { in: [...paths, ...paths.map((p) => `${p}/`)] },
      ...(date ? { date } : {}),
    },
    _sum: { totalViews: true, pushViews: true },
  });
  for (const r of rows) {
    const key = r.pagePath.replace(/\/+$/, '') || '/';
    const e = out.get(key) ?? { reads: 0, pushReads: 0 };
    e.reads += r._sum.totalViews ?? 0;
    e.pushReads += r._sum.pushViews ?? 0;
    out.set(key, e);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* CMS                                                                 */
/* ------------------------------------------------------------------ */

/** CmsArticleView sums per (canonicalPath, externalId), over a date range. Nulls are counted, not summed as 0. */
export type CmsSum = {
  canonicalPath: string;
  externalId: string | null;
  views: number;
  /** Sum of the KNOWN push counts. */
  pushViews: number;
  /** Rows whose push count is null (unknown). */
  pushUnknownRows: number;
  /** views − push − digest per row, only where BOTH are known (else the row's views), clamped ≥ 0, summed. */
  organic: number;
};

/**
 * CMS rows for these paths / ids, summed per (canonicalPath, externalId) over `range`. Index scans only:
 * (portal, canonicalPath, date) and (portal, externalId, date) joined by a bitmap OR.
 */
export async function cmsSums(paths: string[], ids: string[], portal: string, range: ReadsRange | null): Promise<CmsSum[]> {
  if (!range || (paths.length === 0 && ids.length === 0)) return [];
  const lo = range.from ? Prisma.sql`AND date >= ${range.from}::date` : Prisma.empty;
  const hi = range.to ? Prisma.sql`AND date <= ${range.to}::date` : Prisma.empty;
  const rows = await prisma.$queryRaw<
    { canonicalPath: string; externalId: string | null; views: bigint; pushViews: bigint; pushUnknownRows: bigint; organic: bigint }[]
  >`
    SELECT "canonicalPath", "externalId",
           SUM(views)::bigint AS views,
           COALESCE(SUM("pushViews"), 0)::bigint AS "pushViews",
           COUNT(*) FILTER (WHERE "pushViews" IS NULL)::bigint AS "pushUnknownRows",
           SUM(GREATEST(views - CASE WHEN "pushViews" IS NOT NULL AND "digestViews" IS NOT NULL THEN "pushViews" + "digestViews" ELSE 0 END, 0))::bigint AS organic
      FROM "CmsArticleView"
     WHERE portal = ${portal}
       AND ("canonicalPath" = ANY(${paths}::text[]) OR "externalId" = ANY(${ids}::text[]))
       ${lo} ${hi}
     GROUP BY "canonicalPath", "externalId"`;
  return rows.map((r) => ({
    canonicalPath: r.canonicalPath,
    externalId: r.externalId,
    views: Number(r.views),
    pushViews: Number(r.pushViews),
    pushUnknownRows: Number(r.pushUnknownRows),
    organic: Number(r.organic),
  }));
}

/** The CMS sums that belong to one requested path: its canonicalPath, or (for a migrated story) its old id. */
export function cmsSumsFor(path: string, sums: CmsSum[]): CmsSum[] {
  const id = externalIdOfPath(path);
  return sums.filter((s) => s.canonicalPath === path || (id !== null && s.externalId === id));
}

/* ------------------------------------------------------------------ */
/* The one function family                                             */
/* ------------------------------------------------------------------ */

/**
 * Views and push-views per article path (taxscan URL paths from `readsPath()`), over `opts.range` (default: every
 * date). A path with no data from any source is ABSENT from the map ("—", not 0).
 */
export async function readsForPaths(paths: string[], opts: ReadsOpts = {}): Promise<Map<string, PathReads>> {
  const portal = opts.portal ?? env.rss.portal;
  const mode = opts.mode ?? env.cmsViews.source;
  const cmsFrom = opts.cmsFrom ?? env.cmsViews.cmsFrom;
  const out = new Map<string, PathReads>();
  const unique = [...new Set(paths)];
  if (unique.length === 0) return out;
  const split = splitRange(opts.range, mode, cmsFrom);

  const ga = split.ga ? await readsByPath(unique, portal, split.ga) : new Map<string, { reads: number; pushReads: number }>();
  const ids = unique.map(externalIdOfPath).filter((i): i is string => i !== null);
  const cms = mode === 'cms' ? await cmsSums(unique, [...new Set(ids)], portal, split.cms) : [];

  for (const p of unique) {
    const g = ga.get(p);
    // A row matched by BOTH path and id appears once in `cmsSumsFor` (one group per (path, id) pair).
    const c = cmsSumsFor(p, cms);
    if (!g && c.length === 0) continue;
    const cmsViews = c.reduce((n, s) => n + s.views, 0);
    const unknown = c.some((s) => s.pushUnknownRows > 0);
    out.set(p, {
      views: (g?.reads ?? 0) + cmsViews,
      pushViews: unknown ? null : (g?.pushReads ?? 0) + c.reduce((n, s) => n + s.pushViews, 0),
      usedGa: !!g,
      usedCms: c.length > 0,
    });
  }
  return out;
}

/**
 * Every article path read in [start, end) (IST day keys, end EXCLUSIVE like `reportWindow()`), for the emailed coverage
 * report. GA rows are the site's pages (the caller keeps article pages only); `usedCms` marks rows that are CMS
 * articles by definition (new stories carry no numeric id in their URL, so the numeric-id test must not drop them).
 */
export async function readsWindowByPath(
  startKey: string,
  endKey: string,
  opts: Omit<ReadsOpts, 'range'> = {},
): Promise<Map<string, PathReads>> {
  const portal = opts.portal ?? env.rss.portal;
  const mode = opts.mode ?? env.cmsViews.source;
  const cmsFrom = opts.cmsFrom ?? env.cmsViews.cmsFrom;
  const last = dayBefore(endKey);
  const split = splitRange({ from: startKey, to: last }, mode, cmsFrom);
  const out = new Map<string, PathReads>();
  if (split.ga) {
    const date = dateFilter(split.ga.from ?? null, split.ga.to ?? null);
    if (date !== null) {
      const grouped = await prisma.articleReadStat.groupBy({
        by: ['pagePath'],
        where: { portal, ...(date ? { date } : {}) },
        _sum: { totalViews: true, pushViews: true },
      });
      for (const g of grouped) {
        const path = g.pagePath.replace(/\/+$/, '');
        const e = out.get(path) ?? { views: 0, pushViews: 0, usedGa: true, usedCms: false };
        e.views += g._sum.totalViews ?? 0;
        e.pushViews = (e.pushViews ?? 0) + (g._sum.pushViews ?? 0);
        out.set(path, e);
      }
    }
  }
  if (split.cms) {
    const lo = split.cms.from ? Prisma.sql`AND date >= ${split.cms.from}::date` : Prisma.empty;
    const hi = split.cms.to ? Prisma.sql`AND date <= ${split.cms.to}::date` : Prisma.empty;
    const rows = await prisma.$queryRaw<{ canonicalPath: string; views: bigint; pushViews: bigint; unknown: bigint }[]>`
      SELECT "canonicalPath", SUM(views)::bigint AS views, COALESCE(SUM("pushViews"), 0)::bigint AS "pushViews",
             COUNT(*) FILTER (WHERE "pushViews" IS NULL)::bigint AS unknown
        FROM "CmsArticleView"
       WHERE portal = ${portal} ${lo} ${hi}
       GROUP BY "canonicalPath"`;
    for (const r of rows) {
      const e = out.get(r.canonicalPath) ?? { views: 0, pushViews: 0, usedGa: false, usedCms: false };
      e.views += Number(r.views);
      // Known push counts add up; an unknown day contributes nothing (the email's "via push" is "from 15 Oct").
      e.pushViews = (e.pushViews ?? 0) + Number(r.pushViews);
      e.usedCms = true;
      out.set(r.canonicalPath, e);
    }
  }
  return out;
}

/** Whether reads are tracked at all: GA reads on (today's gate), or the CMS source selected and its sync on. */
export function readsEnabled(): boolean {
  return env.gaReads.enabled || (env.cmsViews.source === 'cms' && env.cmsViews.enabled);
}

/* ------------------------------------------------------------------ */
/* Labels                                                              */
/* ------------------------------------------------------------------ */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** `2026-09-29` → `29 Sep`. */
export function shortDay(key: string): string {
  const [, m, d] = key.split('-').map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]}`;
}

/** GA4's own caveat (the consent banner went live on the new CMS on 29 Sep). */
export const GA_NOTE = 'Reads: GA4 (≈1 in 10 readers since 29 Sep)';

/**
 * The small source note shown wherever reads appear. `ga`: GA4's caveat. `cms`: "Reads: CMS" when only the CMS
 * contributed, the GA4 caveat when only GA did (a range before the cut-over), "CMS from <date>, GA4 before" for both.
 */
export function readsSourceNote(mode: ReadsMode, used: { ga: boolean; cms: boolean }, cmsFrom: string = env.cmsViews.cmsFrom): string {
  if (mode === 'ga') return GA_NOTE;
  if (used.cms && used.ga) return `Reads: CMS from ${shortDay(cmsFrom)}, GA4 before`;
  if (used.ga && !used.cms) return GA_NOTE;
  return 'Reads: CMS';
}
