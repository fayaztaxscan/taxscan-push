import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import {
  parseGaDate,
  mergeGaReports,
  syncGaReads,
  startGaReadsSync,
  type GaReport,
  type FetchLike,
  type GaCredentials,
} from '../services/gaReads';

const report = (rows: [string, string, number][]): GaReport => ({
  rowCount: rows.length,
  rows: rows.map(([date, path, views]) => ({
    dimensionValues: [{ value: date }, { value: path }],
    metricValues: [{ value: String(views) }],
  })),
});

describe('parseGaDate', () => {
  it('parses YYYYMMDD to a UTC-midnight date', () => {
    expect(parseGaDate('20260711').toISOString()).toBe('2026-07-11T00:00:00.000Z');
    expect(parseGaDate('20261231').toISOString()).toBe('2026-12-31T00:00:00.000Z');
  });
});

describe('mergeGaReports', () => {
  it('joins totals + push rows by (date, pagePath); missing push → 0', () => {
    const totals = report([
      ['20260710', '/top-stories/a', 100],
      ['20260710', '/top-stories/b', 50],
      ['20260711', '/top-stories/a', 30],
    ]);
    const push = report([['20260710', '/top-stories/a', 12]]);
    const rows = mergeGaReports(totals, push);
    expect(rows).toHaveLength(3);
    const a10 = rows.find((r) => r.pagePath === '/top-stories/a' && r.date.toISOString().startsWith('2026-07-10'));
    expect(a10).toMatchObject({ totalViews: 100, pushViews: 12 });
    const b10 = rows.find((r) => r.pagePath === '/top-stories/b');
    expect(b10).toMatchObject({ totalViews: 50, pushViews: 0 });
    const a11 = rows.find((r) => r.date.toISOString().startsWith('2026-07-11'));
    expect(a11).toMatchObject({ totalViews: 30, pushViews: 0 });
  });

  it('keeps a push-only row (never drops data)', () => {
    const rows = mergeGaReports(report([]), report([['20260710', '/x', 5]]));
    expect(rows).toEqual([
      expect.objectContaining({ pagePath: '/x', totalViews: 5, pushViews: 5 }),
    ]);
  });
});

describe('syncGaReads', () => {
  const portal = `test-ga-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  // The JWT is signed locally before fetch is called, so the key must be a
  // real (throwaway) RSA key even though the token endpoint is mocked.
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const creds: GaCredentials = {
    client_email: 'x@y.iam',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };

  /** fetch mock: token endpoint → fixed token; batchRunReports → given reports. */
  const gaFetch = (totals: GaReport, push: GaReport): FetchLike => async (url) => {
    if (String(url).includes('oauth2.googleapis.com')) {
      return new Response(JSON.stringify({ access_token: `tok-${Math.random()}`, expires_in: 0 }), { status: 200 });
    }
    return new Response(JSON.stringify({ reports: [totals, push] }), { status: 200 });
  };

  afterAll(async () => {
    await prisma.articleReadStat.deleteMany({ where: { portal } });
  });

  it('mirrors GA rows into ArticleReadStat and replaces returned dates on re-sync', async () => {
    const r1 = await syncGaReads({
      creds,
      portal,
      fetchImpl: gaFetch(
        report([
          ['20260710', '/top-stories/a', 100],
          ['20260711', '/top-stories/a', 30],
          ['20260711', '/top-stories/b', 8],
        ]),
        report([['20260710', '/top-stories/a', 12]]),
      ),
    });
    expect(r1).toEqual({ rows: 3, dates: 2 });
    const stored = await prisma.articleReadStat.findMany({ where: { portal }, orderBy: [{ date: 'asc' }, { pagePath: 'asc' }] });
    expect(stored).toHaveLength(3);
    expect(stored[0]).toMatchObject({ pagePath: '/top-stories/a', totalViews: 100, pushViews: 12 });

    // Re-sync: GA now reports settled (higher) numbers for the 11th only; /b
    // dropped out of that date's rows. The 11th is replaced wholesale, the
    // 10th (also returned) is refreshed, no duplicates accumulate.
    const r2 = await syncGaReads({
      creds,
      portal,
      fetchImpl: gaFetch(
        report([
          ['20260710', '/top-stories/a', 100],
          ['20260711', '/top-stories/a', 45],
        ]),
        report([
          ['20260710', '/top-stories/a', 12],
          ['20260711', '/top-stories/a', 9],
        ]),
      ),
    });
    expect(r2).toEqual({ rows: 2, dates: 2 });
    const after = await prisma.articleReadStat.findMany({ where: { portal }, orderBy: [{ date: 'asc' }, { pagePath: 'asc' }] });
    expect(after).toHaveLength(2); // /b gone, no dupes
    expect(after[1]).toMatchObject({ pagePath: '/top-stories/a', totalViews: 45, pushViews: 9 });
  });

  it('leaves existing rows untouched when the GA call fails', async () => {
    const before = await prisma.articleReadStat.count({ where: { portal } });
    const failingFetch: FetchLike = async (url) =>
      String(url).includes('oauth2.googleapis.com')
        ? new Response(JSON.stringify({ access_token: 't', expires_in: 0 }), { status: 200 })
        : new Response(JSON.stringify({ error: { message: 'quota' } }), { status: 429 });
    await expect(syncGaReads({ creds, portal, fetchImpl: failingFetch })).rejects.toThrow(/batchRunReports failed \(429\)/);
    expect(await prisma.articleReadStat.count({ where: { portal } })).toBe(before);
  });
});

describe('startGaReadsSync', () => {
  it('is a no-op when GA_READS_ENABLED is off (default)', () => {
    // env is read at import time; tests run without the flag → must not throw
    // or schedule anything.
    expect(() => startGaReadsSync()).not.toThrow();
  });
});
