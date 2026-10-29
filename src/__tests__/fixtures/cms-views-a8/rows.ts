/**
 * Feed 2 fixtures in the shape of the CMS contract's Appendix A.8 (`GET /api/v1/push-feed/article-views`;
 * /Users/bestdoc/Documents/cms-platform/docs/design/push-data-feeds-2026-10-22.md). Fake data, no real reader:
 *  - a story born on the new CMS (no `external_id`, no numeric id in its address),
 *  - a migrated story (`external_id` set, keeps its old address, which ends in that same id),
 *  - days before 2026-10-15, where `push_views` / `digest_views` are NULL (no source was recorded: unknown, not 0),
 *  - days from 2026-10-15, where they are known numbers.
 */
export type A8Row = {
  article_id: string;
  canonical_url: string;
  external_id: string | null;
  date: string;
  views: number;
  push_views: number | null;
  digest_views: number | null;
  updated_at: string;
};

const row = (o: Partial<A8Row> & Pick<A8Row, 'article_id' | 'canonical_url' | 'date' | 'views'>): A8Row => ({
  external_id: null,
  push_views: null,
  digest_views: null,
  updated_at: '2026-10-29T11:07:03+05:30',
  ...o,
});

/** A story born on the new CMS: its address carries no numeric id. */
export const NEW_STORY_URL = 'https://www.taxscan.in/gst/karnataka-hc-allows-itc-under-retrospective-amendment';
/** A migrated story: it keeps its old address, which ends in the old CMS's news id. */
export const MIGRATED_URL = 'https://www.taxscan.in/income-tax/itat-upholds-order-1452345';
export const MIGRATED_EXTERNAL_ID = '1452345';

export const A8_ROWS: A8Row[] = [
  // New story: first full day (null source), then known source days.
  row({ article_id: '61458', canonical_url: NEW_STORY_URL, date: '2026-10-13', views: 400 }),
  row({ article_id: '61458', canonical_url: NEW_STORY_URL, date: '2026-10-15', views: 1840, push_views: 120, digest_views: 35 }),
  row({ article_id: '61458', canonical_url: NEW_STORY_URL, date: '2026-10-16', views: 900, push_views: 10, digest_views: 5 }),
  // Migrated story.
  row({ article_id: '61001', canonical_url: MIGRATED_URL, external_id: MIGRATED_EXTERNAL_ID, date: '2026-10-01', views: 300 }),
  row({ article_id: '61001', canonical_url: MIGRATED_URL, external_id: MIGRATED_EXTERNAL_ID, date: '2026-10-20', views: 50, push_views: 0, digest_views: 0 }),
  // Another migrated story, only known-source days.
  row({ article_id: '61002', canonical_url: 'https://www.taxscan.in/gst/old-gst-ruling-1400001', external_id: '1400001', date: '2026-10-21', views: 70, push_views: 20, digest_views: 10 }),
  // A story with views only on the first partial day (28 Sep).
  row({ article_id: '61003', canonical_url: 'https://www.taxscan.in/customs/customs-order-1400002', external_id: '1400002', date: '2026-09-28', views: 12 }),
];

/** Pages of `n` rows in the contract's order (date, article_id), with a keyset-style opaque cursor. */
export function a8Pages(rows: A8Row[], n: number, asOf = '2026-10-29T11:07:03+05:30'): string[] {
  const sorted = [...rows].sort((a, b) => (a.date === b.date ? (a.article_id < b.article_id ? -1 : 1) : a.date < b.date ? -1 : 1));
  const pages: string[] = [];
  for (let i = 0; i < sorted.length; i += n) {
    const next = i + n < sorted.length ? Buffer.from(`${sorted[i + n - 1].date}|${sorted[i + n - 1].article_id}`).toString('base64url') : null;
    pages.push(JSON.stringify({ data: sorted.slice(i, i + n), meta: { next_cursor: next, as_of: asOf } }));
  }
  return pages.length ? pages : [JSON.stringify({ data: [], meta: { next_cursor: null, as_of: asOf } })];
}
