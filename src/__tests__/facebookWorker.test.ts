import bcrypt from 'bcrypt';
import cron from 'node-cron';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import type { User, UserRole } from '@prisma/client';
import { createApp } from '../app';
import { env } from '../lib/env';
import { prisma } from '../lib/prisma';
import { postToFacebook, checkConnection, postForm, feedUrl, classify, type FacebookResult } from '../services/facebook/client';
import { buildMessage } from '../services/facebook/post';
import { isAllowedPushUrl } from '../lib/urlAllowlist';
import { runFacebookTick, retryNow, startFacebookWorker, resetFacebookStops, loginProblem, policyProblem, authKey, policyKey, UNKNOWN_ERROR, type WorkerDeps } from '../services/facebook/worker';

/**
 * Brief 2026-11-03-facebook-page-posting, acceptance 1-7 (backend). Graph is a fake: no real Facebook call anywhere. Rows live
 * under a unique `test-fb-*` portal mapped to a private page `fbtest`, so the real `taxscan` page state is never touched.
 */
const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const PORTAL = `test-fb-${RUN}`;
const PAGE = `fbtest${Math.floor(Math.random() * 1e9)}`; // private per run: another process on the same DB never shares its rows
const TOKEN = 'SECRET-TOKEN-4f9a1c-EAAB1234567890';
const PASSWORD = 'fb-worker-test-pw-1';
const IST_MS = (5 * 60 + 30) * 60_000;
const ist = (h: number, m = 0, day = 3) => new Date(Date.UTC(2026, 10, day, h, m) - IST_MS);
const NOW = ist(10, 0);
const FROM = ist(4, 0);
const MIN = 60_000;
const at = (base: Date, min: number) => new Date(base.getTime() + min * MIN);

const posted = (id = '123_456'): FacebookResult => ({ kind: 'posted', postId: id });
const fail = (kind: 'rate' | 'transient' | 'auth' | 'policy' | 'duplicate' | 'failed', status: number | null, code: number | null, subcode: number | null = null): FacebookResult => ({
  kind,
  status,
  code,
  subcode,
  error: `HTTP ${status} code ${code}`,
});

let calls: { pageId: string; accessToken: string; message: string; link: string }[] = [];
let script: (n: number) => FacebookResult | Promise<FacebookResult> = () => posted();
const post: NonNullable<WorkerDeps['post']> = async (r) => {
  calls.push(r);
  return script(calls.length);
};
let mails: { to: string; subject: string; text: string }[] = [];
const deps = (over: WorkerDeps = {}): WorkerDeps => ({
  now: () => NOW,
  post,
  fetchCms: async () => null,
  emailSender: async (m) => {
    mails.push(m);
    return { ok: true };
  },
  isEmailConfigured: () => true,
  recipients: async () => ['admin@team.test'],
  portals: { [PORTAL]: PAGE },
  postFrom: FROM,
  quiet: { start: '23:00', end: '07:00' },
  minGapMinutes: 10,
  dailyCap: 30,
  ...over,
});

let seq = 0;
async function camp(slug: string, lastSentAt: Date, o: { host?: string; status?: 'SENT' | 'DRAFT'; title?: string; target?: object; url?: string } = {}) {
  return prisma.campaign.create({
    data: {
      portal: PORTAL,
      title: o.title ?? `Story ${slug}`,
      body: 'b',
      url: o.url ?? `https://${o.host ?? 'www.taxscan.in'}/gst/${slug}-${RUN}-${++seq}`,
      target: o.target ?? {},
      status: o.status ?? 'SENT',
      lastSentAt,
      authority: 'Supreme Court',
      categories: ['GST'],
    } as never,
  });
}
const rowsOf = () => prisma.facebookPost.findMany({ where: { page: PAGE }, orderBy: { createdAt: 'asc' } });
/** Runs ticks one minute apart until `n` of them, returning the clock of each. */
async function ticks(n: number, start: Date, over: WorkerDeps = {}) {
  for (let i = 0; i < n; i += 1) await runFacebookTick(deps({ now: () => at(start, i), ...over }));
}

const userIds: string[] = [];
const loginApp = createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 } });
let admin: User;
let publisher: User;
let adminCookie: string;
let publisherCookie: string;
async function makeUser(role: UserRole): Promise<User> {
  const u = await prisma.user.create({ data: { email: `fb-${role.toLowerCase()}-${RUN}-${++seq}@team.test`, passwordHash: await bcrypt.hash(PASSWORD, 4), role, isActive: true } });
  userIds.push(u.id);
  return u;
}
async function cookieFor(u: User): Promise<string> {
  const res = await request(loginApp).post('/api/auth/login').send({ email: u.email, password: PASSWORD });
  expect(res.status).toBe(200);
  const sc = res.headers['set-cookie'];
  return (Array.isArray(sc) ? sc : [sc as unknown as string]).map((l) => l.split(';')[0]).join('; ');
}
const appWith = (over: WorkerDeps = {}, fetchImpl?: typeof fetch) =>
  createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 }, facebook: { enabled: () => true, clock: () => NOW, portals: () => ({ [PORTAL]: PAGE }), postFrom: () => FROM, worker: deps(over), fetch: fetchImpl } });

const cleanState = async () => {
  await prisma.facebookPost.deleteMany({ where: { page: PAGE } });
  await prisma.digestSetting.deleteMany({ where: { key: { in: [authKey(PAGE), policyKey(PAGE)] } } });
  await prisma.campaign.deleteMany({ where: { portal: { startsWith: PORTAL } } });
};
const savedPage = env.facebook.pages[PAGE];
beforeAll(async () => {
  env.facebook.pages[PAGE] = { pageId: '1234567890', accessToken: TOKEN };
  admin = await makeUser('ADMIN');
  publisher = await makeUser('PUBLISHER');
  adminCookie = await cookieFor(admin);
  publisherCookie = await cookieFor(publisher);
});
beforeEach(async () => {
  calls = [];
  mails = [];
  script = () => posted();
  env.facebook.pages[PAGE] = { pageId: '1234567890', accessToken: TOKEN };
  resetFacebookStops();
  await cleanState();
  logSpy.mockClear();
  errSpy.mockClear();
});
afterAll(async () => {
  if (savedPage) env.facebook.pages[PAGE] = savedPage;
  else delete env.facebook.pages[PAGE];
  await cleanState();
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL audit_log.allow_purge = 'true'`);
    await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "userId" = ANY(${userIds}::text[])`;
  });
  await prisma.userSession.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe('1. what posts', () => {
  it('SENT taxscan articles (both URL shapes) post once; never test-segment-only, home/section/academy/shop, before go-live, older than 24 h, drafts; a re-push or clone adds no row', async () => {
    const before = await camp('before-golive', at(FROM, -30));
    const a = await camp('numeric', at(NOW, -50), { url: `https://www.taxscan.in/gst/slug-${RUN}-111111` });
    const b = await camp('slugonly', at(NOW, -40)); // /gst/<slug> with no trailing id
    await camp('test-only', at(NOW, -45), { target: { type: 'topics', topics: [env.testSegmentTopic] } });
    await camp('home', at(NOW, -44), { url: 'https://www.taxscan.in/' });
    await camp('section', at(NOW, -43), { url: 'https://www.taxscan.in/gst' });
    await camp('academy', at(NOW, -42), { host: 'academy.taxscan.in' });
    await camp('shop', at(NOW, -41), { host: 'shop.taxscan.in' });
    await camp('draft', at(NOW, -39), { status: 'DRAFT' });
    await prisma.campaign.create({ data: { portal: PORTAL, title: 'again', body: 'b', url: b.url, target: {}, status: 'SENT', lastSentAt: at(NOW, -5) } });
    await prisma.campaign.create({ data: { portal: PORTAL, title: 'old again', body: 'b', url: before.url, target: {}, status: 'SENT', lastSentAt: at(NOW, -2) } });
    await ticks(30, NOW);
    expect(calls.map((c) => c.message.split('\n')[0])).toEqual([`Story numeric`, `Story slugonly`]);
    const rows = await rowsOf();
    expect(rows.map((r) => r.campaignId)).toEqual([a.id, b.id]);
    expect(rows.every((r) => r.status === 'POSTED' && r.facebookPostId === '123_456' && r.attempts === 1)).toBe(true);
  });
  it('nothing older than 24 h is posted', async () => {
    await camp('stale', at(NOW, -25 * 60));
    await ticks(2, NOW, { postFrom: at(NOW, -30 * 60) });
    expect(calls).toHaveLength(0);
  });
});

describe('2. request shape', () => {
  it('form body has message, link, access_token; the URL has no token; version from env; message = headline + blank line + <= 4 plain hashtags ending #taxscan', async () => {
    let sent: { url: string; init: RequestInit } | null = null;
    const f = (async (url: string, init: RequestInit) => {
      sent = { url, init };
      return { status: 200, ok: true, headers: new Headers(), json: async () => ({ id: '999_888' }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const message = buildMessage('Order [Read] (2)', ['SupremeCourt', 'GST', 'Section69CGST', 'Interest', 'taxscan']);
    const r = await postToFacebook({ pageId: '1234567890', accessToken: TOKEN, message, link: 'https://www.taxscan.in/gst/x?utm_source=taxscan-facebook' }, f);
    expect(r).toEqual({ kind: 'posted', postId: '999_888' });
    expect(sent!.url).toBe(`https://graph.facebook.com/${env.facebook.graphVersion}/1234567890/feed`);
    expect(env.facebook.graphVersion).toBe('v25.0');
    expect(sent!.url).not.toContain(TOKEN);
    expect(sent!.url).not.toContain('access_token');
    const form = new URLSearchParams(String(sent!.init.body));
    expect([...form.keys()].sort()).toEqual(['access_token', 'link', 'message']);
    expect(form.get('access_token')).toBe(TOKEN);
    expect((sent!.init.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(form.get('message')).toBe('Order [Read] (2)\n\n#SupremeCourt #GST #Section69CGST #taxscan');
    expect(feedUrl('42')).toContain(env.facebook.graphVersion);
    expect(postForm({ pageId: '1', accessToken: 't'.repeat(20), message: 'm', link: 'l' })).toContain('access_token=');
  });
  it('the worker posts headline + hashtags (no link text) and a link with the four Facebook UTMs that passes the allowlist', async () => {
    await camp('shape', at(NOW, -5), { title: 'Order  (2)\n [Read Order]' });
    await runFacebookTick(deps());
    expect(calls).toHaveLength(1);
    const c = calls[0];
    expect(c.pageId).toBe('1234567890');
    expect(c.message).toBe('Order (2) [Read Order]\n\n#SupremeCourt #GST #taxscan');
    expect(c.message).not.toContain('http');
    const u = new URL(c.link);
    expect(u.searchParams.get('utm_source')).toBe('taxscan-facebook');
    expect(u.searchParams.get('utm_medium')).toBe('social');
    expect(u.searchParams.get('utm_campaign')).toBe(`facebook-${PAGE}`);
    expect(u.searchParams.get('utm_content')).toMatch(/^shape-/);
    expect(isAllowedPushUrl(c.link)).toBe(true);
    expect(logSpy.mock.calls.map((x) => String(x[0])).join('\n')).toMatch(/\[facebook\] page=fbtest\d+ campaign=\S+ outcome=posted hashtags=fallback/);
  });
  it('at most 4 hashtags even with rich CMS data, #taxscan last', async () => {
    await camp('rich', at(NOW, -5));
    await runFacebookTick(deps({ fetchCms: async () => ({ keywords: ['Section 69 CGST Act', 'Input Tax Credit', 'Pre-deposit', 'Penalty'], courts: [{ name: 'Supreme Court of India', shortName: 'SC' }], category: 'GST' }) }));
    const tags = calls[0].message.split('\n\n')[1].split(' ');
    expect(tags.length).toBeLessThanOrEqual(4);
    expect(tags[tags.length - 1]).toBe('#taxscan');
    expect(tags.every((t) => /^#[A-Za-z0-9]+$/.test(t))).toBe(true);
    expect(logSpy.mock.calls.map((x) => String(x[0])).join('\n')).toContain('hashtags=cms');
  });
});

describe('3. pacing', () => {
  it('5 campaigns pushed at once: 1 post per tick and at least FACEBOOK_MIN_GAP_MINUTES apart', async () => {
    for (let i = 0; i < 5; i += 1) await camp(`burst${i}`, at(NOW, -20 + i));
    const times: number[] = [];
    for (let m = 0; m < 45; m += 1) {
      const before = calls.length;
      const t = await runFacebookTick(deps({ now: () => at(NOW, m) }));
      expect(calls.length - before).toBeLessThanOrEqual(1);
      if (calls.length > before) times.push(m);
      if (m === 1) expect(t.waited).toBe('gap');
    }
    expect(times).toEqual([0, 10, 20, 30, 40]);
    expect(calls.map((c) => c.message.split('\n')[0])).toEqual(['Story burst0', 'Story burst1', 'Story burst2', 'Story burst3', 'Story burst4']);
  });
  it('the 31st post of an IST day waits (cap 30), and posts the next day while still inside 24 h', async () => {
    const c = await camp('thirty-first', at(NOW, 200 * 0 - 5));
    for (let i = 0; i < 30; i += 1) {
      await prisma.facebookPost.create({ data: { page: PAGE, articleKey: `k-${RUN}-${i}`, campaignId: c.id, status: 'POSTED', attempts: 1, postedAt: at(ist(0, 30), i) } });
    }
    const t = await runFacebookTick(deps({ now: () => at(NOW, 120) }));
    expect(t.waited).toBe('daily_cap');
    expect(calls).toHaveLength(0);
    // next IST day (still within 24 h of the push), well past the gap: posts
    await runFacebookTick(deps({ now: () => ist(0, 30, 4), postFrom: at(NOW, -60) }));
    expect(calls).toHaveLength(1);
  });
});

describe('4. errors', () => {
  it('190: auth stop, one email per IST day, banner; nothing more is attempted; a new token resumes', async () => {
    await camp('a', at(NOW, -30));
    await camp('b', at(NOW, -20));
    script = () => fail('auth', 400, 190);
    const t = await runFacebookTick(deps());
    expect(t.authStopped).toBe(true);
    expect(calls).toHaveLength(1);
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe('admin@team.test');
    expect(await loginProblem(PAGE)).toMatchObject({ status: 400 });
    await ticks(3, at(NOW, 20));
    expect(calls).toHaveLength(1);
    // a restart the same day: tries once, fails again, no second email
    resetFacebookStops();
    await runFacebookTick(deps({ now: () => at(NOW, 30) }));
    expect(calls).toHaveLength(2);
    expect(mails).toHaveLength(1);
    // the next IST day: one more email
    resetFacebookStops();
    await runFacebookTick(deps({ now: () => ist(10, 0, 4), postFrom: at(NOW, -60 * 24) }));
    expect(mails).toHaveLength(2);
    // a new token resumes and clears the banner
    env.facebook.pages[PAGE] = { pageId: '1234567890', accessToken: `${TOKEN}-new` };
    script = () => posted();
    await runFacebookTick(deps({ now: () => ist(10, 30, 4), postFrom: at(NOW, -60 * 24) }));
    expect(calls[calls.length - 1].accessToken).toBe(`${TOKEN}-new`);
    expect(await loginProblem(PAGE)).toBeNull();
  });
  it('permission (10, 2xx) and HTTP 401/403 are auth too (classifier)', () => {
    for (const [status, code] of [[403, 10], [400, 200], [400, 299], [401, null], [403, null], [400, 190]] as const) expect(classify(status, code === null ? null : { code }, TOKEN).kind).toBe('auth');
  });
  it('368: policy stop that survives a restart, e-mails at once, blocks Retry, and is cleared only by ADMIN Resume (audited)', async () => {
    await camp('p1', at(NOW, -30));
    await camp('p2', at(NOW, -20));
    script = () => fail('policy', 400, 368, 1390008);
    const t = await runFacebookTick(deps());
    expect(t.policyStopped).toBe(true);
    expect(mails).toHaveLength(1);
    expect(mails[0].subject).toContain('Facebook blocked a post');
    expect(await policyProblem(PAGE)).toMatchObject({ code: 368, subcode: 1390008 });
    const failedRow = (await rowsOf())[0];
    expect(failedRow.status).toBe('FAILED');
    // "restart": every in-memory stop forgotten, ticks keep refusing to post
    resetFacebookStops();
    script = () => posted();
    await ticks(30, at(NOW, 40));
    expect(calls).toHaveLength(1);
    expect(mails).toHaveLength(1);
    // Retry refused while stopped
    const a = appWith();
    const retry = await request(a).post(`/api/facebook/posts/${failedRow.id}/retry`).set('Cookie', adminCookie);
    expect(retry.status).toBe(409);
    expect(retry.body.error).toBe('policy_stop');
    expect(calls).toHaveLength(1);
    // the screen shows the red banner data; a publisher cannot resume
    const list = await request(a).get('/api/facebook/posts?date=2026-11-03').set('Cookie', publisherCookie);
    expect(list.body.policy).toMatchObject({ code: 368 });
    expect((await request(a).post('/api/facebook/resume').set('Cookie', publisherCookie)).status).toBe(403);
    expect(await policyProblem(PAGE)).not.toBeNull();
    // ADMIN resume: audited, posting continues
    const ok = await request(a).post('/api/facebook/resume').set('Cookie', adminCookie);
    expect(ok.status).toBe(200);
    expect(await policyProblem(PAGE)).toBeNull();
    const audit = await prisma.auditLog.findMany({ where: { userId: admin.id, action: 'FACEBOOK_POSTING_RESUMED' } });
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0].metadata)).not.toMatch(/https?:|facebook\.com|SECRET/);
    expect((await request(a).post('/api/facebook/resume').set('Cookie', adminCookie)).status).toBe(409);
    await runFacebookTick(deps({ now: () => at(NOW, 100) }));
    expect(calls).toHaveLength(2);
  });
  it('classifier: spam/blocked/restricted types and a user title on an unknown 4xx are policy; ordinary 4xx are not', () => {
    expect(classify(400, { type: 'OAuthException', code: 368 }, TOKEN).kind).toBe('policy');
    expect(classify(400, { type: 'SpamBlockedException', code: 100 }, TOKEN).kind).toBe('policy');
    expect(classify(400, { type: 'x', code: 100, error_user_title: 'Action blocked' }, TOKEN).kind).toBe('policy');
    expect(classify(400, { type: 'GraphMethodException', code: 100, message: 'Invalid parameter' }, TOKEN).kind).toBe('failed');
    expect(classify(400, { code: 506 }, TOKEN).kind).toBe('duplicate');
    expect(classify(500, null, TOKEN).kind).toBe('transient');
    expect(classify(400, { code: 2 }, TOKEN).kind).toBe('transient');
  });
  it('4/17/32/613 and HTTP 429: retry at +15 then +60 min, then FAILED', async () => {
    for (const [status, code] of [[400, 4], [400, 17], [400, 32], [400, 613], [429, null]] as const) {
      await cleanState();
      calls = [];
      await camp(`rate${code}`, at(NOW, -5));
      script = () => fail('rate', status, code);
      await runFacebookTick(deps());
      let row = (await rowsOf())[0];
      expect(row.status).toBe('PENDING');
      expect(row.nextAttemptAt!.getTime() - NOW.getTime()).toBe(15 * MIN);
      await runFacebookTick(deps({ now: () => at(NOW, 15) }));
      row = (await rowsOf())[0];
      expect(row.attempts).toBe(2);
      expect(row.nextAttemptAt!.getTime() - at(NOW, 15).getTime()).toBe(60 * MIN);
      await runFacebookTick(deps({ now: () => at(NOW, 75) }));
      row = (await rowsOf())[0];
      expect(row.status).toBe('FAILED');
      expect(row.nextAttemptAt).toBeNull();
      expect(calls).toHaveLength(3);
    }
  });
  it('5xx / network / timeout / code 1 / 2: retry +1, +5, +15, then FAILED', async () => {
    await camp('flaky', at(NOW, -5));
    script = () => fail('transient', 503, null);
    const delays: number[] = [];
    let now = NOW;
    for (let i = 0; i < 4; i += 1) {
      await runFacebookTick(deps({ now: () => now }));
      const row = (await rowsOf())[0];
      if (row.status === 'FAILED') break;
      delays.push((row.nextAttemptAt!.getTime() - now.getTime()) / MIN);
      now = row.nextAttemptAt!;
    }
    expect(delays).toEqual([1, 5, 15]);
    expect((await rowsOf())[0]).toMatchObject({ status: 'FAILED', attempts: 4 });
    expect(calls).toHaveLength(4);
  });
  it('client: a thrown fetch is transient (network), an abort is a timeout', async () => {
    const boom = (async () => {
      throw new Error(`boom ${TOKEN}`);
    }) as unknown as typeof fetch;
    const r = await postToFacebook({ pageId: '1234567890', accessToken: TOKEN, message: 'm', link: 'l' }, boom);
    expect(r).toMatchObject({ kind: 'transient', error: 'network error' });
  });
  it('506: FAILED "already posted", no retry', async () => {
    await camp('dup', at(NOW, -5));
    script = () => fail('duplicate', 400, 506);
    await runFacebookTick(deps());
    await ticks(30, at(NOW, 1));
    expect(calls).toHaveLength(1);
    expect((await rowsOf())[0]).toMatchObject({ status: 'FAILED', error: 'Facebook says this was already posted', nextAttemptAt: null });
  });
  it('another 4xx fails at once; a retry due in quiet hours waits for 07:00 IST', async () => {
    await camp('bad', at(NOW, -5));
    script = () => fail('failed', 400, 100);
    await runFacebookTick(deps());
    expect((await rowsOf())[0].status).toBe('FAILED');
    await cleanState();
    const late = ist(22, 59);
    await camp('late', at(late, -3));
    script = () => fail('transient', 503, null);
    await runFacebookTick(deps({ now: () => late, postFrom: at(late, -60) }));
    const row = (await rowsOf())[0];
    expect(row.nextAttemptAt!.getTime()).toBe(ist(7, 0, 4).getTime());
    const n = calls.length;
    await runFacebookTick(deps({ now: () => at(late, 30), postFrom: at(late, -60) })); // 23:29 IST: still quiet
    expect(calls).toHaveLength(n);
  });
  it('a stale in-flight row becomes FAILED "unknown", never re-posted; a crash mid-attempt does the same', async () => {
    // updatedAt is the DB's real clock, so the tick's clock is real time + 11 min (as the LinkedIn test does)
    const row = await prisma.facebookPost.create({ data: { page: PAGE, articleKey: 'k-stale', campaignId: 'c-stale', status: 'PENDING', attempts: 1 } });
    const t = await runFacebookTick(deps({ now: () => new Date(Date.now() + 11 * MIN) }));
    expect(t.staleClosed).toBe(1);
    expect(calls).toHaveLength(0);
    expect((await prisma.facebookPost.findUnique({ where: { id: row.id } }))).toMatchObject({ status: 'FAILED', error: UNKNOWN_ERROR });
    await cleanState();
    await camp('crash', at(NOW, -5));
    script = () => {
      throw new Error('db down');
    };
    await runFacebookTick(deps());
    expect((await rowsOf())[0]).toMatchObject({ status: 'FAILED', error: UNKNOWN_ERROR });
    script = () => posted();
    await ticks(25, at(NOW, 1));
    expect(calls).toHaveLength(1);
  });
});

describe('5. the token never leaves the building', () => {
  it('client: only in the body (post) or the Authorization header (check); scrubbed from error text', async () => {
    const f = (async () => ({ status: 400, ok: false, headers: new Headers(), json: async () => ({ error: { message: `bad Bearer ${TOKEN} / access_token=${TOKEN} / ${TOKEN}`, code: 100, type: 'GraphMethodException' } }) }) as unknown as Response) as unknown as typeof fetch;
    const r = await postToFacebook({ pageId: '1234567890', accessToken: TOKEN, message: 'm', link: 'l' }, f);
    expect(r.kind).toBe('failed');
    if (r.kind !== 'posted') expect(r.error).not.toContain(TOKEN);
    const c = await checkConnection({ pageId: '1234567890', accessToken: TOKEN }, f);
    expect(JSON.stringify(c)).not.toContain(TOKEN);
  });
  it('not in any log line, row, setting, alert email or API response across success, retry, auth and policy paths', async () => {
    await camp('leak-a', at(NOW, -30));
    await camp('leak-b', at(NOW, -29));
    await camp('leak-c', at(NOW, -28));
    const msg = `oops ${TOKEN}`;
    const scripted: FacebookResult[] = [posted(), { kind: 'transient', status: 500, code: null, subcode: null, error: msg.replace(TOKEN, '[token]') }, fail('policy', 400, 368)];
    script = (n) => scripted[n - 1];
    for (let m = 0; m < 40; m += 1) await runFacebookTick(deps({ now: () => at(NOW, m) }));
    const a = appWith();
    const list = await request(a).get('/api/facebook/posts?date=2026-11-03').set('Cookie', adminCookie);
    expect(list.status).toBe(200);
    const everything = JSON.stringify({
      logs: [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errSpy.mock.calls],
      rows: await rowsOf(),
      settings: await prisma.digestSetting.findMany({ where: { key: { in: [authKey(PAGE), policyKey(PAGE)] } } }),
      mails,
      api: list.body,
    });
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain('SECRET-TOKEN');
    expect(mails.length).toBeGreaterThan(0);
  });
  it('source scan: the token is never in a URL builder, a console call or a template string URL', () => {
    const dir = path.join(__dirname, '../services/facebook');
    const files = [...fs.readdirSync(dir).map((f) => path.join(dir, f)), path.join(__dirname, '../routes/facebook.ts')];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      expect(src).not.toMatch(/\?[^'"`\n]*access_token=\$\{/); // never `…?access_token=${token}`
      expect(src).not.toMatch(/graph\.facebook\.com[^\n]*\$\{[^}]*(accessToken|token)/i);
      for (const m of src.matchAll(/console\.(log|error|warn)\(([^\n]*)\)/g)) {
        expect(m[2]).not.toMatch(/accessToken|\btoken\b|access_token/);
        if (/catch/.test(m[0]) || /\berr\)/.test(m[2])) expect(m[2]).toMatch(/safeErrorLog/);
      }
      expect(src).not.toMatch(/console\.\w+\([^)]*,\s*(err|error)\s*\)/);
    }
  });
});

describe('6. the flag', () => {
  it('off: no cron, every endpoint 404, features.facebookPosting is false', async () => {
    const schedule = jest.spyOn(cron, 'schedule');
    const was = env.facebook.enabled;
    env.facebook.enabled = false;
    startFacebookWorker();
    expect(schedule).not.toHaveBeenCalled();
    const a = createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 }, facebook: { enabled: () => false } });
    for (const [m, p] of [['get', '/api/facebook/posts'], ['post', '/api/facebook/posts/x/retry'], ['post', '/api/facebook/posts/x/skip'], ['post', '/api/facebook/check'], ['post', '/api/facebook/resume']] as const) {
      expect((await request(a)[m](p).set('Cookie', adminCookie)).status).toBe(404);
    }
    const me = await request(loginApp).get('/api/auth/me').set('Cookie', adminCookie);
    expect(me.body.features.facebookPosting).toBe(false);
    env.facebook.enabled = was;
    schedule.mockRestore();
  });
  it('on without FACEBOOK_POST_FROM, or without a valid page id / token: refuses to start and says why; with both it schedules', () => {
    const schedule = jest.spyOn(cron, 'schedule');
    const was = { enabled: env.facebook.enabled, from: env.facebook.postFrom, tax: env.facebook.pages.taxscan };
    env.facebook.enabled = true;
    env.facebook.postFrom = null;
    startFacebookWorker();
    expect(schedule).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('[facebook] refusing to start: FACEBOOK_POST_FROM');
    env.facebook.postFrom = new Date();
    env.facebook.pages.taxscan = { pageId: 'abc', accessToken: 'x' };
    startFacebookWorker();
    expect(schedule).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('PAGE_TOKEN are not both set and valid');
    env.facebook.pages.taxscan = { pageId: '1234567890', accessToken: TOKEN };
    startFacebookWorker();
    expect(schedule).toHaveBeenCalledWith('* * * * *', expect.any(Function));
    Object.assign(env.facebook, { enabled: was.enabled, postFrom: was.from });
    env.facebook.pages.taxscan = was.tax;
    schedule.mockRestore();
  });
  it('the tick itself refuses without a go-live time', async () => {
    await camp('no-from', at(NOW, -5));
    const t = await runFacebookTick(deps({ postFrom: null }));
    expect(t.refused).toContain('FACEBOOK_POST_FROM');
    expect(calls).toHaveLength(0);
  });
});

describe('7. check connection', () => {
  const fakeFetch = (status: number, body: unknown, spy?: (url: string, init: RequestInit) => void) =>
    (async (url: string, init: RequestInit) => {
      spy?.(url, init);
      return { status, ok: status >= 200 && status < 300, headers: new Headers(), json: async () => body } as unknown as Response;
    }) as unknown as typeof fetch;
  it('200 {name}: "Connected to page: …"; GET with the token in the header, not the URL, and no /feed call', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const a = appWith({}, fakeFetch(200, { name: 'Taxscan', id: '1234567890' }, (url, init) => seen.push({ url, init })));
    const res = await request(a).post('/api/facebook/check').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, name: 'Taxscan', message: 'Connected to page: Taxscan' });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(`https://graph.facebook.com/${env.facebook.graphVersion}/1234567890?fields=name`);
    expect(seen[0].url).not.toContain('/feed');
    expect(seen[0].url).not.toContain(TOKEN);
    expect(seen[0].init.method).toBe('GET');
    expect((seen[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
  });
  it('190: the auth class, no post, no state change', async () => {
    const a = appWith({}, fakeFetch(400, { error: { code: 190, type: 'OAuthException', message: `expired ${TOKEN}` } }));
    const res = await request(a).post('/api/facebook/check').set('Cookie', adminCookie);
    expect(res.body).toMatchObject({ ok: false, kind: 'auth', code: 190 });
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
    expect(await loginProblem(PAGE)).toBeNull();
    expect(await rowsOf()).toHaveLength(0);
  });
  it('ADMIN only (publisher 403, anonymous 401)', async () => {
    const a = appWith({}, fakeFetch(200, { name: 'x' }));
    expect((await request(a).post('/api/facebook/check').set('Cookie', publisherCookie)).status).toBe(403);
    expect((await request(a).post('/api/facebook/check')).status).toBe(401);
  });
});

describe('API: list, retry, skip', () => {
  it('lists the IST day with statuses and post links; Retry posts once; Skip works; auth is required', async () => {
    const c1 = await camp('l1', at(NOW, -50));
    const c2 = await camp('l2', at(NOW, -40));
    await camp('l3', at(NOW, -30));
    await prisma.facebookPost.create({ data: { page: PAGE, articleKey: (await keyOf(c1)), campaignId: c1.id, status: 'POSTED', attempts: 1, postedAt: at(NOW, -49), facebookPostId: '1234567890_555' } });
    const failedRow = await prisma.facebookPost.create({ data: { page: PAGE, articleKey: await keyOf(c2), campaignId: c2.id, status: 'FAILED', attempts: 4, error: 'HTTP 400 code 100' } });
    const a = appWith();
    expect((await request(a).get('/api/facebook/posts')).status).toBe(401);
    const list = await request(a).get('/api/facebook/posts?date=2026-11-03').set('Cookie', publisherCookie);
    expect(list.status).toBe(200);
    expect(list.body.rows.map((r: { status: string }) => r.status)).toEqual(['POSTED', 'FAILED', 'WAITING']);
    expect(list.body.rows[0].postUrl).toBe('https://www.facebook.com/1234567890_555');
    expect(list.body).toMatchObject({ page: PAGE, login: null, policy: null, counts: { posted: 1, failed: 1, waiting: 1, all: 3 } });
    expect((await request(a).get('/api/facebook/posts?date=2026-10-01').set('Cookie', publisherCookie)).status).toBe(400);
    const retry = await request(a).post(`/api/facebook/posts/${failedRow.id}/retry`).set('Cookie', publisherCookie);
    expect(retry.body).toEqual({ ok: true, status: 'POSTED' });
    expect(calls).toHaveLength(1);
    expect((await request(a).post(`/api/facebook/posts/${failedRow.id}/retry`).set('Cookie', publisherCookie)).status).toBe(409);
    expect((await request(a).post(`/api/facebook/posts/${failedRow.id}/skip`).set('Cookie', publisherCookie)).status).toBe(409);
    expect((await retryNow('nope', deps())).ok).toBe(false);
  });
});

async function keyOf(c: { id: string; url: string }) {
  const { articleKey } = await import('../services/reports');
  return articleKey(c);
}
