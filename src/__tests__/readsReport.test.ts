import crypto from 'crypto';
import request from 'supertest';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { env } from '../lib/env';
import {
  cleanPageTitle,
  buildReadsReport,
  refreshReadsReport,
  getReadsReport,
  isArticlePath,
  readsSummaryForWindow,
  READ_WINDOWS,
} from '../services/readsReport';
import type { FetchLike, GaCredentials } from '../services/gaReads';

const app = createApp();
const AUTH = `Bearer ${process.env.ADMIN_TOKEN}`;

// The JWT is signed locally before the mocked fetch is reached, so a real
// (throwaway) RSA key is required.
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const creds: GaCredentials = {
  client_email: 'x@y.iam',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
};

type Row = [path: string, title: string, views: number];
const gaRows = (rows: Row[]) => ({
  rowCount: rows.length,
  rows: rows.map(([path, title, views]) => ({
    dimensionValues: [{ value: path }, { value: title }],
    metricValues: [{ value: String(views) }],
  })),
});

/**
 * fetch mock: the token endpoint returns a throwaway token; a runReport call
 * WITHOUT dimensions is the site-total; one WITH dimensions gets the given
 * article rows (same set for every window — windows only differ by dateRange,
 * which the mock ignores).
 */
function gaFetch(articles: Row[], siteViews = 1000): FetchLike {
  return async (url, init) => {
    if (String(url).includes('oauth2.googleapis.com')) {
      return new Response(JSON.stringify({ access_token: 't', expires_in: 0 }), { status: 200 });
    }
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (!body.dimensions) {
      return new Response(
        JSON.stringify({ rowCount: 1, rows: [{ dimensionValues: [], metricValues: [{ value: String(siteViews) }] }] }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify(gaRows(articles)), { status: 200 });
  };
}

describe('cleanPageTitle', () => {
  it('strips the site suffix before classification', () => {
    expect(cleanPageTitle('ITAT quashes reassessment - Taxscan')).toBe('ITAT quashes reassessment');
    expect(cleanPageTitle('GST fraud case | plain title')).toBe('GST fraud case | plain title');
  });
});

describe('isArticlePath', () => {
  it.each([
    '/gst/foo-bar-12345',
    '/gst/foo-bar',
    '/other-taxations/foo',
    '/income-tax/foo/',
    '/foo-bar-12345', // an old one-segment id, as before
    '/top-stories/a-story-1448729/',
    '/corporate-laws/foo',
    '/excise-customs/foo',
    '/cst-vat/foo',
    '/service-tax/foo',
    '/job-scan/foo',
    '/news-updates/foo',
    '/top-stories/foo',
  ])('%s is an article', (path) => {
    expect(isArticlePath(path)).toBe(true);
  });

  it.each([
    '/trackers/gst',
    '/trackers/income-tax',
    '/subscription/x',
    '/pricing',
    '/',
    '',
    '/gst',
    '/gst/',
    '/foo-bar', // one segment, no id
    '/gst/page/2', // three segments
    '/tag/gst/foo',
    '/gstx/foo', // the section must match exactly
  ])('"%s" is not an article', (path) => {
    expect(isArticlePath(path)).toBe(false);
  });
});

describe('readsSummaryForWindow from GA rows, new-CMS URLs', () => {
  const portal = `test-reads-newurls-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

  afterAll(async () => {
    await prisma.articleReadStat.deleteMany({ where: { portal } });
  });

  it('counts an id-less article and leaves site pages out', async () => {
    const date = new Date('2026-10-03');
    await prisma.articleReadStat.createMany({
      data: [
        { portal, pagePath: `/gst/${portal}-story`, date, totalViews: 70, pushViews: 7 },
        { portal, pagePath: `/income-tax/${portal}-old-444444`, date, totalViews: 20, pushViews: 2 },
        { portal, pagePath: '/trackers/gst', date, totalViews: 900, pushViews: 9 },
        { portal, pagePath: '/pricing', date, totalViews: 800, pushViews: 8 },
      ],
    });
    const s = await readsSummaryForWindow({
      start: new Date('2026-10-01T18:30:00Z'),
      end: new Date('2026-10-04T18:30:00Z'),
      portal,
    });
    expect(s).toMatchObject({ totalReads: 90, pushReads: 9 });
    expect(s!.topArticles.map((a) => a.reads)).toEqual([70, 20]);
  });
});

describe('buildReadsReport', () => {
  it('aggregates by bench and category with per-window shares, report ordering', async () => {
    const payload = await buildReadsReport({
      creds,
      fetchImpl: gaFetch([
        ['/top-stories/a-111111', 'ITAT deletes addition on cash deposits - Taxscan', 600],
        ['/top-stories/b-222222', 'Supreme Court upholds GST notification - Taxscan', 300],
        ['/top-stories/c-333333', 'CBDT extends ITR filing deadline - Taxscan', 100],
      ]),
    });

    expect(payload.windows).toHaveLength(READ_WINDOWS.length);
    expect(payload.windows[0]).toMatchObject({ label: '1 week', siteViews: 1000, articleViews: 1000, articlesRead: 3 });

    const bench = (l: string) => payload.benches.find((b) => b.label === l);
    expect(bench('ITAT')?.cells[0]).toMatchObject({ views: 600, articles: 1, share: 0.6 });
    expect(bench('Supreme Court')?.cells[0]).toMatchObject({ views: 300, share: 0.3 });
    // Report ordering: SC before ITAT, residual "no bench" rows last. The CBDT
    // deadline item names no court → "No bench – News" (it's news, not knowledge).
    const labels = payload.benches.map((b) => b.label);
    expect(labels.indexOf('Supreme Court')).toBeLessThan(labels.indexOf('ITAT'));
    expect(labels[labels.length - 1]).toBe('No bench – News');

    // Categories ordered by 12-month views desc: Income Tax (700) before GST (300).
    expect(payload.categories[0].label).toBe('Income Tax');
    expect(payload.categories[0].cells[4]).toMatchObject({ views: 700, articles: 2, share: 0.7 });
    expect(payload.categories[1].label).toBe('GST');
  });
});

describe('refreshReadsReport + getReadsReport', () => {
  const portal = `test-reads-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

  afterAll(async () => {
    await prisma.gaReadsReport.deleteMany({ where: { portal } });
  });

  it('upserts one row per portal; re-runs replace the payload, not duplicate it', async () => {
    await refreshReadsReport({ creds, portal, fetchImpl: gaFetch([['/x-111111', 'ITAT ruling - Taxscan', 10]]) });
    const first = await getReadsReport(portal);
    expect(first?.payload.benches.find((b) => b.label === 'ITAT')?.cells[0]?.views).toBe(10);

    await refreshReadsReport({ creds, portal, fetchImpl: gaFetch([['/x-111111', 'ITAT ruling - Taxscan', 25]]) });
    const rows = await prisma.gaReadsReport.findMany({ where: { portal } });
    expect(rows).toHaveLength(1);
    const second = await getReadsReport(portal);
    expect(second?.payload.benches.find((b) => b.label === 'ITAT')?.cells[0]?.views).toBe(25);
  });
});

describe('GET /api/reports/reads', () => {
  const portal = env.rss.portal;

  afterEach(async () => {
    (env.gaReads as { enabled: boolean }).enabled = false;
    await prisma.gaReadsReport.deleteMany({ where: { portal } });
  });

  it('404s when the feature is disabled (test default)', async () => {
    const res = await request(app).get('/api/reports/reads').set('Authorization', AUTH);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('disabled');
  });

  it('serves ready:false before the first build, then the cached payload', async () => {
    (env.gaReads as { enabled: boolean }).enabled = true;

    const empty = await request(app).get('/api/reports/reads').set('Authorization', AUTH);
    expect(empty.status).toBe(200);
    expect(empty.body.ready).toBe(false);

    await refreshReadsReport({ creds, portal, fetchImpl: gaFetch([['/x-111111', 'ITAT ruling - Taxscan', 10]]) });
    const res = await request(app).get('/api/reports/reads').set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(true);
    expect(res.body.generatedAt).toBeTruthy();
    expect(res.body.windows).toHaveLength(READ_WINDOWS.length);
    expect(res.body.benches.find((b: { label: string }) => b.label === 'ITAT').cells[0].views).toBe(10);
  });

  it('rejects unauthenticated requests', async () => {
    const res = await request(app).get('/api/reports/reads');
    expect(res.status).toBe(401);
  });
});
