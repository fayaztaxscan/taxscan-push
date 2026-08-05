import request from 'supertest';
import type { SearchSurface } from '@prisma/client';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { env } from '../lib/env';
import {
  buildSurfacesReport,
  getSurfacesReport,
  __resetSurfacesCache,
  type SurfaceGrid,
  type SurfacesPayload,
} from '../services/surfacesReport';
import { READ_WINDOWS } from '../services/readsReport';

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

/** Window index by label, so assertions don't hard-code READ_WINDOWS order. */
const wi = (label: string) => READ_WINDOWS.findIndex((w) => w.label === label);

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

  it('reports the trailing windows the Reads tab uses, and how fresh the data is', () => {
    expect(payload.windows.map((w) => w.label)).toEqual(READ_WINDOWS.map((w) => w.label));
    expect(payload.dataThrough).toBe('2026-08-05');
  });

  it('keeps the IST day boundary: today counts, the 1-week edge day counts, the day before does not', () => {
    const week = payload.windows[wi('1 week')].totals;
    // 500 (today, IST) + 100 (edge day) + 0 (impressions-only). The 2026-07-28
    // rows and the homepage row are excluded.
    expect(week.DISCOVER).toEqual({ clicks: 600, impressions: 15200, articles: 3 });

    const month = payload.windows[wi('1 month')].totals;
    expect(month.DISCOVER).toEqual({ clicks: 647, impressions: 16070, articles: 5 });
  });

  it('keeps the two surfaces apart for the same article and day', () => {
    expect(payload.windows[wi('1 week')].totals.GOOGLE_NEWS).toEqual({
      clicks: 20,
      impressions: 400,
      articles: 1,
    });
    expect(row(payload.byCategory, 'DISCOVER', 'Income Tax')?.cells[wi('1 week')]).toEqual({
      clicks: 500,
      impressions: 9000,
      articles: 1,
    });
    expect(row(payload.byCategory, 'GOOGLE_NEWS', 'Income Tax')?.cells[wi('1 week')]).toEqual({
      clicks: 20,
      impressions: 400,
      articles: 1,
    });
    // The other surface's rows never leak into this one's grid.
    expect(row(payload.byCategory, 'GOOGLE_NEWS', 'GST')).toBeUndefined();
  });

  it('distinguishes "no pickup" (null) from a synced zero-click row', () => {
    const customs = row(payload.byCategory, 'DISCOVER', 'Customs');
    expect(customs?.cells[wi('1 week')]).toBeNull();
    expect(customs?.cells[wi('1 month')]).toEqual({ clicks: 40, impressions: 800, articles: 1 });

    // Impressions without a single click is a finding, not an absence.
    expect(row(payload.byCategory, 'DISCOVER', 'SEBI/RBI')?.cells[wi('1 week')]).toEqual({
      clicks: 0,
      impressions: 1200,
      articles: 1,
    });
  });

  it('labels and orders rows with the coverage report helpers', () => {
    // Categories by widest-window clicks: Income Tax 507, GST 100, Customs 40, SEBI/RBI 0.
    expect(grid(payload.byCategory, 'DISCOVER').rows.map((r) => r.label)).toEqual([
      'Income Tax',
      'GST',
      'Customs',
      'SEBI/RBI',
    ]);
    expect(row(payload.byCategory, 'DISCOVER', 'Income Tax')?.cells[wi('1 month')]).toEqual({
      clicks: 507,
      impressions: 9070,
      articles: 2,
    });

    // Benches by judicial hierarchy (benchRank), never by volume — the Supreme
    // Court row (100 clicks) leads the ITAT row (500), residual rows last.
    expect(grid(payload.byBench, 'DISCOVER').rows.map((r) => r.label)).toEqual([
      'Supreme Court',
      'ITAT',
      'No bench – News',
    ]);
    expect(row(payload.byBench, 'DISCOVER', 'No bench – News')?.cells[wi('1 month')]).toEqual({
      clicks: 47,
      impressions: 2070,
      articles: 3,
    });
  });

  it('tops the list by clicks, with the real headline where we captured the article', () => {
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
    expect(payload.windows).toHaveLength(READ_WINDOWS.length);
    expect(payload.windows[0].totals.DISCOVER).toEqual({ clicks: 0, impressions: 0, articles: 0 });
    expect(grid(payload.byCategory, 'DISCOVER').rows).toEqual([]);
    expect(payload.topArticles.GOOGLE_NEWS).toEqual([]);
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
    expect(first.windows[wi('1 week')].totals.DISCOVER.clicks).toBe(10);

    await seed(portal, [[P.sc, 'DISCOVER', '2026-08-04', 5, 50]]);
    const cached = await getSurfacesReport(portal, { ttlMs: 60_000, now: NOW });
    expect(cached.windows[wi('1 week')].totals.DISCOVER.clicks).toBe(10);

    __resetSurfacesCache();
    const fresh = await getSurfacesReport(portal, { ttlMs: 60_000, now: NOW });
    expect(fresh.windows[wi('1 week')].totals.DISCOVER.clicks).toBe(15);
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
    expect(res.body.windows).toHaveLength(READ_WINDOWS.length);
    expect(res.body.windows[0].totals.DISCOVER.clicks).toBe(300);
    expect(row(res.body.byBench, 'GOOGLE_NEWS', 'ITAT')?.cells[0]).toEqual({
      clicks: 11,
      impressions: 90,
      articles: 1,
    });
  });

  it('rejects unauthenticated requests', async () => {
    const res = await request(app).get('/api/reports/surfaces');
    expect(res.status).toBe(401);
  });
});
