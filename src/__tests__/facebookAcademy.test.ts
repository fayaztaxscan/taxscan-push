import bcrypt from 'bcrypt';
import cron from 'node-cron';
import request from 'supertest';
import { randomBytes } from 'node:crypto';
import type { Campaign, User, UserRole } from '@prisma/client';
import { createApp } from '../app';
import { env, parseFacebookAcademyEnv, parseFacebookShopscanEnv } from '../lib/env';
import { prisma } from '../lib/prisma';
import { articleKey } from '../services/reports';
import { classify, postToFacebook, type FacebookRequest, type FacebookResult } from '../services/facebook/client';
import { PAGE_ACADEMY, PAGE_SHOPSCAN, PAGE_TAXSCAN, SHARED_PAGES, isSharedPage, pageAllPushesFrom, pageConfig, pagePostFrom, portalPages, withFacebookUtm } from '../services/facebook/pages';
import { authKey, loginProblem, policyKey, policyProblem, resetFacebookStops, resumePolicy, runFacebookTick, startFacebookWorker, startupProblem, type WorkerDeps } from '../services/facebook/worker';
import { activeSocialPages, facebookSkipKey, unknownSocialKeys } from '../services/social/pages';
import { activePages, facebookAuthKey, facebookPolicyKey, getPageStatus, pageLabel } from '../services/social/pageStatus';
import { alertIfNeeded, alertKey } from '../services/social/pageAlerts';
import { pauseKey, clearPause, setPause } from '../services/social/pause';
import { pushKey } from '../services/social/allPushes';

/**
 * Brief 2026-11-27-facebook-academy-page: the Taxscan Academy Facebook page, a second SHARED page beside Shopscan. EVERY Graph call is a
 * fake: no real Facebook request anywhere.
 *
 * ISOLATION (as in facebookShopscan.test.ts): rows live in a shared dev DB, so the tests that write rows never use the REAL page names.
 * `fbacad-t…` plays the Taxscan page, `fbacad-s…` Shopscan and `fbacad-a…` Academy, under a unique portal. Where the REAL names matter
 * (the page list and its order, the UTM, the boot lines, Compose, page status, the list route) the functions are pure, read only, or only
 * `env` is toggled for the length of one test; nothing is written under the names `taxscan` / `shopscan` / `academy`.
 */
const logs: string[] = [];
jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
jest.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
jest.spyOn(console, 'warn').mockImplementation(() => undefined);

const RUN = `${Date.now()}-${randomBytes(3).toString('hex')}`;
const PORTAL = `test-fbacad-${RUN}`;
const PAGE_T = `fbacad-t${Math.floor(Math.random() * 1e9)}`; // plays the Taxscan page
const PAGE_S = `fbacad-s${Math.floor(Math.random() * 1e9)}`; // plays Shopscan
const PAGE_A = `fbacad-a${Math.floor(Math.random() * 1e9)}`; // plays Academy
const ID_T = '1111111111';
const ID_S = '2222222222';
const ID_A = '3333333333';
const TOKEN_T = `TAXSCAN-PAGE-TOKEN-${RUN}`;
const TOKEN_S = `SHOPSCAN-PAGE-TOKEN-${RUN}`;
const TOKEN_A = `ACADEMY-PAGE-TOKEN-${RUN}`;
const IST_MS = (5 * 60 + 30) * 60_000;
const ist = (h: number, m = 0, day = 28) => new Date(Date.UTC(2026, 10, day, h, m) - IST_MS);
const MIN = 60_000;
const at = (base: Date, min: number) => new Date(base.getTime() + min * MIN);
const NOW = ist(10, 0);
const FROM_T = ist(4, 0); // the Taxscan page's go-live
const FROM_S = ist(6, 0); // Shopscan's own
const FROM_A = ist(8, 0); // Academy's own, the latest
const PASSWORD = 'fb-academy-test-pw-1';

const posted = (id = '123_456'): FacebookResult => ({ kind: 'posted', postId: id });
const failure = (kind: 'rate' | 'transient' | 'auth' | 'policy' | 'duplicate' | 'failed', status: number | null, code: number | null): FacebookResult => ({
  kind,
  status,
  code,
  subcode: null,
  error: `HTTP ${status} code ${code}`,
});

let calls: FacebookRequest[] = [];
let script: (r: FacebookRequest, n: number) => FacebookResult | Promise<FacebookResult> = (r, n) => posted(`${r.pageId}_${n}`);
const post: NonNullable<WorkerDeps['post']> = async (r) => {
  calls.push(r);
  return script(r, calls.length);
};
const callsFor = (pageId: string) => calls.filter((c) => c.pageId === pageId);
const calledPages = () => calls.map((c) => c.pageId);
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
  portals: { [PORTAL]: [PAGE_T, PAGE_S, PAGE_A] },
  postFrom: { [PAGE_T]: FROM_T, [PAGE_S]: FROM_S, [PAGE_A]: FROM_A },
  allPushesFrom: { [PAGE_T]: null }, // the Taxscan page stays on today's rule; each shared page's own is its go-live
  quiet: { start: '23:00', end: '07:00' },
  minGapMinutes: 10,
  dailyCap: 30,
  ...over,
});

let seq = 0;
async function camp(slug: string, lastSentAt: Date, o: { url?: string; title?: string; body?: string; skip?: string[]; picture?: string | null } = {}): Promise<Campaign> {
  return prisma.campaign.create({
    data: {
      portal: PORTAL,
      title: o.title ?? `Story ${slug}`,
      body: o.body ?? 'b',
      url: o.url ?? `https://www.taxscan.in/gst/${slug}-${RUN}-${++seq}`,
      target: {},
      status: 'SENT',
      lastSentAt,
      authority: 'Supreme Court',
      categories: ['GST'],
      socialSkip: o.skip ?? [],
      socialImageId: o.picture ?? null,
    } as never,
  });
}
const courseUrl = (s: string) => `https://academy.taxscan.in/course/${s}-${RUN}`;
const productUrl = (s: string) => `https://shop.taxscan.in/products/${s}-${RUN}`;
const rowsOf = (page: string) => prisma.facebookPost.findMany({ where: { page }, orderBy: { createdAt: 'asc' } });
/** A finished post already on a page's record (for the gap, the daily cap and the status tests). */
const seedRow = (page: string, key: string, campaignId: string, status: 'POSTED' | 'FAILED', when: Date, error: string | null = null) =>
  prisma.facebookPost.create({ data: { page, articleKey: key, campaignId, status, attempts: 1, postedAt: status === 'POSTED' ? when : null, error, facebookPostId: status === 'POSTED' ? `${page}_seed` : null, updatedAt: when } });
/** Runs `n` ticks one minute apart. */
async function ticks(n: number, start: Date, over: WorkerDeps = {}) {
  for (let i = 0; i < n; i += 1) await runFacebookTick(deps({ now: () => at(start, i), ...over }));
}

const pageKeys = [PAGE_T, PAGE_S, PAGE_A];
const settingKeys = pageKeys.flatMap((p) => [authKey(p), policyKey(p), pauseKey('facebook', p), alertKey('facebook', p, 'failing'), alertKey('facebook', p, 'held')]);
const imageIds: string[] = [];
const cleanState = async () => {
  await prisma.facebookPost.deleteMany({ where: { page: { in: pageKeys } } });
  await prisma.digestSetting.deleteMany({ where: { key: { in: settingKeys } } });
  await prisma.campaign.deleteMany({ where: { portal: { startsWith: PORTAL } } });
};

// What the tests change on `env`, restored after each test (and the registered pages after the file).
const saved = {
  enabled: env.facebook.enabled,
  postFrom: env.facebook.postFrom,
  allPushesFrom: env.facebook.allPushesFrom,
  taxscan: env.facebook.pages.taxscan,
  shopscan: env.facebook.sharedPages.shopscan,
  academy: env.facebook.sharedPages.academy,
  anyLinkFrom: env.social.anyLinkFrom,
  pictureEnabled: env.social.pictureEnabled,
};
const setShared = (page: string, v: (typeof env.facebook.sharedPages)[string] | undefined) => {
  if (v) env.facebook.sharedPages[page] = v;
  else delete env.facebook.sharedPages[page];
};
const restoreEnv = () => {
  env.facebook.enabled = saved.enabled;
  env.facebook.postFrom = saved.postFrom;
  env.facebook.allPushesFrom = saved.allPushesFrom;
  env.facebook.pages.taxscan = saved.taxscan;
  setShared('shopscan', saved.shopscan);
  setShared('academy', saved.academy);
  env.social.anyLinkFrom = saved.anyLinkFrom;
  env.social.pictureEnabled = saved.pictureEnabled;
};
/** The REAL pages for a test of the page list / Compose / status: Taxscan valid, each shared page on or off. Restored by `restoreEnv`. */
function realPages(on: { shopscan: boolean; academy: boolean }) {
  env.facebook.enabled = true;
  env.facebook.pages.taxscan = { pageId: '4444444444', accessToken: `REAL-TAXSCAN-TEST-TOKEN-${RUN}` };
  setShared('shopscan', on.shopscan ? { pageId: '5555555555', accessToken: `REAL-SHOPSCAN-TEST-TOKEN-${RUN}`, postFrom: FROM_S } : undefined);
  setShared('academy', on.academy ? { pageId: '6666666666', accessToken: `REAL-ACADEMY-TEST-TOKEN-${RUN}`, postFrom: FROM_A } : undefined);
}

const userIds: string[] = [];
const loginApp = createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 } });
let adminCookie: string;
async function makeUser(role: UserRole): Promise<User> {
  const u = await prisma.user.create({ data: { email: `fbacad-${role.toLowerCase()}-${RUN}-${++seq}@team.test`, passwordHash: await bcrypt.hash(PASSWORD, 4), role, isActive: true } });
  userIds.push(u.id);
  return u;
}
async function cookieFor(u: User): Promise<string> {
  const res = await request(loginApp).post('/api/auth/login').send({ email: u.email, password: PASSWORD });
  expect(res.status).toBe(200);
  const sc = res.headers['set-cookie'];
  return (Array.isArray(sc) ? sc : [sc as unknown as string]).map((l) => l.split(';')[0]).join('; ');
}
type FetchFake = (url: string, init?: { headers?: Record<string, string> }) => Promise<Response>;
const appWith = (o: { portals?: Record<string, string[]>; fetch?: FetchFake } = {}) =>
  createApp({
    rateLimit: { publicPerMin: 10000, loginPerMin: 10000 },
    facebook: {
      enabled: () => true,
      clock: () => NOW,
      portals: () => o.portals ?? { [PORTAL]: [PAGE_T, PAGE_S, PAGE_A] },
      postFrom: () => ({ [PAGE_T]: FROM_T, [PAGE_S]: FROM_S, [PAGE_A]: FROM_A }),
      allPushesFrom: () => ({ [PAGE_T]: null }),
      worker: deps(),
      fetch: o.fetch as unknown as typeof fetch,
    },
  });

beforeAll(async () => {
  adminCookie = await cookieFor(await makeUser('ADMIN'));
});
beforeEach(async () => {
  calls = [];
  mails = [];
  logs.length = 0;
  script = (r, n) => posted(`${r.pageId}_${n}`);
  env.facebook.pages[PAGE_T] = { pageId: ID_T, accessToken: TOKEN_T };
  env.facebook.sharedPages[PAGE_S] = { pageId: ID_S, accessToken: TOKEN_S, postFrom: FROM_S };
  env.facebook.sharedPages[PAGE_A] = { pageId: ID_A, accessToken: TOKEN_A, postFrom: FROM_A };
  env.social.pictureEnabled = false;
  resetFacebookStops();
  await cleanState();
});
afterEach(restoreEnv);
afterAll(async () => {
  restoreEnv();
  delete env.facebook.pages[PAGE_T];
  delete env.facebook.sharedPages[PAGE_S];
  delete env.facebook.sharedPages[PAGE_A];
  await cleanState();
  await prisma.socialImage.deleteMany({ where: { id: { in: imageIds } } });
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL audit_log.allow_purge = 'true'`);
    await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "userId" = ANY(${userIds}::text[])`;
  });
  await prisma.userSession.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

/* ------------------------------------------------------------------ */
/* 1. Off by default; invalid or partial config; the worker still starts */
/* ------------------------------------------------------------------ */

const GOOD = { FACEBOOK_ACADEMY_PAGE_ID: '8765432109', FACEBOOK_ACADEMY_PAGE_TOKEN: 'ACADEMY-VALID-TOKEN-0123456789', FACEBOOK_ACADEMY_POST_FROM: '2026-11-28T02:30:00Z' };
const VARS = Object.keys(GOOD) as (keyof typeof GOOD)[];
const SHOP_VARS = VARS.map((v) => v.replace('ACADEMY', 'SHOPSCAN'));
const NOT_CONFIGURED = 'not configured (it needs FACEBOOK_ACADEMY_PAGE_ID, FACEBOOK_ACADEMY_PAGE_TOKEN and FACEBOOK_ACADEMY_POST_FROM)';
const SHOP_NOT_CONFIGURED = 'not configured (it needs FACEBOOK_SHOPSCAN_PAGE_ID, FACEBOOK_SHOPSCAN_PAGE_TOKEN and FACEBOOK_SHOPSCAN_POST_FROM)';

/** Runs `fn` with exactly these Facebook shared-page variables in process.env, then puts the environment back. */
function withSharedVars(vars: Record<string, string>, fn: () => void) {
  const keys = [...VARS, ...SHOP_VARS];
  const was = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) delete process.env[k];
    Object.assign(process.env, vars);
    fn();
  } finally {
    for (const [k, v] of Object.entries(was)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('1. the Academy variables: off unless ALL THREE are valid, and never a reason to refuse the start', () => {
  it('all three valid → active, with its own id, token and go-live', () => {
    const r = parseFacebookAcademyEnv(GOOD);
    expect(r.off).toBeNull();
    expect(r.page).toEqual({ pageId: '8765432109', accessToken: 'ACADEMY-VALID-TOKEN-0123456789', postFrom: new Date('2026-11-28T02:30:00Z') });
  });

  it('every other combination is OFF with a reason that names the variables and never a value: none, one, two, and each one invalid', () => {
    const sentinel = { FACEBOOK_ACADEMY_PAGE_ID: 'IDVALUE-zzz', FACEBOOK_ACADEMY_PAGE_TOKEN: 'a token with spaces SENTINEL', FACEBOOK_ACADEMY_POST_FROM: 'TIMEVALUE-yyy' };
    expect(parseFacebookAcademyEnv({})).toEqual({ page: null, off: NOT_CONFIGURED });
    for (let mask = 1; mask < 7; mask += 1) {
      const src: NodeJS.ProcessEnv = {};
      VARS.forEach((v, i) => {
        if ((mask >> i) & 1) src[v] = GOOD[v];
      });
      const r = parseFacebookAcademyEnv(src);
      expect(r.page).toBeNull();
      for (const v of VARS.filter((_, i) => !((mask >> i) & 1))) expect(r.off).toContain(v);
    }
    for (const v of VARS) {
      const r = parseFacebookAcademyEnv({ ...GOOD, [v]: sentinel[v] });
      expect(r.page).toBeNull();
      expect(r.off).toContain(v);
      for (const s of Object.values(sentinel)) expect(r.off).not.toContain(s);
      for (const ok of Object.values(GOOD)) expect(r.off).not.toContain(ok);
    }
    // a lenient date is NOT a strict ISO time here
    expect(parseFacebookAcademyEnv({ ...GOOD, FACEBOOK_ACADEMY_POST_FROM: '12' }).page).toBeNull();
  });

  it('the two shared pages never read each other\'s variables, and Shopscan\'s words are what they were', () => {
    const shopGood = Object.fromEntries(Object.entries(GOOD).map(([k, v]) => [k.replace('ACADEMY', 'SHOPSCAN'), v]));
    expect(parseFacebookShopscanEnv(GOOD)).toEqual({ page: null, off: SHOP_NOT_CONFIGURED });
    expect(parseFacebookAcademyEnv(shopGood)).toEqual({ page: null, off: NOT_CONFIGURED });
    expect(parseFacebookShopscanEnv({ ...shopGood, FACEBOOK_SHOPSCAN_PAGE_ID: 'abc', FACEBOOK_SHOPSCAN_PAGE_TOKEN: '', FACEBOOK_SHOPSCAN_POST_FROM: 'soon' }).off).toBe(
      'FACEBOOK_SHOPSCAN_PAGE_ID is missing or not digits; FACEBOOK_SHOPSCAN_PAGE_TOKEN is missing or not a valid page token; FACEBOOK_SHOPSCAN_POST_FROM is missing or not a valid ISO time',
    );
  });

  it('the env wiring: `sharedPages` holds academy only while its three variables are valid, independently of Shopscan', () => {
    const load = (): typeof env => {
      let loaded: typeof env | undefined;
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        loaded = (require('../lib/env') as typeof import('../lib/env')).env;
      });
      return loaded as typeof env;
    };
    withSharedVars(GOOD, () => {
      expect(load().facebook.sharedPages).toEqual({ academy: { pageId: '8765432109', accessToken: 'ACADEMY-VALID-TOKEN-0123456789', postFrom: new Date('2026-11-28T02:30:00Z') } });
    });
    withSharedVars({ ...GOOD, FACEBOOK_ACADEMY_PAGE_ID: 'abc' }, () => expect(load().facebook.sharedPages).toEqual({}));
    withSharedVars({}, () => expect(load().facebook.sharedPages).toEqual({}));
    const shop = Object.fromEntries(Object.entries(GOOD).map(([k, v]) => [k.replace('ACADEMY', 'SHOPSCAN'), v]));
    withSharedVars({ ...GOOD, ...shop }, () => expect(Object.keys(load().facebook.sharedPages)).toEqual(['shopscan', 'academy']));
  });

  it('inactive: Taxscan and Shopscan tick as before; the real name `academy` with no config makes no row and no refusal', async () => {
    realPages({ shopscan: true, academy: false });
    expect(portalPages()).toEqual({ taxscan: [PAGE_TAXSCAN, PAGE_SHOPSCAN] });
    expect(pageConfig(PAGE_ACADEMY)).toBeNull();
    expect(isSharedPage(PAGE_ACADEMY)).toBe(true);
    realPages({ shopscan: false, academy: false });
    expect(portalPages()).toEqual({ taxscan: [PAGE_TAXSCAN] });

    const portals = { [PORTAL]: [PAGE_T, PAGE_S, PAGE_ACADEMY] };
    expect(startupProblem({ portals, postFrom: FROM_T })).toBeNull();
    const c = await camp('inactive', at(NOW, -30));
    const t = await runFacebookTick(deps({ portals, postFrom: { [PAGE_T]: FROM_T, [PAGE_S]: FROM_S } }));
    expect(t.refused).toBeNull();
    expect(t.posted).toBe(2);
    expect(calledPages()).toEqual([ID_T, ID_S]);
    expect(await prisma.facebookPost.count({ where: { campaignId: c.id, page: PAGE_ACADEMY } })).toBe(0);
  });

  it('boot: ONE Academy line, off and why (names, never values) or on with the go-live; Shopscan\'s line is unchanged; the worker starts either way', () => {
    const schedule = jest.spyOn(cron, 'schedule').mockImplementation((() => ({})) as never);
    const academyLines = () => logs.filter((l) => l.includes('academy page'));
    const shopLines = () => logs.filter((l) => l.includes('shopscan page'));
    try {
      realPages({ shopscan: false, academy: false });
      env.facebook.postFrom = FROM_T;
      withSharedVars({}, () => {
        logs.length = 0;
        startFacebookWorker();
        expect(academyLines()).toEqual([`[facebook] academy page off: ${NOT_CONFIGURED}`]);
        expect(shopLines()).toEqual([`[facebook] shopscan page off: ${SHOP_NOT_CONFIGURED}`]);
        // Shopscan's line comes first, then Academy's
        expect(logs.findIndex((l) => l.includes('shopscan page'))).toBeLessThan(logs.findIndex((l) => l.includes('academy page')));
      });
      withSharedVars({ FACEBOOK_ACADEMY_PAGE_ID: 'IDVALUE-zzz', FACEBOOK_ACADEMY_PAGE_TOKEN: 'TOKEN SENTINEL with spaces' }, () => {
        logs.length = 0;
        startFacebookWorker();
        expect(academyLines()).toHaveLength(1);
        for (const v of VARS) expect(academyLines()[0]).toContain(v);
        expect(logs.join('\n')).not.toMatch(/IDVALUE-zzz|SENTINEL/);
      });
      expect(schedule).toHaveBeenCalledTimes(2); // started both times
      realPages({ shopscan: false, academy: true });
      logs.length = 0;
      startFacebookWorker();
      expect(academyLines()).toEqual([`[facebook] academy page on (every push from ${FROM_A.toISOString()})`]);
      expect(logs.join('\n')).not.toContain(`REAL-ACADEMY-TEST-TOKEN-${RUN}`);
      expect(schedule).toHaveBeenCalledTimes(3);
    } finally {
      schedule.mockRestore();
    }
  });
});

/* ------------------------------------------------------------------ */
/* 2. All three active: one push, three rows, three calls, in order     */
/* ------------------------------------------------------------------ */

describe('2. all three active: one push makes three rows and three post calls, Taxscan → Shopscan → Academy', () => {
  it('in the same tick, each with its own page id and token; each link tagged for its own page; nothing twice', async () => {
    const c = await camp('three', at(NOW, -30), { title: 'Supreme Court rules on ITC' });
    const t = await runFacebookTick(deps());
    expect(t.posted).toBe(3);
    expect(calls.map((x) => [x.pageId, x.accessToken])).toEqual([
      [ID_T, TOKEN_T],
      [ID_S, TOKEN_S],
      [ID_A, TOKEN_A],
    ]);
    expect(calls.map((x) => new URL(x.link).searchParams.get('utm_campaign'))).toEqual([`facebook-${PAGE_T}`, `facebook-${PAGE_S}`, `facebook-${PAGE_A}`]);
    expect(calls[2].message).toBe(calls[0].message); // the same text and hashtags
    expect((await rowsOf(PAGE_A)).map((r) => [r.campaignId, r.status, r.articleKey, r.facebookPostId])).toEqual([[c.id, 'POSTED', pushKey({ id: c.id, lastSentAt: c.lastSentAt as Date }), `${ID_A}_3`]]);
    expect(JSON.stringify(logs)).not.toContain(TOKEN_A);
    await runFacebookTick(deps({ now: () => at(NOW, 1) }));
    expect(calls).toHaveLength(3);
  });

  it('the real names: the list order, UTM `facebook-academy`, its own config, and its go-live is also its all-pushes time', () => {
    expect(SHARED_PAGES).toEqual([PAGE_SHOPSCAN, PAGE_ACADEMY]);
    const tagged = new URL(withFacebookUtm('https://www.taxscan.in/gst/x-1', PAGE_ACADEMY, 'x-1'));
    expect([tagged.searchParams.get('utm_source'), tagged.searchParams.get('utm_medium'), tagged.searchParams.get('utm_campaign')]).toEqual(['taxscan-facebook', 'social', 'facebook-academy']);
    realPages({ shopscan: true, academy: true });
    expect(portalPages()).toEqual({ taxscan: [PAGE_TAXSCAN, PAGE_SHOPSCAN, PAGE_ACADEMY] });
    expect(pageConfig(PAGE_ACADEMY)).toEqual({ pageId: '6666666666', accessToken: `REAL-ACADEMY-TEST-TOKEN-${RUN}` });
    expect(pagePostFrom(PAGE_ACADEMY)).toEqual(FROM_A);
    expect(pageAllPushesFrom(PAGE_ACADEMY)).toEqual(FROM_A);
    realPages({ shopscan: false, academy: true }); // Academy needs nothing of Shopscan
    expect(portalPages()).toEqual({ taxscan: [PAGE_TAXSCAN, PAGE_ACADEMY] });
  });
});

/* ------------------------------------------------------------------ */
/* 3. Every push from Academy's go-live                                */
/* ------------------------------------------------------------------ */

describe('3. Academy posts EVERY push from its own go-live, and nothing before it', () => {
  it('an article, a course, a shop product, a site page (with SOCIAL_ANY_LINK_FROM), an exact repeat and a re-push each post; a push before its go-live never does', async () => {
    env.social.anyLinkFrom = FROM_A;
    const before = await camp('before', at(FROM_A, -30)); // after Taxscan's and Shopscan's go-live, before Academy's
    const article = await camp('article', at(FROM_A, 2), { title: 'Article one' });
    const course = await camp('course', at(FROM_A, 5), { url: courseUrl('c1'), title: 'Course one', body: 'Learn GST' });
    const product = await camp('product', at(FROM_A, 10), { url: productUrl('p1'), title: 'Product one', body: 'An e-book' });
    const site = await camp('site', at(FROM_A, 20), { url: 'https://www.taxscan.in/pricing', title: 'Pricing' });
    const repeat = await camp('repeat', at(FROM_A, 25), { url: course.url, title: 'Course one again', body: 'Learn GST' });
    const again = await camp('again', at(FROM_A, 30), { url: before.url, title: 'Story before, again' });
    await ticks(12, NOW, { minGapMinutes: 0 });
    const rows = await rowsOf(PAGE_A);
    expect(rows.map((r) => r.campaignId)).toEqual([article.id, course.id, product.id, site.id, repeat.id, again.id]); // oldest first, `before` never
    expect(rows.every((r) => r.status === 'POSTED' && r.articleKey.startsWith('push:'))).toBe(true);
    expect(await prisma.facebookPost.count({ where: { page: PAGE_A, campaignId: before.id } })).toBe(0);
    expect(callsFor(ID_A).map((c) => c.message.split('\n')[0])).toEqual(['Article one', 'Course one', 'Product one', 'Pricing', 'Course one again', 'Story before, again']);
    // Shopscan, with an earlier go-live, did post the push Academy must not
    expect((await rowsOf(PAGE_S)).map((r) => r.campaignId)).toContain(before.id);
  });

  it('without SOCIAL_ANY_LINK_FROM a site page does not post on Academy', async () => {
    env.social.anyLinkFrom = null;
    const course = await camp('course2', at(FROM_A, 5), { url: courseUrl('c2'), title: 'Course two' });
    await camp('site2', at(FROM_A, 10), { url: 'https://www.taxscan.in/pricing', title: 'Pricing' });
    await ticks(5, NOW, { minGapMinutes: 0 });
    expect((await rowsOf(PAGE_A)).map((r) => r.campaignId)).toEqual([course.id]);
  });
});

/* ------------------------------------------------------------------ */
/* 4. Pacing per page                                                  */
/* ------------------------------------------------------------------ */

describe('4. pacing is per page: the gap and the daily cap count a page\'s own rows only', () => {
  /** A campaign before every go-live: it gives seed rows something to point at and no page wants it. */
  const oldCamp = () => camp('old', at(FROM_T, -30));

  it('Academy inside its gap holds Academy only', async () => {
    const old = await oldCamp();
    await camp('gap', at(NOW, -20));
    await seedRow(PAGE_A, 'push:seed:1', old.id, 'POSTED', at(NOW, -5));
    const t = await runFacebookTick(deps());
    expect(t.waited).toBe('gap');
    expect(calledPages()).toEqual([ID_T, ID_S]);
    // its gap over, it posts, and the others are not held by it
    calls = [];
    await runFacebookTick(deps({ now: () => at(NOW, 6) }));
    expect(calledPages()).toEqual([ID_A]);
  });

  it('Taxscan and Shopscan inside their gaps do not hold Academy', async () => {
    const old = await oldCamp();
    await camp('gap-other', at(NOW, -20));
    await seedRow(PAGE_T, articleKey(old), old.id, 'POSTED', at(NOW, -5));
    await seedRow(PAGE_S, 'push:seed:2', old.id, 'POSTED', at(NOW, -5));
    await runFacebookTick(deps());
    expect(calledPages()).toEqual([ID_A]);
  });

  it('each page\'s daily cap counts only its own posts, in both directions', async () => {
    const old = await oldCamp();
    await camp('cap1', at(NOW, -40));
    await seedRow(PAGE_A, 'push:seed:3', old.id, 'POSTED', at(NOW, -180)); // Academy is at its cap of 1 today
    const t1 = await runFacebookTick(deps({ dailyCap: 1, minGapMinutes: 0 }));
    expect(t1.waited).toBe('daily_cap');
    expect(calledPages()).toEqual([ID_T, ID_S]);
    await cleanState();
    calls = [];
    const old2 = await oldCamp();
    await camp('cap2', at(NOW, -10));
    await seedRow(PAGE_T, articleKey(old2), old2.id, 'POSTED', at(NOW, -180));
    await seedRow(PAGE_S, 'push:seed:4', old2.id, 'POSTED', at(NOW, -180));
    await runFacebookTick(deps({ dailyCap: 1, minGapMinutes: 0 }));
    expect(calledPages()).toEqual([ID_A]);
  });
});

/* ------------------------------------------------------------------ */
/* 5. Stops per page                                                   */
/* ------------------------------------------------------------------ */

describe('5. a stop on Academy stops Academy only', () => {
  it.each([
    ['190', 400, 190],
    ['401', 401, null],
    ['403', 403, null],
  ] as const)('a %s answer is an auth stop for Academy alone; Taxscan and Shopscan keep posting', async (_name, status, code) => {
    const verdict = classify(status, code === null ? null : { code, message: 'Error validating access token' }, TOKEN_A);
    expect(verdict.kind).toBe('auth');
    script = (r, n) => (r.pageId === ID_A ? verdict : posted(`${r.pageId}_${n}`));
    const c1 = await camp('auth1', at(NOW, -30));
    const t1 = await runFacebookTick(deps());
    expect(t1.authStopped).toBe(true);
    expect(t1.posted).toBe(2);
    expect(await loginProblem(PAGE_A)).not.toBeNull();
    expect(await loginProblem(PAGE_T)).toBeNull();
    expect(await loginProblem(PAGE_S)).toBeNull();
    const c2 = await camp('auth2', at(NOW, -5));
    calls = [];
    await ticks(3, at(NOW, 1), { minGapMinutes: 0 });
    expect(callsFor(ID_A)).toHaveLength(0);
    expect((await rowsOf(PAGE_T)).map((r) => r.campaignId)).toEqual([c1.id, c2.id]);
    expect((await rowsOf(PAGE_S)).map((r) => r.campaignId)).toEqual([c1.id, c2.id]);
  });

  it('one alert per page per IST day, naming that page\'s token variable; a new token resumes it', async () => {
    script = (r, n) => (r.pageId === ID_A ? failure('auth', 401, 190) : posted(`${r.pageId}_${n}`));
    await camp('al1', at(NOW, -30));
    await runFacebookTick(deps());
    expect(mails.map((m) => m.subject)).toEqual([`Facebook posting stopped — the ${PAGE_A} page token was rejected`]);
    expect(mails[0].text).toContain(`FACEBOOK_${PAGE_A.toUpperCase()}_PAGE_TOKEN`);
    expect(JSON.stringify(mails)).not.toContain(TOKEN_A);
    // a second token, also rejected, the same day: stopped again, no second email
    env.facebook.sharedPages[PAGE_A] = { pageId: ID_A, accessToken: `${TOKEN_A}-SECOND`, postFrom: FROM_A };
    await runFacebookTick(deps({ now: () => at(NOW, 10), minGapMinutes: 0 }));
    expect(callsFor(ID_A)).toHaveLength(2);
    expect(mails).toHaveLength(1);
    // a good token lifts the stop and the waiting push posts
    script = (r, n) => posted(`${r.pageId}_${n}`);
    env.facebook.sharedPages[PAGE_A] = { pageId: ID_A, accessToken: `${TOKEN_A}-GOOD`, postFrom: FROM_A };
    await runFacebookTick(deps({ now: () => at(NOW, 20), minGapMinutes: 0 }));
    expect(await loginProblem(PAGE_A)).toBeNull();
    expect((await rowsOf(PAGE_A)).map((r) => r.status)).toEqual(['POSTED']);
  });

  it('a 368 policy block stops Academy until an ADMIN Resume of Academy; one alert; Resume of another page does nothing', async () => {
    script = (r, n) => (r.pageId === ID_A ? failure('policy', 400, 368) : posted(`${r.pageId}_${n}`));
    await camp('pol1', at(NOW, -30));
    const t1 = await runFacebookTick(deps());
    expect(t1.policyStopped).toBe(true);
    expect(t1.posted).toBe(2);
    expect(await policyProblem(PAGE_A)).toMatchObject({ code: 368 });
    expect(await policyProblem(PAGE_T)).toBeNull();
    expect(await policyProblem(PAGE_S)).toBeNull();
    expect(mails.map((m) => m.subject)).toEqual([`Facebook blocked a post — posting to the ${PAGE_A} page is stopped`]);
    await camp('pol2', at(NOW, -5));
    calls = [];
    resetFacebookStops(); // a restart does not lift a policy stop
    await ticks(3, at(NOW, 1), { minGapMinutes: 0 });
    expect(callsFor(ID_A)).toHaveLength(0);
    expect(callsFor(ID_T)).toHaveLength(1);
    expect(callsFor(ID_S)).toHaveLength(1);
    expect(mails).toHaveLength(1);
    expect(await resumePolicy(PAGE_T)).toBe(false);
    expect(await resumePolicy(PAGE_S)).toBe(false);
    expect(await policyProblem(PAGE_A)).not.toBeNull();
    expect(await resumePolicy(PAGE_A)).toBe(true);
    script = (r, n) => posted(`${r.pageId}_${n}`);
    calls = [];
    await runFacebookTick(deps({ now: () => at(NOW, 10), minGapMinutes: 0 }));
    expect(callsFor(ID_A)).toHaveLength(1);
  });

  it.each([
    ['Taxscan', ID_T, PAGE_T],
    ['Shopscan', ID_S, PAGE_S],
  ] as const)('and the other way round: a %s stop does not hold Academy', async (_name, id, page) => {
    script = (r, n) => (r.pageId === id ? failure('policy', 400, 368) : posted(`${r.pageId}_${n}`));
    await camp('rev', at(NOW, -30));
    const t = await runFacebookTick(deps());
    expect(t.policyStopped).toBe(true);
    expect(callsFor(ID_A)).toHaveLength(1);
    expect((await rowsOf(PAGE_A)).map((r) => r.status)).toEqual(['POSTED']);
    expect(await policyProblem(page)).not.toBeNull();
    expect(await policyProblem(PAGE_A)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 6. Pause / Resume per page                                          */
/* ------------------------------------------------------------------ */

describe('6. Pause `facebook:academy`', () => {
  it('paused: Academy rows are SKIPPED page_paused with no call, the others post; resumed: the next push posts, the skipped one never', async () => {
    const c1 = await camp('pause1', at(NOW, -30));
    await setPause('facebook', PAGE_A, { byUserId: null, by: 'tester', note: null, now: NOW });
    await runFacebookTick(deps());
    expect(calledPages()).toEqual([ID_T, ID_S]);
    expect((await rowsOf(PAGE_A)).map((r) => [r.campaignId, r.status, r.error])).toEqual([[c1.id, 'SKIPPED', 'page_paused']]);
    expect((await getPageStatus('facebook', PAGE_A, NOW)).status).toBe('paused');
    expect((await getPageStatus('facebook', PAGE_T, NOW)).status).toBe('ok');
    expect((await getPageStatus('facebook', PAGE_S, NOW)).status).toBe('ok');
    expect(await clearPause('facebook', PAGE_A)).toBe(true);
    const c2 = await camp('pause2', at(NOW, 1));
    await runFacebookTick(deps({ now: () => at(NOW, 2), minGapMinutes: 0 }));
    expect(callsFor(ID_A)).toHaveLength(1);
    expect((await rowsOf(PAGE_A)).map((r) => [r.campaignId, r.status])).toEqual([
      [c1.id, 'SKIPPED'],
      [c2.id, 'POSTED'],
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* 7. Compose "Post to"                                                */
/* ------------------------------------------------------------------ */

describe('7. Compose "Post to"', () => {
  it('lists "Facebook · Academy" only while it is active, after Shopscan; a send may untick it only then', () => {
    const facebook = () => activeSocialPages().filter((p) => p.key.startsWith('facebook:'));
    realPages({ shopscan: true, academy: false });
    expect(facebook().map((p) => p.key)).toEqual(['facebook:taxscan', 'facebook:shopscan']);
    expect(unknownSocialKeys(['facebook:academy'])).toEqual(['facebook:academy']);
    realPages({ shopscan: true, academy: true });
    expect(facebook()).toEqual([
      { key: 'facebook:taxscan', label: 'Facebook · Taxscan' },
      { key: 'facebook:shopscan', label: 'Facebook · Shopscan' },
      { key: 'facebook:academy', label: 'Facebook · Academy' },
    ]);
    expect(unknownSocialKeys(['facebook:academy', 'facebook:shopscan', 'facebook:taxscan'])).toEqual([]);
    env.facebook.enabled = false;
    expect(facebook()).toEqual([]);
  });

  it('unticking it writes SKIPPED compose_skip for Academy only; the others post', async () => {
    const c = await camp('skip', at(NOW, -30), { skip: [facebookSkipKey(PAGE_A)] });
    const t = await runFacebookTick(deps());
    expect(t.posted).toBe(2);
    expect(calledPages()).toEqual([ID_T, ID_S]);
    expect((await rowsOf(PAGE_A)).map((r) => [r.campaignId, r.status, r.error])).toEqual([[c.id, 'SKIPPED', 'compose_skip']]);
  });
});

/* ------------------------------------------------------------------ */
/* 8. The Compose picture                                              */
/* ------------------------------------------------------------------ */

describe('8. the Compose picture goes to Academy too; a refused photo falls back to /feed on Academy only', () => {
  it('/photos on each page through the real client (fake fetch); a 4xx on Academy\'s /photos is repeated once on its /feed', async () => {
    const imageId = randomBytes(32).toString('hex');
    imageIds.push(imageId);
    await prisma.socialImage.create({ data: { id: imageId, mime: 'image/png', width: 1200, height: 627, size: 4, bytes: Buffer.from([1, 2, 3, 4]) } });
    env.social.pictureEnabled = true;
    const urls: string[] = [];
    const graph = (async (url: string) => {
      urls.push(new URL(url).pathname.replace(/^\/v[\d.]+/, ''));
      if (url.includes(`/${ID_A}/photos`)) return { status: 400, json: async () => ({ error: { code: 100, message: 'cannot read the picture' } }) };
      return { status: 200, json: async () => ({ id: 'photo-1', post_id: 'page_1' }) };
    }) as unknown as typeof fetch;
    const c = await camp('pic', at(NOW, -30), { picture: imageId });
    await runFacebookTick(deps({ socialPicture: true, post: (r) => postToFacebook(r, graph) }));
    expect(urls).toEqual([`/${ID_T}/photos`, `/${ID_S}/photos`, `/${ID_A}/photos`, `/${ID_A}/feed`]);
    for (const page of [PAGE_T, PAGE_S]) expect((await rowsOf(page)).map((r) => [r.campaignId, r.status, r.error])).toEqual([[c.id, 'POSTED', null]]);
    const a = (await rowsOf(PAGE_A))[0];
    expect([a.campaignId, a.status]).toEqual([c.id, 'POSTED']);
    expect(a.error).toMatch(/posted as a link post/);
  });
});

/* ------------------------------------------------------------------ */
/* 9. The screen's API                                                 */
/* ------------------------------------------------------------------ */

describe('9. the list, Retry / Skip, Check connection and Resume for the Academy page', () => {
  const BEARER = { Authorization: `Bearer ${env.adminToken}` };
  const list = (app: ReturnType<typeof appWith>, q = '') => request(app).get(`/api/facebook/posts?date=2026-11-28${q}`).set(BEARER);

  it('the real name: `?page=academy` answers while active (pages in order) and is 400 invalid_page while inactive', async () => {
    const real = () => createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 }, facebook: { enabled: () => true, clock: () => NOW } });
    realPages({ shopscan: true, academy: true });
    const on = await list(real(), '&page=academy'); // read only
    expect(on.status).toBe(200);
    expect(on.body.page).toBe('academy');
    expect(on.body.pages).toEqual(['taxscan', 'shopscan', 'academy']);
    expect(on.body.everyPushFrom).toBe(FROM_A.toISOString());
    realPages({ shopscan: true, academy: false });
    const off = await list(real(), '&page=academy');
    expect(off.status).toBe(400);
    expect(off.body).toEqual({ error: 'invalid_page' });
  });

  it('its own rows, banners and status; every push is its own row from its go-live', async () => {
    const c0 = await camp('list0', at(FROM_A, -30)); // before Academy's go-live
    const c1 = await camp('list1', at(NOW, -50));
    const c2 = await camp('list2', at(NOW, -40));
    await seedRow(PAGE_A, pushKey({ id: c2.id, lastSentAt: c2.lastSentAt as Date }), c2.id, 'FAILED', at(NOW, -35), 'HTTP 422');
    await prisma.digestSetting.create({ data: { key: policyKey(PAGE_A), value: JSON.stringify({ stoppedAt: NOW.toISOString(), status: 400, code: 368, subcode: null, message: 'blocked' }) } });
    const app = appWith();
    const a = await list(app, `&page=${PAGE_A}`);
    expect(a.status).toBe(200);
    expect(a.body.pages).toEqual([PAGE_T, PAGE_S, PAGE_A]);
    expect(a.body.rows.map((r: { campaignId: string; status: string }) => [r.campaignId, r.status])).toEqual([
      [c0.id, 'NOT_POSTED'],
      [c1.id, 'WAITING'],
      [c2.id, 'FAILED'],
    ]);
    expect(a.body.everyPushFrom).toBe(FROM_A.toISOString());
    expect(a.body.policy).toMatchObject({ code: 368 });
    expect(a.body.pageStatus).toMatchObject({ page: PAGE_A, status: 'stopped', reason: 'policy_block' });
    const t = await list(app);
    expect(t.body.policy).toBeNull();
    expect(t.body.pageStatus.status).toBe('ok');
    expect((await list(appWith({ portals: { [PORTAL]: [PAGE_T, PAGE_S] } }), `&page=${PAGE_A}`)).status).toBe(400);
  });

  it('Retry and Skip on an Academy row touch only it', async () => {
    const c = await camp('retry', at(NOW, -50));
    const rt = await seedRow(PAGE_T, articleKey(c), c.id, 'FAILED', at(NOW, -40), 'HTTP 500');
    const rs = await seedRow(PAGE_S, pushKey({ id: c.id, lastSentAt: c.lastSentAt as Date }), c.id, 'FAILED', at(NOW, -40), 'HTTP 500');
    const ra = await seedRow(PAGE_A, pushKey({ id: c.id, lastSentAt: c.lastSentAt as Date }), c.id, 'FAILED', at(NOW, -40), 'HTTP 500');
    const app = appWith();
    expect((await request(app).post(`/api/facebook/posts/${ra.id}/retry`).set(BEARER)).body).toEqual({ ok: true, status: 'POSTED' });
    expect(calledPages()).toEqual([ID_A]);
    const ra2 = await seedRow(PAGE_A, 'push:other:1', c.id, 'FAILED', at(NOW, -30), 'HTTP 500');
    expect((await request(app).post(`/api/facebook/posts/${ra2.id}/skip`).set(BEARER)).body).toEqual({ ok: true, status: 'SKIPPED' });
    for (const id of [rt.id, rs.id]) expect((await prisma.facebookPost.findUniqueOrThrow({ where: { id } })).status).toBe('FAILED');
  });

  it('Check connection uses Academy\'s own id and token; Resume, Pause and resume-from-pause act on Academy only', async () => {
    const seen: { url: string; auth: string }[] = [];
    const fetchFake: FetchFake = async (url, init) => {
      seen.push({ url, auth: init?.headers?.Authorization ?? '' });
      return { ok: true, status: 200, json: async () => ({ name: 'Academy Page' }) } as unknown as Response;
    };
    const app = appWith({ fetch: fetchFake });
    const send = (path: string, body: object) => request(app).post(path).set('Cookie', adminCookie).send(body);
    expect((await send('/api/facebook/check', { page: PAGE_A })).body).toMatchObject({ ok: true, name: 'Academy Page' });
    expect(seen.map((s) => [s.url.includes(ID_A), s.auth])).toEqual([[true, `Bearer ${TOKEN_A}`]]);
    for (const page of [PAGE_A, PAGE_S]) {
      await prisma.digestSetting.create({ data: { key: policyKey(page), value: JSON.stringify({ stoppedAt: NOW.toISOString(), status: 400, code: 368, subcode: null, message: 'blocked' }) } });
    }
    expect((await send('/api/facebook/resume', { page: PAGE_A })).body).toEqual({ ok: true });
    expect(await policyProblem(PAGE_A)).toBeNull();
    expect(await policyProblem(PAGE_S)).not.toBeNull();
    expect((await send('/api/facebook/page-pause', { page: PAGE_A })).status).toBe(200);
    expect((await getPageStatus('facebook', PAGE_A, NOW)).status).toBe('paused');
    expect((await getPageStatus('facebook', PAGE_T, NOW)).status).toBe('ok');
    expect((await send('/api/facebook/page-resume', { page: PAGE_A })).status).toBe(200);
  });
});

/* ------------------------------------------------------------------ */
/* 11. Page status and alerts                                          */
/* ------------------------------------------------------------------ */

describe('11. page status and alerts report `facebook:academy` on its own', () => {
  it('the status list names Academy only while it is active, after Shopscan', () => {
    const facebook = () => activePages().filter((p) => p.channel === 'facebook').map((p) => p.page);
    realPages({ shopscan: true, academy: false });
    expect(facebook()).toEqual(['taxscan', 'shopscan']);
    realPages({ shopscan: true, academy: true });
    expect(facebook()).toEqual(['taxscan', 'shopscan', 'academy']);
    expect(pageLabel('facebook', PAGE_ACADEMY)).toBe('Facebook · Academy');
  });

  it('two failed Academy posts in a row = failing for Academy alone, with ONE email that day', async () => {
    const old = await camp('stold', at(FROM_T, -30));
    await seedRow(PAGE_T, 'ok-t', old.id, 'POSTED', at(NOW, -60));
    await seedRow(PAGE_S, 'push:ok-s:1', old.id, 'POSTED', at(NOW, -60));
    await seedRow(PAGE_A, 'push:f1:1', old.id, 'FAILED', at(NOW, -30), 'HTTP 422');
    await seedRow(PAGE_A, 'push:f2:2', old.id, 'FAILED', at(NOW, -20), 'HTTP 422');
    expect(await getPageStatus('facebook', PAGE_A, NOW)).toMatchObject({ status: 'failing', reason: 'recent_posts_failed', failures: 2, page: PAGE_A });
    expect((await getPageStatus('facebook', PAGE_T, NOW)).status).toBe('ok');
    expect((await getPageStatus('facebook', PAGE_S, NOW)).status).toBe('ok');
    expect(await alertIfNeeded('facebook', PAGE_A, NOW, deps())).toBe('sent');
    expect(await alertIfNeeded('facebook', PAGE_A, NOW, deps())).toBe('already_today');
    expect(await alertIfNeeded('facebook', PAGE_S, NOW, deps())).toBe('not_alertable');
    expect(mails).toHaveLength(1);
    expect(mails[0].subject).toContain(pageLabel('facebook', PAGE_A));
    expect(facebookAuthKey(PAGE_A)).toBe(authKey(PAGE_A));
    expect(facebookPolicyKey(PAGE_A)).toBe(policyKey(PAGE_A));
  });
});
