import request from 'supertest';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Prisma } from '@prisma/client';
import { createApp } from '../app';
import { env, parseAllPushesFrom, SOCIAL_ANY_LINK_FROM_VAR } from '../lib/env';
import { prisma } from '../lib/prisma';
import { listCampaigns } from '../services/metrics';
import { isAllPushesCampaign, pageLinkOf, pageUtmContent, pushKey } from '../services/social/allPushes';
import { fetchStorePage, type StorePageFetch, type StorePageResult, type StorePageTags } from '../services/social/storePage';
import type { LinkedInRequest, LinkedInResult } from '../services/linkedin/client';
import { buildPagePost, buildPost, buildStorePost } from '../services/linkedin/post';
import { buildFacebookPagePost, buildFacebookPost, buildFacebookStorePost } from '../services/facebook/post';
import type { FacebookResult } from '../services/facebook/client';
import { buildPostText } from '../services/whatsapp/postText';
import { buildPushPostText, pushKindOf } from '../services/whatsapp/pushText';
import { getQueue, markArticle } from '../services/whatsapp/queue';
import { authKey as liAuthKey, resetLinkedInStops, retryNow as liRetry, runLinkedInTick, type WorkerDeps as LiDeps } from '../services/linkedin/worker';
import { authKey as fbAuthKey, policyKey, resetFacebookStops, runFacebookTick, type WorkerDeps as FbDeps } from '../services/facebook/worker';
import { resetTokenCache } from '../services/linkedin/token';

/**
 * Brief 2026-11-07-social-every-link: from SOCIAL_ANY_LINK_FROM (one time for all four channels) a push to ANY other allowed page
 * (a shop collection, the pricing page, the home page) is posted like an article, course or product, on LinkedIn Taxscan, LinkedIn
 * Academy, Facebook and the WhatsApp list; before it, never. The time check lives INSIDE `isAllPushesCampaign`, so these tests run
 * every one of its call sites with a real other-page push: both workers, both screens, the WhatsApp queue and its marks, and the
 * Campaigns Channels marks (`channelsFor`). ALL LinkedIn, Facebook and page calls are mocked; nothing is posted.
 *
 * ISOLATION (as socialAllPushes.test.ts): the workers use private pages (PAGE plays the Taxscan LinkedIn page, PAGE_AC the Academy
 * page, FB_PAGE the Facebook page) on a private portal. Only the Channels marks are hard-wired to the real page `taxscan`; they use
 * run-unique links and their rows are removed after every test.
 */
const logs: string[] = [];
jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
jest.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
jest.spyOn(console, 'warn').mockImplementation(() => undefined);

const RUN = `${Date.now()}-${randomBytes(3).toString('hex')}`;
const PORTAL = `test-anylink-${RUN}`;
const PAGE = `lianyl${randomBytes(3).toString('hex')}`; // plays the Taxscan LinkedIn page: owns the token
const PAGE_AC = `${PAGE}-ac`; // plays the Academy page: shares PAGE's token
const FB_PAGE = `fbanyl${randomBytes(3).toString('hex')}`;
const ORG = 'urn:li:organization:101';
const ORG_AC = 'urn:li:organization:91100022';
const TOKEN = `ANYLINK-LI-TOKEN-${RUN}`;
const FB_PAGE_ID = '1234567890';
const FB_TOKEN = `ANYLINK-FB-TOKEN-${RUN}-EAAB1234567890`;
const BEARER = { Authorization: `Bearer ${env.adminToken}` };

const IST_MS = (5 * 60 + 30) * 60_000;
const ist = (h: number, m = 0, day = 3) => new Date(Date.UTC(2026, 10, day, h, m) - IST_MS);
const MIN = 60_000;
const at = (base: Date, min: number) => new Date(base.getTime() + min * MIN);
const NOW = ist(10, 0); // 3 Nov 2026 10:00 IST: the workers' clock
const FROM = ist(4, 0); // the Taxscan page's go-live
const FROM_AC = ist(7, 0); // the Academy page's go-live
const PUSHES = ist(8, 0); // every channel's all-pushes time
const ANY = ist(9, 0); // SOCIAL_ANY_LINK_FROM
const SECOND_BEFORE = new Date(ANY.getTime() - 1000);
const DAY = '2026-11-03';

const URLS = {
  collection: 'https://shop.taxscan.in/collections/all',
  pricing: 'https://www.taxscan.in/pricing',
  home: 'https://www.taxscan.in/',
} as const;
const CONTENT: Record<keyof typeof URLS, string> = { collection: 'collections-all', pricing: 'pricing', home: 'home' };
const KINDS = Object.keys(URLS) as (keyof typeof URLS)[];

const posted = (id = 'urn:li:share:1'): LinkedInResult => ({ kind: 'posted', postId: id });
const failed422: LinkedInResult = { kind: 'failed', status: 422, error: 'HTTP 422: invalid content' };
const fbPosted = (id = '123_456'): FacebookResult => ({ kind: 'posted', postId: id });

/* ---------- mocks ---------- */

let calls: LinkedInRequest[] = [];
let script: (r: LinkedInRequest, n: number) => LinkedInResult | Promise<LinkedInResult> = () => posted(`urn:li:share:${calls.length}`);
const liPost: NonNullable<LiDeps['post']> = async (r) => {
  calls.push(r);
  return script(r, calls.length);
};
let pageCalls: string[] = [];
const CARD: StorePageTags = { title: 'Card title | Taxscan', description: 'Card description from the page.', imageUrl: 'https://shop.taxscan.in/cdn/card.jpg', imageReason: null };
let pageScript: (url: string) => StorePageResult | Promise<StorePageResult> = () => ({ ok: true, tags: CARD });
const pageFetch: StorePageFetch = async (url) => {
  pageCalls.push(url);
  return pageScript(url);
};
let imageCalls: string[] = [];
const imageFetch: NonNullable<LiDeps['fetchImage']> = async (u) => (imageCalls.push(u), { ok: true, bytes: new Uint8Array([0xff, 0xd8, 1, 2]), contentType: 'image/jpeg' });
const imageUpload: NonNullable<LiDeps['uploadImage']> = async () => ({ kind: 'ok', urn: 'urn:li:image:C9ZZ' });

const liDeps = (over: LiDeps = {}): LiDeps => ({
  now: () => NOW,
  post: liPost,
  fetchCms: async () => null,
  fetchStorePage: pageFetch,
  fetchImage: imageFetch,
  uploadImage: imageUpload,
  waitImage: async () => ({ ok: true }),
  emailSender: async () => ({ ok: true }),
  isEmailConfigured: () => true,
  recipients: async () => ['admin@team.test'],
  portals: { [PORTAL]: [PAGE, PAGE_AC] },
  postFrom: { [PAGE]: FROM, [PAGE_AC]: FROM_AC },
  allPushesFrom: { [PAGE]: PUSHES, [PAGE_AC]: PUSHES },
  quiet: { start: '23:00', end: '07:00' },
  ...over,
});
const ONE = { portals: { [PORTAL]: [PAGE] } } satisfies LiDeps; // the Taxscan page alone

let fbCalls: { pageId: string; accessToken: string; message: string; link: string }[] = [];
const fbPost: NonNullable<FbDeps['post']> = async (r) => {
  fbCalls.push(r);
  return fbPosted(`1_${fbCalls.length}`);
};
const fbDeps = (over: FbDeps = {}): FbDeps => ({
  now: () => NOW,
  post: fbPost,
  fetchCms: async () => null,
  emailSender: async () => ({ ok: true }),
  isEmailConfigured: () => true,
  recipients: async () => ['admin@team.test'],
  portals: { [PORTAL]: FB_PAGE },
  postFrom: FROM,
  allPushesFrom: PUSHES,
  quiet: { start: '23:00', end: '07:00' },
  minGapMinutes: 10,
  dailyCap: 30,
  ...over,
});

/** `n` LinkedIn ticks (3 posts each, shared by the pages): enough for any list in these tests; a finished list is a no-op. */
async function liTicks(d: LiDeps = liDeps(), n = 4) {
  for (let i = 0; i < n; i++) await runLinkedInTick(d);
}
/** `n` Facebook ticks, 11 minutes apart (at most one post per tick, a 10 minute gap). */
async function fbTicks(n = 4, over: FbDeps = {}) {
  for (let i = 0; i < n; i++) await runFacebookTick(fbDeps({ now: () => at(NOW, 11 * i), ...over }));
}

/* ---------- campaigns and rows ---------- */

let seq = 0;
type PushOpts = { title?: string; body?: string; target?: object; status?: 'SENT' | 'DRAFT'; portal?: string };
async function push(url: string, lastSentAt: Date | null, o: PushOpts = {}) {
  return prisma.campaign.create({
    data: {
      portal: o.portal ?? PORTAL,
      title: o.title ?? `Shop now ${++seq}`,
      body: o.body ?? 'Every ebook is on offer.',
      url,
      target: (o.target ?? { type: 'all' }) as Prisma.InputJsonValue,
      status: o.status ?? 'SENT',
      lastSentAt,
      authority: null,
      categories: [],
    },
  });
}
const courseUrl = (slug: string) => `https://academy.taxscan.in/course/${slug}-${RUN}`;
const productUrl = (slug: string) => `https://shop.taxscan.in/products/${slug}-${RUN}`;
const articleUrl = (slug: string) => `https://www.taxscan.in/gst/${slug}-${RUN}-${++seq}`;
const liRows = (page: string) => prisma.linkedInPost.findMany({ where: { page }, orderBy: { createdAt: 'asc' } });
const fbRows = () => prisma.facebookPost.findMany({ where: { page: FB_PAGE }, orderBy: { createdAt: 'asc' } });
const keysOf = async (page: string) => (await liRows(page)).map((r) => r.articleKey);
const pk = (c: { id: string; lastSentAt: Date | null }) => pushKey({ id: c.id, lastSentAt: c.lastSentAt as Date });
const sameKeys = (actual: string[], expected: string[]) => expect([...actual].sort()).toEqual([...expected].sort());
const params = (link: string) => new URL(link).searchParams;
const anyLink = (from: Date | null) => {
  env.social.anyLinkFrom = from;
};
/** A push's own tracking, which every channel must replace, plus a parameter that must survive. */
const OWN = 'utm_source=push&utm_medium=web&utm_campaign=morning&utm_content=old&ref=keep';
const withOwn = (u: string) => `${u}${u.includes('?') ? '&' : '?'}${OWN}`;

const saved = {
  shared: env.linkedin.sharedPages,
  taxscan: env.linkedin.pages.taxscan,
  liPage: env.linkedin.pages[PAGE],
  from: env.linkedin.postFrom,
  enabled: env.linkedin.enabled,
  liAll: env.linkedin.allPushesFrom,
  tr: { ...env.linkedin.tokenRefresh },
  fbEnabled: env.facebook.enabled,
  fbFrom: env.facebook.postFrom,
  fbAll: env.facebook.allPushesFrom,
  fbTaxscan: env.facebook.pages.taxscan,
  waQueue: env.whatsapp.queueEnabled,
  waAll: env.whatsapp.allPushesFrom,
  any: env.social.anyLinkFrom,
  hosts: env.allowedPushHosts,
};
async function wipe() {
  await prisma.linkedInPost.deleteMany({ where: { page: { in: [PAGE, PAGE_AC] } } });
  await prisma.facebookPost.deleteMany({ where: { page: FB_PAGE } });
  await prisma.whatsAppPost.deleteMany({ where: { portal: PORTAL } });
  await prisma.digestSetting.deleteMany({ where: { key: { in: [liAuthKey(PAGE), liAuthKey(PAGE_AC), fbAuthKey(FB_PAGE), policyKey(FB_PAGE)] } } });
  await prisma.campaign.deleteMany({ where: { portal: { startsWith: PORTAL } } });
}
beforeEach(async () => {
  calls = [];
  fbCalls = [];
  pageCalls = [];
  imageCalls = [];
  logs.length = 0;
  script = () => posted(`urn:li:share:${calls.length}`);
  pageScript = () => ({ ok: true, tags: CARD });
  env.linkedin.pages[PAGE] = { orgUrn: ORG, accessToken: TOKEN };
  env.linkedin.pages.taxscan = { orgUrn: '', accessToken: '' }; // the real page is never touched
  env.linkedin.sharedPages = { [PAGE_AC]: { orgUrn: ORG_AC, postFrom: FROM_AC, tokenFrom: PAGE } };
  env.linkedin.postFrom = FROM;
  env.linkedin.allPushesFrom = {};
  Object.assign(env.linkedin.tokenRefresh, { ...saved.tr, enabled: false });
  env.facebook.pages[FB_PAGE] = { pageId: FB_PAGE_ID, accessToken: FB_TOKEN };
  env.facebook.allPushesFrom = null;
  env.whatsapp.allPushesFrom = null;
  env.allowedPushHosts = ['taxscan.in', 'www.taxscan.in', 'academy.taxscan.in', 'shop.taxscan.in']; // hermetic: whatever the developer's .env says
  anyLink(ANY);
  resetLinkedInStops();
  resetFacebookStops();
  resetTokenCache();
  await wipe();
});
afterAll(async () => {
  env.linkedin.sharedPages = saved.shared;
  env.linkedin.pages.taxscan = saved.taxscan;
  if (saved.liPage) env.linkedin.pages[PAGE] = saved.liPage;
  else delete env.linkedin.pages[PAGE];
  delete env.facebook.pages[FB_PAGE];
  env.linkedin.postFrom = saved.from;
  env.linkedin.enabled = saved.enabled;
  env.linkedin.allPushesFrom = saved.liAll;
  Object.assign(env.linkedin.tokenRefresh, saved.tr);
  env.facebook.enabled = saved.fbEnabled;
  env.facebook.postFrom = saved.fbFrom;
  env.facebook.allPushesFrom = saved.fbAll;
  env.facebook.pages.taxscan = saved.fbTaxscan;
  env.whatsapp.queueEnabled = saved.waQueue;
  env.whatsapp.allPushesFrom = saved.waAll;
  env.social.anyLinkFrom = saved.any;
  env.allowedPushHosts = saved.hosts;
  await wipe();
  await prisma.$disconnect();
});

/* ================================================================== */
/* The setting, the kind, the shared rule                              */
/* ================================================================== */

describe('the setting: off unless a strict ISO time', () => {
  it('the name, and the strict parse (the same check as every all-pushes time)', () => {
    expect(SOCIAL_ANY_LINK_FROM_VAR).toBe('SOCIAL_ANY_LINK_FROM');
    expect(parseAllPushesFrom({}, SOCIAL_ANY_LINK_FROM_VAR)).toEqual({ at: null, off: 'SOCIAL_ANY_LINK_FROM is not set' });
    for (const bad of ['2026', '04/11/2026', 'Nov 4', 'soon', '2026-13-45']) {
      expect(parseAllPushesFrom({ SOCIAL_ANY_LINK_FROM: bad } as NodeJS.ProcessEnv, SOCIAL_ANY_LINK_FROM_VAR)).toEqual({ at: null, off: 'SOCIAL_ANY_LINK_FROM is not a valid ISO time' });
    }
    expect(parseAllPushesFrom({ SOCIAL_ANY_LINK_FROM: '2026-11-09T09:00:00+05:30' } as NodeJS.ProcessEnv, SOCIAL_ANY_LINK_FROM_VAR).at).toEqual(new Date('2026-11-09T03:30:00Z'));
  });

  it('env.social.anyLinkFrom is wired to the variable: valid → the time, unset or invalid → null (env loaded afresh)', () => {
    const before = process.env.SOCIAL_ANY_LINK_FROM;
    const load = (v: string | undefined) => {
      if (v === undefined) delete process.env.SOCIAL_ANY_LINK_FROM;
      else process.env.SOCIAL_ANY_LINK_FROM = v;
      let at: Date | null = new Date(0);
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        at = (require('../lib/env') as typeof import('../lib/env')).env.social.anyLinkFrom;
      });
      return at;
    };
    try {
      expect(load(undefined)).toBeNull();
      expect(load('2026-11-09T04:00:00Z')).toEqual(new Date('2026-11-09T04:00:00Z'));
      expect(load('04/11/2026')).toBeNull();
      expect(load('')).toBeNull();
    } finally {
      if (before === undefined) delete process.env.SOCIAL_ANY_LINK_FROM;
      else process.env.SOCIAL_ANY_LINK_FROM = before;
    }
  });
});

describe('pageLinkOf and pageUtmContent: any OTHER page on a NAMED allowed host', () => {
  it('the three pages of the brief, and what utm_content they get', () => {
    for (const k of KINDS) {
      const l = pageLinkOf(URLS[k]);
      expect(l).not.toBeNull();
      expect(pageUtmContent(l!)).toBe(CONTENT[k]);
    }
    expect(pageLinkOf('https://shop.taxscan.in/collections/all/')).toMatchObject({ segments: ['collections', 'all'], base: 'https://shop.taxscan.in/collections/all/' });
    expect(pageUtmContent(pageLinkOf('https://shop.taxscan.in/collections/all/')!)).toBe('collections-all');
    expect(pageUtmContent(pageLinkOf('https://www.taxscan.in/')!)).toBe('home');
    expect(pageLinkOf('https://www.taxscan.in/pricing?x=1#f')!.base).toBe('https://www.taxscan.in/pricing'); // no query, no fragment
  });

  it('segments are decoded and the whole is cut like an article id', () => {
    expect(pageUtmContent(pageLinkOf('https://shop.taxscan.in/collections/gst%20books')!)).toBe('collections-gst books');
    const long = `https://shop.taxscan.in/collections/${'a'.repeat(300)}`;
    expect(pageUtmContent(pageLinkOf(long)!)).toHaveLength(100);
    expect(pageUtmContent(pageLinkOf('https://shop.taxscan.in/collections/%E0%A4%A')!)).toBe('collections-%E0%A4%A'); // a bad escape keeps the raw segment
  });

  it('an article, a course, a product, an off-list host, userinfo, a port and junk are not pages', () => {
    for (const u of [
      'https://www.taxscan.in/gst/an-article-slug',
      'https://www.taxscan.in/gst/an-article-123456',
      courseUrl('c'),
      productUrl('p'),
      'https://evil.example.com/collections/all',
      'https://shop.taxscan.in.evil.example.com/collections/all',
      'https://user:pw@shop.taxscan.in/collections/all',
      'https://shop.taxscan.in:8443/collections/all',
      'ftp://shop.taxscan.in/collections/all',
      'not a url',
      '',
    ]) {
      expect(pageLinkOf(u)).toBeNull();
    }
  });

  it('with the allowlist emptied (the operator\'s permissive mode) nothing is a page: the card fetch is never pointed at an unlisted host', () => {
    env.allowedPushHosts = [];
    expect(pageLinkOf(URLS.collection)).toBeNull();
    expect(isAllPushesCampaign({ url: URLS.collection, lastSentAt: ANY }, 'test', ANY)).toBe(false);
  });
});

describe('isAllPushesCampaign: the time check lives inside it', () => {
  const TEST_TOPIC = 'test';
  const rule = (c: { url: string; target?: unknown; lastSentAt?: Date | null }, from: Date | null = ANY) => isAllPushesCampaign(c, TEST_TOPIC, from);

  it('1. setting unset: the three pages do not qualify; articles, courses and products are exactly as today (with or without a send time)', () => {
    for (const k of KINDS) {
      expect(rule({ url: URLS[k], lastSentAt: ANY }, null)).toBe(false);
      expect(rule({ url: URLS[k], lastSentAt: new Date('2030-01-01') }, null)).toBe(false);
    }
    for (const u of [articleUrl('a'), courseUrl('c'), productUrl('p')]) {
      expect(rule({ url: u }, null)).toBe(true);
      expect(rule({ url: u, lastSentAt: null }, null)).toBe(true);
      expect(rule({ url: u, lastSentAt: SECOND_BEFORE }, ANY)).toBe(true); // the time never touches these three
    }
  });

  it('2–3. set: at the time and after, yes; ONE SECOND before, no — and the same for any older push', () => {
    for (const k of KINDS) {
      expect(rule({ url: URLS[k], lastSentAt: ANY })).toBe(true);
      expect(rule({ url: URLS[k], lastSentAt: new Date(ANY.getTime() + 1) })).toBe(true);
      expect(rule({ url: URLS[k], lastSentAt: SECOND_BEFORE })).toBe(false);
      expect(rule({ url: URLS[k], lastSentAt: new Date(ANY.getTime() - 1) })).toBe(false);
      expect(rule({ url: URLS[k], lastSentAt: new Date('2020-01-01') })).toBe(false);
    }
  });

  it('a push with no send time never qualifies as a page (fail closed): a caller that forgot lastSentAt posts nothing, never the past', () => {
    for (const k of KINDS) {
      expect(rule({ url: URLS[k] })).toBe(false);
      expect(rule({ url: URLS[k], lastSentAt: null })).toBe(false);
      expect(rule({ url: URLS[k], lastSentAt: undefined })).toBe(false);
    }
  });

  it('5. a link off ALLOWED_PUSH_HOSTS and a test-segment-only push make no row, with the setting on', () => {
    expect(rule({ url: 'https://evil.example.com/collections/all', lastSentAt: ANY })).toBe(false);
    expect(rule({ url: 'https://www.taxscan.in.evil.example.com/pricing', lastSentAt: ANY })).toBe(false);
    expect(rule({ url: URLS.collection, lastSentAt: ANY, target: { type: 'topics', topics: [TEST_TOPIC] } })).toBe(false);
    expect(rule({ url: URLS.collection, lastSentAt: ANY, target: { type: 'topics', topics: [TEST_TOPIC, 'gst'] } })).toBe(true); // a real topic too = a real send
  });

  it('the kind label: article, course, product, page (a page is a page whatever the time)', () => {
    expect(pushKindOf(articleUrl('a'))).toBe('article');
    expect(pushKindOf(courseUrl('c'))).toBe('course');
    expect(pushKindOf(productUrl('p'))).toBe('product');
    for (const k of KINDS) expect(pushKindOf(URLS[k])).toBe('page');
    expect(pushKindOf('https://evil.example.com/x')).toBeNull();
  });
});

describe('every call site of isAllPushesCampaign (source scan): a new or removed caller fails here and must be reviewed', () => {
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((n) => {
      const p = path.join(dir, n);
      return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
    });
  }
  it('exactly these 12 calls, in 9 files — each covered by a behaviour test (Telegram: src/__tests__/telegramWorker.test.ts)', () => {
    const root = path.join(__dirname, '..');
    const found: Record<string, number> = {};
    for (const f of files(root)) {
      if (f.includes('__tests__')) continue;
      const n = readFileSync(f, 'utf8')
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l) && !/^\s*import\b/.test(l) && !/export function isAllPushesCampaign/.test(l))
        .reduce((sum, l) => sum + (l.match(/isAllPushesCampaign\(/g)?.length ?? 0), 0);
      if (n > 0) found[path.relative(root, f)] = n;
    }
    expect(found).toEqual({
      'routes/facebook.ts': 2, // the Facebook screen (+1: an unticked Compose push's row) → "the screens" below; src/__tests__/socialComposeSkip.test.ts
      'routes/linkedin.ts': 2, // the LinkedIn screen (+1: an unticked Compose push's row) → "the screens" below; src/__tests__/socialComposeSkip.test.ts
      'routes/telegram.ts': 1, // the Telegram screen (every push is a row) → src/__tests__/telegramWorker.test.ts "the screen API"
      'services/facebook/worker.ts': 1, // the Facebook worker   → "Facebook worker" below
      'services/linkedin/worker.ts': 1, // the LinkedIn worker   → "LinkedIn worker" below
      'services/metrics.ts': 3, // the Channels marks (LinkedIn + Facebook, WhatsApp, and +1 Telegram) → "Channels marks" below; src/__tests__/telegramWorker.test.ts
      'services/social/composeSkip.ts': 1, // which unticked Compose pushes would have posted → src/__tests__/socialComposeSkip.test.ts
      'services/telegram/worker.ts': 1, // the Telegram worker → src/__tests__/telegramWorker.test.ts "2. what posts"
      'services/whatsapp/queue.ts': 3, // getQueue, markArticle and (+1) getQueue's unticked Compose pushes → "WhatsApp" below; src/__tests__/socialComposeSkip.test.ts
    });
  });
});

/* ================================================================== */
/* LinkedIn worker (both pages)                                        */
/* ================================================================== */

describe('LinkedIn worker', () => {
  it('1. setting unset: the three pages make no row on either page; an article, a course and a product behave as today', async () => {
    anyLink(null);
    await push(URLS.collection, ANY);
    await push(URLS.pricing, ANY);
    await push(URLS.home, ANY);
    const a = await push(articleUrl('a'), at(ANY, 1));
    const c = await push(courseUrl('c'), at(ANY, 2));
    const p = await push(productUrl('p'), at(ANY, 3));
    await liTicks();
    sameKeys(await keysOf(PAGE), [pk(a), pk(c), pk(p)]);
    sameKeys(await keysOf(PAGE_AC), [pk(a), pk(c), pk(p)]);
    expect(calls).toHaveLength(6);
    expect(logs.join('\n')).not.toContain('kind=page');
  });

  it('2. set: each of the three, sent at or after the time, makes one row on LinkedIn Taxscan and one on LinkedIn Academy, and posts', async () => {
    const sent = [await push(URLS.collection, ANY), await push(URLS.pricing, at(ANY, 1)), await push(URLS.home, at(ANY, 5))];
    await liTicks();
    sameKeys(await keysOf(PAGE), sent.map(pk));
    sameKeys(await keysOf(PAGE_AC), sent.map(pk));
    expect((await liRows(PAGE)).every((r) => r.status === 'POSTED')).toBe(true);
    expect((await liRows(PAGE_AC)).every((r) => r.status === 'POSTED')).toBe(true);
    expect(calls).toHaveLength(6);
    expect(calls.filter((r) => r.orgUrn === ORG)).toHaveLength(3);
    expect(calls.filter((r) => r.orgUrn === ORG_AC)).toHaveLength(3);
    expect(logs.filter((l) => l.includes('posted') && l.includes('kind=page'))).toHaveLength(6);
  });

  it('3. the same pushes sent one second before the time make no row, however old — through the worker', async () => {
    await push(URLS.collection, SECOND_BEFORE);
    await push(URLS.pricing, SECOND_BEFORE);
    await push(URLS.home, SECOND_BEFORE);
    await push(URLS.collection, at(PUSHES, 30)); // old: after every page's own time, long before the setting
    await push(URLS.pricing, at(PUSHES, 1));
    await push(URLS.home, new Date(FROM.getTime() + 1000));
    await push(URLS.collection, at(FROM, -3 * 24 * 60)); // before the pages' go-live: not even read
    await liTicks();
    expect(await liRows(PAGE)).toHaveLength(0);
    expect(await liRows(PAGE_AC)).toHaveLength(0);
    expect(calls).toHaveLength(0);
    // and the same second after does post: the boundary is exactly the setting
    await push(URLS.collection, ANY);
    await liTicks();
    expect(calls).toHaveLength(2);
  });

  it('4. a page that has not switched on its all-pushes rule gets no row for these pushes', async () => {
    const c = await push(URLS.collection, ANY);
    await liTicks(liDeps({ allPushesFrom: { [PAGE]: PUSHES, [PAGE_AC]: null } }));
    sameKeys(await keysOf(PAGE), [pk(c)]);
    expect(await liRows(PAGE_AC)).toHaveLength(0);
    // switched on, but LATER than the push: it did not follow the rule at that send time
    await prisma.linkedInPost.deleteMany({ where: { page: PAGE } });
    calls = [];
    await liTicks(liDeps({ allPushesFrom: { [PAGE]: at(ANY, 30), [PAGE_AC]: at(ANY, 30) } }));
    expect(await liRows(PAGE)).toHaveLength(0);
    expect(await liRows(PAGE_AC)).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('5. a link off ALLOWED_PUSH_HOSTS and a test-segment-only push make no row, with the setting on', async () => {
    await push('https://evil.example.com/collections/all', ANY);
    await push('https://www.taxscan.in.evil.example.com/pricing', ANY);
    await push(URLS.collection, ANY, { target: { type: 'topics', topics: [env.testSegmentTopic] } });
    await liTicks();
    expect(await liRows(PAGE)).toHaveLength(0);
    expect(await liRows(PAGE_AC)).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('6. the link carries ONE set of this page\'s UTMs: the push\'s own are gone, other parameters stay, utm_content is right', async () => {
    for (const k of KINDS) await push(withOwn(URLS[k]), ANY, { title: `Page ${k}` });
    await liTicks(liDeps(ONE));
    expect(calls).toHaveLength(3);
    for (const r of calls) {
      const q = params(r.link);
      const kind = KINDS.find((k) => r.commentary.includes(`Page ${k}`))!;
      for (const n of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content']) expect(q.getAll(n)).toHaveLength(1);
      expect(q.get('utm_source')).toContain('linkedin');
      expect(q.get('utm_source')).not.toBe('push');
      expect(q.get('utm_medium')).toBe('social');
      expect(q.get('utm_campaign')).not.toBe('morning');
      expect(q.get('utm_content')).toBe(CONTENT[kind]);
      expect(q.get('ref')).toBe('keep');
      expect(new URL(r.link).origin + new URL(r.link).pathname).toBe(new URL(URLS[kind]).origin + new URL(URLS[kind]).pathname);
    }
  });

  it('the post is the push\'s own wording and the page\'s card: commentary, card title, description, picture; fetched on the page without its query, https', async () => {
    await push(withOwn(URLS.collection), ANY, { title: 'Shop now', body: 'Every ebook is on offer.' });
    await liTicks(liDeps(ONE));
    expect(pageCalls).toEqual(['https://shop.taxscan.in/collections/all']);
    expect(calls).toHaveLength(1);
    const r = calls[0];
    expect(r.commentary.split('\n')[0]).toBe('Shop now');
    expect(r.commentary).toContain('Every ebook is on offer.');
    expect(r.title).toBe('Card title | Taxscan');
    expect(r.description).toBe('Card description from the page.');
    expect(r.thumbnail).toBe('urn:li:image:C9ZZ');
    expect(imageCalls).toEqual(['https://shop.taxscan.in/cdn/card.jpg']);
    expect(logs.some((l) => /posted.*image=ok.*kind=page/.test(l))).toBe(true);
  });

  it('7. a resend of the same campaign makes a new row; two overlapping ticks post one', async () => {
    const c = await push(URLS.pricing, ANY);
    await Promise.all([runLinkedInTick(liDeps(ONE)), runLinkedInTick(liDeps(ONE))]);
    expect(calls).toHaveLength(1);
    expect(await liRows(PAGE)).toHaveLength(1);
    const again = await prisma.campaign.update({ where: { id: c.id }, data: { lastSentAt: at(ANY, 30) } });
    await liTicks(liDeps(ONE));
    expect(calls).toHaveLength(2);
    sameKeys(await keysOf(PAGE), [pk(c), pk(again)]);
    await liTicks(liDeps(ONE));
    expect(calls).toHaveLength(2); // and nothing more
  });

  it.each([
    ['page_timeout', { ok: false, reason: 'page_timeout' } as StorePageResult],
    ['page_redirect', { ok: false, reason: 'page_redirect' } as StorePageResult],
    ['page_http_404', { ok: false, reason: 'page_http_404' } as StorePageResult],
    ['page_network', { ok: false, reason: 'page_network' } as StorePageResult],
  ])('8. a failed page fetch (%s) still posts: the push\'s wording, no picture', async (reason, answer) => {
    pageScript = () => answer;
    await push(URLS.collection, ANY, { title: 'Shop now', body: 'Every ebook is on offer.' });
    await liTicks(liDeps(ONE));
    expect(calls).toHaveLength(1);
    expect(calls[0].commentary.split('\n')[0]).toBe('Shop now');
    expect(calls[0].title).toBe('Shop now');
    expect(calls[0].thumbnail).toBeUndefined();
    expect(imageCalls).toHaveLength(0);
    expect(logs.join('\n')).toContain(`image=none:${reason}`);
    expect((await liRows(PAGE))[0].status).toBe('POSTED');
  });

  it('8. a fetch that THROWS posts too', async () => {
    pageScript = () => {
      throw new Error('boom');
    };
    await push(URLS.home, ANY, { title: 'Welcome' });
    await liTicks(liDeps(ONE));
    expect(calls).toHaveLength(1);
    expect(calls[0].thumbnail).toBeUndefined();
    expect(logs.join('\n')).toContain('image=none:page_network');
  });

  it('8. through the REAL fetch guard: a redirect, a slow page and an unreadable one still post with no picture; no URL, body or header is logged', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const redirecting = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      throw new TypeError('fetch failed', { cause: { message: 'unexpected redirect' } });
    }) as unknown as typeof fetch;
    const slow = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }) as unknown as typeof fetch;
    for (const [f, reason] of [
      [redirecting, 'page_redirect'],
      [slow, 'page_timeout'],
    ] as const) {
      calls = [];
      logs.length = 0;
      await prisma.linkedInPost.deleteMany({ where: { page: PAGE } });
      await prisma.campaign.deleteMany({ where: { portal: PORTAL } });
      await push(withOwn(URLS.collection), ANY, { title: 'Shop now' });
      await liTicks(liDeps({ ...ONE, fetchStorePage: (u) => fetchStorePage(u, f) }));
      expect(calls).toHaveLength(1);
      expect(calls[0].thumbnail).toBeUndefined();
      expect(logs.join('\n')).toContain(`image=none:${reason}`);
      expect(logs.join('\n')).not.toContain('shop.taxscan.in/collections');
      expect(logs.join('\n')).not.toContain('ref=keep');
    }
    expect(seen.map((s) => s.url)).toEqual(['https://shop.taxscan.in/collections/all', 'https://shop.taxscan.in/collections/all']);
    for (const s of seen) expect(s.init.redirect).toBe('error');
  });

  it('11. removing the setting reposts nothing, and rows already made keep their status', async () => {
    // No card picture (the page fetch fails): LinkedIn repeats a rejected post WITH a picture once without it, so a plain 422 would end up POSTED.
    pageScript = () => ({ ok: false, reason: 'page_network' });
    script = (_r, n) => (n === 1 ? failed422 : posted(`urn:li:share:${n}`));
    const failedOne = await push(URLS.collection, ANY, { title: 'First fails' });
    await push(URLS.pricing, at(ANY, 1), { title: 'Second posts' });
    await liTicks(liDeps(ONE));
    const before = (await liRows(PAGE)).map((r) => [r.articleKey, r.status]);
    expect(before).toHaveLength(2);
    expect(before.find(([k]) => k === pk(failedOne))![1]).toBe('FAILED');
    expect(before.filter(([, s]) => s === 'POSTED')).toHaveLength(1);
    const callsBefore = calls.length;
    anyLink(null);
    await push(URLS.home, at(ANY, 10)); // a NEW page push with the setting gone: no row either
    await liTicks(liDeps(ONE));
    expect(calls).toHaveLength(callsBefore);
    expect((await liRows(PAGE)).map((r) => [r.articleKey, r.status])).toEqual(before);
  });

  it('a retry of an existing page row keeps working after the setting is removed (the LINK decides the builder, never the time)', async () => {
    pageScript = () => ({ ok: false, reason: 'page_network' }); // no picture, so the 422 stays FAILED (see the test above)
    script = (_r, n) => (n === 1 ? failed422 : posted(`urn:li:share:${n}`));
    await push(URLS.collection, ANY, { title: 'Retry me' });
    await liTicks(liDeps(ONE));
    const row = (await liRows(PAGE))[0];
    expect(row.status).toBe('FAILED');
    anyLink(null);
    const r = await liRetry(row.id, liDeps(ONE));
    expect(r).toMatchObject({ ok: true, status: 'POSTED' });
    expect(calls).toHaveLength(2);
    expect(calls[1].commentary.split('\n')[0]).toBe('Retry me');
  });
});

/* ================================================================== */
/* Facebook worker                                                     */
/* ================================================================== */

describe('Facebook worker', () => {
  it('1. setting unset: the three pages make no row; an article, a course and a product behave as today', async () => {
    anyLink(null);
    await push(URLS.collection, ANY);
    await push(URLS.pricing, ANY);
    await push(URLS.home, ANY);
    const a = await push(articleUrl('a'), at(ANY, 1));
    const c = await push(courseUrl('c'), at(ANY, 2));
    const p = await push(productUrl('p'), at(ANY, 3));
    await fbTicks(6);
    sameKeys((await fbRows()).map((r) => r.articleKey), [pk(a), pk(c), pk(p)]);
    expect(fbCalls).toHaveLength(3);
    expect(logs.join('\n')).not.toContain('kind=page');
  });

  it('2. set: each of the three, sent at or after the time, makes one row on Facebook and posts', async () => {
    const sent = [await push(URLS.collection, ANY), await push(URLS.pricing, at(ANY, 1)), await push(URLS.home, at(ANY, 5))];
    await fbTicks(6);
    sameKeys((await fbRows()).map((r) => r.articleKey), sent.map(pk));
    expect((await fbRows()).every((r) => r.status === 'POSTED')).toBe(true);
    expect(fbCalls).toHaveLength(3);
    expect(logs.filter((l) => l.includes('posted') && l.includes('kind=page'))).toHaveLength(3);
  });

  it('3. one second before the time: no row, however old — through the worker', async () => {
    await push(URLS.collection, SECOND_BEFORE);
    await push(URLS.pricing, SECOND_BEFORE);
    await push(URLS.home, at(PUSHES, 5));
    await fbTicks(6);
    expect(await fbRows()).toHaveLength(0);
    expect(fbCalls).toHaveLength(0);
    await push(URLS.pricing, ANY);
    await fbTicks(3);
    expect(fbCalls).toHaveLength(1);
  });

  it('4. Facebook has not switched on its all-pushes rule, or switched on after the push: no row', async () => {
    await push(URLS.collection, ANY);
    await fbTicks(3, { allPushesFrom: null });
    expect(await fbRows()).toHaveLength(0);
    await fbTicks(3, { allPushesFrom: at(ANY, 30) });
    expect(await fbRows()).toHaveLength(0);
    expect(fbCalls).toHaveLength(0);
  });

  it('5. off the allowlist and test-segment-only: no row, with the setting on', async () => {
    await push('https://evil.example.com/collections/all', ANY);
    await push(URLS.collection, ANY, { target: { type: 'topics', topics: [env.testSegmentTopic] } });
    await fbTicks(4);
    expect(await fbRows()).toHaveLength(0);
    expect(fbCalls).toHaveLength(0);
  });

  it('6. one set of the page\'s UTMs; the push\'s own gone; other parameters stay; utm_content right; the message is the push\'s own wording', async () => {
    for (const k of KINDS) await push(withOwn(URLS[k]), at(ANY, KINDS.indexOf(k)), { title: `Page ${k}`, body: 'Every ebook is on offer.' });
    await fbTicks(6);
    expect(fbCalls).toHaveLength(3);
    for (const r of fbCalls) {
      const kind = KINDS.find((k) => r.message.startsWith(`Page ${k}`))!;
      const q = params(r.link);
      for (const n of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content']) expect(q.getAll(n)).toHaveLength(1);
      expect(q.get('utm_source')).toContain('facebook');
      expect(q.get('utm_medium')).toBe('social');
      expect(q.get('utm_content')).toBe(CONTENT[kind]);
      expect(q.get('utm_campaign')).not.toBe('morning');
      expect(q.get('ref')).toBe('keep');
      expect(r.message).toBe(`Page ${kind}\n\nEvery ebook is on offer.\n\n#taxscan`);
    }
  });

  it('7. a resend of the same campaign makes a new row; two overlapping ticks post one', async () => {
    const c = await push(URLS.collection, ANY);
    await Promise.all([runFacebookTick(fbDeps()), runFacebookTick(fbDeps())]);
    expect(fbCalls).toHaveLength(1);
    const again = await prisma.campaign.update({ where: { id: c.id }, data: { lastSentAt: at(ANY, 30) } });
    await fbTicks(3);
    expect(fbCalls).toHaveLength(2);
    sameKeys((await fbRows()).map((r) => r.articleKey), [pk(c), pk(again)]);
  });

  it('8. Facebook builds the card itself: the page post needs no page fetch, so there is nothing to fail', () => {
    const p = buildFacebookPagePost({ title: 'Shop now', url: URLS.collection, body: 'b' }, FB_PAGE);
    expect(p).not.toBeNull();
    expect(typeof (p as unknown as { then?: unknown }).then).toBe('undefined'); // synchronous, no network
  });

  it('11. removing the setting reposts nothing; rows keep their status', async () => {
    const c = await push(URLS.collection, ANY);
    await fbTicks(3);
    const before = (await fbRows()).map((r) => [r.articleKey, r.status]);
    expect(before).toEqual([[pk(c), 'POSTED']]);
    anyLink(null);
    await push(URLS.pricing, at(ANY, 10));
    await fbTicks(4);
    expect(fbCalls).toHaveLength(1);
    expect((await fbRows()).map((r) => [r.articleKey, r.status])).toEqual(before);
  });
});

/* ================================================================== */
/* WhatsApp: the queue, its post text, Copy / Posted / Skip            */
/* ================================================================== */

describe('WhatsApp queue and marks', () => {
  const queue = (from: Date | null = PUSHES) => getQueue(PORTAL, DAY, { allPushesFrom: from });

  it('1. setting unset: the three pages are not listed; an article, a course and a product are', async () => {
    anyLink(null);
    await push(URLS.collection, ANY);
    await push(URLS.pricing, ANY);
    await push(URLS.home, ANY);
    await push(articleUrl('a'), at(ANY, 1));
    await push(courseUrl('c'), at(ANY, 2));
    await push(productUrl('p'), at(ANY, 3));
    const q = await queue();
    expect(q.rows.map((r) => r.kind).sort()).toEqual(['article', 'course', 'product']);
  });

  it('2. set: each of the three is a row of its own, labelled `page`, in push order, with the post text ready to copy', async () => {
    const a = await push(URLS.collection, ANY, { title: 'Shop now', body: 'Every ebook is on offer.' });
    const b = await push(URLS.pricing, at(ANY, 1), { title: 'Pricing', body: 'Plans from ₹499.' });
    const c = await push(URLS.home, at(ANY, 5), { title: 'Welcome', body: 'Taxscan home.' });
    const q = await queue();
    expect(q.rows.map((r) => [r.campaignId, r.kind, r.rule, r.status])).toEqual([
      [a.id, 'page', 'push', 'TODO'],
      [b.id, 'page', 'push', 'TODO'],
      [c.id, 'page', 'push', 'TODO'],
    ]);
    expect(q.rows.map((r) => r.articleKey)).toEqual([pk(a), pk(b), pk(c)]);
    for (const [r, content] of [
      [q.rows[0], 'collections-all'],
      [q.rows[1], 'pricing'],
      [q.rows[2], 'home'],
    ] as const) {
      const [head, line, link] = r.text.split('\n\n');
      expect(head).toBe(`*${r.headline}*`);
      expect(line).toBeTruthy();
      const qs = params(link);
      expect(qs.getAll('utm_source')).toEqual(['taxscan-whatsapp']);
      expect(qs.get('utm_medium')).toBe('social');
      expect(qs.get('utm_content')).toBe(content);
      expect(r.text).toBe(buildPushPostText({ id: r.campaignId, title: r.headline, body: r.text.split('\n\n')[1], url: new URL(link).origin + new URL(link).pathname })); // Copy = the same text
    }
  });

  it('3. one second before the time: not listed, however old', async () => {
    await push(URLS.collection, SECOND_BEFORE);
    await push(URLS.pricing, SECOND_BEFORE);
    await push(URLS.home, at(PUSHES, 5));
    expect((await queue()).rows).toHaveLength(0);
    const ok = await push(URLS.home, ANY);
    expect((await queue()).rows.map((r) => r.campaignId)).toEqual([ok.id]);
  });

  it('4. WhatsApp has not switched on its all-pushes rule, or switched on after the push: not listed', async () => {
    await push(URLS.collection, ANY);
    expect((await queue(null)).rows).toHaveLength(0);
    expect((await queue(at(ANY, 30))).rows).toHaveLength(0);
  });

  it('5. off the allowlist and test-segment-only: not listed, with the setting on', async () => {
    await push('https://evil.example.com/collections/all', ANY);
    await push(URLS.collection, ANY, { target: { type: 'topics', topics: [env.testSegmentTopic] } });
    expect((await queue()).rows).toHaveLength(0);
  });

  it('6. the link in the post carries one set of WhatsApp UTMs; the push\'s own are gone; other parameters stay', async () => {
    for (const k of KINDS) await push(withOwn(URLS[k]), at(ANY, KINDS.indexOf(k)), { title: `Page ${k}` });
    const q = await queue();
    expect(q.rows).toHaveLength(3);
    for (const r of q.rows) {
      const link = r.text.split('\n\n').pop()!;
      const kind = KINDS.find((k) => r.headline === `Page ${k}`)!;
      const qs = params(link);
      for (const n of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content']) expect(qs.getAll(n)).toHaveLength(1);
      expect(qs.get('utm_source')).toBe('taxscan-whatsapp');
      expect(qs.get('utm_content')).toBe(CONTENT[kind]);
      expect(qs.get('utm_campaign')).not.toBe('morning');
      expect(qs.get('ref')).toBe('keep');
    }
  });

  it('7. a resend of the same campaign is another row', async () => {
    const c = await push(URLS.pricing, ANY);
    expect((await queue()).rows).toHaveLength(1);
    await prisma.campaign.update({ where: { id: c.id }, data: { lastSentAt: at(ANY, 30) } });
    const q = await queue();
    expect(q.rows.map((r) => r.articleKey)).toEqual([pk({ id: c.id, lastSentAt: at(ANY, 30) })]); // the campaign row's send time moved: one push, its new key
  });

  it('10. Posted, Skip and undo work on a page row (the mark is stored under the push\'s own key); a push before the time is not_found', async () => {
    const c = await push(URLS.collection, ANY);
    const before = await push(URLS.pricing, SECOND_BEFORE);
    const key = pk(c);
    const o = { allPushesFrom: PUSHES, key };
    expect(await markArticle(PORTAL, c.id, 'POSTED', null, NOW, o)).toEqual({ ok: true, status: 'POSTED' });
    expect((await queue()).rows[0]).toMatchObject({ articleKey: key, status: 'POSTED' });
    expect(await markArticle(PORTAL, c.id, 'SKIPPED', null, NOW, o)).toEqual({ ok: true, status: 'SKIPPED' });
    expect((await queue()).rows[0].status).toBe('SKIPPED');
    expect(await markArticle(PORTAL, c.id, 'TODO', null, NOW, o)).toEqual({ ok: true, status: 'TODO' });
    expect((await queue()).rows[0].status).toBe('TODO');
    expect(await markArticle(PORTAL, before.id, 'POSTED', null, NOW, { allPushesFrom: PUSHES })).toEqual({ ok: false, reason: 'not_found' });
    anyLink(null);
    expect(await markArticle(PORTAL, c.id, 'POSTED', null, NOW, { allPushesFrom: PUSHES })).toEqual({ ok: false, reason: 'not_found' }); // setting gone: a page is not markable
  });

  it('11. removing the setting lists nothing new, and a mark already made keeps its status', async () => {
    const c = await push(URLS.collection, ANY);
    await markArticle(PORTAL, c.id, 'POSTED', null, NOW, { allPushesFrom: PUSHES, key: pk(c) });
    anyLink(null);
    await push(URLS.pricing, at(ANY, 10));
    expect((await queue()).rows).toHaveLength(0);
    const rows = await prisma.whatsAppPost.findMany({ where: { portal: PORTAL } });
    expect(rows.map((r) => [r.articleKey, r.status])).toEqual([[pk(c), 'POSTED']]);
  });
});

/* ================================================================== */
/* The two screens (LinkedIn, Facebook)                                */
/* ================================================================== */

describe('the screens: a page push is a row, and only from the time', () => {
  type Row = { campaignId: string; status: string; headline: string };
  const liApp = () =>
    createApp({
      rateLimit: { publicPerMin: 10000, loginPerMin: 10000 },
      linkedin: {
        enabled: () => true,
        clock: () => NOW,
        portals: () => ({ [PORTAL]: [PAGE, PAGE_AC] }),
        postFrom: () => ({ [PAGE]: FROM, [PAGE_AC]: FROM_AC }),
        allPushesFrom: (() => ({ [PAGE]: PUSHES, [PAGE_AC]: PUSHES })) as never,
        worker: liDeps(),
      },
    });
  const fbApp = () =>
    createApp({
      rateLimit: { publicPerMin: 10000, loginPerMin: 10000 },
      facebook: { enabled: () => true, clock: () => NOW, portals: () => ({ [PORTAL]: FB_PAGE }), postFrom: () => FROM, allPushesFrom: () => PUSHES, worker: fbDeps() },
    });

  it('LinkedIn screen (both pages): the three pages from the time are WAITING rows, then POSTED; one second before: no row', async () => {
    const sent = [await push(URLS.collection, ANY), await push(URLS.pricing, at(ANY, 1)), await push(URLS.home, at(ANY, 2))];
    await push(URLS.home, SECOND_BEFORE);
    for (const page of [PAGE, PAGE_AC]) {
      const body = (await request(liApp()).get(`/api/linkedin/posts?date=${DAY}&page=${page}`).set(BEARER)).body;
      expect((body.rows as Row[]).map((r) => [r.campaignId, r.status])).toEqual(sent.map((c) => [c.id, 'WAITING']));
    }
    await liTicks();
    const after = (await request(liApp()).get(`/api/linkedin/posts?date=${DAY}&page=${PAGE}`).set(BEARER)).body;
    expect((after.rows as Row[]).map((r) => [r.campaignId, r.status])).toEqual(sent.map((c) => [c.id, 'POSTED']));
    anyLink(null);
    const gone = (await request(liApp()).get(`/api/linkedin/posts?date=${DAY}&page=${PAGE}`).set(BEARER)).body;
    expect(gone.rows).toHaveLength(0);
    expect(await liRows(PAGE)).toHaveLength(3); // the rows themselves are untouched
  });

  it('Facebook screen: the same', async () => {
    const sent = [await push(URLS.collection, ANY), await push(URLS.pricing, at(ANY, 1))];
    await push(URLS.pricing, SECOND_BEFORE);
    const body = (await request(fbApp()).get(`/api/facebook/posts?date=${DAY}`).set(BEARER)).body;
    expect((body.rows as Row[]).map((r) => [r.campaignId, r.status])).toEqual(sent.map((c) => [c.id, 'WAITING']));
    await fbTicks(4);
    const after = (await request(fbApp()).get(`/api/facebook/posts?date=${DAY}`).set(BEARER)).body;
    expect((after.rows as Row[]).map((r) => [r.campaignId, r.status])).toEqual(sent.map((c) => [c.id, 'POSTED']));
    anyLink(null);
    expect((await request(fbApp()).get(`/api/facebook/posts?date=${DAY}`).set(BEARER)).body.rows).toHaveLength(0);
  });
});

/* ================================================================== */
/* Campaigns: the Channels marks (channelsFor)                         */
/* ================================================================== */

describe('Campaigns Channels marks: a page push reads as waiting or posted, never blank, and only from the time', () => {
  const CH_RUN = `${RUN}-ch`;
  const portal = env.rss.portal;
  const keys: string[] = [];
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);
  let ANY_NOW = hoursAgo(5);
  const mark = async (name: string, url: string, lastSentAt: Date) => {
    const c = await prisma.campaign.create({ data: { portal, title: `Chan ${name}`, body: 'b', url, target: { type: 'all' } as Prisma.InputJsonValue, status: 'SENT', lastSentAt } });
    return c;
  };
  const marksOf = async (id: string) => {
    const r = (await listCampaigns(600)).find((x) => x.id === id)!;
    return { channels: r.channels, details: r.channelDetails };
  };
  const page = (kind: keyof typeof URLS) => `${URLS[kind]}?run=${CH_RUN}`; // a run-unique query; the path (and so utm_content) is unchanged

  beforeEach(() => {
    ANY_NOW = hoursAgo(5);
    anyLink(ANY_NOW);
    env.linkedin.enabled = true;
    env.linkedin.postFrom = hoursAgo(12);
    env.linkedin.allPushesFrom = { taxscan: hoursAgo(10), academy: null };
    env.facebook.enabled = true;
    env.facebook.postFrom = hoursAgo(12);
    env.facebook.allPushesFrom = hoursAgo(10);
    env.whatsapp.queueEnabled = true;
    env.whatsapp.allPushesFrom = hoursAgo(10);
  });
  afterEach(async () => {
    await prisma.linkedInPost.deleteMany({ where: { articleKey: { in: keys } } });
    await prisma.facebookPost.deleteMany({ where: { articleKey: { in: keys } } });
    await prisma.whatsAppPost.deleteMany({ where: { portal, articleKey: { in: keys } } });
    await prisma.campaign.deleteMany({ where: { url: { contains: CH_RUN } } });
    keys.length = 0;
  });

  it('a page push at or after the time: every channel reads WAITING (TODO on WhatsApp), for all three pages; a recorded row shows its own status', async () => {
    const made: Record<string, { id: string; lastSentAt: Date | null }> = {};
    for (const k of KINDS) made[k] = await mark(k, page(k), new Date(ANY_NOW.getTime() + 60_000 * (KINDS.indexOf(k) + 1)));
    for (const k of KINDS) expect((await marksOf(made[k].id)).channels).toEqual({ whatsapp: 'TODO', linkedin: 'PENDING', facebook: 'PENDING' });
    // rows recorded under the push's own key show THEIR status
    const c = made.collection;
    keys.push(pk(c));
    await prisma.linkedInPost.create({ data: { page: 'taxscan', articleKey: pk(c), campaignId: c.id, status: 'POSTED', attempts: 1, linkedinPostId: 'urn:li:share:77', postedAt: new Date() } });
    await prisma.facebookPost.create({ data: { page: 'taxscan', articleKey: pk(c), campaignId: c.id, status: 'FAILED', attempts: 1, error: 'HTTP 400' } });
    await prisma.whatsAppPost.create({ data: { portal, articleKey: pk(c), campaignId: c.id, status: 'POSTED', actedByUserId: null, actedAt: new Date() } });
    const m = await marksOf(c.id);
    expect(m.channels).toEqual({ whatsapp: 'POSTED', linkedin: 'POSTED', facebook: 'FAILED' });
    expect(m.details?.linkedin?.postUrl).toContain('urn%3Ali%3Ashare%3A77');
    expect(m.details?.facebook?.error).toBe('HTTP 400');
  });

  it('3. ONE SECOND before the time (and any older push): no mark on any channel', async () => {
    const justBefore = await mark('just-before', page('collection'), new Date(ANY_NOW.getTime() - 1000));
    const older = await mark('older', page('pricing'), hoursAgo(8));
    for (const c of [justBefore, older]) expect((await marksOf(c.id)).channels).toEqual({ whatsapp: null, linkedin: null, facebook: null });
    const exactly = await mark('exactly', page('home'), ANY_NOW);
    expect((await marksOf(exactly.id)).channels).toEqual({ whatsapp: 'TODO', linkedin: 'PENDING', facebook: 'PENDING' });
  });

  it('1. setting unset: no mark for a page push; an article still has its mark', async () => {
    anyLink(null);
    const p = await mark('unset', page('pricing'), hoursAgo(2));
    const a = await mark('art', `https://www.taxscan.in/gst/chan-art-${CH_RUN}`, hoursAgo(2));
    expect((await marksOf(p.id)).channels).toEqual({ whatsapp: null, linkedin: null, facebook: null });
    expect((await marksOf(a.id)).channels).toMatchObject({ linkedin: 'PENDING', facebook: 'PENDING' });
  });

  it('4. a channel that has not switched on its all-pushes rule shows no mark for the push', async () => {
    env.linkedin.allPushesFrom = { taxscan: null, academy: null };
    env.facebook.allPushesFrom = null;
    env.whatsapp.allPushesFrom = null;
    const p = await mark('off', page('collection'), hoursAgo(2));
    expect((await marksOf(p.id)).channels).toEqual({ whatsapp: null, linkedin: null, facebook: null });
  });

  it('5. test-segment-only and off-allowlist pushes have no mark', async () => {
    const t = await prisma.campaign.create({ data: { portal, title: 'Chan t', body: 'b', url: page('collection'), target: { type: 'topics', topics: [env.testSegmentTopic] } as Prisma.InputJsonValue, status: 'SENT', lastSentAt: hoursAgo(2) } });
    const e = await mark('evil', `https://evil.example.com/collections/all?run=${CH_RUN}`, hoursAgo(2));
    for (const c of [t, e]) expect((await marksOf(c.id)).channels).toEqual({ whatsapp: null, linkedin: null, facebook: null });
  });

  it('11. removing the setting: the marks disappear but the rows keep their status', async () => {
    const c = await mark('rm', page('collection'), hoursAgo(2));
    keys.push(pk(c));
    await prisma.linkedInPost.create({ data: { page: 'taxscan', articleKey: pk(c), campaignId: c.id, status: 'POSTED', attempts: 1, linkedinPostId: 'urn:li:share:78', postedAt: new Date() } });
    expect((await marksOf(c.id)).channels?.linkedin).toBe('POSTED');
    anyLink(null);
    expect((await marksOf(c.id)).channels).toEqual({ whatsapp: null, linkedin: null, facebook: null });
    expect((await prisma.linkedInPost.findMany({ where: { articleKey: pk(c) } })).map((r) => r.status)).toEqual(['POSTED']);
  });
});

/* ================================================================== */
/* The page fetch (the card)                                           */
/* ================================================================== */

describe('8. fetchStorePage for an other page: https only, a named host, no redirects, 5 s, capped read', () => {
  const html = '<html><head><meta property="og:title" content="Collection"><meta property="og:image" content="https://shop.taxscan.in/c.jpg"></head><body></body></html>';
  const okFetch = (seen: { url: string; init: RequestInit }[]) =>
    (async (url: string, init: RequestInit) => (seen.push({ url, init }), new Response(html, { status: 200 }))) as unknown as typeof fetch;

  it('fetches an allowed https page with redirect "error", a signal and no credentials', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const r = await fetchStorePage('https://shop.taxscan.in/collections/all', okFetch(seen));
    expect(r).toMatchObject({ ok: true, tags: { title: 'Collection', imageUrl: 'https://shop.taxscan.in/c.jpg' } });
    expect(seen).toHaveLength(1);
    expect(seen[0].init.redirect).toBe('error');
    expect(seen[0].init.signal).toBeDefined();
    expect(JSON.stringify(seen[0].init.headers)).not.toMatch(/cookie|authorization/i);
    const root = await fetchStorePage('https://www.taxscan.in/', okFetch([]));
    expect(root.ok).toBe(true);
  });

  it.each([
    ['plain http', 'http://shop.taxscan.in/collections/all'],
    ['an article', 'https://www.taxscan.in/gst/an-article-slug'],
    ['an unlisted host', 'https://evil.example.com/collections/all'],
    ['a lookalike host', 'https://shop.taxscan.in.evil.example.com/collections/all'],
    ['userinfo', 'https://user:pw@shop.taxscan.in/collections/all'],
    ['a port', 'https://shop.taxscan.in:8443/collections/all'],
  ])('refuses %s without making a request', async (_n, url) => {
    const seen: { url: string; init: RequestInit }[] = [];
    expect(await fetchStorePage(url, okFetch(seen))).toEqual({ ok: false, reason: 'page_host' });
    expect(seen).toHaveLength(0);
  });

  it('with the allowlist emptied the fetch is refused for an other page too', async () => {
    env.allowedPushHosts = [];
    const seen: { url: string; init: RequestInit }[] = [];
    expect(await fetchStorePage('https://evil.example.com/collections/all', okFetch(seen))).toEqual({ ok: false, reason: 'page_host' });
    expect(seen).toHaveLength(0);
  });

  it('a 301, a redirect error, a 404 and a timeout each come back as a fixed word', async () => {
    const answer = (res: () => Promise<Response>) => (async () => res()) as unknown as typeof fetch;
    expect(await fetchStorePage('https://shop.taxscan.in/collections/all', answer(async () => new Response('', { status: 301 })))).toEqual({ ok: false, reason: 'page_redirect' });
    expect(await fetchStorePage('https://shop.taxscan.in/collections/all', answer(async () => new Response('', { status: 404 })))).toEqual({ ok: false, reason: 'page_http_404' });
    expect(
      await fetchStorePage(
        'https://shop.taxscan.in/collections/all',
        answer(async () => {
          throw new TypeError('fetch failed', { cause: { message: 'unexpected redirect' } });
        }),
      ),
    ).toEqual({ ok: false, reason: 'page_redirect' });
    expect(
      await fetchStorePage(
        'https://shop.taxscan.in/collections/all',
        answer(async () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          throw e;
        }),
      ),
    ).toEqual({ ok: false, reason: 'page_timeout' });
  });

  it('buildPagePost: the final link must stay on the allowlist, and an article or a course is not a page post', async () => {
    const ok = await buildPagePost({ id: 'x', title: 'Shop now', url: 'https://shop.taxscan.in/collections/all', body: 'b' }, 'taxscan', async () => ({ ok: true, tags: CARD }));
    expect(ok).not.toBeNull();
    expect(await buildPagePost({ id: 'x', title: 't', url: 'https://www.taxscan.in/gst/an-article', body: '' }, 'taxscan', async () => ({ ok: true, tags: CARD }))).toBeNull();
    expect(await buildPagePost({ id: 'x', title: 't', url: courseUrl('c'), body: '' }, 'taxscan', async () => ({ ok: true, tags: CARD }))).toBeNull();
    expect(await buildPagePost({ id: 'x', title: 't', url: 'https://evil.example.com/collections/all', body: '' }, 'taxscan', async () => ({ ok: true, tags: CARD }))).toBeNull();
  });
});

/* ================================================================== */
/* 9. Unchanged kinds: byte-identical to develop                        */
/* ================================================================== */

describe('9. an unchanged article, course and product post is byte-identical to today\'s, on every channel', () => {
  // Captured from origin/develop (before this change) with the same fixtures; see the REPORT.
  const golden = JSON.parse(readFileSync(path.join(__dirname, 'socialEveryLink.golden.json'), 'utf8')) as Record<string, unknown>;
  const course = { id: 'c1', title: '🚨COURSE STARTS TOMORROW 7 PM 🚨', body: '- GST for hotels\n- Live session (1 hour)\n#taxscan @taxscan  Seats   filling fast.', url: 'https://academy.taxscan.in/course/navigating-gst?utm_source=push&utm_medium=web&ref=keep#frag', authority: null, categories: [] as string[] };
  const product = { id: 'p1', title: "Draft Replies to GST Notices: Practitioner's Handbook", body: 'A handbook of issue-wise defences.\nModel formats included.', url: 'https://shop.taxscan.in/products/draft-replies-ebook?utm_campaign=x', authority: null, categories: [] as string[] };
  const article = { id: 'a1', title: 'Supreme Court holds GST refund time limit is directory', body: 'The Court held that the limitation is directory in nature.', url: 'https://www.taxscan.in/gst/some-article-slug-123456?utm_source=push', authority: 'Supreme Court', categories: ['GST'] };
  const tags: StorePageTags = { title: 'T & co | Taxscan', description: 'Card description.', imageUrl: 'https://academy.taxscan.in/x.jpg', imageReason: null };

  it('LinkedIn, Facebook and WhatsApp output equals the golden captured from develop, key by key', async () => {
    const fetched: string[] = [];
    const out: Record<string, unknown> = {
      liCourse: await buildStorePost(course, 'taxscan', async () => ({ ok: true, tags })),
      liCourseFail: await buildStorePost(course, 'taxscan', async () => ({ ok: false, reason: 'page_timeout' })),
      liProduct: await buildStorePost(product, 'academy', async () => ({ ok: true, tags })),
      liArticle: await buildPost(article, 'taxscan', async () => null),
      fbCourse: buildFacebookStorePost(course, 'taxscan'),
      fbProduct: buildFacebookStorePost(product, 'taxscan'),
      fbArticle: await buildFacebookPost(article, 'taxscan', async () => null),
      waArticle: buildPostText(article),
      waPushArticle: buildPushPostText(article),
      waPushCourse: buildPushPostText(course),
      waPushProduct: buildPushPostText(product),
    };
    await buildStorePost(course, 'taxscan', async (u) => (fetched.push(u), { ok: false, reason: 'page_network' }));
    out.liCourseFetchedUrl = fetched;
    const actual = JSON.parse(JSON.stringify(out)) as Record<string, unknown>;
    for (const key of Object.keys(golden)) expect(actual[key]).toEqual(golden[key]);
    expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
  });
});
