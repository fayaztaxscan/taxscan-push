import request from 'supertest';
import type { SearchSurface } from '@prisma/client';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { env } from '../lib/env';
import {
  buildSurfacesReport,
  getSurfacesReport,
  customSurfacesWindow,
  monthColumns,
  comparePair,
  __resetSurfacesCache,
  type SurfaceGrid,
  type SurfacesPayload,
} from '../services/surfacesReport';

const app = createApp();
const AUTH = `Bearer ${process.env.ADMIN_TOKEN}`;

/**
 * IST 2026-08-05 00:30 — deliberately just past IST midnight, so the instant's
 * own UTC date (2026-08-04) is a DAY BEHIND the IST day the windows are
 * measured over. Any comparison that skips the IST day key shows up here.
 */
const NOW = new Date('2026-08-04T19:00:00.000Z');

/** Article ids unique per run: the campaign title lookup matches on URL substring. */
const ID = 1_000_000 + (Date.now() % 8_000_000);
const P = {
  itat: `/top-stories/itat-deletes-addition-on-cash-deposits-${ID}`,
  sc: `/top-stories/supreme-court-upholds-gst-notification-${ID + 1}`,
  cbdt: `/top-stories/cbdt-extends-itr-filing-deadline-${ID + 2}`,
  sebi: `/top-stories/sebi-tightens-disclosure-norms-${ID + 3}`,
  customs: `/top-stories/customs-dept-seizes-gold-consignment-${ID + 4}`,
  home: '/',
};

const grid = (grids: SurfaceGrid[], surface: string) => grids.find((g) => g.surface === surface)!;
const row = (grids: SurfaceGrid[], surface: string, label: string) =>
  grid(grids, surface).rows.find((r) => r.label === label);

/** Column index by key ('2026-07'), so assertions don't hard-code column order. */
const ci = (payload: SurfacesPayload, key: string) => payload.columns.findIndex((c) => c.key === key);

async function seed(portal: string, rows: [string, SearchSurface, string, number, number][]) {
  await prisma.articleSurfaceStat.createMany({
    data: rows.map(([pagePath, surface, date, clicks, impressions]) => ({
      portal,
      pagePath,
      surface,
      date: new Date(`${date}T00:00:00.000Z`),
      clicks,
      impressions,
    })),
  });
}

describe('buildSurfacesReport', () => {
  const portal = `test-surfaces-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  const campaignIds: string[] = [];
  let payload: SurfacesPayload;

  beforeAll(async () => {
    await seed(portal, [
      // Today's IST day — later than NOW's own UTC date, so it is dropped by any
      // window that ends at the raw instant instead of the IST day key.
      [P.itat, 'DISCOVER', '2026-08-05', 500, 9000],
      // Same article + day on the other surface: must stay separate.
      [P.itat, 'GOOGLE_NEWS', '2026-08-05', 20, 400],
      // Exactly the 1-week start edge (istDateKey(NOW − 7d)) — inside.
      [P.sc, 'DISCOVER', '2026-07-29', 100, 5000],
      // One day older — outside 1 week, inside 1 month.
      [P.cbdt, 'DISCOVER', '2026-07-28', 7, 70],
      // Seen but never tapped: a real zero, must NOT collapse to a null cell.
      [P.sebi, 'DISCOVER', '2026-08-04', 0, 1200],
      // Only pickup is older than a week → its category row's 1-week cell is null.
      [P.customs, 'DISCOVER', '2026-07-28', 40, 800],
      // Not an article page — surfacePagePath screens the host only, so the
      // homepage does reach the table and must be filtered out here.
      [P.home, 'DISCOVER', '2026-08-04', 999, 9999],
    ]);
    const c = await prisma.campaign.create({
      data: {
        portal,
        title: 'ITAT Deletes ₹12L Addition on Cash Deposits u/s 69A',
        body: '.',
        url: `https://www.taxscan.in${P.itat}`,
        target: { type: 'all' },
        status: 'SENT',
      },
    });
    campaignIds.push(c.id);
    payload = await buildSurfacesReport({ portal, now: NOW });
  });

  afterAll(async () => {
    await prisma.articleSurfaceStat.deleteMany({ where: { portal } });
    await prisma.campaign.deleteMany({ where: { id: { in: campaignIds } } });
  });

  it('lays the grid out as calendar months, flagging the one still filling', () => {
    expect(payload.mode).toBe('months');
    expect(payload.columns.map((c) => c.key)).toEqual(['2026-07', '2026-08']);
    expect(payload.columns.map((c) => c.label)).toEqual(['Jul 2026', 'Aug 2026']);
    // July is closed; August is not, because Google has only reported to the 5th.
    expect(payload.columns.map((c) => c.partial)).toEqual([false, true]);
    // August is still filling, so July is what every delta is measured against.
    expect(payload.compare).toEqual({ current: 0, base: -1 });
    expect(payload.dataThrough).toBe('2026-08-05');
  });

  it('buckets by IST day: the 5th lands in August, the 28th in July', () => {
    const jul = ci(payload, '2026-07');
    const aug = ci(payload, '2026-08');
    // July: cbdt 7 + customs 40 + sc 100. August: itat 500 (IST today, a day
    // ahead of NOW's own UTC date) + sebi 0. The homepage row is excluded.
    expect(payload.totals[jul].DISCOVER).toEqual({ clicks: 147, impressions: 5870, articles: 3 });
    expect(payload.totals[aug].DISCOVER).toEqual({ clicks: 500, impressions: 10200, articles: 2 });
  });

  it('keeps the two surfaces apart for the same article and day', () => {
    const aug = ci(payload, '2026-08');
    expect(payload.totals[aug].GOOGLE_NEWS).toEqual({ clicks: 20, impressions: 400, articles: 1 });
    expect(row(payload.byCategory, 'DISCOVER', 'Income Tax')?.cells[aug]).toEqual({
      clicks: 500,
      impressions: 9000,
      articles: 1,
    });
    expect(row(payload.byCategory, 'GOOGLE_NEWS', 'Income Tax')?.cells[aug]).toEqual({
      clicks: 20,
      impressions: 400,
      articles: 1,
    });
    // The other surface's rows never leak into this one's grid.
    expect(row(payload.byCategory, 'GOOGLE_NEWS', 'GST')).toBeUndefined();
  });

  it('distinguishes "no pickup" (null) from a synced zero-click row', () => {
    const jul = ci(payload, '2026-07');
    const aug = ci(payload, '2026-08');
    const customs = row(payload.byCategory, 'DISCOVER', 'Customs');
    expect(customs?.cells[jul]).toEqual({ clicks: 40, impressions: 800, articles: 1 });
    expect(customs?.cells[aug]).toBeNull();

    // Impressions without a single click is a finding, not an absence.
    expect(row(payload.byCategory, 'DISCOVER', 'SEBI/RBI')?.cells[aug]).toEqual({
      clicks: 0,
      impressions: 1200,
      articles: 1,
    });
  });

  it('labels and orders rows with the coverage report helpers', () => {
    // Categories by total clicks across the months shown: Income Tax 500, GST
    // 100, Customs 40, SEBI/RBI 0. Sorting on the newest column instead would
    // reshuffle the grid every month — and that column is the partial one.
    expect(grid(payload.byCategory, 'DISCOVER').rows.map((r) => r.label)).toEqual([
      'Income Tax',
      'GST',
      'Customs',
      'SEBI/RBI',
    ]);

    // Benches by judicial hierarchy (benchRank), never by volume — the Supreme
    // Court row (100 clicks) leads the ITAT row (500), residual rows last.
    expect(grid(payload.byBench, 'DISCOVER').rows.map((r) => r.label)).toEqual([
      'Supreme Court',
      'ITAT',
      'No bench – News',
    ]);
    const jul = ci(payload, '2026-07');
    expect(row(payload.byBench, 'DISCOVER', 'No bench – News')?.cells[jul]).toEqual({
      clicks: 47,
      impressions: 870,
      articles: 2,
    });
  });

  it('draws the top list over its own trailing window, not the newest column', () => {
    // August is 5 days old here; a top list scoped to the current column would
    // be five days of data under a month's heading.
    expect(payload.topWindow).toEqual({ from: '2026-07-07', to: '2026-08-05', label: 'last 30 days' });
    const top = payload.topArticles.DISCOVER;
    expect(top.map((t) => t.clicks)).toEqual([500, 100, 40, 7, 0]);
    expect(top[0]).toMatchObject({
      pagePath: P.itat,
      title: 'ITAT Deletes ₹12L Addition on Cash Deposits u/s 69A',
      impressions: 9000,
    });
    // Never captured → slug-derived text.
    expect(top[1].title).toBe('Supreme court upholds gst notification');
    expect(top.some((t) => t.pagePath === P.home)).toBe(false);
    expect(payload.topArticles.GOOGLE_NEWS).toHaveLength(1);
  });
});

describe('buildSurfacesReport with nothing synced', () => {
  it('returns an empty payload with dataThrough null (the route turns this into ready:false)', async () => {
    const payload = await buildSurfacesReport({
      portal: `test-surfaces-empty-${Date.now()}`,
      now: NOW,
    });
    expect(payload.dataThrough).toBeNull();
    expect(payload.dataFrom).toBeNull();
    expect(payload.columns).toEqual([]);
    expect(payload.totals).toEqual([]);
    expect(grid(payload.byCategory, 'DISCOVER').rows).toEqual([]);
    expect(payload.topArticles.GOOGLE_NEWS).toEqual([]);
  });
});

describe('monthColumns', () => {
  it('runs from the first synced month to the month containing now', () => {
    const cols = monthColumns('2026-01-14', '2026-08-05', NOW);
    expect(cols.map((c) => c.key)).toEqual([
      '2026-01', '2026-02', '2026-03', '2026-04',
      '2026-05', '2026-06', '2026-07', '2026-08',
    ]);
    // Month bounds are the calendar's, not the data's: January still starts on
    // the 1st even though the first synced day is the 14th.
    expect(cols[0]).toMatchObject({ from: '2026-01-01', to: '2026-01-31', partial: false });
    expect(cols[7]).toMatchObject({ from: '2026-08-01', to: '2026-08-31', partial: true });
  });

  it('crosses the year boundary and keeps the newest months when capped', () => {
    const cols = monthColumns('2024-01-01', '2026-08-05', NOW);
    expect(cols).toHaveLength(18);
    expect(cols[0].key).toBe('2025-03');
    expect(cols[cols.length - 1].key).toBe('2026-08');
  });
});

/**
 * The payload states which two columns every "vs previous" figure compares,
 * because the two modes order their columns differently. A client that assumed
 * "newest is last" showed range mode's deltas INVERTED — a 53% fall rendered as
 * a 111% rise — so this pairing is server-owned and pinned here.
 */
describe('comparePair', () => {
  it('compares the last COMPLETE month, never into the one still filling', () => {
    const cols = monthColumns('2026-05-01', '2026-08-05', NOW);
    expect(cols[cols.length - 1].partial).toBe(true);
    // Aug is partial, so Jul (index 2) is the subject and Jun (1) the baseline.
    expect(comparePair(cols, 'months')).toEqual({ current: 2, base: 1 });
  });

  it('uses the newest month when it is complete', () => {
    const cols = monthColumns('2026-06-01', '2026-08-31', NOW);
    expect(comparePair(cols, 'months').current).toBe(cols.length - 1);
  });

  it('puts the chosen span first in range mode, its predecessor second', () => {
    const cols = customSurfacesWindow('2026-04-01', '2026-06-30', NOW);
    // Reversing these two is the inversion bug: it reports a fall as a rise.
    expect(comparePair(cols, 'range')).toEqual({ current: 0, base: 1 });
    expect(cols[0].key).toBe('current');
  });

  it('reports no baseline when there is only one column to show', () => {
    const cols = monthColumns('2026-08-01', '2026-08-05', NOW);
    expect(cols).toHaveLength(1);
    expect(comparePair(cols, 'months').base).toBe(-1);
    expect(comparePair([], 'months')).toEqual({ current: -1, base: -1 });
  });
});

describe('customSurfacesWindow', () => {
  it('pairs the range with the equally-long span immediately before it', () => {
    const [current, previous] = customSurfacesWindow('2026-04-01', '2026-06-30', NOW);
    expect(current).toMatchObject({ key: 'current', from: '2026-04-01', to: '2026-06-30' });
    expect(current.label).toBe('1 Apr – 30 Jun 2026');
    // 91 days ending the day before the range starts — which reaches back into
    // the previous year, since Jan–Mar 2026 is only 90 days.
    expect(previous).toMatchObject({ key: 'previous', from: '2025-12-31', to: '2026-03-31' });
    expect(previous.label).toBe('Previous 91 days');
  });

  it('rejects ranges a reader would misread rather than silently clamping', () => {
    expect(() => customSurfacesWindow('2026-6-1', '2026-06-30', NOW)).toThrow(/YYYY-MM-DD/);
    expect(() => customSurfacesWindow('2026-02-31', '2026-03-05', NOW)).toThrow(/does not exist/);
    expect(() => customSurfacesWindow('2026-06-30', '2026-06-01', NOW)).toThrow(/on or before/);
    expect(() => customSurfacesWindow('2027-01-01', '2027-01-05', NOW)).toThrow(/future/);
    expect(() => customSurfacesWindow('2024-01-01', '2026-06-30', NOW)).toThrow(/limited to 400 days/);
  });
});

describe('buildSurfacesReport in range mode', () => {
  const portal = `test-surfaces-range-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

  beforeAll(async () => {
    await seed(portal, [
      // Inside the chosen range.
      [P.itat, 'DISCOVER', '2026-07-30', 100, 1000],
      [P.sc, 'DISCOVER', '2026-08-01', 50, 500],
      // Inside the preceding, equally-long window.
      [P.itat, 'DISCOVER', '2026-07-20', 400, 4000],
      // Outside both — must not reach either column.
      [P.cbdt, 'DISCOVER', '2026-06-01', 999, 9999],
    ]);
  });

  afterAll(async () => {
    await prisma.articleSurfaceStat.deleteMany({ where: { portal } });
  });

  it('returns exactly two columns: the range and the span before it', async () => {
    const payload = await buildSurfacesReport({
      portal,
      now: NOW,
      range: { from: '2026-07-25', to: '2026-08-03' },
    });
    expect(payload.mode).toBe('range');
    expect(payload.columns.map((c) => c.key)).toEqual(['current', 'previous']);
    expect(payload.compare).toEqual({ current: 0, base: 1 });
    expect(payload.columns[1]).toMatchObject({ from: '2026-07-15', to: '2026-07-24' });

    expect(payload.totals[0].DISCOVER).toEqual({ clicks: 150, impressions: 1500, articles: 2 });
    expect(payload.totals[1].DISCOVER).toEqual({ clicks: 400, impressions: 4000, articles: 1 });
    // June is outside both windows and never queried.
    expect(row(payload.byCategory, 'DISCOVER', 'Income Tax')?.cells).toEqual([
      { clicks: 100, impressions: 1000, articles: 1 },
      { clicks: 400, impressions: 4000, articles: 1 },
    ]);
    // The top list follows the chosen range, not a trailing 30 days.
    expect(payload.topWindow).toMatchObject({ from: '2026-07-25', to: '2026-08-03' });
    expect(payload.topArticles.DISCOVER.map((t) => t.clicks)).toEqual([100, 50]);
  });
});

/**
 * The sync only ever fetches a rolling lookback, so a fresh install holds days
 * rather than months. `dataFrom` is what lets the panel say "we only have N days
 * of history" instead of presenting a week's data under a "12 months" heading.
 */
describe('buildSurfacesReport history span', () => {
  const portal = `test-surfaces-span-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

  afterAll(async () => {
    await prisma.articleSurfaceStat.deleteMany({ where: { portal } });
  });

  it('reports the earliest and latest synced day, and spans only the months held', async () => {
    await seed(portal, [
      ['/top-stories/a-111111', 'DISCOVER', '2026-08-01', 10, 100],
      ['/top-stories/b-222222', 'DISCOVER', '2026-08-04', 20, 200],
    ]);
    const payload = await buildSurfacesReport({ portal, now: NOW });
    expect(payload.dataFrom).toBe('2026-08-01');
    expect(payload.dataThrough).toBe('2026-08-04');
    // Four days of history yields ONE month column, not a year of empty ones —
    // and dataFrom is what lets the panel say why the grid is that narrow.
    expect(payload.columns.map((c) => c.key)).toEqual(['2026-08']);
  });
});

describe('getSurfacesReport cache', () => {
  const portal = `test-surfaces-cache-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

  beforeAll(() => __resetSurfacesCache());
  afterAll(async () => {
    __resetSurfacesCache();
    await prisma.articleSurfaceStat.deleteMany({ where: { portal } });
  });

  it('serves the same payload within the TTL and rebuilds once cleared', async () => {
    await seed(portal, [[P.itat, 'DISCOVER', '2026-08-04', 10, 100]]);
    const first = await getSurfacesReport(portal, { ttlMs: 60_000, now: NOW });
    expect(first.totals[ci(first, '2026-08')].DISCOVER.clicks).toBe(10);

    await seed(portal, [[P.sc, 'DISCOVER', '2026-08-04', 5, 50]]);
    const cached = await getSurfacesReport(portal, { ttlMs: 60_000, now: NOW });
    expect(cached.totals[ci(cached, '2026-08')].DISCOVER.clicks).toBe(10);

    __resetSurfacesCache();
    const fresh = await getSurfacesReport(portal, { ttlMs: 60_000, now: NOW });
    expect(fresh.totals[ci(fresh, '2026-08')].DISCOVER.clicks).toBe(15);
  });

  it('caches a custom range separately from the months view', async () => {
    __resetSurfacesCache();
    const months = await getSurfacesReport(portal, { ttlMs: 60_000, now: NOW });
    const range = await getSurfacesReport(portal, {
      ttlMs: 60_000,
      now: NOW,
      range: { from: '2026-08-01', to: '2026-08-04' },
    });
    // A shared key would have served the months payload for the range request.
    expect(months.mode).toBe('months');
    expect(range.mode).toBe('range');
  });
});

describe('GET /api/reports/surfaces', () => {
  const portal = env.rss.portal;

  beforeEach(async () => {
    __resetSurfacesCache();
    await prisma.articleSurfaceStat.deleteMany({ where: { portal } });
  });

  afterEach(async () => {
    (env.searchConsole as { enabled: boolean }).enabled = false;
    await prisma.articleSurfaceStat.deleteMany({ where: { portal } });
  });

  it('404s when the feature is disabled (test default)', async () => {
    const res = await request(app).get('/api/reports/surfaces').set('Authorization', AUTH);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('disabled');
  });

  it('serves ready:false before anything has synced, then the payload', async () => {
    (env.searchConsole as { enabled: boolean }).enabled = true;

    const empty = await request(app).get('/api/reports/surfaces').set('Authorization', AUTH);
    expect(empty.status).toBe(200);
    expect(empty.body.ready).toBe(false);
    expect(empty.body.message).toMatch(/2-3 days/);

    // Dated today so it lands in every trailing window regardless of when this runs.
    await seed(portal, [
      [P.itat, 'DISCOVER', new Date().toISOString().slice(0, 10), 300, 4000],
      [P.itat, 'GOOGLE_NEWS', new Date().toISOString().slice(0, 10), 11, 90],
    ]);
    __resetSurfacesCache();

    const res = await request(app).get('/api/reports/surfaces').set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(true);
    expect(res.body.generatedAt).toBeTruthy();
    expect(res.body.dataThrough).toBeTruthy();
    expect(res.body.mode).toBe('months');
    expect(res.body.columns.length).toBeGreaterThan(0);
    expect(res.body.totals[res.body.columns.length - 1].DISCOVER.clicks).toBe(300);
    expect(row(res.body.byBench, 'GOOGLE_NEWS', 'ITAT')?.cells[0]).toEqual({
      clicks: 11,
      impressions: 90,
      articles: 1,
    });
  });

  it('switches to range mode on ?from&to, and 400s on a range it cannot honour', async () => {
    (env.searchConsole as { enabled: boolean }).enabled = true;
    const today = new Date().toISOString().slice(0, 10);
    await seed(portal, [[P.itat, 'DISCOVER', today, 42, 400]]);
    __resetSurfacesCache();

    const ok = await request(app)
      .get(`/api/reports/surfaces?from=${today}&to=${today}`)
      .set('Authorization', AUTH);
    expect(ok.status).toBe(200);
    expect(ok.body.mode).toBe('range');
    expect(ok.body.columns.map((c: { key: string }) => c.key)).toEqual(['current', 'previous']);
    expect(ok.body.totals[0].DISCOVER.clicks).toBe(42);

    const bad = await request(app)
      .get('/api/reports/surfaces?from=2026-06-30&to=2026-06-01')
      .set('Authorization', AUTH);
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('bad_range');
    expect(bad.body.message).toMatch(/on or before/);

    // A half-specified range is a mistake, not a silent fall back to months.
    const half = await request(app)
      .get('/api/reports/surfaces?from=2026-06-01')
      .set('Authorization', AUTH);
    expect(half.status).toBe(400);
  });

  it('rejects unauthenticated requests', async () => {
    const res = await request(app).get('/api/reports/surfaces');
    expect(res.status).toBe(401);
  });
});
