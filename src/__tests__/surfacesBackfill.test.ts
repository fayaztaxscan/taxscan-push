/**
 * Brief 2026-11-27-surfaces-news-tab: the one-surface Search Console history backfill, run from inside the app by an
 * ADMIN (`POST /api/admin/surfaces/backfill`, `GET …/:id`) against a stand-in for Google. No real network.
 */
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import request from 'supertest';
import type { User, UserRole } from '@prisma/client';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { env } from '../lib/env';
import { __resetTokenCache } from '../services/gaReads';
import { acquireSurfacesLock, releaseSurfacesLock, runScheduledSync } from '../services/searchSurfaces';
import { monthChunks, resetSurfacesBackfillRuns, validateSurfacesBackfill } from '../services/surfacesBackfill';
import { istDateKey } from '../services/reports';

const RUN = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const PASSWORD = 'Backfill-Test-123!';
const AUTH = `Bearer ${process.env.ADMIN_TOKEN}`;
const PORTAL = `test-surfaces-backfill-${RUN}`;
const URL_ = '/api/admin/surfaces/backfill';
const TOKEN = `ya29.stand-in-access-token-${RUN}`;
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const CREDS = JSON.stringify({ client_email: 'sc@y.iam', private_key: PEM });

/** Day keys counted back from today, so no assertion here expires with the calendar. */
const daysAgo = (n: number) => istDateKey(new Date(Date.now() - n * 86_400_000));
const FROM = daysAgo(75);
const TO = daysAgo(3);

type Query = { type: string; startDate: string; endDate: string };
let queries: Query[] = [];
/** Runs before a query is answered: a test blocks or fails a chunk here. */
let onQuery: (q: Query, n: number) => Promise<Response | void> = async () => undefined;
let logged: string[] = [];

/** Google: a token, then one article row on the first day of whatever span was asked for. */
const google = async (url: unknown, init?: RequestInit): Promise<Response> => {
  if (String(url).includes('oauth2.googleapis.com')) {
    return new Response(JSON.stringify({ access_token: TOKEN, expires_in: 3600 }), { status: 200 });
  }
  expect(String(url)).toContain('searchconsole.googleapis.com');
  const q = JSON.parse(String(init?.body)) as Query;
  queries.push(q);
  const override = await onQuery(q, queries.length);
  if (override) return override;
  return new Response(
    JSON.stringify({ rows: [{ keys: [q.startDate, 'https://www.taxscan.in/gst/a-story'], clicks: 7, impressions: 70 }] }),
    { status: 200 },
  );
};

const app = createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 } });
const userIds: string[] = [];
let adminId: string;
let adminCookie: string;
let publisherCookie: string;
const saved = { portal: env.rss.portal, sc: { ...env.searchConsole }, ga: { ...env.gaReads } };

async function makeUser(role: UserRole): Promise<User> {
  const u = await prisma.user.create({ data: { email: `sf-backfill-${role.toLowerCase()}-${RUN}@team.test`, passwordHash: await bcrypt.hash(PASSWORD, 4), role, isActive: true } });
  userIds.push(u.id);
  return u;
}
async function cookieFor(u: User): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ email: u.email, password: PASSWORD });
  expect(res.status).toBe(200);
  const sc = res.headers['set-cookie'];
  return (Array.isArray(sc) ? sc : [sc as unknown as string]).map((l) => l.split(';')[0]).join('; ');
}
const post = (body: object) => request(app).post(URL_).set('Authorization', AUTH).send(body);
const status = (id: string) => request(app).get(`${URL_}/${id}`).set('Authorization', AUTH);
async function finished(id: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 400; i++) {
    const r = await status(id);
    expect(r.status).toBe(200);
    if (r.body.state !== 'running') return r.body;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error('backfill never finished');
}
const stored = (surface?: 'DISCOVER' | 'GOOGLE_SEARCH_NEWS') =>
  prisma.articleSurfaceStat.findMany({ where: { portal: PORTAL, ...(surface ? { surface } : {}) }, orderBy: [{ date: 'asc' }, { surface: 'asc' }] });
const values = (rows: Awaited<ReturnType<typeof stored>>) => rows.map((r) => [r.surface, r.pagePath, r.date.toISOString().slice(0, 10), r.clicks, r.impressions]);

beforeAll(async () => {
  const admin = await makeUser('ADMIN');
  adminId = admin.id;
  adminCookie = await cookieFor(admin);
  publisherCookie = await cookieFor(await makeUser('PUBLISHER'));
});
beforeEach(async () => {
  await prisma.articleSurfaceStat.deleteMany({ where: { portal: PORTAL } });
  resetSurfacesBackfillRuns();
  __resetTokenCache();
  queries = [];
  logged = [];
  onQuery = async () => undefined;
  env.rss.portal = PORTAL;
  Object.assign(env.searchConsole, { enabled: true, siteUrl: 'sc-domain:taxscan.in' });
  Object.assign(env.gaReads, { serviceAccountJson: CREDS, serviceAccountFile: '' });
  jest.spyOn(globalThis, 'fetch').mockImplementation(google as typeof fetch);
  for (const m of ['log', 'warn', 'error'] as const) {
    jest.spyOn(console, m).mockImplementation((...args: unknown[]) => void logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')));
  }
});
afterEach(() => {
  jest.restoreAllMocks();
  releaseSurfacesLock();
});
afterAll(async () => {
  env.rss.portal = saved.portal;
  Object.assign(env.searchConsole, saved.sc);
  Object.assign(env.gaReads, saved.ga);
  await prisma.articleSurfaceStat.deleteMany({ where: { portal: PORTAL } });
  await prisma.auditLog.deleteMany({ where: { action: 'SURFACES_BACKFILL_STARTED' } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe('monthChunks', () => {
  it('cuts at calendar months, oldest first, clipped to the range', () => {
    expect(monthChunks('2026-01-01', '2026-03-15')).toEqual([
      { from: '2026-01-01', to: '2026-01-31' },
      { from: '2026-02-01', to: '2026-02-28' },
      { from: '2026-03-01', to: '2026-03-15' },
    ]);
    expect(monthChunks('2025-12-30', '2026-01-02')).toEqual([
      { from: '2025-12-30', to: '2025-12-31' },
      { from: '2026-01-01', to: '2026-01-02' },
    ]);
    expect(monthChunks('2028-02-29', '2028-02-29')).toEqual([{ from: '2028-02-29', to: '2028-02-29' }]);
  });
});

describe('validateSurfacesBackfill', () => {
  const now = new Date('2026-11-27T06:00:00Z');
  it('takes the history the brief asks for, and `to` defaults to today (IST)', () => {
    expect(validateSurfacesBackfill({ surface: 'news', from: '2026-01-01' }, now)).toMatchObject({
      surface: { surface: 'GOOGLE_SEARCH_NEWS', type: 'news' },
      from: '2026-01-01',
      to: '2026-11-27',
    });
  });
  it('stops at 16 months back', () => {
    expect(validateSurfacesBackfill({ surface: 'news', from: '2025-07-27' }, now)).not.toHaveProperty('error');
    expect(validateSurfacesBackfill({ surface: 'news', from: '2025-07-26' }, now)).toMatchObject({ error: 'invalid_range' });
  });
});

describe('POST /api/admin/surfaces/backfill — who may', () => {
  it('401 with no auth (POST and GET); 403 for a publisher; an ADMIN session and the bearer pass', async () => {
    const body = { surface: 'news', from: TO, to: TO };
    expect((await request(app).post(URL_).send(body)).status).toBe(401);
    expect((await request(app).get(`${URL_}/x`)).status).toBe(401);
    expect((await request(app).post(URL_).set('Cookie', publisherCookie).send(body)).status).toBe(403);
    expect((await request(app).get(`${URL_}/x`).set('Cookie', publisherCookie)).status).toBe(403);
    expect(queries).toHaveLength(0);

    const admin = await request(app).post(URL_).set('Cookie', adminCookie).send(body);
    expect(admin.status).toBe(202);
    await finished(admin.body.id);
    expect((await request(app).get(`${URL_}/${admin.body.id}`).set('Cookie', adminCookie)).status).toBe(200);
    const bearer = await post(body);
    expect(bearer.status).toBe(202);
    await finished(bearer.body.id);
  });

  it('GET an unknown id (or one lost to an app restart) → 404', async () => {
    expect((await status('nope')).status).toBe(404);
  });
});

describe('a bad request → 400, and Google is not called', () => {
  it.each<[object, string]>([
    [{}, 'invalid_surface'],
    [{ from: FROM, to: TO }, 'invalid_surface'],
    [{ surface: 'web', from: FROM }, 'invalid_surface'],
    [{ surface: 'News', from: FROM }, 'invalid_surface'],
    [{ surface: 'GOOGLE_SEARCH_NEWS', from: FROM }, 'invalid_surface'],
    [{ surface: ['news'], from: FROM }, 'invalid_surface'],
    [{ surface: 'news' }, 'invalid_range'],
    [{ surface: 'news', from: '2026-1-1' }, 'invalid_range'],
    [{ surface: 'news', from: '2026-02-30' }, 'invalid_range'],
    [{ surface: 'news', from: '2026-13-01' }, 'invalid_range'],
    [{ surface: 'news', from: 20260101 }, 'invalid_range'],
    [{ surface: 'news', from: TO, to: FROM }, 'invalid_range'],
    [{ surface: 'news', from: FROM, to: '2999-01-01' }, 'invalid_range'],
    [{ surface: 'news', from: FROM, to: 'yesterday' }, 'invalid_range'],
    [{ surface: 'news', from: '2000-01-01', to: TO }, 'invalid_range'],
  ])('%j → %s', async (body, error) => {
    const r = await post(body);
    expect([r.status, r.body.error]).toEqual([400, error]);
    expect(queries).toHaveLength(0);
    expect(acquireSurfacesLock()).toBe(true);
  });
});

describe('not configured → 409, and Google is not called', () => {
  it.each<[string, () => void, string]>([
    ['the flag is off', () => (env.searchConsole.enabled = false), 'search_console_disabled'],
    ['no site url', () => (env.searchConsole.siteUrl = ''), 'search_console_not_configured'],
    ['no credentials', () => (env.gaReads.serviceAccountJson = ''), 'search_console_not_configured'],
    ['unreadable credentials', () => (env.gaReads.serviceAccountJson = '{not json'), 'search_console_not_configured'],
  ])('%s', async (_name, arrange, error) => {
    arrange();
    const r = await post({ surface: 'news', from: TO });
    expect([r.status, r.body]).toEqual([409, { error }]);
    expect(queries).toHaveLength(0);
  });
});

describe('a run', () => {
  it('surface=news fetches only `news`, month by month oldest first, and leaves the other surfaces alone', async () => {
    // A Discover row on a date the backfill will write to.
    await prisma.articleSurfaceStat.create({
      data: { portal: PORTAL, pagePath: '/gst/a-story', date: new Date(`${FROM}T00:00:00Z`), surface: 'DISCOVER', clicks: 500, impressions: 5000 },
    });
    const discover = await stored('DISCOVER');
    const res = await post({ surface: 'news', from: FROM, to: TO });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ state: 'running', surface: 'news', from: FROM, to: TO, error: null });
    const done = await finished(res.body.id);

    const chunks = monthChunks(FROM, TO);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(done).toMatchObject({ state: 'done', chunks, chunksDone: chunks.length, rows: chunks.length, error: null });
    expect(done.finishedAt).toEqual(expect.any(String));
    expect(queries.map((q) => q.type)).toEqual(chunks.map(() => 'news'));
    expect(queries.map((q) => ({ from: q.startDate, to: q.endDate }))).toEqual(chunks);
    expect(await stored('GOOGLE_SEARCH_NEWS')).toHaveLength(chunks.length);
    expect(await stored('DISCOVER')).toEqual(discover);

    // Rerunning the same range is idempotent.
    const first = values(await stored());
    await finished((await post({ surface: 'news', from: FROM, to: TO })).body.id);
    expect(values(await stored())).toEqual(first);
    expect(await stored('DISCOVER')).toEqual(discover);
  });

  it('reports progress while running; a second backfill and the cron pass wait their turn', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reached!: () => void;
    const atSecond = new Promise<void>((r) => (reached = r));
    onQuery = async (_q, n) => {
      if (n === 2) {
        reached();
        await gate;
      }
    };
    const res = await post({ surface: 'news', from: FROM, to: TO });
    await atSecond;
    const mid = await status(res.body.id);
    expect(mid.body).toMatchObject({ state: 'running', chunksDone: 1, rows: 1, finishedAt: null });

    const second = await post({ surface: 'discover', from: TO });
    expect([second.status, second.body]).toEqual([409, { error: 'sync_running' }]);
    await runScheduledSync();
    expect(queries).toHaveLength(2);
    expect(logged.join('\n')).toMatch(/\[surfaces\] sync skipped/);

    release();
    expect(await finished(res.body.id)).toMatchObject({ state: 'done' });
    expect(acquireSurfacesLock()).toBe(true);
  });

  it('is refused while the routine sync holds the lock, with no audit row', async () => {
    const audits = () => prisma.auditLog.count({ where: { action: 'SURFACES_BACKFILL_STARTED', userId: adminId } });
    const before = await audits();
    expect(acquireSurfacesLock()).toBe(true);
    const r = await request(app).post(URL_).set('Cookie', adminCookie).send({ surface: 'news', from: TO });
    expect([r.status, r.body]).toEqual([409, { error: 'sync_running' }]);
    expect(queries).toHaveLength(0);
    expect(await audits()).toBe(before);
  });

  it('a failing chunk stops the run: earlier chunks stay, nothing leaks, the lock is freed, a rerun finishes', async () => {
    onQuery = async (_q, n) => (n === 2 ? new Response(JSON.stringify({ error: { message: 'backend error' } }), { status: 500 }) : undefined);
    const res = await post({ surface: 'news', from: FROM, to: TO });
    const failed = await finished(res.body.id);
    expect(failed).toMatchObject({ state: 'failed', chunksDone: 1, rows: 1 });
    expect(String(failed.error)).toMatch(/Search Console query failed for news \(500\)/);
    expect(queries).toHaveLength(2); // stopped there
    expect(await stored()).toHaveLength(1);

    const everything = JSON.stringify(failed) + logged.join('\n');
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain('PRIVATE KEY');
    expect(logged.join('\n')).toMatch(/backfill failed chunk=2\//);

    onQuery = async () => undefined;
    expect(await finished((await post({ surface: 'news', from: FROM, to: TO })).body.id)).toMatchObject({ state: 'done' });
  });

  it('writes one audit row on start: actor, surface, range and chunk count — nothing else', async () => {
    const res = await request(app).post(URL_).set('Cookie', adminCookie).send({ surface: 'news', from: FROM, to: TO });
    expect(res.status).toBe(202);
    await finished(res.body.id);
    const rows = await prisma.auditLog.findMany({ where: { action: 'SURFACES_BACKFILL_STARTED', resourceId: res.body.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: adminId, resourceType: 'ArticleSurfaceStat' });
    expect(rows[0].metadata).toEqual({ surface: 'news', from: FROM, to: TO, chunks: monthChunks(FROM, TO).length });
  });
});
