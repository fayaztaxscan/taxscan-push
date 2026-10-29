import { CmsListClient, CmsPullError, type CmsClientOptions } from '../audience/cmsClient';
import { readsPath } from '../metrics';
import { env, type AudienceEnv, type ReadsEnv } from '../../lib/env';

/**
 * Door V client: our signed GET to the CMS's article-views feed (Feed 2; CMS push-feed design §5.2 and
 * Appendix A.8, `GET /api/v1/push-feed/article-views`). It is the SAME signed-GET machinery as door L
 * (`CmsListClient`: https only, host on CMS_FEED_ALLOWED_HOSTS, `redirect: 'error'`, 30 s timeout, 429/5xx
 * retried ×3, a fresh timestamp + nonce per attempt) pointed at the views route, with its OWN secret
 * (CMS_FEED_VIEWS_SECRET): this client never holds the list secret, and the list client never holds this one.
 *
 * A reply is accepted only in the A.8 shape; ONE bad row fails the page (and the run writes nothing).
 * Never logs. Errors name the HTTP status or the failing check, never a secret, a signature or a row.
 */

export const VIEWS_PATH = '/api/v1/push-feed/article-views';
/** A.8: limit 1–5000, default 1000. */
export const VIEWS_PAGE_LIMIT = 5_000;
/** A runaway guard, not a size limit: 400 pages × 5,000 rows. */
export const VIEWS_MAX_PAGES = 400;

const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const DIGITS_RE = /^\d{1,18}$/;
const MAX_INT = 2_147_483_647; // Postgres INTEGER

/** One validated A.8 row. `date` is the IST view day (`YYYY-MM-DD`). */
export type ViewRow = {
  articleId: string;
  canonicalPath: string;
  externalId: string | null;
  date: string;
  views: number;
  /** null = unknown (the CMS records no source before 2026-10-15), never 0. */
  pushViews: number | null;
  digestViews: number | null;
  cmsUpdatedAt: Date;
};

export type ViewsPage = { rows: ViewRow[]; nextCursor: string | null; asOf: Date };

const fail = (msg: string): never => {
  throw new CmsPullError('FATAL', `cms views: ${msg}`);
};

function nonNegInt(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > MAX_INT) return fail(`bad ${what}`);
  return v;
}
function nullableCount(v: unknown, what: string): number | null {
  return v === null ? null : nonNegInt(v, what);
}
function isIsoDay(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
}

/** One raw row → ViewRow, or FATAL naming the failing field (never its value). */
export function parseViewRow(raw: unknown): ViewRow {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!o) return fail('a row is not an object');
  if (typeof o.article_id !== 'string' || !DIGITS_RE.test(o.article_id)) return fail('bad article_id');
  if (typeof o.canonical_url !== 'string') return fail('bad canonical_url');
  const canonicalPath = readsPath(o.canonical_url); // https/http taxscan.in host → its path; else null
  if (!canonicalPath || !/^https:\/\//i.test(o.canonical_url)) return fail('bad canonical_url');
  if (o.external_id !== null && (typeof o.external_id !== 'string' || !DIGITS_RE.test(o.external_id))) return fail('bad external_id');
  if (!isIsoDay(o.date)) return fail('bad date');
  if (typeof o.updated_at !== 'string' || !INSTANT_RE.test(o.updated_at)) return fail('bad updated_at');
  const cmsUpdatedAt = new Date(o.updated_at);
  if (Number.isNaN(cmsUpdatedAt.getTime())) return fail('bad updated_at');
  return {
    articleId: o.article_id,
    canonicalPath,
    externalId: o.external_id as string | null,
    date: o.date,
    views: nonNegInt(o.views, 'views'),
    pushViews: nullableCount(o.push_views, 'push_views'),
    digestViews: nullableCount(o.digest_views, 'digest_views'),
    cmsUpdatedAt,
  };
}

/** Strict A.8 page → ViewsPage, or FATAL naming the failing field. */
export function parseViewsPage(text: string, limit: number = VIEWS_PAGE_LIMIT): ViewsPage {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return fail('reply is not JSON');
  }
  const o = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (!o || !Array.isArray(o.data)) return fail('reply has no data array');
  if (o.data.length > limit) return fail('more rows than the limit');
  const meta = o.meta && typeof o.meta === 'object' && !Array.isArray(o.meta) ? (o.meta as Record<string, unknown>) : null;
  if (!meta) return fail('reply has no meta');
  const nc = meta.next_cursor;
  if (!(nc === null || (typeof nc === 'string' && nc.length > 0 && nc.length <= 1024))) return fail('bad meta.next_cursor');
  const asOf = typeof meta.as_of === 'string' && INSTANT_RE.test(meta.as_of) ? new Date(meta.as_of) : null;
  if (!asOf || Number.isNaN(asOf.getTime())) return fail('bad meta.as_of');
  return { rows: o.data.map(parseViewRow), nextCursor: nc as string | null, asOf };
}

export type ViewsRangeQuery = { from: string; to: string; publishedSince?: string | null };

/** The views client: door V, its own secret. */
export class CmsViewsClient {
  constructor(private readonly http: CmsListClient) {}

  /** One page (retries inside). `from` / `to` are IST dates, `to − from ≤ 30` days (the CMS refuses more). */
  async fetchPage(q: ViewsRangeQuery & { cursor?: string | null; limit?: number }): Promise<ViewsPage> {
    const limit = Math.min(Math.max(1, Math.floor(q.limit ?? VIEWS_PAGE_LIMIT)), VIEWS_PAGE_LIMIT);
    if (!isIsoDay(q.from) || !isIsoDay(q.to) || q.from > q.to) throw new CmsPullError('FATAL', 'cms views: bad date range');
    const params: Record<string, string> = { from: q.from, to: q.to, limit: String(limit) };
    if (q.publishedSince) params.published_since = q.publishedSince;
    if (q.cursor) params.cursor = q.cursor;
    return parseViewsPage(await this.http.getText(params), limit);
  }

  /**
   * Every row of the range, all pages. Throws (and returns nothing) when the chain is not complete: a failed page,
   * a cursor that repeats, more than VIEWS_MAX_PAGES pages, or a (date, article) that arrives twice.
   * `asOf` is the FIRST page's `meta.as_of`.
   */
  async fetchRange(q: ViewsRangeQuery, opts: { limit?: number } = {}): Promise<{ rows: ViewRow[]; pages: number; asOf: Date }> {
    const rows: ViewRow[] = [];
    const seenKeys = new Set<string>();
    const seenCursors = new Set<string>();
    let asOf: Date | null = null;
    let cursor: string | null = null;
    let pages = 0;
    for (;;) {
      if (pages >= VIEWS_MAX_PAGES) throw new CmsPullError('FATAL', 'cms views: too many pages');
      const page = await this.fetchPage({ ...q, cursor, limit: opts.limit });
      pages += 1;
      asOf ??= page.asOf;
      for (const r of page.rows) {
        const k = `${r.date}|${r.articleId}`;
        if (seenKeys.has(k)) throw new CmsPullError('FATAL', 'cms views: a (date, article) arrived twice');
        seenKeys.add(k);
        rows.push(r);
      }
      cursor = page.nextCursor;
      if (cursor === null) break;
      if (seenCursors.has(cursor)) throw new CmsPullError('FATAL', 'cms views: the cursor repeats (the chain never ends)');
      seenCursors.add(cursor);
    }
    return { rows, pages, asOf: asOf as Date };
  }
}

/** The production client: the audience env's base URL + allowed hosts, door V's own secret. */
export function createViewsClient(cfg: AudienceEnv = env.audience, reads: ReadsEnv = env.cmsViews, overrides: Partial<CmsClientOptions> = {}): CmsViewsClient {
  return new CmsViewsClient(
    new CmsListClient({
      baseUrl: cfg.cms.baseUrl,
      secret: reads.secret,
      allowedHosts: cfg.cms.allowedHosts,
      path: VIEWS_PATH,
      secretName: 'CMS_FEED_VIEWS_SECRET',
      label: 'cms views',
      ...overrides,
    }),
  );
}
