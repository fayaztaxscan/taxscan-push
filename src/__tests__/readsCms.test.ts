/**
 * Brief 2026-10-29-cms-reads, acceptance 2–5: the ONE reads module and every reader behind it, with
 * READS_SOURCE=ga (today) and =cms. Postgres fixtures only: nothing here calls Google or the CMS.
 */
import crypto from 'crypto';
import request from 'supertest';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { env } from '../lib/env';
import { listCampaigns } from '../services/metrics';
import {
  GA_NOTE,
  cmsSumsFor,
  externalIdOfPath,
  readsForPaths,
  readsSourceNote,
  readsWindowByPath,
  splitRange,
  readsByPath,
} from '../services/reads';
import { buildReadsReportCms, readsSummaryForWindow } from '../services/readsReport';
import { renderReportEmail } from '../services/reports';
import { cmsReadsSource } from '../services/digest/readsSource';
import type { FetchLike, GaCredentials } from '../services/gaReads';

const RUN = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const ID = `8${RUN.slice(-7)}`; // a unique 8-digit "old CMS news id"
const PORTAL = env.rss.portal;
const day = (s: string) => new Date(`${s}T00:00:00Z`);
const AUTH = `Bearer ${process.env.ADMIN_TOKEN}`;
const app = createApp();

const P = {
  fresh: `/gst/cms-fresh-${RUN}`, // born on the new CMS: no numeric id in the address
  migrated: `/income-tax/same-address-${ID}`, // migrated, address unchanged
  renamed: `/income-tax/old-slug-${ID}1`, // the pushed URL's slug; the CMS row has another slug but the same id
  spanning: `/gst/spans-the-cutover-${RUN}-7777`, // GA before 29 Sep + CMS after
  edge28: `/gst/edge-28-sep-${RUN}-8888`, // GA and CMS rows on 28 Sep: the CMS one must not be used
  nothing: `/gst/nothing-anywhere-${RUN}-9999`,
};
const url = (p: string) => `https://www.taxscan.in${p}`;
const campaignIds: string[] = [];
const rowPaths = Object.values(P);

type V = { articleId: string; path: string; externalId?: string | null; date: string; views: number; push: number | null; digest: number | null };
const cmsRows: V[] = [
  { articleId: `f${RUN}`, path: P.fresh, date: '2026-10-13', views: 400, push: null, digest: null },
  { articleId: `f${RUN}`, path: P.fresh, date: '2026-10-15', views: 1000, push: 100, digest: 20 },
  { articleId: `m${RUN}`, path: P.migrated, externalId: ID, date: '2026-10-20', views: 50, push: 0, digest: 0 },
  { articleId: `r${RUN}`, path: `/income-tax/new-slug-${ID}1`, externalId: `${ID}1`, date: '2026-10-21', views: 70, push: 20, digest: 10 },
  { articleId: `s${RUN}`, path: P.spanning, date: '2026-10-05', views: 70, push: null, digest: null },
  { articleId: `e${RUN}`, path: P.edge28, date: '2026-09-28', views: 12, push: null, digest: null },
];

beforeAll(async () => {
  await prisma.cmsArticleView.createMany({
    data: cmsRows.map((r) => ({ portal: PORTAL, articleId: r.articleId, canonicalPath: r.path, externalId: r.externalId ?? null, date: day(r.date), views: r.views, pushViews: r.push, digestViews: r.digest, cmsUpdatedAt: new Date('2026-10-29T05:00:00Z'), fetchedAt: new Date() })),
  });
  await prisma.articleReadStat.createMany({
    data: [
      { portal: PORTAL, pagePath: P.spanning, date: day('2026-09-20'), totalViews: 50, pushViews: 5 },
      { portal: PORTAL, pagePath: `${P.spanning}/`, date: day('2026-09-21'), totalViews: 7, pushViews: 0 }, // GA's trailing-slash spelling
      { portal: PORTAL, pagePath: P.edge28, date: day('2026-09-28'), totalViews: 40, pushViews: 4 },
      { portal: PORTAL, pagePath: P.fresh, date: day('2026-10-13'), totalViews: 90, pushViews: 9 }, // GA also saw it (after the cut-over)
    ],
  });
  const mk = async (p: string) => {
    const c = await prisma.campaign.create({ data: { portal: PORTAL, title: `reads-test ${p}`, body: 'b', url: url(p), target: { type: 'all' }, status: 'SENT' } });
    campaignIds.push(c.id);
    return c.id;
  };
  for (const p of rowPaths) await mk(p);
});

afterEach(() => {
  env.cmsViews.source = 'ga';
});

afterAll(async () => {
  await prisma.cmsArticleView.deleteMany({ where: { portal: PORTAL, articleId: { in: cmsRows.map((r) => r.articleId) } } });
  await prisma.articleReadStat.deleteMany({ where: { portal: PORTAL, pagePath: { in: [...rowPaths, ...rowPaths.map((p) => `${p}/`)] } } });
  await prisma.campaign.deleteMany({ where: { id: { in: campaignIds } } });
  await prisma.$disconnect();
});

const find = async () => {
  const all = await listCampaigns(500);
  return (p: string) => all.find((c) => c.title === `reads-test ${p}`)!;
};

describe('the source split', () => {
  it('splitRange: GA answers dates before READS_CMS_FROM, the CMS from it; ga mode is GA for everything', () => {
    expect(splitRange(undefined, 'cms', '2026-09-29')).toEqual({ ga: { from: null, to: '2026-09-28' }, cms: { from: '2026-09-29', to: null } });
    expect(splitRange({ from: '2026-10-01', to: '2026-10-10' }, 'cms', '2026-09-29')).toEqual({ ga: null, cms: { from: '2026-10-01', to: '2026-10-10' } });
    expect(splitRange({ from: '2026-09-01', to: '2026-09-20' }, 'cms', '2026-09-29')).toEqual({ ga: { from: '2026-09-01', to: '2026-09-20' }, cms: null });
    expect(splitRange({ from: '2026-09-01', to: '2026-10-10' }, 'cms', '2026-09-29')).toEqual({ ga: { from: '2026-09-01', to: '2026-09-28' }, cms: { from: '2026-09-29', to: '2026-10-10' } });
    expect(splitRange({ from: '2026-09-01', to: '2026-10-10' }, 'ga', '2026-09-29')).toEqual({ ga: { from: '2026-09-01', to: '2026-10-10' }, cms: null });
  });

  it('ga mode: every date from GA, the CMS rows are ignored — identical to readsByPath', async () => {
    const paths = [P.fresh, P.spanning, P.edge28, P.nothing];
    const viaModule = await readsForPaths(paths, { portal: PORTAL, mode: 'ga' });
    const direct = await readsByPath(paths, PORTAL);
    expect([...viaModule.keys()].sort()).toEqual([...direct.keys()].sort());
    for (const [p, d] of direct) expect(viaModule.get(p)).toEqual({ views: d.reads, pushViews: d.pushReads, usedGa: true, usedCms: false });
    expect(viaModule.get(P.fresh)?.views).toBe(90); // GA's number, not the CMS's 1,400
    expect(viaModule.has(P.nothing)).toBe(false);
  });

  it('cms mode: dates from READS_CMS_FROM are the CMS\'s; a path matches by canonical path, then by the old id; no match = absent', async () => {
    const m = await readsForPaths([P.fresh, P.migrated, P.renamed, P.nothing], { portal: PORTAL, mode: 'cms', cmsFrom: '2026-09-29' });
    expect(m.get(P.fresh)).toEqual({ views: 1400, pushViews: null, usedGa: false, usedCms: true }); // 400 (push unknown) + 1000; GA's 90 is NOT added
    expect(m.get(P.migrated)).toEqual({ views: 50, pushViews: 0, usedGa: false, usedCms: true }); // a real 0 stays 0
    expect(m.get(P.renamed)).toEqual({ views: 70, pushViews: 20, usedGa: false, usedCms: true }); // other slug, same old id
    expect(m.has(P.nothing)).toBe(false);
  });

  it('unknown is not zero: push_views is null while any contributing CMS day has none, and known once the range starts on 15 Oct', async () => {
    const all = await readsForPaths([P.fresh], { portal: PORTAL, mode: 'cms' });
    expect(all.get(P.fresh)?.pushViews).toBeNull();
    const known = await readsForPaths([P.fresh], { portal: PORTAL, mode: 'cms', range: { from: '2026-10-15' } });
    expect(known.get(P.fresh)).toMatchObject({ views: 1000, pushViews: 100 });
  });

  it('a range spanning READS_CMS_FROM sums GA before + CMS from, and says both were used', async () => {
    const r = (await readsForPaths([P.spanning], { portal: PORTAL, mode: 'cms' })).get(P.spanning)!;
    expect(r.views).toBe(50 + 7 + 70); // GA 20 Sep + GA 21 Sep (the slash spelling) + CMS 5 Oct
    expect(r).toMatchObject({ usedGa: true, usedCms: true, pushViews: null }); // the CMS day has no push count
    expect(readsSourceNote('cms', { ga: r.usedGa, cms: r.usedCms }, '2026-09-29')).toBe('Reads: CMS from 29 Sep, GA4 before');
  });

  it('28 Sep is GA\'s by default (it is a partial CMS day): the CMS row for that date is stored but not used', async () => {
    const r = (await readsForPaths([P.edge28], { portal: PORTAL, mode: 'cms' })).get(P.edge28)!;
    expect(r).toEqual({ views: 40, pushViews: 4, usedGa: true, usedCms: false });
    const asked = (await readsForPaths([P.edge28], { portal: PORTAL, mode: 'cms', cmsFrom: '2026-09-28' })).get(P.edge28)!;
    expect(asked).toMatchObject({ views: 12, usedCms: true });
  });

  it('matching: the trailing-id rule, and the counts against these fixtures', async () => {
    expect(externalIdOfPath('/income-tax/some-title-1452345')).toBe('1452345');
    expect(externalIdOfPath('/gst/no-id-here')).toBeNull();
    expect(externalIdOfPath('/x/y-123')).toBeNull(); // fewer than 4 digits is not an id (articleKey's rule)
    const asked = [P.fresh, P.migrated, P.renamed, P.spanning, P.edge28, P.nothing];
    const got = await readsForPaths(asked, { portal: PORTAL, mode: 'cms', cmsFrom: '2026-09-28' });
    const matched = asked.filter((p) => got.has(p));
    expect({ matched: matched.length, unmatched: asked.length - matched.length }).toEqual({ matched: 5, unmatched: 1 });
    expect(cmsSumsFor('/income-tax/anything-else-12345678', [])).toEqual([]);
  });

  it('the source note: GA4 caveat, "Reads: CMS", or both', () => {
    expect(readsSourceNote('ga', { ga: true, cms: false })).toBe(GA_NOTE);
    expect(GA_NOTE).toBe('Reads: GA4 (≈1 in 10 readers since 29 Sep)');
    expect(readsSourceNote('cms', { ga: false, cms: true })).toBe('Reads: CMS');
    expect(readsSourceNote('cms', { ga: true, cms: false })).toBe(GA_NOTE);
    expect(readsSourceNote('cms', { ga: true, cms: true }, '2026-09-29')).toBe('Reads: CMS from 29 Sep, GA4 before');
  });
});

describe('Campaigns (listCampaigns and GET /api/campaigns)', () => {
  it('READS_SOURCE=ga: GA numbers only, no new field anywhere in the payload', async () => {
    const f = await find();
    expect(f(P.fresh)).toMatchObject({ reads: 90, pushReads: 9 });
    expect(f(P.nothing)).toMatchObject({ reads: null, pushReads: null });
    for (const c of await listCampaigns(500)) expect('readsFrom' in c).toBe(false);
    const res = await request(app).get('/api/campaigns?limit=200').set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['campaigns']);
  });

  it('READS_SOURCE=cms: a campaign whose article has CMS rows shows the CMS numbers; "—" for no data; unknown push is null', async () => {
    env.cmsViews.source = 'cms';
    const f = await find();
    expect(f(P.fresh)).toMatchObject({ reads: 1400, pushReads: null, readsFrom: ['cms'] });
    expect(f(P.migrated)).toMatchObject({ reads: 50, pushReads: 0 });
    expect(f(P.renamed)).toMatchObject({ reads: 70, pushReads: 20 });
    expect(f(P.spanning)).toMatchObject({ reads: 127, readsFrom: ['ga', 'cms'] });
    expect(f(P.nothing)).toMatchObject({ reads: null, pushReads: null });
    expect(f(P.nothing).readsFrom).toBeUndefined();
  });

  it('the API says where the numbers came from only in cms mode', async () => {
    env.cmsViews.source = 'cms';
    const res = await request(app).get('/api/campaigns?limit=200').set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(res.body.readsSource).toEqual({ mode: 'cms', note: 'Reads: CMS from 29 Sep, GA4 before' });
  });
});

describe('the coverage email\'s "How it was read"', () => {
  const portal = `test-reads-email-${RUN}`;
  beforeAll(async () => {
    await prisma.cmsArticleView.createMany({
      data: [
        { portal, articleId: `a${RUN}`, canonicalPath: '/gst/new-cms-story-without-an-id', date: day('2026-10-14'), views: 300, pushViews: null, digestViews: null, cmsUpdatedAt: new Date(), fetchedAt: new Date() },
        { portal, articleId: `b${RUN}`, canonicalPath: '/income-tax/a-migrated-story-1452345', externalId: '1452345', date: day('2026-10-16'), views: 200, pushViews: 50, digestViews: 5, cmsUpdatedAt: new Date(), fetchedAt: new Date() },
      ],
    });
    await prisma.articleReadStat.createMany({
      data: [
        { portal, pagePath: '/gst/a-ga-story-9999999', date: day('2026-09-25'), totalViews: 80, pushViews: 8 },
        { portal, pagePath: '/', date: day('2026-09-25'), totalViews: 999, pushViews: 0 }, // not an article page
      ],
    });
  });
  afterAll(async () => {
    await prisma.cmsArticleView.deleteMany({ where: { portal } });
    await prisma.articleReadStat.deleteMany({ where: { portal } });
  });

  it('ga mode: unchanged — only GA\'s article pages (numeric id), no source field, the existing Google Analytics wording', async () => {
    const r = await readsSummaryForWindow({ start: new Date('2026-09-23T18:30:00Z'), end: new Date('2026-10-18T18:30:00Z'), portal });
    expect(r).toMatchObject({ totalReads: 80, pushReads: 8 });
    expect(r?.sourceNote).toBeUndefined();
    expect(renderReportEmail(emptyReport(), r!).html).toContain('(Google Analytics)');
  });

  it('cms mode: the CMS stories count (new stories have no numeric id), GA only before the cut-over, and the email says so', async () => {
    env.cmsViews.source = 'cms';
    const r = (await readsSummaryForWindow({ start: new Date('2026-09-23T18:30:00Z'), end: new Date('2026-10-18T18:30:00Z'), portal }))!;
    expect(r.totalReads).toBe(80 + 300 + 200);
    expect(r.pushReads).toBe(8 + 50); // the unknown day contributes nothing to "via push"
    expect(r.sourceNote).toBe('Reads: CMS from 29 Sep, GA4 before');
    expect(r.topArticles[0]).toMatchObject({ reads: 300 });
    const mail = renderReportEmail(emptyReport(), r);
    expect(mail.html).toContain('Reads: CMS from 29 Sep, GA4 before');
    expect(mail.html).not.toContain('(Google Analytics)');
    expect(mail.text).toContain('Reads: CMS from 29 Sep, GA4 before');
    const win = await readsWindowByPath('2026-10-12', '2026-10-18', { portal, mode: 'cms' });
    expect(win.get('/gst/new-cms-story-without-an-id')).toMatchObject({ views: 300, usedCms: true, usedGa: false });
  });
});

function emptyReport() {
  return {
    period: 'weekly', start: '2026-10-12', end: '2026-10-18', dates: ['2026-10-12'], total: 5, prevTotal: 4,
    byCategory: { rows: [], dates: ['2026-10-12'], dayTotals: [5], grandTotal: 5 },
    byBench: { rows: [], dates: ['2026-10-12'], dayTotals: [5], grandTotal: 5 },
    quality: { qualified: 3, fallback: 1, review: 1, uncategorized: 0 },
    gaps: { benchesWithNothing: [] },
  } as never;
}

describe('the Reports → Reads tab build in cms mode', () => {
  const portal = `test-reads-report-${RUN}`;
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const creds: GaCredentials = { client_email: 'x@y.iam', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
  beforeAll(async () => {
    await prisma.cmsArticleView.createMany({
      data: [
        { portal, articleId: `x${RUN}`, canonicalPath: '/top-stories/itat-deletes-addition-on-cash-deposits', date: day('2026-10-25'), views: 600, pushViews: 10, digestViews: 5, cmsUpdatedAt: new Date(), fetchedAt: new Date() },
        { portal, articleId: `y${RUN}`, canonicalPath: '/top-stories/supreme-court-upholds-gst-notification', date: day('2026-10-02'), views: 300, pushViews: null, digestViews: null, cmsUpdatedAt: new Date(), fetchedAt: new Date() },
      ],
    });
  });
  afterAll(async () => {
    await prisma.cmsArticleView.deleteMany({ where: { portal } });
  });

  const calls: { window: { startDate: string; endDate: string }; dims: boolean }[] = [];
  const gaFetch: FetchLike = async (u, init) => {
    if (String(u).includes('oauth2.googleapis.com')) return new Response(JSON.stringify({ access_token: 't', expires_in: 0 }), { status: 200 });
    const body = JSON.parse(String(init?.body ?? '{}'));
    calls.push({ window: body.dateRanges[0], dims: !!body.dimensions });
    if (!body.dimensions) return new Response(JSON.stringify({ rowCount: 1, rows: [{ dimensionValues: [], metricValues: [{ value: '5000' }] }] }), { status: 200 });
    return new Response(
      JSON.stringify({ rowCount: 1, rows: [{ dimensionValues: [{ value: '/top-stories/old-gst-ruling-1111111' }, { value: 'CBDT extends ITR filing deadline - Taxscan' }], metricValues: [{ value: '100' }] }] }),
      { status: 200 },
    );
  };

  it('windows inside the CMS era use only the CMS; longer ones add GA for the days BEFORE READS_CMS_FROM; the payload names its source', async () => {
    calls.length = 0;
    const p = await buildReadsReportCms({ creds, fetchImpl: gaFetch, now: new Date('2026-10-29T10:00:00Z'), portal, cmsFrom: '2026-09-29' });
    expect(p.source).toMatchObject({ mode: 'cms', cmsFrom: '2026-09-29', usedGa: true, note: 'Reads: CMS from 29 Sep, GA4 before' });
    // 1 week (from 22 Oct): CMS only — 600.
    expect(p.windows[0]).toMatchObject({ label: '1 week', articleViews: 600, articlesRead: 1 });
    // 1 month (from 29 Sep): still CMS only — 600 + 300.
    expect(p.windows[1]).toMatchObject({ label: '1 month', articleViews: 900, articlesRead: 2 });
    // 3 months: CMS 900 + GA 100 (the GA mock ignores dates, but the request ended on 28 Sep).
    expect(p.windows[2]).toMatchObject({ label: '3 months', articleViews: 1000, articlesRead: 3 });
    const gaDates = calls.map((c) => c.window.endDate);
    expect(new Set(gaDates)).toEqual(new Set(['2026-09-28'])); // GA is never asked about a CMS-era day
    expect(calls.length).toBeGreaterThan(0);
    // Stories are classified from the slug where the CMS had no headline.
    expect(p.benches.find((b) => b.label === 'ITAT')?.cells[0]).toMatchObject({ views: 600, articles: 1 });
    expect(p.benches.find((b) => b.label === 'Supreme Court')?.cells[1]).toMatchObject({ views: 300 });
  });

  it('without GA credentials it is a CMS-only build ("Reads: CMS")', async () => {
    const p = await buildReadsReportCms({ creds: null, now: new Date('2026-10-29T10:00:00Z'), portal, cmsFrom: '2026-09-29' });
    expect(p.source).toMatchObject({ usedGa: false, note: 'Reads: CMS' });
    expect(p.windows[4].articleViews).toBe(900);
  });

  it('the route never serves a build of the other source, and says nothing new while READS_SOURCE=ga', async () => {
    const stored = await prisma.gaReadsReport.findUnique({ where: { portal: PORTAL } });
    await prisma.gaReadsReport.upsert({ where: { portal: PORTAL }, create: { portal: PORTAL, payload: { windows: [], categories: [], benches: [] } }, update: { payload: { windows: [], categories: [], benches: [] } } });
    const enabled = env.gaReads.enabled;
    env.gaReads.enabled = true;
    try {
      const ga = await request(app).get('/api/reports/reads').set('Authorization', AUTH);
      expect(ga.body).toMatchObject({ ready: true });
      expect(ga.body.source).toBeUndefined();
      env.cmsViews.source = 'cms';
      const cms = await request(app).get('/api/reports/reads').set('Authorization', AUTH);
      expect(cms.body).toMatchObject({ ready: false });
      expect(cms.body.message).toMatch(/rebuilt for the new reads source/);
    } finally {
      env.gaReads.enabled = enabled;
      if (stored) await prisma.gaReadsReport.update({ where: { portal: PORTAL }, data: { payload: stored.payload as object } });
      else await prisma.gaReadsReport.delete({ where: { portal: PORTAL } }).catch(() => undefined);
    }
  });
});

describe('the digest\'s ranking input (organic reads)', () => {
  const portal = `test-reads-digest-${RUN}`;
  const NOW = new Date('2026-10-29T10:00:00Z');
  beforeAll(async () => {
    await prisma.cmsArticleView.createMany({
      data: [
        // both known: organic = 1000 − 100 − 20 = 880
        { portal, articleId: `d1${RUN}`, canonicalPath: '/gst/ranked-one', date: day('2026-10-28'), views: 1000, pushViews: 100, digestViews: 20, cmsUpdatedAt: NOW, fetchedAt: NOW },
        // push unknown (before 15 Oct): organic = views
        { portal, articleId: `d2${RUN}`, canonicalPath: '/gst/ranked-two', date: day('2026-10-10'), views: 300, pushViews: null, digestViews: null, cmsUpdatedAt: NOW, fetchedAt: NOW },
        // known but exceeding the views (a visit counted in both): clamped at 0, never negative
        { portal, articleId: `d3${RUN}`, canonicalPath: '/gst/ranked-three', date: day('2026-10-28'), views: 10, pushViews: 9, digestViews: 9, cmsUpdatedAt: NOW, fetchedAt: NOW },
        // one story across two days, one known and one not: per-row rule (880... here 500 − 50 − 0, then 100 as is)
        { portal, articleId: `d4${RUN}`, canonicalPath: '/gst/ranked-four', date: day('2026-10-28'), views: 500, pushViews: 50, digestViews: 0, cmsUpdatedAt: NOW, fetchedAt: NOW },
        { portal, articleId: `d4${RUN}`, canonicalPath: '/gst/ranked-four', date: day('2026-10-12'), views: 100, pushViews: null, digestViews: null, cmsUpdatedAt: NOW, fetchedAt: NOW },
        // a migrated story the builder knows only by its key
        { portal, articleId: `d5${RUN}`, canonicalPath: '/gst/renamed-in-cms', externalId: '1999001', date: day('2026-10-28'), views: 40, pushViews: 0, digestViews: 0, cmsUpdatedAt: NOW, fetchedAt: NOW },
      ],
    });
  });
  afterAll(async () => {
    await prisma.cmsArticleView.deleteMany({ where: { portal } });
  });
  const src = (over: Record<string, unknown> = {}) => cmsReadsSource({ enabled: true, portal, lastSyncAt: async () => NOW, ...over });
  const art = (key: string, ...paths: string[]) => ({ key, paths, capturedAt: NOW });

  it('organic = views − push_views − digest_views when both are known, else views; clamped ≥ 0; summed per row', async () => {
    const r = await src().organicReads([art('article:1', '/gst/ranked-one'), art('article:2', '/gst/ranked-two'), art('article:3', '/gst/ranked-three'), art('article:4', '/gst/ranked-four'), art('article:5', '/gst/never-read')], NOW);
    expect(r.fresh).toBe(true);
    expect(r.byKey.get('article:1')).toBe(880);
    expect(r.byKey.get('article:2')).toBe(300);
    expect(r.byKey.get('article:3')).toBe(0);
    expect(r.byKey.get('article:4')).toBe(450 + 100);
    expect(r.byKey.has('article:5')).toBe(false); // no rows: "no data", not 0
  });

  it('a migrated story is found by the id in its key when its path changed', async () => {
    const r = await src().organicReads([art('article:1999001', '/gst/the-old-slug-1999001')], NOW);
    expect(r.byKey.get('article:1999001')).toBe(40);
  });

  it('not fresh when the sync is off, never ran, or went quiet (the builder then ranks newest-first)', async () => {
    expect(await src({ enabled: false }).organicReads([art('article:1', '/gst/ranked-one')], NOW)).toMatchObject({ fresh: false, reason: 'cms_views_disabled' });
    expect(await src({ lastSyncAt: async () => null }).organicReads([art('article:1', '/gst/ranked-one')], NOW)).toMatchObject({ fresh: false, reason: 'no_read_data' });
    const old = await src({ lastSyncAt: async () => new Date(NOW.getTime() - 7 * 3_600_000) }).organicReads([art('article:1', '/gst/ranked-one')], NOW);
    expect(old.fresh).toBe(false);
    expect(old.reason).toMatch(/^stale_since_/);
  });
});
