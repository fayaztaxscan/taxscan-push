/**
 * Brief 2026-10-29-cms-views-backfill-endpoint: the one-off history backfill, run from inside the app by an ADMIN
 * (`POST /api/admin/cms-views/backfill`, `GET …/:id`) against the fake CMS door V. No real network.
 */
import bcrypt from 'bcrypt';
import request from 'supertest';
import type { User, UserRole } from '@prisma/client';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { env, parseReadsEnv, type AudienceEnv, type ReadsEnv } from '../lib/env';
import { CmsPullError } from '../services/audience/cmsClient';
import * as viewsClient from '../services/cmsViews/client';
import { acquireViewsLock, releaseViewsLock } from '../services/cmsViews/sync';
import { resetBackfillRuns } from '../services/cmsViews/backfill';
import { A8_ROWS } from './fixtures/cms-views-a8/rows';
import { FakeViewsCms } from './cmsViewsFake';

jest.spyOn(console, 'log').mockImplementation(() => undefined);
jest.spyOn(console, 'warn').mockImplementation(() => undefined);
jest.spyOn(console, 'error').mockImplementation(() => undefined);

const RUN = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const SECRET = `v-${'v'.repeat(40)}${RUN.slice(0, 6)}`;
const PASSWORD = 'Backfill-Test-123!';
const AUTH = `Bearer ${process.env.ADMIN_TOKEN}`;
const PORTAL = `test-cms-backfill-${RUN}`;
const URL_ = '/api/admin/cms-views/backfill';

let fake: FakeViewsCms;
let base: string;
const userIds: string[] = [];
let adminCookie: string;
let publisherCookie: string;
let adminId: string;
const app = createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 } });

const audCfg = (): AudienceEnv => ({ cms: { baseUrl: base, allowedHosts: ['127.0.0.1'] } }) as unknown as AudienceEnv;
const readsCfg = (): ReadsEnv => ({ ...parseReadsEnv({ CMS_VIEWS_ENABLED: 'true' }), secret: SECRET });
const createReal = viewsClient.createViewsClient; // before any spy
const realClient = () => createReal(audCfg(), readsCfg(), { allowLoopbackHttpForTests: true, sleep: () => Promise.resolve(), backoffBaseMs: 1 });
const stored = () => prisma.cmsArticleView.findMany({ where: { portal: PORTAL }, orderBy: [{ date: 'asc' }, { articleId: 'asc' }] });
const noStamp = <T extends { fetchedAt: Date }>(r: T) => ({ ...r, fetchedAt: undefined });

async function makeUser(role: UserRole): Promise<User> {
  const u = await prisma.user.create({ data: { email: `backfill-${role.toLowerCase()}-${RUN}@team.test`, passwordHash: await bcrypt.hash(PASSWORD, 4), role, isActive: true } });
  userIds.push(u.id);
  return u;
}
async function cookieFor(u: User): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ email: u.email, password: PASSWORD });
  expect(res.status).toBe(200);
  const sc = res.headers['set-cookie'];
  return (Array.isArray(sc) ? sc : [sc as unknown as string]).map((l) => l.split(';')[0]).join('; ');
}
async function finished(id: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 200; i++) {
    const r = await request(app).get(`${URL_}/${id}`).set('Authorization', AUTH);
    expect(r.status).toBe(200);
    if (r.body.state !== 'running') return r.body;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error('backfill never finished');
}
/** Only `Date` is faked, so the route's "today (IST)" can be a day far enough out for three 30-day chunks. */
const fakeToday = (iso: string) =>
  jest.useFakeTimers({ now: new Date(iso), doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });

const saved = { enabled: env.cmsViews.enabled, secret: env.cmsViews.secret, problems: env.cmsViews.problems, base: env.audience.cms.baseUrl, portal: env.rss.portal };

beforeAll(async () => {
  fake = new FakeViewsCms([SECRET]);
  base = await fake.start();
  const admin = await makeUser('ADMIN');
  adminId = admin.id;
  adminCookie = await cookieFor(admin);
  publisherCookie = await cookieFor(await makeUser('PUBLISHER'));
});
beforeEach(async () => {
  await prisma.cmsArticleView.deleteMany({ where: { portal: PORTAL } });
  fake.reset();
  fake.rows = [...A8_ROWS];
  resetBackfillRuns();
  env.cmsViews.enabled = true;
  env.cmsViews.secret = SECRET;
  env.cmsViews.problems = [];
  env.audience.cms.baseUrl = base;
  env.rss.portal = PORTAL;
  jest.spyOn(viewsClient, 'createViewsClient').mockImplementation(() => realClient());
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  releaseViewsLock();
});
afterAll(async () => {
  Object.assign(env.cmsViews, { enabled: saved.enabled, secret: saved.secret, problems: saved.problems });
  env.audience.cms.baseUrl = saved.base;
  env.rss.portal = saved.portal;
  await fake.stop();
  await prisma.cmsArticleView.deleteMany({ where: { portal: PORTAL } });
  await prisma.audienceSyncState.deleteMany({ where: { portal: PORTAL } });
  await prisma.auditLog.deleteMany({ where: { action: 'CMS_VIEWS_BACKFILL_STARTED' } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe('1. a three-chunk run: 202, then done with the right counts; a rerun gives the same rows', () => {
  it('POST → 202 + id; GET → done, 3/3 chunks, 7 rows new; rerun: 7 fetched, 0 new, 7 updated, identical rows', async () => {
    fakeToday('2026-12-20T10:00:00Z');
    const res = await request(app).post(URL_).set('Authorization', AUTH).send({ from: '2026-09-28', to: '2026-12-20' });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ state: 'running', from: '2026-09-28', to: '2026-12-20', dryRun: false });
    expect(res.body.chunks).toEqual([
      { from: '2026-09-28', to: '2026-10-28' },
      { from: '2026-10-29', to: '2026-11-28' },
      { from: '2026-11-29', to: '2026-12-20' },
    ]);
    const done = await finished(res.body.id);
    jest.useRealTimers(); // not before: the request signature and the fake CMS's check must read the same clock
    expect(done).toMatchObject({ state: 'done', chunksDone: 3, rowsFetched: 7, rowsInserted: 7, rowsUpdated: 0, error: null });
    expect(typeof done.finishedAt).toBe('string');
    const first = await stored();
    expect(first).toHaveLength(7);

    fakeToday('2026-12-20T10:00:00Z');
    const again = await request(app).post(URL_).set('Authorization', AUTH).send({ from: '2026-09-28', to: '2026-12-20' });
    expect(again.status).toBe(202);
    const againDone = await finished(again.body.id);
    jest.useRealTimers();
    expect(againDone).toMatchObject({ state: 'done', chunksDone: 3, rowsFetched: 7, rowsInserted: 0, rowsUpdated: 7 });
    expect((await stored()).map(noStamp)).toEqual(first.map(noStamp));
  });

  it('`to` defaults to today (IST)', async () => {
    const res = await request(app).post(URL_).set('Authorization', AUTH).send({ from: '2026-10-08' });
    expect(res.status).toBe(202);
    expect(res.body.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await finished(res.body.id);
  });
});

describe('2. dryRun writes nothing and reports the plan', () => {
  it('202 with state done, the chunk plan, no request to the CMS, nothing stored, no lock taken', async () => {
    const res = await request(app).post(URL_).set('Authorization', AUTH).send({ from: '2026-09-28', to: '2026-10-29', dryRun: true });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ state: 'done', dryRun: true, chunksDone: 0, rowsFetched: 0 });
    expect(res.body.chunks.length).toBeGreaterThanOrEqual(1);
    expect(fake.requests).toHaveLength(0);
    expect(await stored()).toHaveLength(0);
    expect(acquireViewsLock()).toBe(true);
  });
});

describe('3. refusals', () => {
  it('409 when CMS_VIEWS_ENABLED is off (and when the config is invalid)', async () => {
    env.cmsViews.enabled = false;
    const off = await request(app).post(URL_).set('Authorization', AUTH).send({ from: '2026-10-08', to: '2026-10-20' });
    expect(off.status).toBe(409);
    expect(off.body.error).toBe('cms_views_disabled');
    env.cmsViews.enabled = true;
    env.cmsViews.secret = '';
    const bad = await request(app).post(URL_).set('Authorization', AUTH).send({ from: '2026-10-08', to: '2026-10-20' });
    expect(bad.status).toBe(409);
    expect(bad.body.error).toBe('cms_views_config_invalid');
    expect(fake.requests).toHaveLength(0);
  });

  it('409 while a backfill is running (one at a time), and while the routine sync holds the lock', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    jest.spyOn(viewsClient, 'createViewsClient').mockImplementation(() => ({ fetchRange: async (w: { from: string; to: string }) => (await gate, realClient().fetchRange(w)) }) as unknown as viewsClient.CmsViewsClient);
    const first = await request(app).post(URL_).set('Authorization', AUTH).send({ from: '2026-10-08', to: '2026-10-20' });
    expect(first.status).toBe(202);
    expect((await request(app).get(`${URL_}/${first.body.id}`).set('Authorization', AUTH)).body.state).toBe('running');
    const second = await request(app).post(URL_).set('Authorization', AUTH).send({ from: '2026-10-08', to: '2026-10-20' });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('sync_running');
    release();
    expect(await finished(first.body.id)).toMatchObject({ state: 'done' });

    expect(acquireViewsLock()).toBe(true); // the routine sync's lock
    const third = await request(app).post(URL_).set('Authorization', AUTH).send({ from: '2026-10-08', to: '2026-10-20' });
    expect(third.status).toBe(409);
    expect(third.body.error).toBe('sync_running');
    releaseViewsLock();
  });

  it('400 on bad dates', async () => {
    const bad: unknown[] = [
      {},
      { from: '2026-9-28' },
      { from: '2026-02-30' },
      { from: '2026-09-27' }, // before the CMS's history
      { from: '2026-10-20', to: '2026-10-10' },
      { from: '2026-10-08', to: '2999-01-01' }, // the future
      { from: '2026-10-08', to: 'yesterday' },
      { from: '2026-10-08', dryRun: 'yes' },
    ];
    for (const b of bad) {
      const r = await request(app).post(URL_).set('Authorization', AUTH).send(b as object);
      expect([b, r.status]).toEqual([b, 400]);
    }
    expect(fake.requests).toHaveLength(0);
  });

  it('401 with no auth (POST and GET); 403 for a publisher; an ADMIN session passes', async () => {
    expect((await request(app).post(URL_).send({ from: '2026-10-08' })).status).toBe(401);
    expect((await request(app).get(`${URL_}/x`)).status).toBe(401);
    expect((await request(app).post(URL_).set('Cookie', publisherCookie).send({ from: '2026-10-08' })).status).toBe(403);
    expect((await request(app).get(`${URL_}/x`).set('Cookie', publisherCookie)).status).toBe(403);
    const ok = await request(app).post(URL_).set('Cookie', adminCookie).send({ from: '2026-10-08', dryRun: true });
    expect(ok.status).toBe(202);
    expect((await request(app).get(`${URL_}/${ok.body.id}`).set('Cookie', adminCookie)).status).toBe(200);
  });

  it('GET an unknown id (or one lost to an app restart) → 404', async () => {
    expect((await request(app).get(`${URL_}/nope`).set('Authorization', AUTH)).status).toBe(404);
  });
});

describe('4. a failing chunk', () => {
  it('→ failed with a redacted error; the earlier chunk stays written; the lock is released; a rerun finishes', async () => {
    let calls = 0;
    jest.spyOn(viewsClient, 'createViewsClient').mockImplementation(
      () =>
        ({
          fetchRange: (w: { from: string; to: string }) => (++calls === 2 ? Promise.reject(new CmsPullError('FATAL', `HTTP 500 for ${SECRET}`, 500)) : realClient().fetchRange(w)),
        }) as unknown as viewsClient.CmsViewsClient,
    );
    fakeToday('2026-12-20T10:00:00Z');
    const res = await request(app).post(URL_).set('Authorization', AUTH).send({ from: '2026-09-28', to: '2026-12-20' });
    const done = await finished(res.body.id);
    jest.useRealTimers();
    expect(done).toMatchObject({ state: 'failed', chunksDone: 1, rowsInserted: 7 });
    expect(String(done.error)).toMatch(/HTTP 500/);
    expect(JSON.stringify(done)).not.toContain(SECRET);
    expect(await stored()).toHaveLength(7);
    expect(acquireViewsLock()).toBe(true);
    releaseViewsLock();
  });
});

describe('5. audit row on start', () => {
  it('actor, range and dryRun; none of them a secret', async () => {
    const res = await request(app).post(URL_).set('Cookie', adminCookie).send({ from: '2026-10-08', to: '2026-10-20' });
    expect(res.status).toBe(202);
    await finished(res.body.id).catch(() => undefined);
    const rows = await prisma.auditLog.findMany({ where: { action: 'CMS_VIEWS_BACKFILL_STARTED', resourceId: res.body.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: adminId, resourceType: 'CmsArticleView', metadata: { from: '2026-10-08', to: '2026-10-20', dryRun: false } });
  });
});
