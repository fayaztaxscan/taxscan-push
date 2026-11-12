import bcrypt from 'bcrypt';
import cron from 'node-cron';
import request from 'supertest';
import { randomBytes } from 'node:crypto';
import type { Campaign, User, UserRole } from '@prisma/client';
import { createApp } from '../app';
import { env, parseFacebookShopscanEnv } from '../lib/env';
import { prisma } from '../lib/prisma';
import { articleKey } from '../services/reports';
import { classify, type FacebookRequest, type FacebookResult } from '../services/facebook/client';
import { PAGE_SHOPSCAN, PAGE_TAXSCAN, PORTAL_TO_PAGE, isSharedPage, pageAllPushesFrom, pageConfig, pagePostFrom, portalPages, resolveAllPushesFrom, resolvePostFrom, shopscanActive, withFacebookUtm } from '../services/facebook/pages';
import { authKey, loginProblem, policyKey, policyProblem, resetFacebookStops, resumePolicy, runFacebookTick, startFacebookWorker, startupProblem, type WorkerDeps } from '../services/facebook/worker';
import { activeSocialPages, facebookSkipKey, unknownSocialKeys } from '../services/social/pages';
import { activePages, facebookAuthKey, facebookPolicyKey, getPageStatus, pageLabel } from '../services/social/pageStatus';
import { alertIfNeeded, alertKey } from '../services/social/pageAlerts';
import { pauseKey, clearPause, setPause } from '../services/social/pause';
import { pushKey } from '../services/social/allPushes';

/**
 * Brief 2026-11-12-facebook-shopscan-page: the Shopscan Facebook page, a SHARED page that receives the Taxscan portal's pushes too, with
 * a page id, token and go-live of its own. EVERY Graph call is a fake: no real Facebook request anywhere.
 *
 * ISOLATION: rows live in a shared dev DB, so the tests that write rows never use the REAL page names. `fbshop-t…` plays the Taxscan page
 * (env.facebook.pages) and `fbshop-s…` plays Shopscan (registered in env.facebook.sharedPages), both under a unique portal. Where the REAL
 * names matter (the page list and its order, the UTM, the boot lines, Compose, page status) the functions are pure or only `env` is toggled,
 * for the length of one test, and restored; nothing is written under the names `taxscan` / `shopscan`.
 */
const logs: string[] = [];
jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
jest.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
jest.spyOn(console, 'warn').mockImplementation(() => undefined);

const RUN = `${Date.now()}-${randomBytes(3).toString('hex')}`;
const PORTAL = `test-fbshop-${RUN}`;
const PAGE_T = `fbshop-t${Math.floor(Math.random() * 1e9)}`; // plays the Taxscan page
const PAGE_S = `fbshop-s${Math.floor(Math.random() * 1e9)}`; // plays the Shopscan page
const ID_T = '1111111111';
const ID_S = '2222222222';
const TOKEN_T = `TAXSCAN-PAGE-TOKEN-${RUN}`;
const TOKEN_S = `SHOPSCAN-PAGE-TOKEN-${RUN}`;
const IST_MS = (5 * 60 + 30) * 60_000;
const ist = (h: number, m = 0, day = 14) => new Date(Date.UTC(2026, 10, day, h, m) - IST_MS);
const MIN = 60_000;
const at = (base: Date, min: number) => new Date(base.getTime() + min * MIN);
const NOW = ist(10, 0);
const FROM_T = ist(4, 0); // the Taxscan page's go-live
const FROM_S = ist(8, 0); // the Shopscan page's own go-live, four hours later
const PASSWORD = 'fb-shopscan-test-pw-1';

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
  portals: { [PORTAL]: [PAGE_T, PAGE_S] },
  postFrom: { [PAGE_T]: FROM_T, [PAGE_S]: FROM_S },
  allPushesFrom: { [PAGE_T]: null }, // the Taxscan page stays on today's rule; Shopscan's own is its go-live
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
/** Runs ticks one minute apart until `n` of them. */
async function ticks(n: number, start: Date, over: WorkerDeps = {}) {
  for (let i = 0; i < n; i += 1) await runFacebookTick(deps({ now: () => at(start, i), ...over }));
}

const pageKeys = [PAGE_T, PAGE_S];
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
  anyLinkFrom: env.social.anyLinkFrom,
  pictureEnabled: env.social.pictureEnabled,
};
const restoreEnv = () => {
  env.facebook.enabled = saved.enabled;
  env.facebook.postFrom = saved.postFrom;
  env.facebook.allPushesFrom = saved.allPushesFrom;
  env.facebook.pages.taxscan = saved.taxscan;
  if (saved.shopscan) env.facebook.sharedPages.shopscan = saved.shopscan;
  else delete env.facebook.sharedPages.shopscan;
  env.social.anyLinkFrom = saved.anyLinkFrom;
  env.social.pictureEnabled = saved.pictureEnabled;
};
/** The REAL pages for a test of the page list / Compose / status: Taxscan valid, Shopscan on or off. Restored by `restoreEnv`. */
function realPages(shopscan: boolean) {
  env.facebook.enabled = true;
  env.facebook.pages.taxscan = { pageId: '4444444444', accessToken: `REAL-TAXSCAN-TEST-TOKEN-${RUN}` };
  if (shopscan) env.facebook.sharedPages.shopscan = { pageId: '5555555555', accessToken: `REAL-SHOPSCAN-TEST-TOKEN-${RUN}`, postFrom: FROM_S };
  else delete env.facebook.sharedPages.shopscan;
}

const userIds: string[] = [];
const loginApp = createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 } });
let adminCookie: string;
async function makeUser(role: UserRole): Promise<User> {
  const u = await prisma.user.create({ data: { email: `fbshop-${role.toLowerCase()}-${RUN}-${++seq}@team.test`, passwordHash: await bcrypt.hash(PASSWORD, 4), role, isActive: true } });
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
const appWith = (o: { portals?: Record<string, string[]>; fetch?: FetchFake; over?: WorkerDeps } = {}) =>
  createApp({
    rateLimit: { publicPerMin: 10000, loginPerMin: 10000 },
    facebook: {
      enabled: () => true,
      clock: () => NOW,
      portals: () => o.portals ?? { [PORTAL]: [PAGE_T, PAGE_S] },
      postFrom: () => ({ [PAGE_T]: FROM_T, [PAGE_S]: FROM_S }),
      allPushesFrom: () => ({ [PAGE_T]: null }),
      worker: deps(o.over),
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
  env.social.pictureEnabled = false;
  resetFacebookStops();
  await cleanState();
});
afterEach(restoreEnv);
afterAll(async () => {
  restoreEnv();
  delete env.facebook.pages[PAGE_T];
  delete env.facebook.sharedPages[PAGE_S];
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

describe('1. the Shopscan variables: off unless ALL THREE are valid, and never a reason to refuse the start', () => {
  const GOOD = { FACEBOOK_SHOPSCAN_PAGE_ID: '9876543210', FACEBOOK_SHOPSCAN_PAGE_TOKEN: 'SHOPSCAN-VALID-TOKEN-0123456789', FACEBOOK_SHOPSCAN_POST_FROM: '2026-11-14T02:30:00Z' };
  const VARS = Object.keys(GOOD) as (keyof typeof GOOD)[];

  it('all three valid → active, with its own id, token and go-live; the token is a Page token (printable, no whitespace)', () => {
    const r = parseFacebookShopscanEnv(GOOD);
    expect(r.off).toBeNull();
    expect(r.page).toEqual({ pageId: '9876543210', accessToken: 'SHOPSCAN-VALID-TOKEN-0123456789', postFrom: new Date('2026-11-14T02:30:00Z') });
  });

  it('every other combination is OFF with a reason that names the variables and never a value: none, one, two, and each one invalid', () => {
    const sentinel = { FACEBOOK_SHOPSCAN_PAGE_ID: 'IDVALUE-zzz', FACEBOOK_SHOPSCAN_PAGE_TOKEN: 'a token with spaces SENTINEL', FACEBOOK_SHOPSCAN_POST_FROM: 'TIMEVALUE-yyy' };
    expect(parseFacebookShopscanEnv({})).toEqual({ page: null, off: expect.stringContaining('not configured') });
    for (let mask = 0; mask < 7; mask += 1) {
      // mask 0..6: which of the three are set (never all three: that is the valid case)
      const src: NodeJS.ProcessEnv = {};
      VARS.forEach((v, i) => {
        if ((mask >> i) & 1) src[v] = GOOD[v];
      });
      if (mask === 0) continue;
      const r = parseFacebookShopscanEnv(src);
      expect(r.page).toBeNull();
      for (const v of VARS.filter((_, i) => !((mask >> i) & 1))) expect(r.off).toContain(v);
    }
    for (const v of VARS) {
      const r = parseFacebookShopscanEnv({ ...GOOD, [v]: sentinel[v] });
      expect(r.page).toBeNull();
      expect(r.off).toContain(v);
      for (const s of Object.values(sentinel)) expect(r.off).not.toContain(s);
      for (const ok of Object.values(GOOD)) expect(r.off).not.toContain(ok);
    }
    // a lenient date the old Taxscan parser would take is NOT a strict ISO time here
    expect(parseFacebookShopscanEnv({ ...GOOD, FACEBOOK_SHOPSCAN_POST_FROM: '12' }).page).toBeNull();
  });

  it('inactive: the page list is exactly the old map, the config is null, and the worker starts, ticks Taxscan only and makes no Shopscan row', async () => {
    restoreEnv();
    delete env.facebook.sharedPages.shopscan;
    expect(shopscanActive()).toBe(false);
    expect(portalPages()).toEqual({ taxscan: [PAGE_TAXSCAN] });
    expect(Object.values(PORTAL_TO_PAGE)).toEqual(portalPages().taxscan);
    expect(pageConfig(PAGE_SHOPSCAN)).toBeNull();
    // the real name `shopscan` listed for the portal but with no valid config: never a refusal, never a row
    const portals = { [PORTAL]: [PAGE_T, PAGE_SHOPSCAN] };
    expect(isSharedPage(PAGE_SHOPSCAN)).toBe(true);
    expect(startupProblem({ portals, postFrom: FROM_T })).toBeNull();
    const c = await camp('inactive', at(NOW, -30));
    const t = await runFacebookTick(deps({ portals, postFrom: { [PAGE_T]: FROM_T } }));
    expect(t.refused).toBeNull();
    expect(t.posted).toBe(1);
    expect(calls.map((x) => x.pageId)).toEqual([ID_T]);
    expect((await rowsOf(PAGE_T)).map((r) => r.campaignId)).toEqual([c.id]);
    expect(await prisma.facebookPost.count({ where: { campaignId: c.id, page: PAGE_SHOPSCAN } })).toBe(0);
  });

  it('the Taxscan page keeps its own refusals: no FACEBOOK_POST_FROM, or no valid id / token, still refuses; a shared page never does', () => {
    const portals = { [PORTAL]: [PAGE_T, PAGE_S] };
    expect(startupProblem({ portals, postFrom: { [PAGE_T]: null, [PAGE_S]: FROM_S } })).toMatch(/FACEBOOK_POST_FROM/);
    expect(startupProblem({ portals, postFrom: null })).toMatch(/FACEBOOK_POST_FROM/);
    delete env.facebook.pages[PAGE_T];
    expect(startupProblem({ portals, postFrom: FROM_T })).toBe(`FACEBOOK_${PAGE_T.toUpperCase()}_PAGE_ID / _PAGE_TOKEN are not both set and valid`);
    env.facebook.pages[PAGE_T] = { pageId: ID_T, accessToken: TOKEN_T };
    delete env.facebook.sharedPages[PAGE_S];
    expect(startupProblem({ portals: { [PORTAL]: [PAGE_T, PAGE_SHOPSCAN] }, postFrom: FROM_T })).toBeNull();
  });

  it('boot: ONE Shopscan line, off and why (names, never values) or on with the go-live; the worker starts either way', () => {
    const schedule = jest.spyOn(cron, 'schedule').mockImplementation((() => ({})) as never);
    const envKeys = [...VARS, 'FACEBOOK_SHOPSCAN_NOPE'];
    const was = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
    try {
      realPages(false);
      env.facebook.postFrom = FROM_T;
      for (const k of VARS) delete process.env[k];
      logs.length = 0;
      startFacebookWorker();
      expect(schedule).toHaveBeenCalledTimes(1);
      const off = logs.filter((l) => l.includes('shopscan page'));
      expect(off).toEqual([`[facebook] shopscan page off: not configured (it needs FACEBOOK_SHOPSCAN_PAGE_ID, FACEBOOK_SHOPSCAN_PAGE_TOKEN and FACEBOOK_SHOPSCAN_POST_FROM)`]);

      process.env.FACEBOOK_SHOPSCAN_PAGE_ID = 'IDVALUE-zzz';
      process.env.FACEBOOK_SHOPSCAN_PAGE_TOKEN = 'TOKEN SENTINEL with spaces';
      logs.length = 0;
      startFacebookWorker();
      expect(schedule).toHaveBeenCalledTimes(2); // still started
      const partial = logs.filter((l) => l.includes('shopscan page')).join('\n');
      expect(partial).toContain('FACEBOOK_SHOPSCAN_PAGE_ID');
      expect(partial).toContain('FACEBOOK_SHOPSCAN_PAGE_TOKEN');
      expect(partial).toContain('FACEBOOK_SHOPSCAN_POST_FROM');
      expect(logs.join('\n')).not.toMatch(/IDVALUE-zzz|SENTINEL/);

      realPages(true);
      logs.length = 0;
      startFacebookWorker();
      expect(logs.filter((l) => l.includes('shopscan page'))).toEqual([`[facebook] shopscan page on (every push from ${FROM_S.toISOString()})`]);
    } finally {
      for (const [k, v] of Object.entries(was)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      schedule.mockRestore();
    }
  });
});

/* ------------------------------------------------------------------ */
/* 2. Active: one push, two rows, two calls, in order                   */
/* ------------------------------------------------------------------ */

describe('2. active: one push makes two rows and two post calls, Taxscan then Shopscan, each with its own id and token', () => {
  it('Taxscan first, in the same tick; own page id + token per call; Shopscan\'s link is tagged for its own page', async () => {
    const c = await camp('both', at(NOW, -30), { title: 'Supreme Court rules on ITC' });
    const t = await runFacebookTick(deps());
    expect(t.posted).toBe(2);
    expect(calls.map((x) => [x.pageId, x.accessToken])).toEqual([
      [ID_T, TOKEN_T],
      [ID_S, TOKEN_S],
    ]);
    expect(new URL(calls[0].link).searchParams.get('utm_campaign')).toBe(`facebook-${PAGE_T}`);
    expect(new URL(calls[1].link).searchParams.get('utm_campaign')).toBe(`facebook-${PAGE_S}`);
    expect(calls[1].message).toBe(calls[0].message); // the same text and hashtags on both pages
    const rt = await rowsOf(PAGE_T);
    const rs = await rowsOf(PAGE_S);
    expect(rt.map((r) => [r.campaignId, r.status, r.articleKey])).toEqual([[c.id, 'POSTED', articleKey(c)]]);
    expect(rs.map((r) => [r.campaignId, r.status, r.articleKey])).toEqual([[c.id, 'POSTED', pushKey({ id: c.id, lastSentAt: c.lastSentAt as Date })]]);
    expect(rs[0].facebookPostId).toBe(`${ID_S}_2`);
    expect(JSON.stringify(logs)).not.toContain(TOKEN_S); // a token is never logged
    // a second tick adds nothing: one post per page per push
    await runFacebookTick(deps({ now: () => at(NOW, 1) }));
    expect(calls).toHaveLength(2);
  });

  it('the real name: UTM `facebook-shopscan`, its config comes from its own variables, its go-live is also its all-pushes time', () => {
    const tagged = withFacebookUtm('https://www.taxscan.in/gst/x-1', PAGE_SHOPSCAN, 'x-1');
    expect(new URL(tagged).searchParams.get('utm_campaign')).toBe('facebook-shopscan');
    expect(new URL(tagged).searchParams.get('utm_source')).toBe('taxscan-facebook');
    expect(new URL(tagged).searchParams.get('utm_medium')).toBe('social');
    realPages(true);
    expect(portalPages()).toEqual({ taxscan: [PAGE_TAXSCAN, PAGE_SHOPSCAN] }); // Taxscan first
    expect(pageConfig(PAGE_SHOPSCAN)).toEqual({ pageId: '5555555555', accessToken: `REAL-SHOPSCAN-TEST-TOKEN-${RUN}` });
    expect(pageConfig(PAGE_TAXSCAN)).toEqual({ pageId: '4444444444', accessToken: `REAL-TAXSCAN-TEST-TOKEN-${RUN}` });
    expect(pagePostFrom(PAGE_SHOPSCAN)).toEqual(FROM_S);
    expect(pageAllPushesFrom(PAGE_SHOPSCAN)).toEqual(FROM_S);
    env.facebook.postFrom = FROM_T;
    env.facebook.allPushesFrom = null;
    expect(pagePostFrom(PAGE_TAXSCAN)).toEqual(FROM_T);
    expect(pageAllPushesFrom(PAGE_TAXSCAN)).toBeNull();
    // an injected time: one for every page, or one per page (a page missing from the record uses its own)
    expect(resolvePostFrom(FROM_T, PAGE_SHOPSCAN)).toEqual(FROM_T);
    expect(resolvePostFrom({ [PAGE_TAXSCAN]: FROM_T }, PAGE_SHOPSCAN)).toEqual(FROM_S);
    expect(resolveAllPushesFrom(undefined, PAGE_SHOPSCAN)).toEqual(FROM_S);
    expect(resolveAllPushesFrom(null, PAGE_SHOPSCAN)).toBeNull();
    // with Shopscan off again the list is the old map
    delete env.facebook.sharedPages.shopscan;
    expect(portalPages()).toEqual({ taxscan: [PAGE_TAXSCAN] });
  });
});

/* ------------------------------------------------------------------ */
/* 3. Every push from go-live                                          */
/* ------------------------------------------------------------------ */

describe('3. Shopscan posts EVERY push from its own go-live, and nothing before it', () => {
  it('a course, a shop product, a collection page, a site page (with SOCIAL_ANY_LINK_FROM) and an exact repeat each post; a push before the go-live never does, whatever FACEBOOK_POST_FROM says', async () => {
    env.social.anyLinkFrom = FROM_S;
    const before = await camp('before', at(FROM_S, -30)); // after Taxscan's go-live (04:00), before Shopscan's (08:00)
    const course = await camp('course', at(FROM_S, 5), { url: courseUrl('c1'), title: 'Course one', body: 'Learn GST' });
    const product = await camp('product', at(FROM_S, 10), { url: productUrl('p1'), title: 'Product one', body: 'An e-book' });
    const collection = await camp('collection', at(FROM_S, 15), { url: 'https://shop.taxscan.in/collections/all', title: 'All books' });
    const site = await camp('site', at(FROM_S, 20), { url: 'https://www.taxscan.in/pricing', title: 'Pricing' });
    const repeat = await camp('repeat', at(FROM_S, 25), { url: course.url, title: 'Course one again', body: 'Learn GST' }); // the same URL, pushed again
    const again = await camp('again', at(FROM_S, 30), { url: before.url, title: 'Story before, again' }); // an old article pushed again, after the go-live
    await ticks(10, NOW, { minGapMinutes: 0 });
    const shop = await rowsOf(PAGE_S);
    expect(shop.map((r) => r.campaignId)).toEqual([course.id, product.id, collection.id, site.id, repeat.id, again.id]); // oldest push first, `before` never
    expect(shop.every((r) => r.status === 'POSTED' && r.articleKey.startsWith('push:'))).toBe(true);
    expect(await prisma.facebookPost.count({ where: { page: PAGE_S, campaignId: before.id } })).toBe(0);
    expect(callsFor(ID_S).map((c) => c.message.split('\n')[0])).toEqual(['Course one', 'Product one', 'All books', 'Pricing', 'Course one again', 'Story before, again']);
    // the Taxscan page is unchanged: today's rule, one post per article (its own, earlier go-live), nothing else
    expect((await rowsOf(PAGE_T)).map((r) => r.campaignId)).toEqual([before.id]);
    expect(callsFor(ID_T)).toHaveLength(1);
  });

  it('without SOCIAL_ANY_LINK_FROM the site pages do not post on Shopscan either (the same rule as Taxscan\'s every-push)', async () => {
    env.social.anyLinkFrom = null;
    const course = await camp('course2', at(FROM_S, 5), { url: courseUrl('c2'), title: 'Course two' });
    await camp('site2', at(FROM_S, 10), { url: 'https://www.taxscan.in/pricing', title: 'Pricing' });
    await ticks(5, NOW, { minGapMinutes: 0 });
    expect((await rowsOf(PAGE_S)).map((r) => r.campaignId)).toEqual([course.id]);
  });
});

/* ------------------------------------------------------------------ */
/* 4. Pacing per page                                                  */
/* ------------------------------------------------------------------ */

describe('4. pacing is per page: the gap and the daily cap count a page\'s own rows only', () => {
  it('a Taxscan post inside the gap does not hold Shopscan, and a Shopscan post inside the gap does not hold Taxscan', async () => {
    const old = await camp('old', at(FROM_S, -30)); // gives the seed rows a campaign; before Shopscan's go-live, so Shopscan never wants it
    const c = await camp('gap', at(NOW, -20));
    await seedRow(PAGE_T, articleKey(old), old.id, 'POSTED', at(NOW, -5)); // Taxscan posted 5 minutes ago: inside its 10-minute gap
    const t1 = await runFacebookTick(deps());
    expect(t1.waited).toBe('gap');
    expect(calls.map((x) => x.pageId)).toEqual([ID_S]); // Shopscan posted; Taxscan waited
    // six minutes on, Taxscan's gap is over (5 + 6 > 10) while Shopscan's own is not (it posted 6 minutes ago)
    const c2 = await camp('gap2', at(NOW, 3));
    calls = [];
    const t2 = await runFacebookTick(deps({ now: () => at(NOW, 6) }));
    expect(callsFor(ID_T).map((x) => x.message.split('\n')[0])).toEqual(['Story gap']);
    expect(callsFor(ID_S)).toHaveLength(0);
    expect(t2.waited).toBe('gap');
    expect(c2.id).toBeTruthy();
    expect((await rowsOf(PAGE_T)).map((r) => r.campaignId)).toContain(c.id);
  });

  it('each page\'s daily cap counts only its own posts', async () => {
    const old = await camp('capold', at(FROM_S, -30));
    await camp('cap1', at(NOW, -40));
    await seedRow(PAGE_T, articleKey(old), old.id, 'POSTED', at(NOW, -180)); // Taxscan is already at its cap of 1 today
    const t1 = await runFacebookTick(deps({ dailyCap: 1, minGapMinutes: 0 }));
    expect(t1.waited).toBe('daily_cap');
    expect(calls.map((x) => x.pageId)).toEqual([ID_S]); // Shopscan has posted nothing today: it posts
    await camp('cap2', at(NOW, -10));
    calls = [];
    const t2 = await runFacebookTick(deps({ dailyCap: 1, minGapMinutes: 0, now: () => at(NOW, 5) }));
    expect(t2.waited).toBe('daily_cap');
    expect(calls).toHaveLength(0); // now both are at their own cap
    expect(await rowsOf(PAGE_S).then((r) => r.filter((x) => x.status === 'POSTED').length)).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* 5. Stops per page                                                   */
/* ------------------------------------------------------------------ */

describe('5. a stop on Shopscan stops Shopscan only', () => {
  it('190, 401 and 403 are all "auth" for the worker', () => {
    expect(classify(401, null, TOKEN_S).kind).toBe('auth');
    expect(classify(403, null, TOKEN_S).kind).toBe('auth');
    expect(classify(400, { code: 190, message: 'Error validating access token' }, TOKEN_S).kind).toBe('auth');
  });

  it('a token rejection stops Shopscan alone: Taxscan posts in the same and later ticks, ONE alert for the page that day, and a new token resumes it', async () => {
    script = (r, n) => (r.pageId === ID_S ? failure('auth', 401, 190) : posted(`${r.pageId}_${n}`));
    const c1 = await camp('auth1', at(NOW, -30));
    const t1 = await runFacebookTick(deps());
    expect(t1.authStopped).toBe(true);
    expect(t1.posted).toBe(1); // Taxscan went first and posted
    expect(await loginProblem(PAGE_S)).not.toBeNull();
    expect(await loginProblem(PAGE_T)).toBeNull();
    expect(mails.map((m) => m.subject)).toEqual([`Facebook posting stopped — the ${PAGE_S} page token was rejected`]);
    const c2 = await camp('auth2', at(NOW, -5));
    calls = [];
    await ticks(3, at(NOW, 1), { minGapMinutes: 0 });
    expect(callsFor(ID_S)).toHaveLength(0); // stopped: no call
    expect(callsFor(ID_T).length).toBeGreaterThan(0); // Taxscan keeps posting
    expect((await rowsOf(PAGE_T)).map((r) => r.campaignId)).toEqual([c1.id, c2.id]);
    expect(mails).toHaveLength(1); // one alert, however many ticks
    // a new token (its fingerprint changes) lifts the stop; the row that waited posts
    script = (r, n) => posted(`${r.pageId}_${n}`);
    env.facebook.sharedPages[PAGE_S] = { pageId: ID_S, accessToken: `${TOKEN_S}-NEW`, postFrom: FROM_S };
    await runFacebookTick(deps({ now: () => at(NOW, 10), minGapMinutes: 0 }));
    expect(callsFor(ID_S).map((c) => c.accessToken)).toEqual([`${TOKEN_S}-NEW`]);
    expect(await loginProblem(PAGE_S)).toBeNull();
  });

  it('a 368 policy block stops Shopscan until an ADMIN Resume of `shopscan`; Taxscan is untouched; one alert; Resume of the other page does nothing', async () => {
    script = (r, n) => (r.pageId === ID_S ? failure('policy', 400, 368) : posted(`${r.pageId}_${n}`));
    await camp('pol1', at(NOW, -30));
    const t1 = await runFacebookTick(deps());
    expect(t1.policyStopped).toBe(true);
    expect(t1.posted).toBe(1);
    expect(await policyProblem(PAGE_S)).toMatchObject({ code: 368 });
    expect(await policyProblem(PAGE_T)).toBeNull();
    expect(mails.map((m) => m.subject)).toEqual([`Facebook blocked a post — posting to the ${PAGE_S} page is stopped`]);
    await camp('pol2', at(NOW, -5));
    calls = [];
    await ticks(3, at(NOW, 1), { minGapMinutes: 0 });
    expect(callsFor(ID_S)).toHaveLength(0);
    expect(callsFor(ID_T)).toHaveLength(1);
    expect(mails).toHaveLength(1);
    // Resume works per page: the Taxscan page has no stop, so resuming it changes nothing here
    expect(await resumePolicy(PAGE_T)).toBe(false);
    expect(await policyProblem(PAGE_S)).not.toBeNull();
    expect(await resumePolicy(PAGE_S)).toBe(true);
    script = (r, n) => posted(`${r.pageId}_${n}`);
    calls = [];
    await runFacebookTick(deps({ now: () => at(NOW, 10), minGapMinutes: 0 }));
    expect(callsFor(ID_S)).toHaveLength(1);
  });

  it('and the other way round: a Taxscan stop does not hold Shopscan', async () => {
    script = (r, n) => (r.pageId === ID_T ? failure('policy', 400, 368) : posted(`${r.pageId}_${n}`));
    await camp('rev1', at(NOW, -30));
    const t = await runFacebookTick(deps());
    expect(t.policyStopped).toBe(true);
    expect(callsFor(ID_S)).toHaveLength(1);
    expect(await policyProblem(PAGE_T)).not.toBeNull();
    expect(await policyProblem(PAGE_S)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 6. Pause / Resume per page                                          */
/* ------------------------------------------------------------------ */

describe('6. Pause `facebook:shopscan`', () => {
  it('paused: Shopscan rows are SKIPPED page_paused with no call, Taxscan is unaffected; resumed: the next push posts (the skipped one never does)', async () => {
    const c1 = await camp('pause1', at(NOW, -30));
    await setPause('facebook', PAGE_S, { byUserId: null, by: 'tester', note: null, now: NOW });
    await runFacebookTick(deps());
    expect(calls.map((x) => x.pageId)).toEqual([ID_T]);
    expect((await rowsOf(PAGE_S)).map((r) => [r.campaignId, r.status, r.error])).toEqual([[c1.id, 'SKIPPED', 'page_paused']]);
    expect((await getPageStatus('facebook', PAGE_S, NOW)).status).toBe('paused');
    expect((await getPageStatus('facebook', PAGE_T, NOW)).status).toBe('ok');
    expect(await clearPause('facebook', PAGE_S)).toBe(true);
    const c2 = await camp('pause2', at(NOW, 1));
    await runFacebookTick(deps({ now: () => at(NOW, 2), minGapMinutes: 0 }));
    expect(callsFor(ID_S)).toHaveLength(1);
    expect((await rowsOf(PAGE_S)).map((r) => [r.campaignId, r.status])).toEqual([
      [c1.id, 'SKIPPED'],
      [c2.id, 'POSTED'],
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* 7. Compose Post-to                                                  */
/* ------------------------------------------------------------------ */

describe('7. Compose "Post to"', () => {
  it('lists "Facebook · Shopscan" only while it is active, after "Facebook · Taxscan"; a send may untick it only then', () => {
    realPages(false);
    expect(activeSocialPages().filter((p) => p.key.startsWith('facebook:'))).toEqual([{ key: 'facebook:taxscan', label: 'Facebook · Taxscan' }]);
    expect(unknownSocialKeys(['facebook:shopscan'])).toEqual(['facebook:shopscan']);
    realPages(true);
    expect(activeSocialPages().filter((p) => p.key.startsWith('facebook:'))).toEqual([
      { key: 'facebook:taxscan', label: 'Facebook · Taxscan' },
      { key: 'facebook:shopscan', label: 'Facebook · Shopscan' },
    ]);
    expect(unknownSocialKeys(['facebook:shopscan', 'facebook:taxscan'])).toEqual([]);
    env.facebook.enabled = false; // the channel off: no Facebook entries at all
    expect(activeSocialPages().some((p) => p.key.startsWith('facebook:'))).toBe(false);
  });

  it('unticking it writes SKIPPED compose_skip for Shopscan only; Taxscan posts', async () => {
    const c = await camp('skip', at(NOW, -30), { skip: [facebookSkipKey(PAGE_S)] });
    const t = await runFacebookTick(deps());
    expect(t.posted).toBe(1);
    expect(calls.map((x) => x.pageId)).toEqual([ID_T]);
    expect((await rowsOf(PAGE_S)).map((r) => [r.campaignId, r.status, r.error])).toEqual([[c.id, 'SKIPPED', 'compose_skip']]);
    expect((await rowsOf(PAGE_T)).map((r) => [r.campaignId, r.status])).toEqual([[c.id, 'POSTED']]);
  });
});

/* ------------------------------------------------------------------ */
/* 8. The Compose picture                                              */
/* ------------------------------------------------------------------ */

describe('8. the Compose picture goes to both pages; a refused photo falls back to a link post on THAT page only', () => {
  it('a photo post on each page, and a 4xx on Shopscan\'s photo is repeated once as a link post on Shopscan alone', async () => {
    const imageId = randomBytes(32).toString('hex');
    imageIds.push(imageId);
    await prisma.socialImage.create({ data: { id: imageId, mime: 'image/png', width: 1200, height: 627, size: 4, bytes: Buffer.from([1, 2, 3, 4]) } });
    env.social.pictureEnabled = true;
    script = (r, n) => (r.pageId === ID_S && r.photoUrl ? failure('failed', 400, 100) : posted(`${r.pageId}_${n}`));
    const c = await camp('pic', at(NOW, -30), { picture: imageId });
    await runFacebookTick(deps({ socialPicture: true }));
    expect(calls.map((x) => [x.pageId, !!x.photoUrl])).toEqual([
      [ID_T, true],
      [ID_S, true], // refused
      [ID_S, false], // the one fallback, to the feed, on Shopscan only
    ]);
    const rt = (await rowsOf(PAGE_T))[0];
    const rs = (await rowsOf(PAGE_S))[0];
    expect([rt.campaignId, rt.status, rt.error]).toEqual([c.id, 'POSTED', null]);
    expect([rs.campaignId, rs.status]).toEqual([c.id, 'POSTED']);
    expect(rs.error).toMatch(/posted as a link post/);
  });
});

/* ------------------------------------------------------------------ */
/* 9. The screen's API                                                 */
/* ------------------------------------------------------------------ */

describe('9. GET /api/facebook/posts?page=, Retry / Skip, Check connection and Resume are per page', () => {
  const BEARER = { Authorization: `Bearer ${env.adminToken}` };
  const list = (app: ReturnType<typeof appWith>, q = '') => request(app).get(`/api/facebook/posts?date=2026-11-14${q}`).set(BEARER);

  it('the default is the first page; `?page=shopscan` is its own rows; unknown or inactive is 400 invalid_page; `pages` only while there are two', async () => {
    const c1 = await camp('list1', at(NOW, -50));
    const c2 = await camp('list2', at(NOW, -40));
    await seedRow(PAGE_T, articleKey(c1), c1.id, 'POSTED', at(NOW, -45));
    await seedRow(PAGE_S, pushKey({ id: c2.id, lastSentAt: c2.lastSentAt as Date }), c2.id, 'FAILED', at(NOW, -35), 'HTTP 422');
    const app = appWith();
    const a = await list(app);
    expect(a.status).toBe(200);
    expect(a.body.page).toBe(PAGE_T);
    expect(a.body.pages).toEqual([PAGE_T, PAGE_S]);
    expect(a.body.rows.map((r: { campaignId: string; status: string }) => [r.campaignId, r.status])).toEqual([
      [c1.id, 'POSTED'],
      [c2.id, 'WAITING'], // Taxscan has not posted c2 yet
    ]);
    const s = await list(app, `&page=${PAGE_S}`);
    expect(s.status).toBe(200);
    expect(s.body.page).toBe(PAGE_S);
    expect(s.body.pages).toEqual([PAGE_T, PAGE_S]);
    // Shopscan: EVERY push is its own row from its go-live, each with its own status
    expect(s.body.rows.map((r: { campaignId: string; status: string }) => [r.campaignId, r.status])).toEqual([
      [c1.id, 'WAITING'],
      [c2.id, 'FAILED'],
    ]);
    expect(s.body.everyPushFrom).toBe(FROM_S.toISOString());
    expect(a.body.everyPushFrom).toBeUndefined(); // Taxscan stays on today's rule in this test
    expect((await list(app, '&page=nope')).status).toBe(400);
    expect((await list(app, '&page=nope')).body).toEqual({ error: 'invalid_page' });
    // Shopscan inactive: only one page in the list; naming it is 400 and the answer has no `pages` (what it always was)
    const one = appWith({ portals: { [PORTAL]: [PAGE_T] } });
    const o = await list(one);
    expect(o.status).toBe(200);
    expect(o.body.page).toBe(PAGE_T);
    expect('pages' in o.body).toBe(false);
    expect((await list(one, `&page=${PAGE_S}`)).status).toBe(400);
  });

  it('each page\'s banners and status are its own', async () => {
    const c = await camp('banner', at(NOW, -50));
    await prisma.digestSetting.create({ data: { key: policyKey(PAGE_S), value: JSON.stringify({ stoppedAt: NOW.toISOString(), status: 400, code: 368, subcode: null, message: 'blocked' }) } });
    await prisma.digestSetting.create({ data: { key: authKey(PAGE_T), value: JSON.stringify({ stoppedAt: NOW.toISOString(), alertedDay: null, status: 401 }) } });
    const app = appWith();
    const t = (await list(app)).body;
    const s = (await list(app, `&page=${PAGE_S}`)).body;
    expect(t.policy).toBeNull();
    expect(t.login).not.toBeNull();
    expect(s.policy).toMatchObject({ code: 368 });
    expect(s.login).toBeNull();
    expect(t.pageStatus.status).toBe('stopped');
    expect(s.pageStatus.status).toBe('stopped');
    expect(s.pageStatus.reason).toBe('policy_block');
    expect(t.pageStatus.reason).toBe('login_rejected');
    expect(c.id).toBeTruthy();
  });

  it('Retry and Skip on a Shopscan row leave the Taxscan rows untouched', async () => {
    const c = await camp('retry', at(NOW, -50));
    const rt = await seedRow(PAGE_T, articleKey(c), c.id, 'FAILED', at(NOW, -40), 'HTTP 500');
    const rs = await seedRow(PAGE_S, pushKey({ id: c.id, lastSentAt: c.lastSentAt as Date }), c.id, 'FAILED', at(NOW, -40), 'HTTP 500');
    const app = appWith();
    const r = await request(app).post(`/api/facebook/posts/${rs.id}/retry`).set(BEARER);
    expect(r.body).toEqual({ ok: true, status: 'POSTED' });
    expect(callsFor(ID_S)).toHaveLength(1);
    expect(callsFor(ID_T)).toHaveLength(0);
    expect((await prisma.facebookPost.findUniqueOrThrow({ where: { id: rt.id } })).status).toBe('FAILED');
    // skip: the other failed row
    const rs2 = await seedRow(PAGE_S, 'push:other:1', c.id, 'FAILED', at(NOW, -30), 'HTTP 500');
    const sk = await request(app).post(`/api/facebook/posts/${rs2.id}/skip`).set(BEARER);
    expect(sk.body).toEqual({ ok: true, status: 'SKIPPED' });
    expect((await prisma.facebookPost.findUniqueOrThrow({ where: { id: rt.id } })).status).toBe('FAILED'); // still
  });

  it('Check connection asks the page it was told about, with that page\'s own token; Resume clears that page\'s policy stop only; both need `page` to be an active one', async () => {
    const seen: { url: string; auth: string }[] = [];
    const fetchFake: FetchFake = async (url, init) => {
      seen.push({ url, auth: init?.headers?.Authorization ?? '' });
      return { ok: true, status: 200, json: async () => ({ name: url.includes(ID_S) ? 'Shopscan Page' : 'Taxscan Page' }) } as unknown as Response;
    };
    const app = appWith({ fetch: fetchFake });
    const post = (path: string, body: object) => request(app).post(path).set('Cookie', adminCookie).send(body);
    const def = await post('/api/facebook/check', {});
    expect(def.body).toMatchObject({ ok: true, name: 'Taxscan Page' });
    const shop = await post('/api/facebook/check', { page: PAGE_S });
    expect(shop.body).toMatchObject({ ok: true, name: 'Shopscan Page' });
    expect(seen.map((s) => [s.url.includes(ID_S), s.auth])).toEqual([
      [false, `Bearer ${TOKEN_T}`],
      [true, `Bearer ${TOKEN_S}`],
    ]);
    expect((await post('/api/facebook/check', { page: 'nope' })).status).toBe(400);
    // Resume: only the named page's stop
    await prisma.digestSetting.create({ data: { key: policyKey(PAGE_S), value: JSON.stringify({ stoppedAt: NOW.toISOString(), status: 400, code: 368, subcode: null, message: 'blocked' }) } });
    await prisma.digestSetting.create({ data: { key: policyKey(PAGE_T), value: JSON.stringify({ stoppedAt: NOW.toISOString(), status: 400, code: 368, subcode: null, message: 'blocked' }) } });
    expect((await post('/api/facebook/resume', { page: PAGE_S })).body).toEqual({ ok: true });
    expect(await policyProblem(PAGE_S)).toBeNull();
    expect(await policyProblem(PAGE_T)).not.toBeNull(); // untouched
    expect((await post('/api/facebook/resume', { page: PAGE_S })).status).toBe(409); // nothing left to resume
    expect((await post('/api/facebook/resume', { page: 'nope' })).status).toBe(400);
    expect((await post('/api/facebook/resume', {})).body).toEqual({ ok: true }); // no page = the first one
    expect(await policyProblem(PAGE_T)).toBeNull();
    // the shared Pause routes take the page too
    const pause = await post('/api/facebook/page-pause', { page: PAGE_S });
    expect(pause.status).toBe(200);
    expect((await getPageStatus('facebook', PAGE_S, NOW)).status).toBe('paused');
    expect((await getPageStatus('facebook', PAGE_T, NOW)).status).toBe('ok');
    expect((await post('/api/facebook/page-resume', { page: PAGE_S })).status).toBe(200);
  });
});

/* ------------------------------------------------------------------ */
/* 11. Page status and alerts                                          */
/* ------------------------------------------------------------------ */

describe('11. page status and alerts report `facebook:shopscan` on its own', () => {
  it('the status list names Shopscan only while it is active, after Taxscan', () => {
    realPages(false);
    expect(activePages().filter((p) => p.channel === 'facebook')).toEqual([{ channel: 'facebook', page: 'taxscan' }]);
    realPages(true);
    expect(activePages().filter((p) => p.channel === 'facebook')).toEqual([
      { channel: 'facebook', page: 'taxscan' },
      { channel: 'facebook', page: 'shopscan' },
    ]);
  });

  it('two failed Shopscan posts in a row = failing for Shopscan alone, with ONE email that day, worded for Shopscan', async () => {
    const old = await camp('stold', at(FROM_S, -30));
    await seedRow(PAGE_T, 'ok-t', old.id, 'POSTED', at(NOW, -60));
    await seedRow(PAGE_S, 'push:f1:1', old.id, 'FAILED', at(NOW, -30), 'HTTP 422');
    await seedRow(PAGE_S, 'push:f2:2', old.id, 'FAILED', at(NOW, -20), 'HTTP 422');
    const s = await getPageStatus('facebook', PAGE_S, NOW);
    expect(s).toMatchObject({ status: 'failing', reason: 'recent_posts_failed', failures: 2, page: PAGE_S });
    expect((await getPageStatus('facebook', PAGE_T, NOW)).status).toBe('ok');
    expect(await alertIfNeeded('facebook', PAGE_S, NOW, deps())).toBe('sent');
    expect(await alertIfNeeded('facebook', PAGE_S, NOW, deps())).toBe('already_today');
    expect(await alertIfNeeded('facebook', PAGE_T, NOW, deps())).toBe('not_alertable');
    expect(mails).toHaveLength(1);
    expect(mails[0].subject).toContain(pageLabel('facebook', PAGE_S)); // the page's own label ("Facebook · Shopscan" for the real name)
    // the stop markers are keyed by page too
    expect(facebookAuthKey(PAGE_S)).toBe(authKey(PAGE_S));
    expect(facebookPolicyKey(PAGE_S)).toBe(policyKey(PAGE_S));
  });
});
