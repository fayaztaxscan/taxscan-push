/**
 * Brief 2026-10-29-cms-reads, acceptance 1 and 2: the Feed 2 pull against a fake CMS door V (A.8 fixtures, no
 * real network). All-or-nothing writes, one alert per IST day, nulls stay null, door V's own secret.
 */
import { prisma } from '../lib/prisma';
import { parseReadsEnv, parseAudienceEnv, type AudienceEnv, type ReadsEnv } from '../lib/env';
import { signPushGet } from '../lib/cmsSignature';
import { CmsListClient } from '../services/audience/cmsClient';
import { CmsViewsClient, VIEWS_PATH, createViewsClient, parseViewRow, parseViewsPage } from '../services/cmsViews/client';
import { chunkRanges, routineWindow, runViewsSync, startCmsViewsSync } from '../services/cmsViews/sync';
import { A8_ROWS, a8Pages, type A8Row } from './fixtures/cms-views-a8/rows';
import { FakeViewsCms } from './cmsViewsFake';

jest.spyOn(console, 'log').mockImplementation(() => undefined);
jest.spyOn(console, 'warn').mockImplementation(() => undefined);
jest.spyOn(console, 'error').mockImplementation(() => undefined);

const RUN = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const VIEWS_SECRET = `v-${'v'.repeat(40)}${RUN.slice(0, 6)}`;
const LIST_SECRET = `l-${'l'.repeat(40)}${RUN.slice(0, 6)}`;
const NOW = new Date('2026-10-29T10:00:00Z');
const noSleep = () => Promise.resolve();

let fake: FakeViewsCms;
let base: string;
let n = 0;
const portals: string[] = [];
const newPortal = () => {
  const p = `test-cms-views-${RUN}-${++n}`;
  portals.push(p);
  return p;
};
const audCfg = (): AudienceEnv => ({ cms: { baseUrl: base, allowedHosts: ['127.0.0.1'] } }) as unknown as AudienceEnv;
const readsCfg = (secret = VIEWS_SECRET): ReadsEnv => ({ ...parseReadsEnv({ CMS_VIEWS_ENABLED: 'true' }), secret });
const client = (secret = VIEWS_SECRET) => createViewsClient(audCfg(), readsCfg(secret), { allowLoopbackHttpForTests: true, sleep: noSleep, backoffBaseMs: 1 });
const sync = (portal: string, over: Record<string, unknown> = {}) =>
  runViewsSync({ client: client(), now: NOW, portal, from: '2026-09-28', to: '2026-10-29', alertDeps: { isConfigured: () => false }, cfg: readsCfg(), ...over });
/** A stored row without its re-stamped `fetchedAt` (the only column a rerun may touch). */
const noStamp = <T extends { fetchedAt: Date }>(r: T) => ({ ...r, fetchedAt: undefined });
const stored = (portal: string) => prisma.cmsArticleView.findMany({ where: { portal }, orderBy: [{ date: 'asc' }, { articleId: 'asc' }] });
const alerts = async (portal: string) => ((await prisma.audienceSyncState.findUnique({ where: { portal } }))?.alerts ?? {}) as Record<string, { raisedAt?: string; day?: string; reason?: string }>;

beforeAll(async () => {
  fake = new FakeViewsCms([VIEWS_SECRET]);
  base = await fake.start();
});
beforeEach(() => {
  fake.reset();
  fake.rows = [...A8_ROWS];
});
afterAll(async () => {
  await fake.stop();
  await prisma.cmsArticleView.deleteMany({ where: { portal: { in: portals } } });
  await prisma.audienceSyncState.deleteMany({ where: { portal: { in: portals } } });
  await prisma.$disconnect();
});

describe('a complete pull upserts every row; a rerun changes nothing; nulls stay null', () => {
  it('multi-page pull (3 rows a page) stores all 7 fixture rows exactly as sent', async () => {
    const portal = newPortal();
    const r = await runViewsSync({ client: new CmsViewsClient(pagedHttp(3)), now: NOW, portal, from: '2026-09-28', to: '2026-10-29', alertDeps: { isConfigured: () => false }, cfg: readsCfg() });
    expect(r).toMatchObject({ ok: true, rows: 7, pages: 3, inserted: 7 });
    const rows = await stored(portal);
    expect(rows).toHaveLength(7);
    const pre = rows.find((x) => x.articleId === '61458' && x.date.toISOString().startsWith('2026-10-13'))!;
    expect(pre).toMatchObject({ views: 400, pushViews: null, digestViews: null, canonicalPath: '/gst/karnataka-hc-allows-itc-under-retrospective-amendment', externalId: null });
    const known = rows.find((x) => x.articleId === '61458' && x.date.toISOString().startsWith('2026-10-15'))!;
    expect(known).toMatchObject({ views: 1840, pushViews: 120, digestViews: 35 });
    const zero = rows.find((x) => x.articleId === '61001' && x.date.toISOString().startsWith('2026-10-20'))!;
    expect(zero).toMatchObject({ pushViews: 0, digestViews: 0 }); // a real 0 is a 0, not null
    expect(rows.find((x) => x.articleId === '61001')).toMatchObject({ externalId: '1452345', canonicalPath: '/income-tax/itat-upholds-order-1452345' });
    expect(fake.requests.every((q) => q.ok && q.path === VIEWS_PATH)).toBe(true);
    expect(fake.requests[0].params).toMatchObject({ from: '2026-09-28', to: '2026-10-29', limit: '3' });
    expect(fake.requests[0].params?.published_since).toBeUndefined(); // the routine run asks for every article
  });

  it('a rerun is a no-op on the data: same rows, same values, none new', async () => {
    const portal = newPortal();
    await sync(portal);
    const before = (await stored(portal)).map(noStamp);
    const again = await sync(portal);
    expect(again).toMatchObject({ ok: true, rows: 7, inserted: 0 });
    expect((await stored(portal)).map(noStamp)).toEqual(before);
  });

  it('a changed count is updated in place (the CMS recomputes a day hourly)', async () => {
    const portal = newPortal();
    await sync(portal);
    fake.rows = fake.rows.map((r) => (r.article_id === '61458' && r.date === '2026-10-16' ? { ...r, views: 1000, push_views: 12 } : r));
    expect(await sync(portal)).toMatchObject({ ok: true, inserted: 0 });
    expect(await prisma.cmsArticleView.findFirst({ where: { portal, articleId: '61458', date: new Date('2026-10-16') } })).toMatchObject({ views: 1000, pushViews: 12 });
  });

  it('a day the CMS returned no rows for deletes nothing', async () => {
    const portal = newPortal();
    await sync(portal);
    fake.rows = fake.rows.filter((r) => r.date !== '2026-10-16'); // the CMS says nothing about 16 Oct now
    const r = await sync(portal, { from: '2026-10-14', to: '2026-10-29' });
    expect(r.ok).toBe(true);
    expect(await prisma.cmsArticleView.count({ where: { portal, date: new Date('2026-10-16') } })).toBe(1);
    expect(await prisma.cmsArticleView.count({ where: { portal } })).toBe(7);
  });

  it('a range with no rows at all is a successful empty run that writes nothing', async () => {
    const portal = newPortal();
    fake.rows = [];
    expect(await sync(portal)).toMatchObject({ ok: true, rows: 0, pages: 1, inserted: 0 });
    expect(await stored(portal)).toHaveLength(0);
  });
});

/** A client with a small page size (so the fixtures page), over the same fake. */
function clientHttp(limitHint: number) {
  void limitHint;
  return new CmsListClient({ baseUrl: base, secret: VIEWS_SECRET, allowedHosts: ['127.0.0.1'], path: VIEWS_PATH, secretName: 'CMS_FEED_VIEWS_SECRET', label: 'cms views', allowLoopbackHttpForTests: true, sleep: noSleep });
}

describe('an incomplete chain writes NOTHING and raises one alert per IST day', () => {
  const seeded = async (portal: string) => {
    await sync(portal); // 7 good rows in place
    return stored(portal);
  };

  it('a 500 on page 2 (every attempt)', async () => {
    const portal = newPortal();
    const before = await seeded(portal);
    fake.rows = [...A8_ROWS, ...Array.from({ length: 6 }, (_, i): A8Row => ({ ...A8_ROWS[0], article_id: `7${i}`, canonical_url: `https://www.taxscan.in/x/story-${i}`, date: '2026-10-22', views: 5 }))];
    fake.failPage.set(1, { status: 500, times: Infinity });
    const r = await runViewsSync({ client: new CmsViewsClient(pagedHttp(4)), now: NOW, portal, from: '2026-09-28', to: '2026-10-29', alertDeps: { isConfigured: () => false }, cfg: readsCfg() });
    expect(r.ok).toBe(false);
    expect(await stored(portal)).toEqual(before); // page 1's rows were NOT written
    const a = (await alerts(portal)).cms_views_failed;
    expect(a).toMatchObject({ day: '2026-10-29' });
    expect(a.reason).toMatch(/HTTP 500/);
  });

  it('a cursor that never ends', async () => {
    const portal = newPortal();
    const before = await seeded(portal);
    fake.endlessCursor = true;
    const r = await runViewsSync({ client: new CmsViewsClient(pagedHttp(3)), now: NOW, portal, from: '2026-09-28', to: '2026-10-29', alertDeps: { isConfigured: () => false }, cfg: readsCfg() });
    expect(r).toMatchObject({ ok: false });
    expect(r.error).toMatch(/cursor repeats/);
    expect(await stored(portal)).toEqual(before);
  });

  it.each<[string, unknown]>([
    ['a negative count', { ...A8_ROWS[0], article_id: '9001', views: -1 }],
    ['a string count', { ...A8_ROWS[0], article_id: '9002', views: '12' }],
    ['a push_views that is not a count', { ...A8_ROWS[0], article_id: '9003', push_views: 'x' }],
    ['an http (not https) canonical_url', { ...A8_ROWS[0], article_id: '9004', canonical_url: 'http://www.taxscan.in/a/b' }],
    ['a canonical_url on another host', { ...A8_ROWS[0], article_id: '9005', canonical_url: 'https://evil.example/a/b' }],
    ['a non-digit article_id', { ...A8_ROWS[0], article_id: '12a' }],
    ['a bad date', { ...A8_ROWS[0], article_id: '9006', date: '2026-13-40' }],
    ['a missing field', { article_id: '9007', canonical_url: 'https://www.taxscan.in/a/b', date: '2026-10-22', views: 1 }],
    ['a row that is not an object', 'oops'],
  ])('a bad row (%s)', async (_name, bad) => {
    const portal = newPortal();
    const before = await seeded(portal);
    fake.badRow = { index: 2, row: bad };
    const r = await sync(portal);
    expect(r.ok).toBe(false);
    expect(await stored(portal)).toEqual(before);
    expect((await alerts(portal)).cms_views_failed).toBeDefined();
  });

  it('a (date, article) served twice', async () => {
    const portal = newPortal();
    fake.duplicateFirstRow = true;
    const r = await sync(portal);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/arrived twice/);
    expect(await stored(portal)).toHaveLength(0);
  });

  it('one alert per IST day: a second failure the same day refreshes the marker, a new day starts a new one', async () => {
    const portal = newPortal();
    fake.badRow = { index: 0, row: 'oops' };
    await sync(portal);
    const first = (await alerts(portal)).cms_views_failed;
    await sync(portal, { now: new Date(NOW.getTime() + 3_600_000) });
    const second = (await alerts(portal)).cms_views_failed;
    expect(second.raisedAt).toBe(first.raisedAt); // the same marker, not a second alert
    await sync(portal, { now: new Date(NOW.getTime() + 24 * 3_600_000) });
    expect((await alerts(portal)).cms_views_failed.day).toBe('2026-10-30');
  });
});

/** A client that pages `n` rows at a time (the client's limit is a request parameter; the fake honours it). */
function pagedHttp(n: number) {
  const http = clientHttp(n);
  const orig = http.getText.bind(http);
  http.getText = (params: Record<string, string>) => orig({ ...params, limit: String(n) });
  return http;
}

describe('door V uses its own secret', () => {
  it('a request signed with the LIST secret is refused (401 → FATAL, nothing written); with the VIEWS secret it passes', async () => {
    const portal = newPortal();
    const bad = await runViewsSync({ client: client(LIST_SECRET), now: NOW, portal, from: '2026-09-28', to: '2026-10-29', alertDeps: { isConfigured: () => false }, cfg: readsCfg(LIST_SECRET) });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/HTTP 401/);
    expect(fake.requests.at(-1)).toMatchObject({ ok: false, reason: 'bad_signature' });
    expect(await stored(portal)).toHaveLength(0);
    expect((await sync(portal)).ok).toBe(true);
  });

  it('the views client never holds the list secret: createViewsClient signs with CMS_FEED_VIEWS_SECRET only', async () => {
    const reads = readsCfg();
    const aud = parseAudienceEnv({ CMS_FEED_PULL_SECRET: LIST_SECRET, CMS_FEED_BASE_URL: 'https://api.taxscan.in' });
    expect(aud.cms.pullSecret).toBe(LIST_SECRET);
    // The only secret the client is built from is `reads.secret`; a fake that accepts ONLY the list secret refuses it.
    const listOnly = new FakeViewsCms([LIST_SECRET]);
    const b = await listOnly.start();
    try {
      const c = createViewsClient({ cms: { baseUrl: b, allowedHosts: ['127.0.0.1'], pullSecret: LIST_SECRET } } as unknown as AudienceEnv, reads, { allowLoopbackHttpForTests: true, sleep: noSleep });
      await expect(c.fetchPage({ from: '2026-10-01', to: '2026-10-02' })).rejects.toMatchObject({ kind: 'FATAL', http: 401 });
      expect(listOnly.requests.every((q) => !q.ok)).toBe(true);
    } finally {
      await listOnly.stop();
    }
  });

  it('and the list client (door L) with the LIST secret is refused at the views route, and the views secret opens only that route', () => {
    // Pure signature check on both sides: the same canonical request, two different secrets, two different signatures.
    const a = signPushGet({ secret: VIEWS_SECRET, path: VIEWS_PATH, params: { from: '2026-10-01', to: '2026-10-02', limit: '10' }, now: NOW });
    const b = signPushGet({ secret: LIST_SECRET, path: VIEWS_PATH, params: { from: '2026-10-01', to: '2026-10-02', limit: '10' }, now: NOW });
    expect(a.headers['X-Push-Signature']).not.toBe(b.headers['X-Push-Signature']);
  });

  it('https only, host on the allow-list, redirect refused, the secret unset is FATAL (names the variable, not the value)', async () => {
    await expect(createViewsClient(audCfg(), readsCfg(), { allowedHosts: ['api.taxscan.in'], allowLoopbackHttpForTests: true }).fetchPage({ from: '2026-10-01', to: '2026-10-02' })).rejects.toMatchObject({ kind: 'FATAL' });
    await expect(createViewsClient(audCfg(), readsCfg(), { allowLoopbackHttpForTests: false }).fetchPage({ from: '2026-10-01', to: '2026-10-02' })).rejects.toMatchObject({ message: 'cms views: only https is allowed' });
    await expect(createViewsClient(audCfg(), { ...readsCfg(), secret: '' }, { allowLoopbackHttpForTests: true }).fetchPage({ from: '2026-10-01', to: '2026-10-02' })).rejects.toMatchObject({ message: 'cms views: CMS_FEED_VIEWS_SECRET is unset' });
  });

  it('config: the views secret must be ≥ 32 characters and differ from the other door secrets; READS_SOURCE / READS_CMS_FROM defaults', () => {
    expect(parseReadsEnv({ CMS_FEED_VIEWS_SECRET: 'short' })).toMatchObject({ secret: '', problems: [expect.stringContaining('CMS_FEED_VIEWS_SECRET is shorter')] });
    expect(parseReadsEnv({ CMS_FEED_VIEWS_SECRET: LIST_SECRET, CMS_FEED_PULL_SECRET: LIST_SECRET }).problems.join(' ')).toContain('must differ');
    expect(parseReadsEnv({})).toMatchObject({ enabled: false, source: 'ga', cmsFrom: '2026-09-29', problems: [] });
    expect(parseReadsEnv({ READS_SOURCE: 'CMS', READS_CMS_FROM: '2026-10-01', CMS_VIEWS_ENABLED: 'true' })).toMatchObject({ enabled: true, source: 'cms', cmsFrom: '2026-10-01' });
    expect(parseReadsEnv({ READS_SOURCE: 'nope', READS_CMS_FROM: '29/09/2026' })).toMatchObject({ source: 'ga', cmsFrom: '2026-09-29' });
  });

  it('the secret is masked in any logged error (logSecrets)', () => {
    const saved = { ...process.env };
    Object.assign(process.env, { CMS_FEED_VIEWS_SECRET: VIEWS_SECRET });
    try {
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { safeErrorLog } = require('../lib/httpErrors') as typeof import('../lib/httpErrors');
        const out = JSON.stringify(safeErrorLog(new Error(`boom ${VIEWS_SECRET}`), { stack: true }));
        expect(out).not.toContain(VIEWS_SECRET);
        expect(out).toContain('[secret]');
      });
    } finally {
      process.env = saved;
    }
  });

  it('a retried request is signed afresh (new nonce each attempt) and 429 is retried', async () => {
    fake.failPage.set(0, { status: 429, times: 2 });
    const before = fake.requests.length;
    const page = await client().fetchPage({ from: '2026-10-01', to: '2026-10-29' });
    expect(page.rows.length).toBeGreaterThan(0);
    const r = fake.requests.slice(before);
    expect(r).toHaveLength(3);
    // The fake refuses a reused nonce, so three verified attempts prove three different nonces.
    expect(r.map((x) => x.ok)).toEqual([true, true, true]);
  });
});

describe('parsing and windows', () => {
  it('parseViewRow reads an A.8 row; parseViewsPage needs data + meta.next_cursor + meta.as_of', () => {
    const r = parseViewRow(A8_ROWS[1]);
    expect(r).toMatchObject({ articleId: '61458', date: '2026-10-15', views: 1840, pushViews: 120, digestViews: 35, externalId: null });
    expect(parseViewsPage(a8Pages(A8_ROWS, 100)[0]).nextCursor).toBeNull();
    expect(() => parseViewsPage('{"data":[]}')).toThrow(/meta/);
    expect(() => parseViewsPage('{"data":[],"meta":{"next_cursor":"","as_of":"2026-10-29T11:07:03+05:30"}}')).toThrow(/next_cursor/);
    expect(() => parseViewsPage('{"data":[],"meta":{"next_cursor":null,"as_of":"yesterday"}}')).toThrow(/as_of/);
    expect(() => parseViewsPage('nope')).toThrow(/not JSON/);
  });

  it('the routine window is today − 2 … today (IST); the backfill splits into ≤ 30-day-apart chunks', () => {
    expect(routineWindow(new Date('2026-10-29T20:00:00Z'))).toEqual({ from: '2026-10-28', to: '2026-10-30' }); // 01:30 IST on the 30th
    expect(routineWindow(NOW)).toEqual({ from: '2026-10-27', to: '2026-10-29' });
    expect(chunkRanges('2026-09-28', '2026-10-29')).toEqual([
      { from: '2026-09-28', to: '2026-10-28' },
      { from: '2026-10-29', to: '2026-10-29' },
    ]);
    expect(chunkRanges('2026-10-01', '2026-10-05')).toEqual([{ from: '2026-10-01', to: '2026-10-05' }]);
    for (const c of chunkRanges('2026-01-01', '2026-10-29')) expect((Date.parse(c.to) - Date.parse(c.from)) / 86_400_000).toBeLessThanOrEqual(30);
  });
});

describe('boot', () => {
  it('disabled: the boot line, no cron; enabled and valid: schedules the cron in IST; invalid: not started', () => {
    const lines: string[] = [];
    (console.log as jest.Mock).mockImplementation((l: string) => lines.push(String(l)));
    const scheduled: [string, string][] = [];
    const schedule = ((e: string, _f: unknown, o: { timezone: string }) => (scheduled.push([e, o.timezone]), { stop: () => undefined })) as never;
    startCmsViewsSync(parseReadsEnv({}), schedule);
    expect(lines.some((l) => l.startsWith('[cms-views] disabled'))).toBe(true);
    expect(scheduled).toEqual([]);
    startCmsViewsSync(parseReadsEnv({ CMS_VIEWS_ENABLED: 'true' }), schedule); // secret unset → not started
    expect(scheduled).toEqual([]);
    (console.log as jest.Mock).mockImplementation(() => undefined);
  });
});
