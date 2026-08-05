import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import {
  apiDate,
  parseApiDate,
  surfacePagePath,
  fetchSurface,
  syncSearchSurfaces,
  startSearchSurfacesSync,
  type SearchAnalyticsRow,
} from '../services/searchSurfaces';
import { __resetTokenCache, type FetchLike, type GaCredentials } from '../services/gaReads';

/** A Search Analytics row as the API returns it for dimensions [date, page]. */
const row = (date: string, page: string, clicks: number, impressions: number): SearchAnalyticsRow => ({
  keys: [date, page],
  clicks,
  impressions,
});

const URL_BASE = 'https://www.taxscan.in';

describe('apiDate / parseApiDate', () => {
  it('formats and round-trips the API date form', () => {
    expect(apiDate(new Date('2026-08-05T11:22:33.000Z'))).toBe('2026-08-05');
    expect(parseApiDate('2026-08-05').toISOString()).toBe('2026-08-05T00:00:00.000Z');
  });
});

describe('surfacePagePath', () => {
  it('reduces a canonical article URL to the reads join key', () => {
    expect(surfacePagePath(`${URL_BASE}/top-stories/some-ruling-1449424`)).toBe(
      '/top-stories/some-ruling-1449424',
    );
  });

  it('folds the trailing slash, so the two spellings share one key', () => {
    expect(surfacePagePath(`${URL_BASE}/top-stories/x-123/`)).toBe(
      surfacePagePath(`${URL_BASE}/top-stories/x-123`),
    );
  });

  it('accepts the apex host as well as www', () => {
    expect(surfacePagePath('https://taxscan.in/top-stories/x-123')).toBe('/top-stories/x-123');
  });

  it('rejects the storefront hosts — they are not editorial articles', () => {
    expect(surfacePagePath('https://academy.taxscan.in/course/gst-101')).toBeNull();
    expect(surfacePagePath('https://shop.taxscan.in/product/book-9')).toBeNull();
  });

  it('rejects other hosts and unparseable values', () => {
    expect(surfacePagePath('https://example.com/x-1')).toBeNull();
    expect(surfacePagePath('not a url')).toBeNull();
  });
});

describe('fetchSurface', () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const creds: GaCredentials = {
    client_email: 'sc@y.iam',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
  const base = {
    creds,
    surface: 'DISCOVER' as const,
    type: 'discover',
    startDate: '2026-08-01',
    endDate: '2026-08-05',
    siteUrl: 'sc-domain:taxscan.in',
  };

  beforeEach(() => __resetTokenCache());

  /** Mock: token endpoint → a token; query endpoint → the given row pages. */
  const scFetch = (pages: SearchAnalyticsRow[][], sink?: { bodies: unknown[]; urls: string[] }): FetchLike => {
    let call = 0;
    return async (url, init) => {
      if (String(url).includes('oauth2.googleapis.com')) {
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
      }
      sink?.urls.push(String(url));
      sink?.bodies.push(JSON.parse(String(init?.body ?? '{}')));
      const p = pages[call] ?? [];
      call += 1;
      return new Response(JSON.stringify({ rows: p }), { status: 200 });
    };
  };

  it('maps rows to the stored shape and drops non-article hosts', async () => {
    const out = await fetchSurface({
      ...base,
      fetchImpl: scFetch([
        [
          row('2026-08-01', `${URL_BASE}/top-stories/a-111111`, 6110, 90200),
          row('2026-08-01', 'https://academy.taxscan.in/course/x', 40, 900),
          row('2026-08-02', `${URL_BASE}/top-stories/b-222222/`, 212, 3100),
        ],
      ]),
    });
    expect(out).toEqual([
      expect.objectContaining({
        pagePath: '/top-stories/a-111111',
        surface: 'DISCOVER',
        clicks: 6110,
        impressions: 90200,
      }),
      expect.objectContaining({ pagePath: '/top-stories/b-222222', clicks: 212 }),
    ]);
    expect(out[0].date.toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  it('sends the surface type and asks for not-yet-final days', async () => {
    const sink = { bodies: [] as unknown[], urls: [] as string[] };
    await fetchSurface({ ...base, type: 'googleNews', fetchImpl: scFetch([[]], sink) });
    expect(sink.bodies[0]).toMatchObject({
      type: 'googleNews',
      dimensions: ['date', 'page'],
      dataState: 'all',
      startDate: '2026-08-01',
      endDate: '2026-08-05',
    });
    // The property id must survive URL-encoding — `sc-domain:` contains a colon.
    expect(sink.urls[0]).toContain('sc-domain%3Ataxscan.in');
  });

  /**
   * Regression: Google reports the trailing-slash and bare spellings of one URL
   * as separate rows. Both normalise to the same pagePath, so returning them
   * unfolded trips the (portal, pagePath, date, surface) unique index on write.
   * A 400-day backfill hit this in production; an 8-day window never had.
   */
  it('folds rows whose URLs normalise to the same path on the same day', async () => {
    const out = await fetchSurface({
      ...base,
      fetchImpl: scFetch([
        [
          row('2026-08-01', `${URL_BASE}/top-stories/a-111111`, 100, 1000),
          row('2026-08-01', `${URL_BASE}/top-stories/a-111111/`, 25, 300),
        ],
      ]),
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      pagePath: '/top-stories/a-111111',
      clicks: 125,
      impressions: 1300,
    });
  });

  it('keeps the same path on different days apart', async () => {
    const out = await fetchSurface({
      ...base,
      fetchImpl: scFetch([
        [
          row('2026-08-01', `${URL_BASE}/top-stories/a-111111`, 10, 100),
          row('2026-08-02', `${URL_BASE}/top-stories/a-111111`, 20, 200),
        ],
      ]),
    });
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.clicks).sort((a, b) => a - b)).toEqual([10, 20]);
  });

  it('stops paginating on a short page', async () => {
    const sink = { bodies: [] as unknown[], urls: [] as string[] };
    const out = await fetchSurface({
      ...base,
      fetchImpl: scFetch([[row('2026-08-01', `${URL_BASE}/a-111111`, 1, 2)]], sink),
    });
    expect(out).toHaveLength(1);
    expect(sink.bodies).toHaveLength(1); // no second request
  });

  it('surfaces an API error rather than returning partial data', async () => {
    const failing: FetchLike = async (url) =>
      String(url).includes('oauth2.googleapis.com')
        ? new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 })
        : new Response(JSON.stringify({ error: { message: 'permission denied' } }), { status: 403 });
    await expect(fetchSurface({ ...base, fetchImpl: failing })).rejects.toThrow(
      /Search Console query failed for discover \(403\)/,
    );
  });
});

describe('syncSearchSurfaces', () => {
  const portal = `test-sc-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const creds: GaCredentials = {
    client_email: 'sc@y.iam',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
  const siteUrl = 'sc-domain:taxscan.in';

  beforeEach(() => __resetTokenCache());
  afterAll(async () => {
    await prisma.articleSurfaceStat.deleteMany({ where: { portal } });
  });

  /** Mock keyed on the requested `type`, so both surfaces can be scripted. */
  const bySurfaceFetch = (
    byType: Record<string, SearchAnalyticsRow[]>,
    failOn?: string,
  ): FetchLike => async (url, init) => {
    if (String(url).includes('oauth2.googleapis.com')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as { type?: string };
    if (failOn && body.type === failOn) {
      return new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500 });
    }
    return new Response(JSON.stringify({ rows: byType[body.type ?? ''] ?? [] }), { status: 200 });
  };

  it('stores both surfaces separately for the same article and day', async () => {
    const r = await syncSearchSurfaces({
      creds,
      portal,
      siteUrl,
      fetchImpl: bySurfaceFetch({
        discover: [row('2026-08-01', `${URL_BASE}/top-stories/a-111111`, 6110, 90200)],
        googleNews: [row('2026-08-01', `${URL_BASE}/top-stories/a-111111`, 212, 3100)],
      }),
    });
    expect(r).toMatchObject({ rows: 2, dates: 1, bySurface: { DISCOVER: 1, GOOGLE_NEWS: 1 } });

    const stored = await prisma.articleSurfaceStat.findMany({
      where: { portal },
      orderBy: { surface: 'asc' },
    });
    expect(stored).toHaveLength(2);
    expect(stored[0]).toMatchObject({ surface: 'DISCOVER', clicks: 6110, impressions: 90200 });
    expect(stored[1]).toMatchObject({ surface: 'GOOGLE_NEWS', clicks: 212, impressions: 3100 });
  });

  it('replaces a returned date wholesale — settled numbers win, no duplicates', async () => {
    await syncSearchSurfaces({
      creds,
      portal,
      siteUrl,
      fetchImpl: bySurfaceFetch({
        discover: [
          row('2026-08-01', `${URL_BASE}/top-stories/a-111111`, 9000, 120000),
          row('2026-08-01', `${URL_BASE}/top-stories/gone-999999`, 5, 10),
        ],
        googleNews: [row('2026-08-01', `${URL_BASE}/top-stories/a-111111`, 212, 3100)],
      }),
    });
    const after = await prisma.articleSurfaceStat.findMany({
      where: { portal, surface: 'DISCOVER' },
      orderBy: { pagePath: 'asc' },
    });
    expect(after).toHaveLength(2);
    expect(after[0]).toMatchObject({ pagePath: '/top-stories/a-111111', clicks: 9000 });
  });

  it('leaves stored rows untouched when the SECOND surface fails mid-sync', async () => {
    const before = await prisma.articleSurfaceStat.findMany({ where: { portal } });
    expect(before.length).toBeGreaterThan(0);
    await expect(
      syncSearchSurfaces({
        creds,
        portal,
        siteUrl,
        fetchImpl: bySurfaceFetch(
          { discover: [row('2026-08-01', `${URL_BASE}/top-stories/a-111111`, 1, 1)] },
          'googleNews',
        ),
      }),
    ).rejects.toThrow(/Search Console query failed for googleNews \(500\)/);
    // Nothing deleted: the delete only runs after BOTH fetches return.
    const after = await prisma.articleSurfaceStat.findMany({ where: { portal } });
    expect(after).toHaveLength(before.length);
  });

  it('refuses to run without a configured site url', async () => {
    await expect(
      syncSearchSurfaces({ creds, portal, siteUrl: '', fetchImpl: bySurfaceFetch({}) }),
    ).rejects.toThrow(/SEARCH_CONSOLE_SITE_URL/);
  });
});

describe('startSearchSurfacesSync', () => {
  it('is a no-op when SEARCH_CONSOLE_ENABLED is off (default)', () => {
    expect(() => startSearchSurfacesSync()).not.toThrow();
  });
});
