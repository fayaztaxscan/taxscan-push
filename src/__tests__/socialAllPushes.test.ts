import cron from 'node-cron';
import request from 'supertest';
import { randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { createApp } from '../app';
import { env, parseAllPushesFrom, parseIsoTime, ALL_PUSHES_FROM_VARS } from '../lib/env';
import { prisma } from '../lib/prisma';
import { listCampaigns } from '../services/metrics';
import { articleKey } from '../services/reports';
import { isPublicArticleCampaign } from '../services/social/publicCampaign';
import { isAllPushesCampaign, isPushKey, PUSH_KEY_PREFIX, pushKey, storeBodyLines, storeLinkOf } from '../services/social/allPushes';
import { fetchStorePage, parseStorePageTags, STORE_PAGE_READ_BYTES, STORE_PAGE_TIMEOUT_MS, type StorePageFetch, type StorePageResult, type StorePageTags } from '../services/social/storePage';
import { isDuplicateAnswer, isUnverifiedImage, postToLinkedIn, waitForImage, type LinkedInRequest, type LinkedInResult } from '../services/linkedin/client';
import { fetchCoverImage, IMAGE_HOSTS } from '../services/linkedin/image';
import { buildStoreCommentary, buildStorePost, CARD_TITLE_MAX, COMMENTARY_MAX, escapeLittleText } from '../services/linkedin/post';
import { PAGE_ACADEMY, PAGE_TAXSCAN, pageAllPushesFrom, resolveAllPushesFrom } from '../services/linkedin/pages';
import { resetTokenCache } from '../services/linkedin/token';
import { MAX_PER_TICK, DUPLICATE_ERROR as LI_DUPLICATE, authKey as liAuthKey, loginProblem as liLoginProblem, resetLinkedInStops, retryNow as liRetry, runLinkedInTick, startLinkedInWorker, type WorkerDeps as LiDeps } from '../services/linkedin/worker';
import { buildFacebookStorePost } from '../services/facebook/post';
import type { FacebookResult } from '../services/facebook/client';
import { DUPLICATE_ERROR as FB_DUPLICATE, authKey as fbAuthKey, loginProblem as fbLoginProblem, policyKey, policyProblem, resetFacebookStops, resumePolicy, retryNow as fbRetry, runFacebookTick, startFacebookWorker, type WorkerDeps as FbDeps } from '../services/facebook/worker';

/**
 * Brief 2026-11-04-academy-store-posts (the "every push posts" version), acceptance 1-14: from a time set per page, the Taxscan
 * LinkedIn page, the Taxscan Academy LinkedIn page and the Taxscan Facebook page post EVERY push (articles, academy courses, shop
 * products), one post per push, repeats included; a push before the time follows today's rule for good. ALL LinkedIn, Facebook, CMS,
 * page and picture calls are mocked; nothing is posted.
 *
 * ISOLATION: rows live in a shared dev DB, so these tests never read or write the REAL pages `taxscan` / `academy`. They use private
 * pages instead: `PAGE` plays the Taxscan LinkedIn page (it owns the token), `PAGE_AC` the Academy page (it shares PAGE's token and
 * has its own org URN and go-live times), `FB_PAGE` the Facebook page, all registered in `env` for the length of the file and reached
 * through an injected portal map. Only the Channels marks (hard-wired to `taxscan`) use the real page, with run-unique links whose
 * rows are removed after every test.
 */
const logs: string[] = [];
jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
jest.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
jest.spyOn(console, 'warn').mockImplementation(() => undefined);

const RUN = `${Date.now()}-${randomBytes(3).toString('hex')}`;
const PORTAL = `test-push-${RUN}`;
const PAGE = `listore${randomBytes(3).toString('hex')}`; // plays the Taxscan LinkedIn page: owns the token
const PAGE_AC = `${PAGE}-ac`; // plays the Academy page: shares PAGE's token
const FB_PAGE = `fbstore${randomBytes(3).toString('hex')}`;
const ORG = 'urn:li:organization:101';
const ORG_AC = 'urn:li:organization:91100022';
const TOKEN = `ALLPUSH-LI-TOKEN-${RUN}`;
const FB_PAGE_ID = '1234567890';
const FB_TOKEN = `ALLPUSH-FB-TOKEN-${RUN}-EAAB1234567890`;
const BEARER = { Authorization: `Bearer ${env.adminToken}` };

const IST_MS = (5 * 60 + 30) * 60_000;
const ist = (h: number, m = 0, day = 3) => new Date(Date.UTC(2026, 10, day, h, m) - IST_MS);
const MIN = 60_000;
const at = (base: Date, min: number) => new Date(base.getTime() + min * MIN);
const NOW = ist(10, 0); // 3 Nov 2026 10:00 IST
const FROM = ist(4, 0); // the Taxscan page's go-live for ARTICLES (LINKEDIN_POST_FROM / FACEBOOK_POST_FROM)
const FROM_AC = ist(7, 0); // the Academy page's go-live for articles
const PUSHES = ist(8, 0); // the Taxscan LinkedIn page's all-pushes time
const PUSHES_AC = ist(8, 30); // the Academy page's: half an hour later
const PUSHES_FB = ist(8, 0); // the Facebook page's

const posted = (id = 'urn:li:share:1'): LinkedInResult => ({ kind: 'posted', postId: id });
const auth403: LinkedInResult = { kind: 'auth', status: 403, error: 'HTTP 403' };
const retry429: LinkedInResult = { kind: 'retry', status: 429, error: 'HTTP 429' };
const failed422: LinkedInResult = { kind: 'failed', status: 422, error: 'HTTP 422: invalid content' };
const fbPosted = (id = '123_456'): FacebookResult => ({ kind: 'posted', postId: id });
const fbFail = (kind: 'rate' | 'transient' | 'auth' | 'policy' | 'duplicate' | 'failed', status: number | null, code: number | null, subcode: number | null = null): FacebookResult => ({
  kind,
  status,
  code,
  subcode,
  error: `HTTP ${status} code ${code}`,
});

/* ---------- what the pages say (copied from the real course / product pages, 4 Nov 2026) ---------- */

const COURSE_HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta property="og:url" content="https://academy.taxscan.in/course/navigating-gst-challenges-in-the-hospitality-industry/">
<meta property="og:site_name" content="Taxscan Academy">
<meta property="og:title" content="GST in Hospitality &amp; Hotels Course 2026 | Taxscan Academy">
<meta property="og:description" content="GST for hotels and hospitality: room tariffs, F&amp;B, alcohol service charge, PGs and co-living, pricing. 1-hour live session with Rahul Pansari, ₹499+GST.">
<meta property="og:image" content="https://academy.taxscan.in/wp-content/uploads/2026/11/hospitality-28561-share-1200x630-1.jpg">
<meta property="og:image:secure_url" content="https://academy.taxscan.in/wp-content/uploads/2026/11/hospitality-28561-share-1200x630-1.jpg">
<meta property="og:image:width" content="1200">
</head><body><h1>Course</h1></body></html>`;
const SHOP_HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta property="og:site_name" content="Shopscan">
<meta property="og:url" content="https://shop.taxscan.in/products/draft-replies-to-gst-notices-handbook-2026-ebook">
<meta property="og:title" content="Draft Replies to GST Notices: Practitioner&#39;s Handbook (Aug 2026)">
<meta property="og:type" content="product">
<meta property="og:description" content="A practitioner&#39;s handbook of issue-wise defences, procedural objections, evidence checklists, and model formats for GST notices (August 2026 Edition).">
<meta property="og:image" content="http://shop.taxscan.in/cdn/shop/files/DRAFTREPLIESTOGSTNOTICES-MOCKUP_jpg.jpg?v=1786536990">
<meta property="og:image:secure_url" content="https://shop.taxscan.in/cdn/shop/files/DRAFTREPLIESTOGSTNOTICES-MOCKUP_jpg.jpg?v=1786536990">
<meta property="og:image:width" content="600">
</head><body><h1>Product</h1></body></html>`;
const COURSE_IMG = 'https://academy.taxscan.in/wp-content/uploads/2026/11/hospitality-28561-share-1200x630-1.jpg';
const SHOP_IMG = 'https://shop.taxscan.in/cdn/shop/files/DRAFTREPLIESTOGSTNOTICES-MOCKUP_jpg.jpg?v=1786536990';
const COURSE_TAGS: StorePageTags = {
  title: 'GST in Hospitality & Hotels Course 2026 | Taxscan Academy',
  description: 'GST for hotels and hospitality: room tariffs, F&B, alcohol service charge, PGs and co-living, pricing. 1-hour live session with Rahul Pansari, ₹499+GST.',
  imageUrl: COURSE_IMG,
  imageReason: null,
};
const SHOP_TAGS: StorePageTags = {
  title: "Draft Replies to GST Notices: Practitioner's Handbook (Aug 2026)",
  description: "A practitioner's handbook of issue-wise defences, procedural objections, evidence checklists, and model formats for GST notices (August 2026 Edition).",
  imageUrl: SHOP_IMG,
  imageReason: null,
};
const pageOk = (url: string): StorePageResult => ({ ok: true, tags: new URL(url).hostname === 'academy.taxscan.in' ? COURSE_TAGS : SHOP_TAGS });

/** Real titles from production (brief Context) and a body with bullets, parentheses, # and @. */
const T_DETECTIVE = '🕵️‍♂️ Stop being "just an accountant." Become a Financial De…';
const T_TOMORROW = '🚨COURSE STARTS TOMORROW 7 PM 🚨';
const T_GSTAT = '❗GSTAT E-FILING CONFUSION? FEARING DEFECT NOTICES? 💻';
const T_MEGA = '🚨MEGA AUDIT OFFER – 50% OFF + EXTRA 10% OFF!  ! Training on …';
const TAG = '{hashtag|\\#|taxscan}';

/* ---------- mocks ---------- */

let calls: LinkedInRequest[] = [];
let script: (r: LinkedInRequest, n: number) => LinkedInResult | Promise<LinkedInResult> = (r) => posted(`urn:li:share:${r.orgUrn === ORG ? 'T' : 'A'}${calls.length}`);
const liPost: NonNullable<LiDeps['post']> = async (r) => {
  calls.push(r);
  return script(r, calls.length);
};
const only = (orgUrn: string, answer: LinkedInResult) => (r: LinkedInRequest): LinkedInResult => (r.orgUrn === orgUrn ? answer : posted(`urn:li:share:${r.orgUrn === ORG ? 'T' : 'A'}${calls.length}`));
let pageCalls: string[] = [];
let pageScript: (url: string) => StorePageResult | Promise<StorePageResult> = (url) => pageOk(url);
const pageFetch: StorePageFetch = async (url) => {
  pageCalls.push(url);
  return pageScript(url);
};
let imageCalls: string[] = [];
let uploads: { orgUrn: string; accessToken: string }[] = [];
const imageFetch: NonNullable<LiDeps['fetchImage']> = async (u) => (imageCalls.push(u), { ok: true, bytes: new Uint8Array([0xff, 0xd8, 1, 2]), contentType: 'image/jpeg' });
const imageUpload: NonNullable<LiDeps['uploadImage']> = async (r) => (uploads.push({ orgUrn: r.orgUrn, accessToken: r.accessToken }), { kind: 'ok', urn: 'urn:li:image:C9ZZ' });
let mails: { to: string; subject: string; text: string }[] = [];

const liDeps = (over: LiDeps = {}): LiDeps => ({
  now: () => NOW,
  post: liPost,
  fetchCms: async () => null,
  fetchStorePage: pageFetch,
  fetchImage: imageFetch,
  uploadImage: imageUpload,
  waitImage: async () => ({ ok: true }), // never reach LinkedIn's status endpoint from a test
  emailSender: async (m) => {
    mails.push(m);
    return { ok: true };
  },
  isEmailConfigured: () => true,
  recipients: async () => ['admin@team.test'],
  portals: { [PORTAL]: [PAGE, PAGE_AC] },
  postFrom: { [PAGE]: FROM, [PAGE_AC]: FROM_AC },
  allPushesFrom: { [PAGE]: PUSHES, [PAGE_AC]: PUSHES_AC },
  quiet: { start: '23:00', end: '07:00' },
  ...over,
});

let fbCalls: { pageId: string; accessToken: string; message: string; link: string }[] = [];
let fbScript: (n: number) => FacebookResult | Promise<FacebookResult> = () => fbPosted();
const fbPost: NonNullable<FbDeps['post']> = async (r) => {
  fbCalls.push(r);
  return fbScript(fbCalls.length);
};
const fbDeps = (over: FbDeps = {}): FbDeps => ({
  now: () => NOW,
  post: fbPost,
  fetchCms: async () => null,
  emailSender: async (m) => {
    mails.push(m);
    return { ok: true };
  },
  isEmailConfigured: () => true,
  recipients: async () => ['admin@team.test'],
  portals: { [PORTAL]: FB_PAGE },
  postFrom: FROM,
  allPushesFrom: PUSHES_FB,
  quiet: { start: '23:00', end: '07:00' },
  minGapMinutes: 10,
  dailyCap: 30,
  ...over,
});

/* ---------- campaigns and rows ---------- */

let seq = 0;
const courseUrl = (slug: string) => `https://academy.taxscan.in/course/${slug}-${RUN}`;
const productUrl = (slug: string) => `https://shop.taxscan.in/products/${slug}-${RUN}`;
type PushOpts = { title?: string; body?: string; target?: object; status?: 'SENT' | 'DRAFT'; portal?: string };
async function push(url: string, lastSentAt: Date | null, o: PushOpts = {}) {
  return prisma.campaign.create({
    data: {
      portal: o.portal ?? PORTAL,
      title: o.title ?? `Offer ${++seq}`,
      body: o.body ?? 'Seats are filling fast.',
      url,
      target: (o.target ?? { type: 'all' }) as Prisma.InputJsonValue,
      status: o.status ?? 'SENT',
      lastSentAt,
      authority: 'Supreme Court',
      categories: ['GST'],
    },
  });
}
const article = (slug: string, lastSentAt: Date, o: PushOpts = {}) => push(`https://www.taxscan.in/gst/${slug}-${RUN}-${++seq}`, lastSentAt, { title: `Story ${slug}`, ...o });
const liRows = (page: string) => prisma.linkedInPost.findMany({ where: { page }, orderBy: { createdAt: 'asc' } });
const fbRows = () => prisma.facebookPost.findMany({ where: { page: FB_PAGE }, orderBy: { createdAt: 'asc' } });
const params = (link: string) => new URL(link).searchParams;

const saved = {
  shared: env.linkedin.sharedPages,
  taxscan: env.linkedin.pages.taxscan,
  liPage: env.linkedin.pages[PAGE],
  from: env.linkedin.postFrom,
  enabled: env.linkedin.enabled,
  store: env.linkedin.allPushesFrom,
  tr: { ...env.linkedin.tokenRefresh },
  fbEnabled: env.facebook.enabled,
  fbFrom: env.facebook.postFrom,
  fbStore: env.facebook.allPushesFrom,
  fbTaxscan: env.facebook.pages.taxscan,
  waQueue: env.whatsapp.queueEnabled,
  hosts: env.allowedPushHosts,
};
async function wipe() {
  await prisma.linkedInPost.deleteMany({ where: { page: { in: [PAGE, PAGE_AC] } } });
  await prisma.facebookPost.deleteMany({ where: { page: FB_PAGE } });
  await prisma.digestSetting.deleteMany({ where: { key: { in: [liAuthKey(PAGE), liAuthKey(PAGE_AC), fbAuthKey(FB_PAGE), policyKey(FB_PAGE)] } } });
  await prisma.campaign.deleteMany({ where: { portal: { startsWith: PORTAL } } });
}
beforeEach(async () => {
  calls = [];
  fbCalls = [];
  pageCalls = [];
  imageCalls = [];
  uploads = [];
  mails = [];
  logs.length = 0;
  script = (r) => posted(`urn:li:share:${r.orgUrn === ORG ? 'T' : 'A'}${calls.length}`);
  fbScript = () => fbPosted();
  pageScript = (url) => pageOk(url);
  env.linkedin.pages[PAGE] = { orgUrn: ORG, accessToken: TOKEN };
  env.linkedin.pages.taxscan = { orgUrn: '', accessToken: '' }; // the real page is never touched
  env.linkedin.sharedPages = { [PAGE_AC]: { orgUrn: ORG_AC, postFrom: FROM_AC, tokenFrom: PAGE } };
  env.linkedin.postFrom = FROM;
  env.linkedin.allPushesFrom = {}; // hermetic: whatever the developer's .env says
  Object.assign(env.linkedin.tokenRefresh, { ...saved.tr, enabled: false });
  env.facebook.pages[FB_PAGE] = { pageId: FB_PAGE_ID, accessToken: FB_TOKEN };
  env.facebook.allPushesFrom = null;
  env.allowedPushHosts = saved.hosts;
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
  env.linkedin.allPushesFrom = saved.store;
  Object.assign(env.linkedin.tokenRefresh, saved.tr);
  env.facebook.enabled = saved.fbEnabled;
  env.facebook.postFrom = saved.fbFrom;
  env.facebook.allPushesFrom = saved.fbStore;
  env.facebook.pages.taxscan = saved.fbTaxscan;
  env.whatsapp.queueEnabled = saved.waQueue;
  env.allowedPushHosts = saved.hosts;
  await wipe();
  await prisma.$disconnect();
});

/* ================================================================== */
/* 1. The three variables                                              */
/* ================================================================== */

describe('1. the three variables: off unless a strict ISO time (the page then stays on today\'s rule)', () => {
  const VAR = ALL_PUSHES_FROM_VARS.linkedinTaxscan;
  it('the names are the three the brief gives', () => {
    expect(ALL_PUSHES_FROM_VARS).toEqual({ linkedinTaxscan: 'LINKEDIN_TAXSCAN_ALL_PUSHES_FROM', linkedinAcademy: 'LINKEDIN_ACADEMY_ALL_PUSHES_FROM', facebook: 'FACEBOOK_ALL_PUSHES_FROM' });
  });
  it.each([[{}], [{ [VAR]: '' }], [{ [VAR]: '   ' }]])('unset or blank (%j) → off, "is not set"', (src) => {
    expect(parseAllPushesFrom(src as NodeJS.ProcessEnv, VAR)).toEqual({ at: null, off: `${VAR} is not set` });
  });
  it.each(['2026', '04/11/2026', 'Nov 4', 'tomorrow', '2026-13-45', '1730000000000', '2026-11', 'garbage'])('%s is not a valid ISO time → off, and the message never echoes the value', (v) => {
    const r = parseAllPushesFrom({ [VAR]: v } as NodeJS.ProcessEnv, VAR);
    expect(r).toEqual({ at: null, off: `${VAR} is not a valid ISO time` });
    expect(r.off).not.toContain(v === 'garbage' ? 'garbage' : '\u0000');
  });
  it.each([
    ['2026-11-04T10:00:00Z', '2026-11-04T10:00:00.000Z'],
    ['2026-11-04T15:30:00+05:30', '2026-11-04T10:00:00.000Z'],
    ['2026-11-04 15:30:00+05:30', '2026-11-04T10:00:00.000Z'],
    ['2026-11-04', '2026-11-04T00:00:00.000Z'],
    ['  2026-11-04T10:00:00Z  ', '2026-11-04T10:00:00.000Z'],
  ])('%s → %s', (v, iso) => {
    expect(parseAllPushesFrom({ [VAR]: v } as NodeJS.ProcessEnv, VAR)).toEqual({ at: new Date(iso), off: null });
    expect(parseIsoTime(v)).toEqual(new Date(iso));
  });
  it('parseIsoTime is the same strict check LINKEDIN_ACADEMY_POST_FROM uses', () => {
    for (const bad of [undefined, '', '2026', '04/11/2026', 'Nov 4']) expect(parseIsoTime(bad)).toBeNull();
  });

  it('the env module wires each variable to its page: valid → the time, unset or invalid → null (checked by importing env afresh)', () => {
    const names = Object.values(ALL_PUSHES_FROM_VARS);
    const before = Object.fromEntries(names.map((n) => [n, process.env[n]]));
    const load = (vars: Record<string, string | undefined>) => {
      for (const n of names) delete process.env[n];
      for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
      let e!: typeof env;
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        e = (require('../lib/env') as typeof import('../lib/env')).env;
      });
      return { li: { ...e.linkedin.allPushesFrom }, fb: e.facebook.allPushesFrom };
    };
    try {
      expect(load({})).toEqual({ li: { taxscan: null, academy: null }, fb: null });
      expect(load({ LINKEDIN_TAXSCAN_ALL_PUSHES_FROM: '2026-11-05T02:00:00Z' })).toEqual({ li: { taxscan: new Date('2026-11-05T02:00:00Z'), academy: null }, fb: null });
      expect(load({ LINKEDIN_ACADEMY_ALL_PUSHES_FROM: '2026-11-05T03:00:00Z' })).toEqual({ li: { taxscan: null, academy: new Date('2026-11-05T03:00:00Z') }, fb: null });
      expect(load({ FACEBOOK_ALL_PUSHES_FROM: '2026-11-05T04:00:00Z' })).toEqual({ li: { taxscan: null, academy: null }, fb: new Date('2026-11-05T04:00:00Z') });
      expect(load({ LINKEDIN_TAXSCAN_ALL_PUSHES_FROM: 'soon', LINKEDIN_ACADEMY_ALL_PUSHES_FROM: '04/11/2026', FACEBOOK_ALL_PUSHES_FROM: '2026' })).toEqual({ li: { taxscan: null, academy: null }, fb: null });
    } finally {
      for (const n of names) {
        if (before[n] === undefined) delete process.env[n];
        else process.env[n] = before[n];
      }
    }
  });

  it('pageAllPushesFrom: a page\'s own variable; the Academy one counts ONLY while the Academy page is active', () => {
    const was = { store: env.linkedin.allPushesFrom, shared: env.linkedin.sharedPages };
    try {
      env.linkedin.allPushesFrom = { taxscan: PUSHES, academy: PUSHES_AC };
      env.linkedin.sharedPages = {};
      expect(pageAllPushesFrom(PAGE_TAXSCAN)).toEqual(PUSHES);
      expect(pageAllPushesFrom(PAGE_ACADEMY)).toBeNull(); // the page is not active: its variable alone does nothing
      env.linkedin.sharedPages = { academy: { orgUrn: ORG_AC, postFrom: FROM_AC, tokenFrom: 'taxscan' } };
      expect(pageAllPushesFrom(PAGE_ACADEMY)).toEqual(PUSHES_AC);
      env.linkedin.allPushesFrom = { taxscan: null, academy: null };
      expect(pageAllPushesFrom(PAGE_TAXSCAN)).toBeNull();
      expect(pageAllPushesFrom(PAGE_ACADEMY)).toBeNull();
      expect(pageAllPushesFrom('no-such-page')).toBeNull();
    } finally {
      env.linkedin.allPushesFrom = was.store;
      env.linkedin.sharedPages = was.shared;
    }
  });
  it('resolveAllPushesFrom: an injected single time, a per-page record (a missing page uses its own), or nothing', () => {
    env.linkedin.allPushesFrom = { [PAGE]: PUSHES_AC };
    expect(resolveAllPushesFrom(undefined, PAGE)).toEqual(PUSHES_AC); // its own
    expect(resolveAllPushesFrom(PUSHES, PAGE)).toEqual(PUSHES); // one time for every page
    expect(resolveAllPushesFrom(null, PAGE)).toBeNull(); // injected "none"
    expect(resolveAllPushesFrom({ [PAGE]: PUSHES }, PAGE)).toEqual(PUSHES);
    expect(resolveAllPushesFrom({ [PAGE_AC]: PUSHES }, PAGE)).toEqual(PUSHES_AC); // not in the record: its own
    expect(resolveAllPushesFrom({ [PAGE]: null }, PAGE)).toBeNull();
  });
});


/* ================================================================== */
/* 6. What qualifies (the rule), and the row key of ONE push           */
/* ================================================================== */

describe('6. what follows the new rule: a taxscan.in article, a course or a shop product, and nothing else', () => {
  const YES = [
    'https://www.taxscan.in/gst/an-article-slug',
    'https://www.taxscan.in/income-tax/an-article-1451580',
    'https://taxscan.in/top-stories/old-shape-article-1451580',
    'https://www.taxscan.in/gst/an-article-slug?utm_source=izooto&utm_medium=push',
    'https://academy.taxscan.in/course/gst-masterclass',
    'https://academy.taxscan.in/course/gst-masterclass/',
    'https://academy.taxscan.in/course/gst-masterclass?utm_source=izooto&utm_medium=push',
    'https://ACADEMY.taxscan.in/course/gst-masterclass#top',
    'https://academy.taxscan.in/course/navigating-gst-challenges-in-the-hospitality-industry/',
    'https://shop.taxscan.in/products/draft-replies-to-gst-notices-handbook-2026-ebook',
    'https://shop.taxscan.in/products/draft-replies-ebook/?variant=123',
    '  https://shop.taxscan.in/products/draft-replies-ebook  ',
  ];
  const NO = [
    'https://www.taxscan.in/',
    'https://www.taxscan.in',
    'https://www.taxscan.in/income-tax',
    'https://www.taxscan.in/income-tax/',
    'https://academy.taxscan.in/',
    'https://academy.taxscan.in/course',
    'https://academy.taxscan.in/course/',
    'https://academy.taxscan.in/courses/gst',
    'https://academy.taxscan.in/course/gst/extra',
    'https://academy.taxscan.in/my-account/',
    'https://academy.taxscan.in/product/gst',
    'https://shop.taxscan.in/',
    'https://shop.taxscan.in/products',
    'https://shop.taxscan.in/products/',
    'https://shop.taxscan.in/collections/gst-books',
    'https://shop.taxscan.in/collections/gst-books/products/draft-replies',
    'https://shop.taxscan.in/pages/contact',
    'https://shop.taxscan.in/course/x',
    'https://academy.taxscan.in/products/x',
    'http://shop.taxscan.in/products/x',
    'http://academy.taxscan.in/course/x',
    'https://shop.taxscan.in:8443/products/x',
    'https://user@shop.taxscan.in/products/x',
    'https://academy.taxscan.in.evil.example/course/x',
    'https://shop.taxscan.in.evil.example/products/x',
    'https://evil.example/course/x',
    'https://evil.example/gst/an-article-slug',
    'https://www.taxscan.in.evil.example/gst/an-article-slug',
    'not a url',
    '',
  ];
  it.each(YES)('%s follows the new rule', (u) => {
    expect(isAllPushesCampaign({ url: u, target: { type: 'all' } })).toBe(true);
  });
  it.each(NO)('%j does NOT', (u) => {
    expect(isAllPushesCampaign({ url: u, target: { type: 'all' } })).toBe(false);
  });
  it('storeLinkOf tells a course from a product and refuses the rest (its base has no query, no fragment, no trailing slash)', () => {
    expect(storeLinkOf('https://ACADEMY.taxscan.in/course/gst-x/?a=1#f')).toEqual({ kind: 'course', host: 'academy.taxscan.in', slug: 'gst-x', base: 'https://academy.taxscan.in/course/gst-x' });
    expect(storeLinkOf('https://shop.taxscan.in/products/ebook-1?v=2')).toEqual({ kind: 'product', host: 'shop.taxscan.in', slug: 'ebook-1', base: 'https://shop.taxscan.in/products/ebook-1' });
    expect(storeLinkOf('https://www.taxscan.in/gst/an-article-slug')).toBeNull();
    for (const u of NO) expect(storeLinkOf(u)).toBeNull();
  });
  it('isPublicArticleCampaign is NOT changed: a course or a product is never an article (the WhatsApp queue relies on it)', () => {
    expect(isPublicArticleCampaign({ url: 'https://www.taxscan.in/gst/an-article-slug', target: {} })).toBe(true);
    for (const u of YES.filter((x) => x.includes('academy') || x.includes('shop'))) expect(isPublicArticleCampaign({ url: u, target: {} })).toBe(false);
  });
  it('a test-segment-only push does not qualify; one that also names a real topic does', () => {
    for (const url of [courseUrl('gst-x'), 'https://www.taxscan.in/gst/an-article-slug']) {
      expect(isAllPushesCampaign({ url, target: { type: 'topics', topics: [env.testSegmentTopic] } })).toBe(false);
      expect(isAllPushesCampaign({ url, target: { type: 'topics', topics: [' Test '] } }, 'test')).toBe(false);
      expect(isAllPushesCampaign({ url, target: { type: 'topics', topics: [env.testSegmentTopic, 'gst'] } })).toBe(true);
      expect(isAllPushesCampaign({ url, target: { type: 'all' } })).toBe(true);
    }
  });
  it('a host that is not on ALLOWED_PUSH_HOSTS does not qualify', () => {
    env.allowedPushHosts = saved.hosts.filter((h) => h !== 'shop.taxscan.in');
    expect(isAllPushesCampaign({ url: productUrl('x'), target: {} })).toBe(false);
    expect(isAllPushesCampaign({ url: courseUrl('x'), target: {} })).toBe(true);
    env.allowedPushHosts = saved.hosts.filter((h) => h !== 'academy.taxscan.in');
    expect(isAllPushesCampaign({ url: courseUrl('x'), target: {} })).toBe(false);
    env.allowedPushHosts = saved.hosts.filter((h) => h !== 'www.taxscan.in');
    expect(isAllPushesCampaign({ url: 'https://www.taxscan.in/gst/an-article-slug', target: {} })).toBe(false);
  });
});

describe('4. one row per push: the key is push:<campaign id>:<send time in ms>', () => {
  const t1 = new Date('2026-11-03T04:00:00.123Z');
  it('has exactly that shape, and a resend of the same campaign row (a new send time) is a new key', () => {
    expect(pushKey({ id: 'cabc123', lastSentAt: t1 })).toBe(`push:cabc123:${t1.getTime()}`);
    expect(PUSH_KEY_PREFIX).toBe('push:');
    expect(pushKey({ id: 'cabc123', lastSentAt: t1 })).toBe(pushKey({ id: 'cabc123', lastSentAt: new Date(t1.getTime()) })); // the same push is the same key
    expect(pushKey({ id: 'cabc123', lastSentAt: new Date(t1.getTime() + 1) })).not.toBe(pushKey({ id: 'cabc123', lastSentAt: t1 }));
    expect(pushKey({ id: 'cabc124', lastSentAt: t1 })).not.toBe(pushKey({ id: 'cabc123', lastSentAt: t1 }));
  });
  it('does not depend on the link or the wording: a clone of the same article, or the same course twice, are different pushes', () => {
    const a = { id: 'c1', lastSentAt: t1 };
    const b = { id: 'c2', lastSentAt: t1 };
    expect(pushKey(a)).not.toBe(pushKey(b));
  });
  it('can never meet an article key (article:<id>, or the article URL)', () => {
    expect(isPushKey(pushKey({ id: 'c1', lastSentAt: t1 }))).toBe(true);
    for (const k of ['article:1451580', 'https://www.taxscan.in/gst/an-article-slug', `__id:c1`]) expect(isPushKey(k)).toBe(false);
  });
});
describe('8. the LinkedIn commentary: title, body, #taxscan — escaped, emoji safe, body cut before the title', () => {
  it('a real title and a body with bullets, parentheses, # and @', () => {
    const body = 'Join Rahul Pansari (CA) for GSTR-9/9C.\n- Live: 7 PM\n- Fee: ₹499+GST\nSeats @ 50% off #1 course';
    expect(buildStoreCommentary(T_TOMORROW, body)).toBe(
      '🚨COURSE STARTS TOMORROW 7 PM 🚨\n\nJoin Rahul Pansari \\(CA\\) for GSTR-9/9C.\n- Live: 7 PM\n- Fee: ₹499+GST\nSeats \\@ 50% off \\#1 course\n\n' + TAG,
    );
  });
  it('every reserved character is escaped in the title AND the body; the hashtag itself is not', () => {
    const body = 'Step 1 (login) → Step 2 [upload] <PDF> | {draft} ~ _x_ *bold* \\ done @here #now';
    const out = buildStoreCommentary(`${T_GSTAT} (new) [live] #1`, body);
    expect(out).toBe(
      '❗GSTAT E-FILING CONFUSION? FEARING DEFECT NOTICES? 💻 \\(new\\) \\[live\\] \\#1\n\n' +
        'Step 1 \\(login\\) → Step 2 \\[upload\\] \\<PDF\\> \\| \\{draft\\} \\~ \\_x\\_ \\*bold\\* \\\\ done \\@here \\#now\n\n' +
        TAG,
    );
  });
  it('emoji survive, even a ZWJ sequence with a variation selector; quotes and ellipsis are untouched', () => {
    const out = buildStoreCommentary(T_DETECTIVE, '');
    expect(out).toBe(`${T_DETECTIVE}\n\n${TAG}`);
    expect(out).toContain('🕵️‍♂️');
    const mega = buildStoreCommentary(T_MEGA, 'Training on 📌 GST audit — 50% off');
    expect(mega).toBe(`🚨MEGA AUDIT OFFER – 50% OFF + EXTRA 10% OFF! ! Training on …\n\nTraining on 📌 GST audit — 50% off\n\n${TAG}`);
  });
  it('the title is on one line; the body keeps its own lines as single line breaks and nothing else', () => {
    expect(storeBodyLines('  Line one   with   gaps\r\n\r\n\r\n   - bullet\ttwo  \n\n  ')).toBe('Line one with gaps\n- bullet two');
    expect(storeBodyLines('a\rb\r\nc\n\n\nd')).toBe('a\nb\nc\nd');
    expect(storeBodyLines('')).toBe('');
    expect(storeBodyLines(null)).toBe('');
    expect(storeBodyLines(' \n \t \n')).toBe('');
    expect(buildStoreCommentary('A\nB   C', 'x\n\n\ny')).toBe(`A B C\n\nx\ny\n\n${TAG}`);
  });
  it('no body → title, a blank line, #taxscan', () => {
    expect(buildStoreCommentary('Only a title', '')).toBe(`Only a title\n\n${TAG}`);
    expect(buildStoreCommentary('Only a title', '  \n ')).toBe(`Only a title\n\n${TAG}`);
  });
  it('exactly at the limit is kept whole; one character over cuts the BODY (ellipsis), never the title', () => {
    const head = 'Title';
    const room = COMMENTARY_MAX - head.length - TAG.length - 4; // the room for the body
    const exact = buildStoreCommentary(head, 'x'.repeat(room));
    expect(exact.length).toBe(COMMENTARY_MAX);
    expect(exact).toBe(`${head}\n\n${'x'.repeat(room)}\n\n${TAG}`);
    const over = buildStoreCommentary(head, 'x'.repeat(room + 1));
    expect(over.length).toBeLessThanOrEqual(COMMENTARY_MAX);
    expect(over.startsWith(`${head}\n\nx`)).toBe(true);
    expect(over.endsWith(`…\n\n${TAG}`)).toBe(true);
  });
  it('an over-long body is cut at a word boundary, never inside an escape pair, and the title and #taxscan are kept', () => {
    const out = buildStoreCommentary(T_TOMORROW, '(a) '.repeat(1500)); // 6,000 raw characters, 9,000 once escaped
    expect(out.length).toBeLessThanOrEqual(COMMENTARY_MAX);
    expect(out.startsWith(`${T_TOMORROW}\n\n`)).toBe(true);
    expect(out.endsWith(`…\n\n${TAG}`)).toBe(true);
    const body = out.slice(T_TOMORROW.length + 2, out.length - TAG.length - 2 - 1); // without the title, the tag and the ellipsis
    expect(/\\(?![()])/.test(body)).toBe(false); // every backslash is followed by the character it escapes
    expect(body.endsWith('\\)')).toBe(true); // cut at a word end, not mid-pair
    expect(body.length).toBeGreaterThan(2500); // and it used the room it had
  });
  it('a body of nothing but reserved characters is measured as ESCAPED (twice as long) and still fits', () => {
    const out = buildStoreCommentary('T', '('.repeat(4000));
    expect(out.length).toBeLessThanOrEqual(COMMENTARY_MAX);
    expect(/^T\n\n(\\\()+…\n\n\{hashtag\|\\#\|taxscan\}$/.test(out)).toBe(true);
  });
  it('a title so long that nothing is left: the body is dropped, the title is NEVER cut', () => {
    const title = 'T'.repeat(3100);
    expect(buildStoreCommentary(title, 'a body')).toBe(`${title}\n\n${TAG}`);
    const nearly = 'N'.repeat(COMMENTARY_MAX - TAG.length - 4 - 1); // one character of room: not worth an ellipsis
    expect(buildStoreCommentary(nearly, 'some body')).toBe(`${nearly}\n\n${TAG}`);
  });
  it('escapeLittleText is the existing function (the same list of reserved characters)', () => {
    expect(escapeLittleText('a(b)[c]{d}<e>|f\\g@h#i*j_k~l')).toBe('a\\(b\\)\\[c\\]\\{d\\}\\<e\\>\\|f\\\\g\\@h\\#i\\*j\\_k\\~l');
  });
});

describe('8. the Facebook message: title, body, #taxscan — plain text', () => {
  it('a real title, a body with bullets and reserved characters, and #taxscan; nothing escaped', () => {
    const p = buildFacebookStorePost({ title: T_TOMORROW, body: 'Join (CA) @ 50% off #1\n- Live 7 PM\n\n\n- Fee ₹499', url: courseUrl('gst-x') }, 'taxscan');
    expect(p?.message).toBe('🚨COURSE STARTS TOMORROW 7 PM 🚨\n\nJoin (CA) @ 50% off #1\n- Live 7 PM\n- Fee ₹499\n\n#taxscan');
    expect(p).toMatchObject({ hashtags: ['taxscan'], hashtagSource: 'fixed' });
  });
  it('no body → title, a blank line, #taxscan; the title is one line', () => {
    expect(buildFacebookStorePost({ title: `${T_MEGA}\n`, body: '', url: productUrl('p') }, 'taxscan')?.message).toBe('🚨MEGA AUDIT OFFER – 50% OFF + EXTRA 10% OFF! ! Training on …\n\n#taxscan');
  });
  it('not a store link, or off the allowlist → null', () => {
    expect(buildFacebookStorePost({ title: 't', body: 'b', url: 'https://www.taxscan.in/gst/x-1451580' }, 'taxscan')).toBeNull();
    expect(buildFacebookStorePost({ title: 't', body: 'b', url: 'https://shop.taxscan.in/' }, 'taxscan')).toBeNull();
    env.allowedPushHosts = saved.hosts.filter((h) => h !== 'shop.taxscan.in');
    expect(buildFacebookStorePost({ title: 't', body: 'b', url: productUrl('p') }, 'taxscan')).toBeNull();
  });
});

describe('7. each link carries exactly one set of UTMs: the channel\'s', () => {
  const pushed = 'https://shop.taxscan.in/products/draft-replies?utm_source=izooto&utm_medium=push_notifications&utm_campaign=old&utm_content=c&UTM_Term=t&ref=a#buy';
  const noPage: StorePageFetch = async () => ({ ok: false, reason: 'page_http_404' });
  it.each([
    ['taxscan', 'linkedin-taxscan'],
    ['academy', 'linkedin-academy'],
  ])('LinkedIn, %s page: taxscan-linkedin / social / %s / <slug>; the push\'s own utm_* are gone', async (page, campaign) => {
    const p = await buildStorePost({ id: 'c1', title: 't', body: 'b', url: pushed }, page, noPage);
    const q = params(p!.link);
    expect(q.getAll('utm_source')).toEqual(['taxscan-linkedin']);
    expect(q.getAll('utm_medium')).toEqual(['social']);
    expect(q.getAll('utm_campaign')).toEqual([campaign]);
    expect(q.getAll('utm_content')).toEqual(['draft-replies']);
    expect([...q.keys()].filter((k) => k.toLowerCase().startsWith('utm_')).sort()).toEqual(['utm_campaign', 'utm_content', 'utm_medium', 'utm_source']);
    expect(q.get('ref')).toBe('a'); // other parameters survive
    expect(new URL(p!.link).hash).toBe('#buy');
    expect(p!.link.startsWith('https://shop.taxscan.in/products/draft-replies?')).toBe(true);
  });
  it('Facebook: taxscan-facebook / social / facebook-taxscan / <slug>', () => {
    const p = buildFacebookStorePost({ title: 't', body: 'b', url: pushed }, 'taxscan');
    const q = params(p!.link);
    expect([q.getAll('utm_source'), q.getAll('utm_medium'), q.getAll('utm_campaign'), q.getAll('utm_content')]).toEqual([['taxscan-facebook'], ['social'], ['facebook-taxscan'], ['draft-replies']]);
    expect([...q.keys()].filter((k) => k.toLowerCase().startsWith('utm_'))).toHaveLength(4);
    expect(q.get('ref')).toBe('a');
  });
  it('a course link on a trailing slash keeps it; an encoded slug is decoded for utm_content and a long one is cut to 100', async () => {
    const a = await buildStorePost({ id: 'c', title: 't', body: 'b', url: 'https://academy.taxscan.in/course/gst-%E2%82%B9499/' }, 'taxscan', noPage);
    expect(a!.link.startsWith('https://academy.taxscan.in/course/gst-%E2%82%B9499/?')).toBe(true);
    expect(params(a!.link).get('utm_content')).toBe('gst-₹499');
    const long = await buildStorePost({ id: 'c', title: 't', body: 'b', url: `https://academy.taxscan.in/course/${'s'.repeat(150)}` }, 'taxscan', noPage);
    expect(params(long!.link).get('utm_content')).toBe('s'.repeat(100));
  });
});

/* ================================================================== */
/* 7. The page, its tags and the picture                               */
/* ================================================================== */

describe('9. the product page: og tags, secure_url first, start of the page only', () => {
  const PAGE_URL = 'https://shop.taxscan.in/products/p/';
  it('the real course page: title and description decoded, a https picture', () => {
    expect(parseStorePageTags(COURSE_HTML, 'https://academy.taxscan.in/course/x/')).toEqual(COURSE_TAGS);
  });
  it('the real shop page: og:image is http, og:image:secure_url is https → the secure_url is used (decoded entities too)', () => {
    expect(parseStorePageTags(SHOP_HTML, PAGE_URL)).toEqual(SHOP_TAGS);
  });
  it('secure_url wins whichever tag comes first', () => {
    const html = '<meta property="og:image:secure_url" content="https://shop.taxscan.in/cdn/a.jpg"><meta property="og:image" content="https://shop.taxscan.in/cdn/b.jpg">';
    expect(parseStorePageTags(html, PAGE_URL).imageUrl).toBe('https://shop.taxscan.in/cdn/a.jpg');
    const reversed = '<meta property="og:image" content="https://shop.taxscan.in/cdn/b.jpg"><meta property="og:image:secure_url" content="https://shop.taxscan.in/cdn/a.jpg">';
    expect(parseStorePageTags(reversed, PAGE_URL).imageUrl).toBe('https://shop.taxscan.in/cdn/a.jpg');
  });
  it('og:image alone is used when it is https; over http it is IGNORED (no picture, reason not_https)', () => {
    expect(parseStorePageTags('<meta property="og:image" content="https://shop.taxscan.in/cdn/b.jpg">', PAGE_URL)).toMatchObject({ imageUrl: 'https://shop.taxscan.in/cdn/b.jpg', imageReason: null });
    expect(parseStorePageTags('<meta property="og:image" content="http://shop.taxscan.in/cdn/b.jpg">', PAGE_URL)).toMatchObject({ imageUrl: null, imageReason: 'not_https' });
    expect(parseStorePageTags('<meta property="og:image:secure_url" content="http://shop.taxscan.in/cdn/b.jpg"><meta property="og:image" content="http://shop.taxscan.in/cdn/b.jpg">', PAGE_URL)).toMatchObject({ imageUrl: null, imageReason: 'not_https' });
  });
  it('no image tag (or an empty one) → no_tag; a relative or protocol-relative value resolves against the https page', () => {
    expect(parseStorePageTags('<meta property="og:title" content="x">', PAGE_URL)).toMatchObject({ imageUrl: null, imageReason: 'no_tag', title: 'x' });
    expect(parseStorePageTags('<meta property="og:image" content="">', PAGE_URL)).toMatchObject({ imageUrl: null, imageReason: 'no_tag' });
    expect(parseStorePageTags('<meta property="og:image" content="/cdn/c.jpg">', PAGE_URL).imageUrl).toBe('https://shop.taxscan.in/cdn/c.jpg');
    expect(parseStorePageTags('<meta property="og:image" content="//shop.taxscan.in/cdn/d.jpg">', PAGE_URL).imageUrl).toBe('https://shop.taxscan.in/cdn/d.jpg');
  });
  it('markup in a title or description is stripped and whitespace collapsed; missing tags are null', () => {
    const t = parseStorePageTags('<meta property="og:title" content="  A &quot;big&quot;\n offer  "><meta property="og:description" content="&lt;b&gt;Bold&lt;/b&gt; text">', PAGE_URL);
    expect(t).toMatchObject({ title: 'A "big" offer', description: 'Bold text' });
    expect(parseStorePageTags('<html></html>', PAGE_URL)).toEqual({ title: null, description: null, imageUrl: null, imageReason: 'no_tag' });
  });
  it('only the START of the page is looked at: a tag after the cap is not seen', () => {
    const late = `${' '.repeat(STORE_PAGE_READ_BYTES + 10)}<meta property="og:title" content="too late">`;
    expect(parseStorePageTags(late, PAGE_URL).title).toBeNull();
  });
});

describe('9. fetching the page is safe', () => {
  const URL_OK = 'https://shop.taxscan.in/products/p/';
  const html = (body: string, init: ResponseInit = {}) => new Response(body, { status: 200, headers: { 'content-type': 'text/html' }, ...init });
  const asFetch = (fn: (url: string, init: RequestInit) => Promise<Response>) => jest.fn(fn) as unknown as jest.MockedFunction<typeof fetch>;

  it('ONE request: https, no redirects, a signal (the 5 s limit), no credentials; the tags come back', async () => {
    const f = asFetch(async () => html(SHOP_HTML));
    const timer = jest.spyOn(globalThis, 'setTimeout');
    try {
      expect(await fetchStorePage(URL_OK, f)).toEqual({ ok: true, tags: SHOP_TAGS });
      expect(timer).toHaveBeenCalledWith(expect.any(Function), STORE_PAGE_TIMEOUT_MS);
    } finally {
      timer.mockRestore();
    }
    expect(STORE_PAGE_TIMEOUT_MS).toBe(5000);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(URL_OK);
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(Object.keys(init.headers as Record<string, string>).map((k) => k.toLowerCase()).sort()).toEqual(['accept', 'user-agent']);
    expect(init.method ?? 'GET').toBe('GET');
  });
  it.each([
    ['another host', 'https://evil.example/products/x'],
    ['http', 'http://shop.taxscan.in/products/x'],
    // A shop collection and the academy home page used to be refused here. Since brief 2026-11-07-social-every-link they are "other pages" on a
    // named allowed host and ARE fetched (https only, no redirects, 5 s, capped read); socialEveryLink.test.ts covers that and what stays refused.
    ['an article', 'https://www.taxscan.in/gst/x-1451580'],
    ['a port', 'https://shop.taxscan.in:8443/products/x'],
  ])('%s → page_host, and NO request is made', async (_n, u) => {
    const f = asFetch(async () => html(SHOP_HTML));
    expect(await fetchStorePage(u, f)).toEqual({ ok: false, reason: 'page_host' });
    expect(f).not.toHaveBeenCalled();
  });
  it('a host off ALLOWED_PUSH_HOSTS → page_host, no request', async () => {
    env.allowedPushHosts = saved.hosts.filter((h) => h !== 'shop.taxscan.in');
    const f = asFetch(async () => html(SHOP_HTML));
    expect(await fetchStorePage(URL_OK, f)).toEqual({ ok: false, reason: 'page_host' });
    expect(f).not.toHaveBeenCalled();
  });
  it('404 and 5xx → page_http_<status>; a 3xx or a thrown redirect → page_redirect; an abort → page_timeout; anything else → page_network', async () => {
    expect(await fetchStorePage(URL_OK, asFetch(async () => html('x', { status: 404 })))).toEqual({ ok: false, reason: 'page_http_404' });
    expect(await fetchStorePage(URL_OK, asFetch(async () => html('x', { status: 503 })))).toEqual({ ok: false, reason: 'page_http_503' });
    expect(await fetchStorePage(URL_OK, asFetch(async () => new Response(null, { status: 301, headers: { location: 'https://evil.example/' } })))).toEqual({ ok: false, reason: 'page_redirect' });
    const thrown = asFetch(async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: new Error('unexpected redirect') });
    });
    expect(await fetchStorePage(URL_OK, thrown)).toEqual({ ok: false, reason: 'page_redirect' });
    const aborted = asFetch(async () => {
      throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    });
    expect(await fetchStorePage(URL_OK, aborted)).toEqual({ ok: false, reason: 'page_timeout' });
    const down = asFetch(async () => {
      throw new Error('ECONNRESET');
    });
    expect(await fetchStorePage(URL_OK, down)).toEqual({ ok: false, reason: 'page_network' });
  });
  it('only the START of a huge page is read: the stream is cancelled past the cap, and a tag beyond it is never seen', async () => {
    const enc = new TextEncoder();
    const CHUNK = 64 * 1024;
    let pulled = 0;
    let cancelled = false;
    const head = '<html><head><meta property="og:title" content="Early title">';
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += 1;
        // chunk 1 holds the early tag; the og:description comes only in chunk 7, past the cap
        const text = pulled === 1 ? head + ' '.repeat(CHUNK - head.length) : pulled === 7 ? '<meta property="og:description" content="Too late">'.padEnd(CHUNK, ' ') : 'x'.repeat(CHUNK);
        c.enqueue(enc.encode(text));
      },
      cancel() {
        cancelled = true;
      },
    });
    const r = await fetchStorePage(URL_OK, asFetch(async () => new Response(stream, { status: 200 })));
    expect(r).toMatchObject({ ok: true, tags: { title: 'Early title', description: null } });
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThanOrEqual(STORE_PAGE_READ_BYTES / CHUNK + 2); // the cap, plus what the stream pre-reads
  });
  it('the LinkedIn picture hosts now include the two store hosts (and still refuse everything else)', async () => {
    expect([...IMAGE_HOSTS].sort()).toEqual(['academy.taxscan.in', 'documents.taxscan.in', 'shop.taxscan.in', 'taxscan.in', 'www.taxscan.in']);
    const ok = asFetch(async () => new Response(new Uint8Array([0xff, 0xd8, 1]), { status: 200, headers: { 'content-type': 'image/jpeg' } }));
    expect(await fetchCoverImage(SHOP_IMG, ok)).toMatchObject({ ok: true });
    expect(await fetchCoverImage(COURSE_IMG, ok)).toMatchObject({ ok: true });
    const never = asFetch(async () => new Response('x'));
    for (const bad of ['http://shop.taxscan.in/cdn/x.jpg', 'https://cdn.shopify.com/s/files/x.jpg', 'https://shop.taxscan.in.evil.example/x.jpg', 'https://academy.taxscan.in:8443/x.jpg']) {
      expect(await fetchCoverImage(bad, never)).toEqual({ ok: false, reason: 'host' });
    }
    expect(never).not.toHaveBeenCalled();
  });
});

describe('7 + 8 + 9. buildStorePost: the whole LinkedIn payload', () => {
  const pushedCourse = { id: 'c1', title: T_TOMORROW, body: 'Join (CA) @ 7 PM\n- Live', url: 'https://academy.taxscan.in/course/navigating-gst?utm_source=izooto&utm_medium=push' };
  it('the page is fetched on its canonical form: the link without a query string, WITH a trailing slash (WordPress redirects the other form)', async () => {
    const seen: string[] = [];
    const f: StorePageFetch = async (u) => (seen.push(u), pageOk(u));
    await buildStorePost(pushedCourse, 'taxscan', f);
    await buildStorePost({ ...pushedCourse, url: 'https://academy.taxscan.in/course/navigating-gst/?x=1' }, 'taxscan', f);
    await buildStorePost({ ...pushedCourse, url: 'https://shop.taxscan.in/products/ebook?variant=2' }, 'taxscan', f);
    expect(seen).toEqual(['https://academy.taxscan.in/course/navigating-gst/', 'https://academy.taxscan.in/course/navigating-gst/', 'https://shop.taxscan.in/products/ebook/']);
  });
  it('commentary from the push; card title and description from the page (≤ 200); the picture from the page; hashtags fixed', async () => {
    const p = await buildStorePost(pushedCourse, 'academy', async (u) => pageOk(u));
    expect(p).toMatchObject({
      commentary: buildStoreCommentary(pushedCourse.title, pushedCourse.body),
      title: COURSE_TAGS.title,
      coverImageUrl: COURSE_IMG,
      hashtags: ['taxscan'],
      hashtagSource: 'fixed',
    });
    expect(p!.imageReason).toBeUndefined();
    expect(p!.description.length).toBeLessThanOrEqual(200);
    expect(COURSE_TAGS.description!.startsWith(p!.description.replace(/…$/, ''))).toBe(true);
    expect(params(p!.link).get('utm_campaign')).toBe('linkedin-academy');
  });
  it('a page that cannot be read: the card falls back to the push title and body, no picture, and the reason is kept (page_http_404 / page_timeout / page_network when it throws)', async () => {
    for (const [fn, reason] of [
      [async () => ({ ok: false, reason: 'page_http_404' }) as StorePageResult, 'page_http_404'],
      [async () => ({ ok: false, reason: 'page_timeout' }) as StorePageResult, 'page_timeout'],
      [async (): Promise<StorePageResult> => {
        throw new Error('boom');
      }, 'page_network'],
    ] as const) {
      const p = await buildStorePost(pushedCourse, 'taxscan', fn);
      expect(p).toMatchObject({ title: T_TOMORROW, description: 'Join (CA) @ 7 PM - Live', coverImageUrl: null, imageReason: reason });
    }
  });
  it('a page with no usable picture says why: no_tag, or not_https', async () => {
    const tags = (t: Partial<StorePageTags>): StorePageFetch => async () => ({ ok: true, tags: { title: 'T', description: 'D', imageUrl: null, imageReason: 'no_tag', ...t } });
    expect(await buildStorePost(pushedCourse, 'taxscan', tags({}))).toMatchObject({ coverImageUrl: null, imageReason: 'no_tag', title: 'T', description: 'D' });
    expect(await buildStorePost(pushedCourse, 'taxscan', tags({ imageReason: 'not_https' }))).toMatchObject({ imageReason: 'not_https' });
  });
  it('a long og:title is cut at a word boundary; an og:title that is missing falls back to the push title', async () => {
    const long = 'word '.repeat(100).trim();
    const p = await buildStorePost(pushedCourse, 'taxscan', async () => ({ ok: true, tags: { ...COURSE_TAGS, title: long } }));
    expect(p!.title.length).toBeLessThanOrEqual(CARD_TITLE_MAX);
    expect(p!.title.endsWith('word…')).toBe(true);
    const none = await buildStorePost(pushedCourse, 'taxscan', async () => ({ ok: true, tags: { ...COURSE_TAGS, title: null, description: null } }));
    expect(none).toMatchObject({ title: T_TOMORROW, description: 'Join (CA) @ 7 PM - Live' });
  });
  it('not a store link, or a final link off ALLOWED_PUSH_HOSTS → null, and the page is never fetched', async () => {
    const f = jest.fn(async (u: string) => pageOk(u));
    expect(await buildStorePost({ ...pushedCourse, url: 'https://www.taxscan.in/gst/x-1451580' }, 'taxscan', f)).toBeNull();
    expect(await buildStorePost({ ...pushedCourse, url: 'https://shop.taxscan.in/' }, 'taxscan', f)).toBeNull();
    env.allowedPushHosts = saved.hosts.filter((h) => h !== 'academy.taxscan.in');
    expect(await buildStorePost(pushedCourse, 'taxscan', f)).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
});


/* ================================================================== */
/* LinkedIn: the worker                                                 */
/* ================================================================== */

const before = (min: number) => at(PUSHES, -min); // earlier than the Taxscan page's all-pushes time (08:00 IST): today's rule
const after = (min: number) => at(PUSHES, min); // at or after it: the new rule (for the Academy page: after(30) and later)
const ONE = { portals: { [PORTAL]: [PAGE] } } satisfies LiDeps; // the Taxscan page alone
const pk = (c: { id: string; lastSentAt: Date | null }) => pushKey({ id: c.id, lastSentAt: c.lastSentAt as Date });
const keysOf = async (page: string) => (await liRows(page)).map((r) => r.articleKey);
const sameKeys = (actual: string[], expected: string[]) => expect([...actual].sort()).toEqual([...expected].sort());
const headOf = (c: { commentary: string }) => c.commentary.split('\n')[0];
const liRow = (page: string, key: string, c: { id: string }, status: 'POSTED' | 'FAILED' | 'SKIPPED' | 'PENDING', extra: object = {}) =>
  prisma.linkedInPost.create({ data: { page, articleKey: key, campaignId: c.id, status, attempts: 1, ...extra } as never });
const fbRow = (key: string, c: { id: string }, status: 'POSTED' | 'FAILED' | 'SKIPPED' | 'PENDING', extra: object = {}) =>
  prisma.facebookPost.create({ data: { page: FB_PAGE, articleKey: key, campaignId: c.id, status, attempts: 1, ...extra } as never });

describe('1. LinkedIn: no all-pushes time → no new-rule row, no page fetch, the tick exactly as today', () => {
  it.each([[undefined], [null], [{ [PAGE]: null, [PAGE_AC]: null }], [{}]])('allPushesFrom %j: only the article posts, once on each page; its clone, a course and a product make nothing', async (allPushesFrom) => {
    const art = await article('a1', at(NOW, -90));
    await push(art.url, at(NOW, -60)); // the same article again: a backfill clone / a resend
    await push(courseUrl('c'), at(NOW, -50));
    await push(productUrl('p'), at(NOW, -40));
    const d = () => liDeps({ allPushesFrom: allPushesFrom as LiDeps['allPushesFrom'] });
    const t = await runLinkedInTick(d());
    expect(t).toMatchObject({ posted: 2, failed: 0, refused: null });
    expect(calls.map((c) => c.orgUrn)).toEqual([ORG, ORG_AC]);
    expect(await keysOf(PAGE)).toEqual([articleKey(art)]);
    expect(await keysOf(PAGE_AC)).toEqual([articleKey(art)]);
    expect(pageCalls).toEqual([]);
    await runLinkedInTick(d());
    expect(calls).toHaveLength(2); // a later tick adds nothing
  });
  it('the env variable alone turns a page on (nothing injected); the other page, without one, stays on today\'s rule', async () => {
    env.linkedin.allPushesFrom = { [PAGE]: PUSHES };
    const c = await push(courseUrl('c'), after(10));
    await runLinkedInTick(liDeps({ allPushesFrom: undefined }));
    expect(await keysOf(PAGE)).toEqual([pk(c)]);
    expect(await keysOf(PAGE_AC)).toEqual([]);
  });
  it('an all-pushes time that lies after every push changes nothing at all (the same rows as with it unset)', async () => {
    const art = await article('a1', at(NOW, -90));
    await push(art.url, at(NOW, -60));
    await push(courseUrl('c'), at(NOW, -50));
    const run = async (allPushesFrom: LiDeps['allPushesFrom']) => {
      await prisma.linkedInPost.deleteMany({ where: { page: { in: [PAGE, PAGE_AC] } } });
      calls = [];
      await runLinkedInTick(liDeps({ allPushesFrom }));
      return { keys: [...(await keysOf(PAGE)), ...(await keysOf(PAGE_AC))].sort(), orgs: calls.map((c) => c.orgUrn) };
    };
    expect(await run({ [PAGE]: at(NOW, 60), [PAGE_AC]: at(NOW, 60) })).toEqual(await run(null));
  });
});

describe('2. LinkedIn: each switch alone affects only its page; with both set, one push is one post on each page', () => {
  async function trio() {
    const a = await article('a', at(NOW, -60)); // 09:00: after both pages' times
    const c = await push(courseUrl('c'), at(NOW, -50), { title: T_TOMORROW });
    const p = await push(productUrl('p'), at(NOW, -40), { title: T_GSTAT });
    return { a, c, p };
  }
  it('only the Taxscan page: every push posts there, one row each; the Academy page stays on today\'s rule (the article only)', async () => {
    const { a, c, p } = await trio();
    const d = () => liDeps({ allPushesFrom: { [PAGE]: PUSHES, [PAGE_AC]: null } });
    await runLinkedInTick(d());
    await runLinkedInTick(d()); // MAX_PER_TICK (3) is shared by the pages, Taxscan first
    sameKeys(await keysOf(PAGE), [pk(a), pk(c), pk(p)]);
    expect(await keysOf(PAGE_AC)).toEqual([articleKey(a)]);
    expect(calls.map((x) => x.orgUrn)).toEqual([ORG, ORG, ORG, ORG_AC]);
    expect(calls.map((x) => params(x.link).get('utm_campaign'))).toEqual([`linkedin-${PAGE}`, `linkedin-${PAGE}`, `linkedin-${PAGE}`, `linkedin-${PAGE_AC}`]);
  });
  it('only the Academy page: every push posts there under the Academy org URN and the shared token; the Taxscan page stays on today\'s rule', async () => {
    const { a, c, p } = await trio();
    const d = () => liDeps({ allPushesFrom: { [PAGE]: null, [PAGE_AC]: PUSHES_AC } });
    await runLinkedInTick(d());
    await runLinkedInTick(d());
    expect(await keysOf(PAGE)).toEqual([articleKey(a)]);
    sameKeys(await keysOf(PAGE_AC), [pk(a), pk(c), pk(p)]);
    expect(calls.map((x) => x.orgUrn)).toEqual([ORG, ORG_AC, ORG_AC, ORG_AC]);
    expect(calls.map((x) => x.accessToken)).toEqual([TOKEN, TOKEN, TOKEN, TOKEN]); // the Academy page has no token of its own
    expect(uploads.filter((u) => u.orgUrn === ORG_AC)).toHaveLength(2); // the course and the product have a picture; the pictures go up under the Academy org
  });
  it('both pages: three pushes make three posts on each page (MAX_PER_TICK is shared, Taxscan first, so two ticks)', async () => {
    const { a, c, p } = await trio();
    await runLinkedInTick(liDeps());
    expect(calls.map((x) => x.orgUrn)).toEqual([ORG, ORG, ORG]);
    await runLinkedInTick(liDeps());
    expect(calls.map((x) => x.orgUrn)).toEqual([ORG, ORG, ORG, ORG_AC, ORG_AC, ORG_AC]);
    for (const page of [PAGE, PAGE_AC]) {
      sameKeys(await keysOf(page), [pk(a), pk(c), pk(p)]);
      expect((await liRows(page)).map((r) => r.status)).toEqual(['POSTED', 'POSTED', 'POSTED']);
    }
    expect(MAX_PER_TICK).toBe(3);
  });
  it('a push between the two pages\' times is the new rule for Taxscan (08:00) and today\'s rule for Academy (08:30)', async () => {
    const course = await push(courseUrl('c'), ist(8, 15)); // not an article: only the new rule posts it
    const art = await article('a', ist(8, 20));
    await runLinkedInTick(liDeps());
    sameKeys(await keysOf(PAGE), [pk(course), pk(art)]);
    expect(await keysOf(PAGE_AC)).toEqual([articleKey(art)]); // the article by today's rule; the course not at all
  });
  it('the Academy time alone, with the Academy page not in the portal map, posts nothing there', async () => {
    await push(courseUrl('c'), after(60));
    await runLinkedInTick(liDeps({ portals: { [PORTAL]: [PAGE] }, allPushesFrom: { [PAGE]: null, [PAGE_AC]: PUSHES_AC } }));
    expect(calls).toEqual([]);
    expect(await liRows(PAGE_AC)).toEqual([]);
  });
});

describe('3. LinkedIn: no flood at switch-on', () => {
  it('past articles, backfill clones, courses and products before the time make no row; a pre-time article with no row still gets its one post, as today', async () => {
    const posted1 = await article('posted', before(120)); // 06:00, posted long ago
    await liRow(PAGE, articleKey(posted1), posted1, 'POSTED', { linkedinPostId: 'urn:li:share:old', postedAt: before(115) });
    await push(posted1.url, before(60)); // its backfill clone, 07:00
    const fresh = await article('fresh', before(50)); // 07:10: no row yet
    await push(fresh.url, before(40)); // its clone
    await push(courseUrl('c'), before(30)); // a course, twice, and a product, all before the time
    await push(courseUrl('c'), before(20));
    await push(productUrl('p'), before(10));
    const d = (allPushesFrom: LiDeps['allPushesFrom']) => liDeps({ ...ONE, allPushesFrom });
    const t1 = await runLinkedInTick(d({ [PAGE]: PUSHES }));
    expect(t1.posted).toBe(1); // only `fresh`: today's rule
    const keysOn = await keysOf(PAGE);
    sameKeys(keysOn, [articleKey(posted1), articleKey(fresh)]);
    expect(keysOn.some(isPushKey)).toBe(false);
    expect(pageCalls).toEqual([]);
    // the same data with the time UNSET gives the same rows and the same post
    await prisma.linkedInPost.deleteMany({ where: { page: PAGE, articleKey: articleKey(fresh) } });
    calls = [];
    await runLinkedInTick(d({ [PAGE]: null }));
    sameKeys(await keysOf(PAGE), keysOn);
    expect(calls).toHaveLength(1);
    // a push after the time starts the new rule
    const live = await push(courseUrl('live'), after(5));
    await runLinkedInTick(d({ [PAGE]: PUSHES }));
    sameKeys(await keysOf(PAGE), [...keysOn, pk(live)]);
  });
  it('a push before the time follows today\'s rule FOREVER: days later it still makes no new-rule row', async () => {
    const old = await push(courseUrl('c'), before(30));
    const oldArticle = await article('old', before(20));
    await runLinkedInTick(liDeps({ ...ONE, now: () => at(NOW, 3 * 24 * 60) }));
    expect(await keysOf(PAGE)).toEqual([articleKey(oldArticle)]);
    void old;
  });
  it('today\'s 14-day look-back still holds for pushes before the time, and does not apply after it: a clone of an article first pushed before go-live posts only under the new rule', async () => {
    const ancient = await article('ancient', ist(2, 0)); // before the page\'s own go-live (04:00): never posted
    await push(ancient.url, before(30), { title: ancient.title }); // its clone, after go-live but before the all-pushes time: still not posted
    const cloneAfter = await push(ancient.url, after(10), { title: ancient.title }); // after the time: every push posts
    await runLinkedInTick(liDeps(ONE));
    expect(await keysOf(PAGE)).toEqual([pk(cloneAfter)]);
    expect(calls).toHaveLength(1);
  });
  it('an all-pushes time EARLIER than the page\'s own go-live never reaches back before that go-live (the Academy page: 06:00 against its own 07:00)', async () => {
    await push(courseUrl('early'), ist(6, 30)); // after the all-pushes time, before the page\'s own go-live: never posted there
    const ok = await push(courseUrl('ok'), ist(7, 30));
    await runLinkedInTick(liDeps({ allPushesFrom: { [PAGE]: null, [PAGE_AC]: ist(6, 0) } }));
    expect(await keysOf(PAGE_AC)).toEqual([pk(ok)]);
    expect(await keysOf(PAGE)).toEqual([]); // the Taxscan page has no time: today\'s rule, and a course is not an article
  });
});

describe('4. LinkedIn: after the time, every push posts — repeats included', () => {
  it('the same article pushed twice (a clone, a Compose copy) and then the same campaign row sent again: three pushes, three posts', async () => {
    const a = await article('dup', after(10));
    const clone = await push(a.url, after(20), { title: a.title });
    await runLinkedInTick(liDeps(ONE));
    expect(calls).toHaveLength(2);
    sameKeys(await keysOf(PAGE), [pk(a), pk(clone)]);
    // the SAME campaign row sent again: its send time moves, so it is a new push
    const again = await prisma.campaign.update({ where: { id: a.id }, data: { lastSentAt: after(30) } });
    await runLinkedInTick(liDeps(ONE));
    expect(calls).toHaveLength(3);
    sameKeys(await keysOf(PAGE), [pk(a), pk(clone), pk(again)]);
    expect(new Set(await keysOf(PAGE)).size).toBe(3);
    await runLinkedInTick(liDeps(ONE));
    expect(calls).toHaveLength(3); // and nothing more
  });
  it('the same course with the same wording pushed twice posts twice', async () => {
    const c1 = await push(courseUrl('c'), after(10), { title: 'Seats are filling fast' });
    const c2 = await push(courseUrl('c'), after(20), { title: 'Seats are filling fast' });
    await runLinkedInTick(liDeps(ONE));
    expect(calls.map(headOf)).toEqual(['Seats are filling fast', 'Seats are filling fast']);
    sameKeys(await keysOf(PAGE), [pk(c1), pk(c2)]);
    await runLinkedInTick(liDeps(ONE));
    expect(calls).toHaveLength(2);
  });
  it('a morning backfill clone of an article that was already posted posts again', async () => {
    const orig = await article('yesterday', before(60)); // pushed (and posted) under today\'s rule
    await liRow(PAGE, articleKey(orig), orig, 'POSTED', { linkedinPostId: 'urn:li:share:orig', postedAt: before(55) });
    const clone = await push(orig.url, after(30), { title: orig.title }); // the clone, pushed after the time
    await runLinkedInTick(liDeps(ONE));
    expect(calls).toHaveLength(1);
    sameKeys(await keysOf(PAGE), [articleKey(orig), pk(clone)]);
    // and the clone of a push that was ITSELF posted under the new rule posts again too (the next morning)
    const nextMorning = await push(orig.url, after(24 * 60 + 30), { title: orig.title });
    await runLinkedInTick(liDeps({ ...ONE, now: () => at(NOW, 24 * 60) }));
    expect(calls).toHaveLength(2);
    sameKeys(await keysOf(PAGE), [articleKey(orig), pk(clone), pk(nextMorning)]);
  });
});

describe('5. LinkedIn: an article first pushed before the time and repeated after it', () => {
  it('whose first push is posted: the repeat posts once, the original is not posted again', async () => {
    const orig = await article('both', before(60));
    await liRow(PAGE, articleKey(orig), orig, 'POSTED', { linkedinPostId: 'urn:li:share:orig', postedAt: before(55) });
    const rep = await push(orig.url, after(15), { title: orig.title });
    await runLinkedInTick(liDeps(ONE));
    await runLinkedInTick(liDeps(ONE));
    expect(calls).toHaveLength(1);
    sameKeys(await keysOf(PAGE), [articleKey(orig), pk(rep)]);
  });
  it('whose first push has no row yet: the original still posts once (today\'s rule) and the repeat once (the new rule)', async () => {
    const orig = await article('both2', before(60));
    const rep = await push(orig.url, after(15), { title: orig.title });
    await runLinkedInTick(liDeps(ONE));
    expect(calls).toHaveLength(2);
    sameKeys(await keysOf(PAGE), [articleKey(orig), pk(rep)]);
    expect(calls.map(headOf)).toEqual([orig.title, orig.title]); // oldest first: the original, then the repeat
  });
});

describe('6. LinkedIn: what is NOT posted, and overlapping ticks', () => {
  it('home pages, section pages, other academy / shop pages, test-segment-only, drafts, other portals and a push with no send time make no row, no fetch, no post', async () => {
    const decoys = [
      'https://www.taxscan.in/',
      'https://www.taxscan.in/income-tax',
      'https://academy.taxscan.in/',
      'https://academy.taxscan.in/my-account/',
      'https://academy.taxscan.in/courses/',
      'https://academy.taxscan.in/course/',
      'https://shop.taxscan.in/',
      'https://shop.taxscan.in/collections/gst-books',
      `https://shop.taxscan.in/collections/gst-books/products/x-${RUN}`,
      'https://shop.taxscan.in/pages/contact',
      `http://shop.taxscan.in/products/x-${RUN}`,
    ];
    for (const [i, url] of decoys.entries()) await push(url, after(5 + i));
    const testOnly = { type: 'topics', topics: [env.testSegmentTopic] };
    await push(courseUrl('test-only'), after(30), { target: testOnly });
    await article('test-only-article', after(31), { target: testOnly });
    await push(courseUrl('draft'), after(32), { status: 'DRAFT' });
    await push(courseUrl('other-portal'), after(33), { portal: `${PORTAL}-x` });
    await push(courseUrl('never-sent'), null);
    for (let i = 0; i < 2; i += 1) await runLinkedInTick(liDeps());
    expect(await liRows(PAGE)).toEqual([]);
    expect(await liRows(PAGE_AC)).toEqual([]);
    expect(pageCalls).toEqual([]);
    expect(calls).toEqual([]);
    // the control: a good one beside them posts, so the decoys were not ignored for another reason
    await push(courseUrl('good'), after(40));
    await runLinkedInTick(liDeps());
    expect((await liRows(PAGE)).length).toBe(1);
  });
  it('two ticks at once never post the same push twice', async () => {
    const a = await article('race-a', after(10));
    const c = await push(courseUrl('race-c'), after(20));
    const p = await push(productUrl('race-p'), after(30));
    const slow: LiDeps = {
      post: async (r) => {
        await new Promise((res) => setTimeout(res, 15)); // widen the window in which the other tick looks
        return liPost(r);
      },
    };
    await Promise.all([runLinkedInTick(liDeps({ ...ONE, ...slow })), runLinkedInTick(liDeps({ ...ONE, ...slow }))]);
    expect(calls).toHaveLength(3);
    sameKeys(await keysOf(PAGE), [pk(a), pk(c), pk(p)]);
    expect((await liRows(PAGE)).every((r) => r.status === 'POSTED')).toBe(true);
  });
  it('an overlapping tick that created the row first is a quiet no-op (P2002), not a failure', async () => {
    const c = await push(courseUrl('gst-a'), after(30));
    const realCreate = prisma.linkedInPost.create.bind(prisma.linkedInPost);
    const create = jest.spyOn(prisma.linkedInPost, 'create').mockImplementationOnce((async (args: Parameters<typeof realCreate>[0]) => {
      await realCreate(args); // "the other tick" wins the race
      return realCreate(args); // ours collides on the unique (page, articleKey)
    }) as never);
    try {
      const t = await runLinkedInTick(liDeps(ONE));
      expect(t).toMatchObject({ posted: 0, failed: 0 });
      expect(calls).toEqual([]);
    } finally {
      create.mockRestore();
    }
    expect(await keysOf(PAGE)).toEqual([pk(c)]);
  });
});

describe('5 + 8. LinkedIn: the post a course or product push becomes', () => {
  it('commentary from the push, the link with this page\'s UTMs, the card from the page, the picture attached', async () => {
    const body = 'Join Rahul Pansari (CA) for GSTR-9/9C.\n- Live: 7 PM\nSeats @ 50% off #1';
    await push(`${courseUrl('hospitality')}?utm_source=izooto&utm_medium=push_notifications&utm_campaign=x&utm_content=y`, after(30), { title: T_TOMORROW, body });
    await runLinkedInTick(liDeps(ONE));
    expect(calls).toHaveLength(1);
    const c = calls[0];
    expect(c.commentary).toBe(buildStoreCommentary(T_TOMORROW, body));
    expect(c.title).toBe(COURSE_TAGS.title);
    expect(c.description!.length).toBeLessThanOrEqual(200);
    expect(c.thumbnail).toBe('urn:li:image:C9ZZ');
    const q = params(c.link);
    expect([q.get('utm_source'), q.get('utm_medium'), q.get('utm_campaign'), q.get('utm_content')]).toEqual(['taxscan-linkedin', 'social', `linkedin-${PAGE}`, `hospitality-${RUN}`.slice(0, 100)]);
    expect([...q.keys()].filter((k) => k.startsWith('utm_'))).toHaveLength(4);
    expect(pageCalls).toEqual([`https://academy.taxscan.in/course/hospitality-${RUN}/`]);
    expect(imageCalls).toEqual([COURSE_IMG]);
    expect(logs.some((l) => l.includes(`page=${PAGE}`) && l.includes('outcome=posted hashtags=fixed image=ok kind=course'))).toBe(true);
  });
  it('a product push: the shop page\'s title, description and (https) picture', async () => {
    await push(productUrl('ebook'), after(30), { title: T_GSTAT, body: 'Model formats for GST notices' });
    await runLinkedInTick(liDeps(ONE));
    expect(calls[0]).toMatchObject({ title: SHOP_TAGS.title, thumbnail: 'urn:li:image:C9ZZ' });
    expect(imageCalls).toEqual([SHOP_IMG]);
    expect(calls[0].commentary).toBe(buildStoreCommentary(T_GSTAT, 'Model formats for GST notices'));
    expect(logs.some((l) => l.includes('kind=product'))).toBe(true);
  });
  it('the page cannot be read: the post goes out with the push\'s own title and body for the card, no picture, the reason logged', async () => {
    pageScript = async () => ({ ok: false, reason: 'page_http_404' });
    await push(courseUrl('gst-a'), after(30), { title: T_MEGA, body: 'Early bird till Friday' });
    await runLinkedInTick(liDeps(ONE));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ title: '🚨MEGA AUDIT OFFER – 50% OFF + EXTRA 10% OFF! ! Training on …', description: 'Early bird till Friday' });
    expect(calls[0].thumbnail).toBeUndefined();
    expect(imageCalls).toEqual([]);
    expect(logs.some((l) => l.includes('outcome=posted hashtags=fixed image=none:page_http_404 kind=course'))).toBe(true);
    expect((await liRows(PAGE))[0].status).toBe('POSTED');
  });
  it('a page fetch that throws never fails the post (image=none:page_network)', async () => {
    pageScript = async () => {
      throw new Error('socket hang up');
    };
    await push(productUrl('ebook'), after(30));
    await runLinkedInTick(liDeps(ONE));
    expect(calls).toHaveLength(1);
    expect(logs.some((l) => l.includes('image=none:page_network kind=product'))).toBe(true);
    expect((await liRows(PAGE))[0]).toMatchObject({ status: 'POSTED', attempts: 1 });
  });
  it('an ARTICLE under the new rule is built exactly as under today\'s rule: the same call, field for field, and no page is fetched', async () => {
    const url = `https://www.taxscan.in/gst/same-article-${RUN}`;
    const cms = async () => ({ keywords: ['Section 69 CGST Act'], courts: [{ name: 'Supreme Court', shortName: 'SC' }], category: 'GST', coverImageUrl: 'https://documents.taxscan.in/cms/media/x.jpg', excerpt: 'An excerpt.' });
    const run = async (allPushesFrom: LiDeps['allPushesFrom']) => {
      await wipe();
      calls = [];
      pageCalls = [];
      logs.length = 0;
      await push(url, after(30), { title: 'The same article', body: 'The body.' });
      await runLinkedInTick(liDeps({ ...ONE, allPushesFrom, fetchCms: cms }));
      return { calls: calls.map((c) => ({ ...c })), outcome: logs.filter((l) => l.startsWith('[linkedin] page=')).map((l) => l.replace(/campaign=\S+/, 'campaign=X')), pageCalls: [...pageCalls] };
    };
    const today = await run({ [PAGE]: null });
    const fresh = await run({ [PAGE]: PUSHES });
    expect(fresh).toEqual(today);
    expect(today.calls).toHaveLength(1);
    expect(today.calls[0].commentary).toContain('Section69CGST');
    expect(today.calls[0].thumbnail).toBe('urn:li:image:C9ZZ');
    expect(today.pageCalls).toEqual([]);
    expect(today.outcome[0]).toContain('outcome=posted hashtags=cms image=ok');
    expect(today.outcome[0]).not.toContain('kind=');
  });
});

describe('9. LinkedIn: the picture is fail-open', () => {
  const imageVia = (f: typeof fetch): NonNullable<LiDeps['fetchImage']> => (u) => fetchCoverImage(u, f);
  const reasonLine = (reason: string) => logs.some((l) => l.includes(`outcome=posted hashtags=fixed image=none:${reason} kind=product`));
  async function postOne(over: LiDeps = {}) {
    await push(productUrl('ebook'), after(30), { title: T_GSTAT });
    await runLinkedInTick(liDeps({ ...ONE, ...over }));
    expect(calls).toHaveLength(1); // the post goes out whatever happened to the picture
    expect(calls[0].thumbnail).toBeUndefined();
    expect((await liRows(PAGE))[0]).toMatchObject({ status: 'POSTED', attempts: 1 });
  }
  it('secure_url is preferred end to end: the https file is the one downloaded and uploaded (real parser, real image fetch, mocked network)', async () => {
    const pageUrls: string[] = [];
    const imgUrls: string[] = [];
    const pageNet = (async (u: string) => (pageUrls.push(u), new Response(SHOP_HTML, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }))) as unknown as typeof fetch;
    const imgNet = (async (u: string) => (imgUrls.push(u), new Response(new Uint8Array([0xff, 0xd8, 1, 2]), { status: 200, headers: { 'content-type': 'image/jpeg' } }))) as unknown as typeof fetch;
    await push(productUrl('ebook'), after(30));
    await runLinkedInTick(liDeps({ ...ONE, fetchStorePage: (u) => fetchStorePage(u, pageNet), fetchImage: imageVia(imgNet) }));
    expect(pageUrls).toEqual([`https://shop.taxscan.in/products/ebook-${RUN}/`]);
    expect(imgUrls).toEqual([SHOP_IMG]); // never the http og:image
    expect(calls[0]).toMatchObject({ thumbnail: 'urn:li:image:C9ZZ', title: SHOP_TAGS.title });
    expect(uploads).toEqual([{ orgUrn: ORG, accessToken: TOKEN }]);
  });
  it('og:image over http only → no picture, no image download, image=none:not_https', async () => {
    pageScript = async () => ({ ok: true, tags: { ...SHOP_TAGS, imageUrl: null, imageReason: 'not_https' } });
    await postOne();
    expect(imageCalls).toEqual([]);
    expect(reasonLine('not_https')).toBe(true);
  });
  it('no og:image tag → image=none:no_tag', async () => {
    pageScript = async () => ({ ok: true, tags: { ...SHOP_TAGS, imageUrl: null, imageReason: 'no_tag' } });
    await postOne();
    expect(reasonLine('no_tag')).toBe(true);
  });
  it('a picture host off the allowlist → no download at all, image=none:host', async () => {
    pageScript = async () => ({ ok: true, tags: { ...SHOP_TAGS, imageUrl: 'https://cdn.example.org/x.jpg' } });
    const net = jest.fn(async () => new Response('x')) as unknown as typeof fetch;
    await postOne({ fetchImage: imageVia(net) });
    expect(net).not.toHaveBeenCalled();
    expect(reasonLine('host')).toBe(true);
  });
  it('a redirect on the picture → image=none:redirect', async () => {
    const net = (async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: new Error('unexpected redirect') });
    }) as unknown as typeof fetch;
    await postOne({ fetchImage: imageVia(net) });
    expect(reasonLine('redirect')).toBe(true);
  });
  it('a timeout on the picture → image=none:timeout', async () => {
    const net = (async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }) as unknown as typeof fetch;
    await postOne({ fetchImage: imageVia(net) });
    expect(reasonLine('timeout')).toBe(true);
  });
  it('a 404 on the picture → image=none:http_404', async () => {
    const net = (async () => new Response('gone', { status: 404 })) as unknown as typeof fetch;
    await postOne({ fetchImage: imageVia(net) });
    expect(reasonLine('http_404')).toBe(true);
  });
  it.each([
    ['page_timeout', { ok: false, reason: 'page_timeout' } as StorePageResult],
    ['page_redirect', { ok: false, reason: 'page_redirect' } as StorePageResult],
    ['page_http_404', { ok: false, reason: 'page_http_404' } as StorePageResult],
    ['page_host', { ok: false, reason: 'page_host' } as StorePageResult],
  ])('the page itself fails (%s) → posted without a picture, image=none:%s', async (reason, result) => {
    pageScript = async () => result;
    await postOne();
    expect(reasonLine(reason)).toBe(true);
    expect(imageCalls).toEqual([]);
  });
  it('the picture upload failing softly never stops the post; a 401 / 403 from the registration is a login stop with NO post call', async () => {
    await push(productUrl('ebook'), after(30));
    await runLinkedInTick(liDeps({ ...ONE, uploadImage: async () => ({ kind: 'soft', reason: 'init_http_500' }) }));
    expect(calls).toHaveLength(1);
    expect(calls[0].thumbnail).toBeUndefined();
    expect(logs.some((l) => l.includes('image=none:init_http_500 kind=product'))).toBe(true);

    await wipe();
    calls = [];
    resetLinkedInStops();
    await push(productUrl('ebook-2'), after(30));
    const t = await runLinkedInTick(liDeps({ ...ONE, uploadImage: async () => ({ kind: 'auth', status: 401, error: 'HTTP 401 (image upload)' }) }));
    expect(t.authStopped).toBe(true);
    expect(calls).toEqual([]);
    expect(await liLoginProblem(PAGE)).toMatchObject({ status: 401 });
  });
});

describe('12. LinkedIn: a 429 on the image status poll still publishes the post, picture attached unverified, with no retry loop', () => {
  it('for a course / product post under the new rule (the article version is in linkedinWorker.test.ts)', async () => {
    await push(courseUrl('gst-a'), after(30));
    const polled: string[] = [];
    const sleeps: number[] = [];
    const s429 = (async (u: string) => (polled.push(u), { ok: false, status: 429, headers: new Headers({ 'retry-after': '3600' }), json: async () => ({ message: 'Too many requests' }) } as unknown as Response)) as unknown as typeof fetch;
    expect(isUnverifiedImage('status_429')).toBe(true);
    await runLinkedInTick(liDeps({ ...ONE, waitImage: (r) => waitForImage(r, s429, async (ms) => void sleeps.push(ms)) }));
    expect(polled).toEqual(['https://api.linkedin.com/rest/images/urn%3Ali%3Aimage%3AC9ZZ']); // one look
    expect(sleeps).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0].thumbnail).toBe('urn:li:image:C9ZZ');
    expect(logs.some((l) => l.includes('outcome=posted hashtags=fixed image=ok:unverified kind=course'))).toBe(true);
    expect((await liRows(PAGE))[0]).toMatchObject({ status: 'POSTED', attempts: 1 });
  });
});

describe('10. LinkedIn: LinkedIn\'s duplicate answer is a plain FAILED — no retry, no repeat without the picture, no stop, no alert', () => {
  const dup: LinkedInResult = { kind: 'duplicate', status: 422, error: 'HTTP 422: com.linkedin.content.common.exception.BadRequestResponseException: Content is a duplicate of urn:li:share:7141138937766391808' };
  it('the row says so in plain words; the same push is not tried again; the next push posts', async () => {
    const first = await push(courseUrl('dup'), after(10), { title: 'Same words' });
    const next = await push(productUrl('next'), after(20));
    script = (_r, n) => (n === 1 ? dup : posted());
    const t1 = await runLinkedInTick(liDeps(ONE));
    expect(t1).toMatchObject({ failed: 1, posted: 1, authStopped: false });
    const rows = await liRows(PAGE);
    expect(rows.find((r) => r.campaignId === first.id)).toMatchObject({ status: 'FAILED', error: 'LinkedIn says this was already posted', attempts: 1, nextAttemptAt: null });
    expect(rows.find((r) => r.campaignId === next.id)).toMatchObject({ status: 'POSTED' });
    expect(LI_DUPLICATE).toBe('LinkedIn says this was already posted');
    expect(calls).toHaveLength(2); // ONE call for the duplicate (not repeated without its picture), one for the next push
    expect(calls[0].thumbnail).toBe('urn:li:image:C9ZZ');
    expect(mails).toEqual([]); // no alert
    expect(await liLoginProblem(PAGE)).toBeNull(); // no login stop
    expect(logs.some((l) => l.includes('reason=duplicate') && l.includes('kind=course'))).toBe(true);
    // nothing retries it, however long we wait
    for (const m of [1, 5, 15, 60, 600]) await runLinkedInTick(liDeps({ ...ONE, now: () => at(NOW, m) }));
    expect(calls).toHaveLength(2);
    // a later push still posts
    await push(courseUrl('later'), at(NOW, 30));
    await runLinkedInTick(liDeps({ ...ONE, now: () => at(NOW, 31) }));
    expect(calls).toHaveLength(3);
  });
  it('an ARTICLE push that LinkedIn calls a duplicate (an identical backfill clone) is the same: FAILED, plain reason, nothing else', async () => {
    const a = await article('same', after(10));
    await push(a.url, after(20), { title: a.title });
    script = (_r, n) => (n === 2 ? dup : posted());
    const t = await runLinkedInTick(liDeps(ONE));
    expect(t).toMatchObject({ posted: 1, failed: 1, authStopped: false });
    expect((await liRows(PAGE)).map((r) => r.status).sort()).toEqual(['FAILED', 'POSTED']);
    expect((await liRows(PAGE)).find((r) => r.status === 'FAILED')).toMatchObject({ error: LI_DUPLICATE, nextAttemptAt: null });
    expect(mails).toEqual([]);
  });
  it('a picture-related rejection is still repeated once without the picture; when THAT answer is the duplicate, the row says duplicate', async () => {
    await push(courseUrl('c'), after(10));
    script = (_r, n) => (n === 1 ? failed422 : dup);
    await runLinkedInTick(liDeps(ONE));
    expect(calls).toHaveLength(2);
    expect(calls[0].thumbnail).toBe('urn:li:image:C9ZZ');
    expect(calls[1].thumbnail).toBeUndefined();
    expect((await liRows(PAGE))[0]).toMatchObject({ status: 'FAILED', error: LI_DUPLICATE });
    expect(logs.some((l) => l.includes('reason=duplicate image=dropped:422 kind=course'))).toBe(true);
  });
  it('Retry on the failed duplicate posts it again and reports what LinkedIn says (a duplicate again → FAILED, the same plain reason)', async () => {
    const c = await push(courseUrl('c'), after(10));
    script = () => dup;
    await runLinkedInTick(liDeps(ONE));
    const row = (await liRows(PAGE))[0];
    expect(await liRetry(row.id, liDeps(ONE))).toEqual({ ok: true, status: 'FAILED' });
    expect((await liRows(PAGE))[0]).toMatchObject({ status: 'FAILED', error: LI_DUPLICATE, campaignId: c.id });
    expect(mails).toEqual([]);
  });
});

describe('10. LinkedIn client: how the duplicate answer is recognised', () => {
  const real = {
    errorDetailType: 'com.linkedin.common.error.BadRequest',
    message: 'com.linkedin.content.common.exception.BadRequestResponseException: Content is a duplicate of urn:li:share:7141138937766391808',
    errorDetails: { inputErrors: [{ description: 'Duplicate post is detected', input: { inputPath: { fieldPath: '/' } }, code: 'DUPLICATE_POST' }] },
    status: 422,
  };
  const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  const req = { orgUrn: ORG, accessToken: TOKEN, commentary: 'c', title: 't', link: 'https://www.taxscan.in/gst/x' };
  it('the real 422 body is a duplicate (not a retry, not a login error), and nothing secret reaches the verdict', async () => {
    const r = await postToLinkedIn(req, answer(422, real));
    expect(r).toMatchObject({ kind: 'duplicate', status: 422 });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });
  it('the code at the top level, or the message alone, is a duplicate too — but only on a 422', () => {
    expect(isDuplicateAnswer(422, { code: 'DUPLICATE_POST' })).toBe(true);
    expect(isDuplicateAnswer(422, { message: 'Content is a duplicate of urn:li:share:1' })).toBe(true);
    expect(isDuplicateAnswer(422, real)).toBe(true);
    for (const status of [400, 401, 403, 409, 429, 500, 200]) expect(isDuplicateAnswer(status, real)).toBe(false);
  });
  it('other 422s, other bodies and non-JSON are not duplicates; the old verdicts are unchanged', async () => {
    expect(isDuplicateAnswer(422, { message: 'field commentary is required', errorDetails: { inputErrors: [{ code: 'MISSING_FIELD' }] } })).toBe(false);
    expect(isDuplicateAnswer(422, null)).toBe(false);
    expect(isDuplicateAnswer(422, 'DUPLICATE_POST')).toBe(false);
    expect(await postToLinkedIn(req, answer(422, { message: 'field commentary is required' }))).toMatchObject({ kind: 'failed', status: 422 });
    expect(await postToLinkedIn(req, answer(429, real))).toMatchObject({ kind: 'retry' }); // only a 422 can be a duplicate
    expect(await postToLinkedIn(req, answer(403, { message: 'nope' }))).toMatchObject({ kind: 'auth' });
    expect(await postToLinkedIn(req, answer(500, {}))).toMatchObject({ kind: 'retry' });
    const notJson = (async () => new Response('<html>422</html>', { status: 422 })) as unknown as typeof fetch;
    expect(await postToLinkedIn(req, notJson)).toMatchObject({ kind: 'failed', status: 422 });
    const created = (async () => new Response('{}', { status: 201, headers: { 'x-restli-id': 'urn:li:share:9' } })) as unknown as typeof fetch;
    expect(await postToLinkedIn(req, created)).toEqual({ kind: 'posted', postId: 'urn:li:share:9' });
  });
});

describe('11. LinkedIn: MAX_PER_TICK and the order hold across every kind of push and both rules', () => {
  it('articles, courses, products and clones waiting together: the 3 oldest first, whatever the kind, then the rest next tick', async () => {
    const a1 = await article('a1', after(10));
    const s1 = await push(courseUrl('s1'), after(15), { title: 'Course one' });
    await push(a1.url, after(20), { title: 'Story a1' }); // a clone of a1
    const s2 = await push(productUrl('s2'), after(25), { title: 'Product two' });
    const a3 = await article('a3', after(30));
    const s3 = await push(courseUrl('s3'), after(35), { title: 'Course three' });
    const t1 = await runLinkedInTick(liDeps(ONE));
    expect(t1.posted).toBe(MAX_PER_TICK);
    expect(calls.map(headOf)).toEqual(['Story a1', 'Course one', 'Story a1']);
    const t2 = await runLinkedInTick(liDeps(ONE));
    expect(t2.posted).toBe(3);
    expect(calls.map(headOf)).toEqual(['Story a1', 'Course one', 'Story a1', 'Product two', 'Story a3', 'Course three']);
    expect((await liRows(PAGE)).length).toBe(6);
    void [s1, s2, a3, s3];
  });
  it('a pre-time article that is still waiting goes out in its place among the new-rule pushes: oldest first across both rules', async () => {
    const old = await article('old', before(30)); // 07:30: today's rule, no row yet
    const c1 = await push(courseUrl('c1'), after(10), { title: 'Course one' });
    const a2 = await article('a2', after(20));
    const clone = await push(old.url, after(30), { title: old.title }); // the clone of the old article, after the time
    const p1 = await push(productUrl('p1'), after(40), { title: 'Product one' });
    await runLinkedInTick(liDeps(ONE));
    expect(calls.map(headOf)).toEqual([old.title, 'Course one', 'Story a2']);
    await runLinkedInTick(liDeps(ONE));
    expect(calls.map(headOf)).toEqual([old.title, 'Course one', 'Story a2', old.title, 'Product one']);
    sameKeys(await keysOf(PAGE), [articleKey(old), pk(c1), pk(a2), pk(clone), pk(p1)]);
  });
});

describe('11. LinkedIn: a login error stops that page — every kind of post — and only that page', () => {
  it('a 403 on Academy stops Academy\'s posts (articles, courses, products) and nothing on Taxscan; the stop clears when the token changes or the app restarts', async () => {
    const a = await article('a1', at(NOW, -60)); // 09:00, after both pages\' times
    const c = await push(courseUrl('c1'), at(NOW, -50));
    script = only(ORG_AC, auth403);
    const t1 = await runLinkedInTick(liDeps());
    expect(t1.authStopped).toBe(true);
    // Taxscan posted both; Academy made ONE attempt (its oldest push), which was refused
    expect(calls.map((x) => x.orgUrn)).toEqual([ORG, ORG, ORG_AC]);
    expect(await liLoginProblem(PAGE_AC)).toMatchObject({ status: 403 });
    expect(await liLoginProblem(PAGE)).toBeNull();
    sameKeys(await keysOf(PAGE), [pk(a), pk(c)]);
    expect(await liRows(PAGE_AC)).toHaveLength(1); // the course was never even claimed
    expect((await liRows(PAGE_AC))[0]).toMatchObject({ articleKey: pk(a), status: 'PENDING', attempts: 0 });
    expect(mails).toHaveLength(1); // one alert, naming the Academy page
    expect(mails[0].subject).toContain(PAGE_AC); // the alert names the stopped page
    // later ticks: nothing goes to Academy while it is stopped; a new push still posts on Taxscan
    calls = [];
    const p = await push(productUrl('p1'), at(NOW, -40));
    const t2 = await runLinkedInTick(liDeps());
    expect(t2.authStopped).toBe(true);
    expect(calls.map((x) => x.orgUrn)).toEqual([ORG]);
    // the stop clears with a restart / a new token: Academy then posts what it was holding
    resetLinkedInStops();
    script = () => posted('urn:li:share:AC');
    calls = [];
    await runLinkedInTick(liDeps());
    expect(calls.every((x) => x.orgUrn === ORG_AC)).toBe(true);
    sameKeys(await keysOf(PAGE_AC), [pk(a), pk(c), pk(p)]);
    expect((await liRows(PAGE_AC)).every((r) => r.status === 'POSTED')).toBe(true);
  });
  it('a 403 met by a course first stops the page\'s articles too', async () => {
    await push(courseUrl('c1'), at(NOW, -60));
    await article('a1', at(NOW, -50));
    script = only(ORG_AC, auth403);
    const t = await runLinkedInTick(liDeps({ allPushesFrom: { [PAGE]: null, [PAGE_AC]: PUSHES_AC } }));
    expect(t.authStopped).toBe(true);
    // Taxscan (today's rule): its article; Academy (new rule): only the course was attempted (refused), the article behind it was not
    expect(calls.map((x) => [x.orgUrn, headOf(x).startsWith('Story') ? 'article' : 'course'])).toEqual([
      [ORG, 'article'],
      [ORG_AC, 'course'],
    ]);
    expect(await liLoginProblem(PAGE_AC)).toMatchObject({ status: 403 });
  });
});

describe('11. LinkedIn: retries, Retry and Skip work on the rows of every kind of push', () => {
  it('a 429 on a course retries at +1 minute through the course builder (the page is read again), then posts', async () => {
    const c = await push(courseUrl('gst-a'), after(30));
    script = (_r, n) => (n === 1 ? retry429 : posted());
    await runLinkedInTick(liDeps(ONE));
    const row = (await liRows(PAGE))[0];
    expect(row).toMatchObject({ status: 'PENDING', attempts: 1, error: 'HTTP 429', campaignId: c.id, articleKey: pk(c) });
    expect(row.nextAttemptAt).toEqual(at(NOW, 1));
    await runLinkedInTick(liDeps({ ...ONE, now: () => at(NOW, 1) }));
    expect(calls).toHaveLength(2);
    expect(calls[1].commentary).toBe(calls[0].commentary);
    expect(pageCalls).toHaveLength(2);
    expect((await liRows(PAGE))[0]).toMatchObject({ status: 'POSTED', attempts: 2 });
    expect(logs.some((l) => l.includes('outcome=retry attempt=1') && l.endsWith('kind=course'))).toBe(true);
  });
  it('a refused product post (422) is FAILED; Retry posts it now with the product builder; the push is not posted a second time', async () => {
    const c = await push(productUrl('ebook'), after(30), { title: T_GSTAT, body: 'Model formats' });
    script = () => failed422;
    await runLinkedInTick(liDeps(ONE));
    expect((await liRows(PAGE))[0]).toMatchObject({ status: 'FAILED', error: 'HTTP 422: invalid content' });
    script = () => posted('urn:li:share:RETRIED');
    const row = (await liRows(PAGE))[0];
    expect(await liRetry(row.id, liDeps(ONE))).toEqual({ ok: true, status: 'POSTED' });
    const last = calls[calls.length - 1];
    expect(last.commentary).toBe(buildStoreCommentary(T_GSTAT, 'Model formats'));
    expect(last.title).toBe(SHOP_TAGS.title);
    expect((await liRows(PAGE))[0]).toMatchObject({ status: 'POSTED', linkedinPostId: 'urn:li:share:RETRIED', campaignId: c.id });
    const n = calls.length;
    await runLinkedInTick(liDeps(ONE));
    expect(calls).toHaveLength(n);
  });
  it('Retry on a failed ARTICLE row of the new rule uses the article builder', async () => {
    const a = await article('a1', after(30));
    await liRow(PAGE, pk(a), a, 'FAILED', { attempts: 4, error: 'HTTP 500' });
    const row = (await liRows(PAGE))[0];
    expect(await liRetry(row.id, liDeps(ONE))).toEqual({ ok: true, status: 'POSTED' });
    expect(calls[0].commentary).toContain('{hashtag|\\#|taxscan}');
    expect(pageCalls).toEqual([]);
    expect(logs.some((l) => l.includes('outcome=posted hashtags=fallback') && !l.includes('kind='))).toBe(true);
  });
  it('a row whose link no longer qualifies fails with its own words instead of posting', async () => {
    const c = await push(courseUrl('gst-a'), after(30));
    await liRow(PAGE, pk(c), c, 'FAILED', { attempts: 4, error: 'x' });
    env.allowedPushHosts = saved.hosts.filter((h) => h !== 'academy.taxscan.in');
    const row = (await liRows(PAGE))[0];
    expect(await liRetry(row.id, liDeps())).toEqual({ ok: true, status: 'FAILED' });
    expect((await liRows(PAGE))[0].error).toBe('not a course or shop product link, or the link is not allowed');
    expect(calls).toEqual([]);
  });
});

/* ================================================================== */
/* Facebook: the worker                                                 */
/* ================================================================== */

/** Ticks `n` minutes apart from `start` (the gap between two posts is 10 minutes, so most tests space them 11 apart). */
async function fbTicks(times: number[], over: FbDeps = {}) {
  const out = [];
  for (const m of times) out.push(await runFacebookTick(fbDeps({ now: () => at(NOW, m), ...over })));
  return out;
}
const fbKeys = async () => (await fbRows()).map((r) => r.articleKey);

describe('1. Facebook: no all-pushes time → no new-rule row, the tick exactly as today', () => {
  it.each([[undefined], [null]])('allPushesFrom %j: only the article posts (once); its clone, a course and a product make nothing', async (allPushesFrom) => {
    const art = await article('a1', at(NOW, -90));
    await push(art.url, at(NOW, -60));
    await push(courseUrl('c'), at(NOW, -50));
    await push(productUrl('p'), at(NOW, -40));
    await fbTicks([0, 11, 22, 33], { allPushesFrom: allPushesFrom as FbDeps['allPushesFrom'] });
    expect(await fbKeys()).toEqual([articleKey(art)]);
    expect(fbCalls).toHaveLength(1);
  });
  it('the env variable alone turns the page on', async () => {
    env.facebook.allPushesFrom = PUSHES_FB;
    const c = await push(courseUrl('c'), after(10));
    await fbTicks([0], { allPushesFrom: undefined });
    expect(await fbKeys()).toEqual([pk(c)]);
  });
});

describe('2. Facebook: every push posts — one per tick, at least 10 minutes apart, under the page id', () => {
  it('an article, a course and a product: three rows, three posts, the push\'s own wording and Facebook\'s UTMs', async () => {
    const a = await article('a', at(NOW, -60));
    const c = await push(courseUrl('gst-a'), at(NOW, -50), { title: T_TOMORROW, body: 'Join (CA) @ 7 PM\n- Live' });
    const p = await push(productUrl('ebook-a'), at(NOW, -40), { title: T_GSTAT, body: 'Model formats' });
    const [t1] = await fbTicks([0]);
    expect(t1.posted).toBe(1);
    expect(fbCalls[0]).toMatchObject({ pageId: FB_PAGE_ID, accessToken: FB_TOKEN });
    expect(fbCalls[0].message.split('\n')[0]).toBe('Story a');
    // the gap: nothing at +5 minutes, the next at +10, the next at +20
    expect((await fbTicks([5]))[0].waited).toBe('gap');
    expect(fbCalls).toHaveLength(1);
    expect((await fbTicks([10]))[0].posted).toBe(1);
    expect(fbCalls[1].message).toBe('🚨COURSE STARTS TOMORROW 7 PM 🚨\n\nJoin (CA) @ 7 PM\n- Live\n\n#taxscan');
    const q = params(fbCalls[1].link);
    expect([q.get('utm_source'), q.get('utm_medium'), q.get('utm_campaign'), q.get('utm_content')]).toEqual(['taxscan-facebook', 'social', `facebook-${FB_PAGE}`, `gst-a-${RUN}`]);
    expect((await fbTicks([20]))[0].posted).toBe(1);
    expect(fbCalls[2].message).toBe(`${T_GSTAT}\n\nModel formats\n\n#taxscan`);
    sameKeys(await fbKeys(), [pk(a), pk(c), pk(p)]);
    expect(logs.some((l) => l.includes(`[facebook] page=${FB_PAGE}`) && l.includes('outcome=posted hashtags=fixed kind=course'))).toBe(true);
    expect(logs.some((l) => l.includes('kind=product'))).toBe(true);
  });
  it('an article under the new rule is built exactly as under today\'s rule (the same call), and no page is fetched or uploaded', async () => {
    const net = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in tests'));
    try {
      const url = `https://www.taxscan.in/gst/fb-same-${RUN}`;
      const run = async (allPushesFrom: FbDeps['allPushesFrom']) => {
        await wipe();
        fbCalls = [];
        await push(url, after(30), { title: 'The same article', body: 'b' });
        await fbTicks([0], { allPushesFrom });
        return fbCalls.map((c) => ({ ...c }));
      };
      const today = await run(null);
      expect(await run(PUSHES_FB)).toEqual(today);
      expect(today).toHaveLength(1);
      expect(net).not.toHaveBeenCalled();
    } finally {
      net.mockRestore();
    }
  });
  it('each switch alone affects only its own channel: the Facebook time alone makes no LinkedIn post of a course, and the LinkedIn times alone make no Facebook post of it', async () => {
    await push(courseUrl('only-fb'), at(NOW, -30));
    await runLinkedInTick(liDeps({ allPushesFrom: { [PAGE]: null, [PAGE_AC]: null } }));
    await runFacebookTick(fbDeps()); // Facebook has its time
    expect(calls).toEqual([]);
    expect(await liRows(PAGE)).toEqual([]);
    expect(await liRows(PAGE_AC)).toEqual([]);
    expect(fbCalls).toHaveLength(1);

    await wipe();
    calls = [];
    fbCalls = [];
    await push(courseUrl('only-li'), at(NOW, -30));
    await runFacebookTick(fbDeps({ allPushesFrom: null }));
    await runLinkedInTick(liDeps()); // both LinkedIn pages have theirs
    expect(fbCalls).toEqual([]);
    expect(await fbRows()).toEqual([]);
    expect(calls.map((x) => x.orgUrn)).toEqual([ORG, ORG_AC]);
  });
  it('all three pages: ONE course push is one post on each LinkedIn page and one on Facebook, under the right org URN and page id', async () => {
    await push(courseUrl('c'), at(NOW, -30));
    await runLinkedInTick(liDeps());
    await runFacebookTick(fbDeps());
    expect(calls.map((x) => x.orgUrn)).toEqual([ORG, ORG_AC]);
    expect(fbCalls.map((x) => x.pageId)).toEqual([FB_PAGE_ID]);
    expect(await liRows(PAGE)).toHaveLength(1);
    expect(await liRows(PAGE_AC)).toHaveLength(1);
    expect(await fbRows()).toHaveLength(1);
  });
});

describe('3 + 4 + 5. Facebook: no flood at switch-on, then repeats post', () => {
  it('pushes before the time make no new-rule row; a pre-time article with no row still posts once; after the time a clone and a repeated course post again', async () => {
    const done = await article('done', before(120));
    await fbRow(articleKey(done), done, 'POSTED', { facebookPostId: '1_1', postedAt: before(115) });
    await push(done.url, before(60)); // its backfill clone, before the time
    const fresh = await article('fresh', before(50)); // no row yet
    await push(courseUrl('c'), before(30));
    await push(productUrl('p'), before(10));
    await fbTicks([0, 11, 22]);
    sameKeys(await fbKeys(), [articleKey(done), articleKey(fresh)]);
    expect(fbCalls).toHaveLength(1);
    // after the time: the same course twice, a clone of the already-posted article, an article first pushed before and repeated after
    const c1 = await push(courseUrl('again'), after(5), { title: 'Same words' });
    const c2 = await push(courseUrl('again'), after(10), { title: 'Same words' });
    const clone = await push(done.url, after(15), { title: done.title });
    const rep = await push(fresh.url, after(20), { title: fresh.title });
    await fbTicks([33, 44, 55, 66, 77]);
    sameKeys(await fbKeys(), [articleKey(done), articleKey(fresh), pk(c1), pk(c2), pk(clone), pk(rep)]);
    expect(fbCalls).toHaveLength(5);
    await fbTicks([88, 99]);
    expect(fbCalls).toHaveLength(5); // and nothing more
  });
  it('today\'s 14-day look-back still holds before the time and does not apply after it', async () => {
    const ancient = await article('ancient', ist(2, 0)); // before FACEBOOK_POST_FROM (04:00): never posted
    await push(ancient.url, before(30), { title: ancient.title }); // its clone before the all-pushes time: still not posted
    const cloneAfter = await push(ancient.url, after(10), { title: ancient.title });
    await fbTicks([0, 11, 22]);
    expect(await fbKeys()).toEqual([pk(cloneAfter)]);
    expect(fbCalls).toHaveLength(1);
  });
  it('an all-pushes time EARLIER than FACEBOOK_POST_FROM never reaches back before the go-live', async () => {
    await push(courseUrl('early'), ist(3, 30)); // after the all-pushes time (03:00), before the page\'s go-live (04:00)
    const ok = await push(courseUrl('ok'), ist(4, 30));
    await fbTicks([0, 11, 22], { allPushesFrom: ist(3, 0) });
    expect(await fbKeys()).toEqual([pk(ok)]);
    expect(fbCalls).toHaveLength(1);
  });
  it('the same campaign row sent again is a new push and posts again', async () => {
    const c = await push(courseUrl('c'), after(10));
    await fbTicks([0]);
    await prisma.campaign.update({ where: { id: c.id }, data: { lastSentAt: after(20) } });
    await fbTicks([11]);
    expect(fbCalls).toHaveLength(2);
    expect(new Set(await fbKeys()).size).toBe(2);
  });
});

describe('6. Facebook: what is NOT posted', () => {
  it('the decoys make no row and no post; two ticks at once never post a push twice', async () => {
    const urls = ['https://www.taxscan.in/', 'https://www.taxscan.in/income-tax', 'https://academy.taxscan.in/', 'https://academy.taxscan.in/courses/', 'https://shop.taxscan.in/', 'https://shop.taxscan.in/collections/gst-books', `https://shop.taxscan.in/collections/gst-books/products/x-${RUN}`, `http://shop.taxscan.in/products/x-${RUN}`];
    for (const [i, url] of urls.entries()) await push(url, after(5 + i));
    const testOnly = { type: 'topics', topics: [env.testSegmentTopic] };
    await push(courseUrl('test-only'), after(30), { target: testOnly });
    await article('test-only-article', after(31), { target: testOnly });
    await push(courseUrl('draft'), after(32), { status: 'DRAFT' });
    await push(courseUrl('other-portal'), after(33), { portal: `${PORTAL}-x` });
    await push(courseUrl('never-sent'), null);
    await fbTicks([0, 11, 22]);
    expect(await fbRows()).toEqual([]);
    expect(fbCalls).toEqual([]);
    const good1 = await push(courseUrl('good1'), after(40));
    const good2 = await push(productUrl('good2'), after(41));
    const slow: FbDeps = {
      post: async (r) => {
        await new Promise((res) => setTimeout(res, 15));
        return fbPost(r);
      },
      minGapMinutes: 0,
    };
    await Promise.all([runFacebookTick(fbDeps(slow)), runFacebookTick(fbDeps(slow))]);
    await Promise.all([runFacebookTick(fbDeps({ ...slow, now: () => at(NOW, 2) })), runFacebookTick(fbDeps({ ...slow, now: () => at(NOW, 2) }))]);
    expect(fbCalls).toHaveLength(2); // each push once, whatever overlapped
    sameKeys(await fbKeys(), [pk(good1), pk(good2)]);
  });
});

describe('10. Facebook: the duplicate answer (code 506) is a plain FAILED — no retry, no stop, no alert', () => {
  it('the row says "Facebook says this was already posted"; neither stop is set; no mail; the next push posts', async () => {
    const first = await push(courseUrl('dup'), after(10), { title: 'Same words' });
    const next = await push(productUrl('next'), after(20));
    fbScript = (n) => (n === 1 ? fbFail('duplicate', 400, 506) : fbPosted());
    const t1 = (await fbTicks([0]))[0];
    expect(t1).toMatchObject({ failed: 1, posted: 0, authStopped: false, policyStopped: false });
    expect((await fbRows())[0]).toMatchObject({ campaignId: first.id, status: 'FAILED', error: FB_DUPLICATE, attempts: 1, nextAttemptAt: null });
    expect(FB_DUPLICATE).toBe('Facebook says this was already posted');
    expect(await policyProblem(FB_PAGE)).toBeNull();
    expect(await fbLoginProblem(FB_PAGE)).toBeNull();
    expect(mails).toEqual([]);
    expect(logs.some((l) => l.includes('reason=duplicate') && l.includes('kind=course'))).toBe(true);
    // not retried, however long we wait; the next push posts
    const t2 = (await fbTicks([11]))[0];
    expect(t2.posted).toBe(1);
    expect((await fbRows()).find((r) => r.campaignId === next.id)).toMatchObject({ status: 'POSTED' });
    await fbTicks([22, 33, 600]);
    expect(fbCalls).toHaveLength(2);
  });
  it('an ARTICLE refused as a duplicate is the same', async () => {
    const a = await article('same', after(10));
    await push(a.url, after(20), { title: a.title });
    fbScript = (n) => (n === 2 ? fbFail('duplicate', 400, 506) : fbPosted());
    await fbTicks([0, 11]);
    expect((await fbRows()).map((r) => r.status).sort()).toEqual(['FAILED', 'POSTED']);
    expect(await policyProblem(FB_PAGE)).toBeNull();
    expect(mails).toEqual([]);
  });
});

describe('11. Facebook: stops, the gap, the daily cap and the order hold across every kind of push', () => {
  it('a policy block on a course stops the page until an ADMIN resumes; the next waiting push (any kind) then goes out', async () => {
    const s = await push(courseUrl('gst-a'), after(10));
    const a = await article('a1', after(20));
    fbScript = (n) => (n === 1 ? fbFail('policy', 400, 368) : fbPosted());
    const t1 = (await fbTicks([0]))[0];
    expect(t1.policyStopped).toBe(true);
    expect((await fbRows())[0]).toMatchObject({ campaignId: s.id, status: 'FAILED' });
    expect(await policyProblem(FB_PAGE)).toMatchObject({ code: 368 });
    expect(mails).toHaveLength(1);
    for (const r of await fbTicks([11, 22, 600])) expect(r.policyStopped).toBe(true);
    expect(fbCalls).toHaveLength(1); // nothing else was attempted, not even after hours
    expect(await resumePolicy(FB_PAGE)).toBe(true);
    expect((await fbTicks([700]))[0].posted).toBe(1);
    expect((await fbRows()).map((r) => [r.campaignId, r.status])).toEqual([
      [s.id, 'FAILED'], // never retried into a block
      [a.id, 'POSTED'],
    ]);
  });
  it('a policy block on an ARTICLE holds the course and product pushes behind it until Resume', async () => {
    const a = await article('a1', after(10));
    const s = await push(productUrl('ebook'), after(20));
    fbScript = (n) => (n === 1 ? fbFail('policy', 400, 368) : fbPosted());
    await fbTicks([0, 11, 22]);
    expect(fbCalls).toHaveLength(1);
    await resumePolicy(FB_PAGE);
    await fbTicks([33]);
    expect((await fbRows()).map((r) => [r.campaignId, r.status])).toEqual([
      [a.id, 'FAILED'],
      [s.id, 'POSTED'],
    ]);
  });
  it('a bad token stops the page (every kind) until the token changes or the app restarts', async () => {
    await push(courseUrl('gst-a'), after(10));
    fbScript = () => fbFail('auth', 401, 190);
    expect((await fbTicks([0]))[0].authStopped).toBe(true);
    expect(await fbLoginProblem(FB_PAGE)).toMatchObject({ status: 401 });
    await fbTicks([11]);
    expect(fbCalls).toHaveLength(1);
    resetFacebookStops();
    fbScript = () => fbPosted();
    await fbTicks([22]);
    expect(fbCalls).toHaveLength(2);
    expect((await fbRows())[0].status).toBe('POSTED');
  });
  it('the daily cap counts every kind of push and the rest spill to the next IST day, however old by then', async () => {
    const a1 = await article('a1', after(10));
    const s1 = await push(courseUrl('s1'), after(15), { title: 'Course one' });
    const s2 = await push(productUrl('s2'), after(20), { title: 'Product two' });
    const a2 = await article('a2', after(25));
    const cap = { dailyCap: 2 };
    expect((await fbTicks([0], cap))[0].posted).toBe(1);
    expect((await fbTicks([11], cap))[0].posted).toBe(1);
    expect((await fbTicks([22], cap))[0]).toMatchObject({ posted: 0, waited: 'daily_cap' });
    expect((await fbRows()).map((r) => r.campaignId)).toEqual([a1.id, s1.id]); // the article and the course used the day's two
    const next = (m: number) => at(ist(10, 0, 4), m);
    expect((await runFacebookTick(fbDeps({ ...cap, now: () => next(0) }))).posted).toBe(1);
    expect((await runFacebookTick(fbDeps({ ...cap, now: () => next(11) }))).posted).toBe(1);
    expect((await fbRows()).map((r) => r.campaignId)).toEqual([a1.id, s1.id, s2.id, a2.id]);
    expect(fbCalls[2].message.startsWith('Product two')).toBe(true);
  });
  it('one post per tick, oldest first across both rules: a waiting pre-time article, then the new-rule pushes in the order they were sent', async () => {
    const old = await article('old', before(30));
    const c1 = await push(courseUrl('c1'), after(10), { title: 'Course one' });
    const clone = await push(old.url, after(20), { title: old.title });
    const p1 = await push(productUrl('p1'), after(30), { title: 'Product one' });
    await fbTicks([0, 11, 22, 33]);
    expect(fbCalls.map((c) => c.message.split('\n')[0])).toEqual([old.title, 'Course one', old.title, 'Product one']);
    sameKeys(await fbKeys(), [articleKey(old), pk(c1), pk(clone), pk(p1)]);
    // two ticks in the same minute still post only one
    await push(courseUrl('c2'), after(40));
    await push(courseUrl('c3'), after(41));
    const n = fbCalls.length;
    await runFacebookTick(fbDeps({ now: () => at(NOW, 60), minGapMinutes: 0 }));
    expect(fbCalls).toHaveLength(n + 1);
  });
  it('Retry posts a failed course with the course builder, Skip closes a failed row', async () => {
    const c = await push(courseUrl('gst-a'), after(30), { title: T_TOMORROW, body: 'Join (CA)' });
    await fbRow(pk(c), c, 'FAILED', { attempts: 4, error: 'HTTP 500' });
    const row = (await fbRows())[0];
    expect(await fbRetry(row.id, fbDeps())).toEqual({ ok: true, status: 'POSTED' });
    expect(fbCalls[0].message).toBe(`${T_TOMORROW}\n\nJoin (CA)\n\n#taxscan`);
    expect(params(fbCalls[0].link).get('utm_source')).toBe('taxscan-facebook');
  });
});

/* ================================================================== */
/* 13. The screens                                                      */
/* ================================================================== */

describe('13. the LinkedIn screen: one row per push under the new rule, per page', () => {
  const app = (over: { allPushesFrom?: () => unknown } = {}) =>
    createApp({
      rateLimit: { publicPerMin: 10000, loginPerMin: 10000 },
      linkedin: {
        enabled: () => true,
        clock: () => NOW,
        portals: () => ({ [PORTAL]: [PAGE, PAGE_AC] }),
        postFrom: () => ({ [PAGE]: FROM, [PAGE_AC]: FROM_AC }),
        allPushesFrom: (over.allPushesFrom ?? (() => ({ [PAGE]: PUSHES, [PAGE_AC]: PUSHES_AC }))) as never,
        worker: liDeps(),
      },
    });
  const get = (a: ReturnType<typeof app>, page: string) => request(a).get(`/api/linkedin/posts?date=2026-11-03&page=${page}`).set(BEARER);
  type Row = { id: string | null; campaignId: string; headline: string; status: string; error: string | null; postUrl: string | null; pushedTime: string };

  it('a repeat is its own row; WAITING and NOT_POSTED follow the rule that applies to each push, per page', async () => {
    const tooOld = await article('too-old', ist(6, 30)); // 06:30: before Academy\'s article go-live (07:00), after Taxscan\'s (04:00)
    const first = await article('a1', ist(7, 30)); // today's rule on both pages
    const clone = await push(first.url, ist(8, 10), { title: first.title }); // a clone: new rule for Taxscan (08:00), today's rule for Academy (08:30)
    const course = await push(courseUrl('c'), ist(8, 20), { title: 'A course' }); // new rule for Taxscan only
    const late = await push(productUrl('p'), ist(9, 0), { title: 'A product' }); // new rule on both
    const lateClone = await push(first.url, ist(9, 5), { title: first.title }); // new rule on both
    const a = app();
    const taxscan = await get(a, PAGE);
    expect(taxscan.status).toBe(200);
    expect((taxscan.body.rows as Row[]).map((r) => [r.campaignId, r.status])).toEqual([
      [tooOld.id, 'WAITING'],
      [first.id, 'WAITING'],
      [clone.id, 'WAITING'], // its own row
      [course.id, 'WAITING'],
      [late.id, 'WAITING'],
      [lateClone.id, 'WAITING'],
    ]);
    expect(taxscan.body.counts).toMatchObject({ waiting: 6, notPosted: 0, all: 6 });
    const academy = await get(a, PAGE_AC);
    expect((academy.body.rows as Row[]).map((r) => [r.campaignId, r.status])).toEqual([
      [tooOld.id, 'NOT_POSTED'], // pushed before the Academy page's go-live
      [first.id, 'WAITING'],
      [late.id, 'WAITING'],
      [lateClone.id, 'WAITING'],
    ]);
    expect(academy.body.counts).toMatchObject({ waiting: 3, notPosted: 1, all: 4 });
  });
  it('an all-pushes time earlier than the page\'s own go-live lists nothing from before that go-live', async () => {
    await push(courseUrl('early'), ist(6, 30)); // Academy: after its all-pushes time (06:00), before its go-live (07:00)
    const ok = await push(courseUrl('ok'), ist(7, 30));
    const rows = (await get(app({ allPushesFrom: () => ({ [PAGE]: null, [PAGE_AC]: ist(6, 0) }) }), PAGE_AC)).body.rows as Row[];
    expect(rows.map((r) => [r.campaignId, r.status])).toEqual([[ok.id, 'WAITING']]);
  });
  it('the answer says the page posts every push (everyPushFrom, the time the new rule really starts) only while it does; otherwise the answer has no such field', async () => {
    const a = app();
    expect((await get(a, PAGE)).body.everyPushFrom).toBe(PUSHES.toISOString());
    expect((await get(a, PAGE_AC)).body.everyPushFrom).toBe(PUSHES_AC.toISOString());
    // a time earlier than the page\'s own go-live is reported as the go-live (that is when the new rule really starts)
    const early = app({ allPushesFrom: () => ({ [PAGE]: ist(2, 0), [PAGE_AC]: ist(6, 0) }) });
    expect((await get(early, PAGE)).body.everyPushFrom).toBe(FROM.toISOString());
    expect((await get(early, PAGE_AC)).body.everyPushFrom).toBe(FROM_AC.toISOString());
    for (const f of [() => ({ [PAGE]: null, [PAGE_AC]: null }), () => null, () => undefined, () => ({})]) {
      const body = (await get(app({ allPushesFrom: f }), PAGE)).body;
      expect('everyPushFrom' in body).toBe(false);
      expect(Object.keys(body).sort()).toEqual(['counts', 'date', 'login', 'page', 'pages', 'rows', 'tokenShared']); // the answer is exactly what it was (the two pages share a token)
    }
  });
  it('a page with no all-pushes time lists exactly what it did before: one row per article, no courses or products', async () => {
    const first = await article('a1', ist(7, 30));
    await push(first.url, ist(9, 0), { title: first.title }); // a clone
    await push(courseUrl('c'), ist(9, 10));
    for (const f of [() => ({ [PAGE]: null, [PAGE_AC]: null }), () => null, () => undefined, () => ({})]) {
      const rows = (await get(app({ allPushesFrom: f }), PAGE)).body.rows as Row[];
      expect(rows.map((r) => r.campaignId)).toEqual([first.id]);
    }
  });
  it('a pre-time article keeps its place and status; a row of the new rule for the same article is separate', async () => {
    const orig = await article('both', ist(7, 30));
    await liRow(PAGE, articleKey(orig), orig, 'POSTED', { linkedinPostId: 'urn:li:share:1', postedAt: ist(7, 35) });
    const rep = await push(orig.url, ist(9, 0), { title: orig.title });
    const rows = (await get(app(), PAGE)).body.rows as Row[];
    expect(rows.map((r) => [r.campaignId, r.status])).toEqual([
      [orig.id, 'POSTED'],
      [rep.id, 'WAITING'],
    ]);
  });
  it('POSTED rows link to the post; FAILED rows show the reason, with Retry (posts it now) and Skip', async () => {
    const ok = await push(courseUrl('ok'), at(NOW, -50), { title: 'Will post' });
    const bad = await push(productUrl('bad'), at(NOW, -40), { title: 'Will fail' });
    const skip = await push(courseUrl('skip'), at(NOW, -30), { title: 'Will be skipped' });
    await liRow(PAGE, pk(ok), ok, 'POSTED', { linkedinPostId: 'urn:li:share:77', postedAt: at(NOW, -45) });
    await liRow(PAGE, pk(bad), bad, 'FAILED', { attempts: 4, error: 'HTTP 422: nope' });
    await liRow(PAGE, pk(skip), skip, 'FAILED', { attempts: 4, error: LI_DUPLICATE });
    const a = app();
    const rows = (await get(a, PAGE)).body.rows as Row[];
    expect(rows.map((r) => [r.headline, r.status])).toEqual([
      ['Will post', 'POSTED'],
      ['Will fail', 'FAILED'],
      ['Will be skipped', 'FAILED'],
    ]);
    expect(rows[0].postUrl).toBe('https://www.linkedin.com/feed/update/urn%3Ali%3Ashare%3A77/');
    expect(rows[1]).toMatchObject({ error: 'HTTP 422: nope' });
    expect(rows[2]).toMatchObject({ error: 'LinkedIn says this was already posted' });
    const retried = await request(a).post(`/api/linkedin/posts/${rows[1].id}/retry`).set(BEARER).send({});
    expect(retried.status).toBe(200);
    expect(retried.body).toEqual({ ok: true, status: 'POSTED' });
    expect(calls).toHaveLength(1);
    expect(headOf(calls[0])).toBe('Will fail');
    const skipped = await request(a).post(`/api/linkedin/posts/${rows[2].id}/skip`).set(BEARER).send({});
    expect(skipped.body).toEqual({ ok: true, status: 'SKIPPED' });
    expect(((await get(a, PAGE)).body.rows as Row[]).map((r) => r.status)).toEqual(['POSTED', 'POSTED', 'SKIPPED']);
  });
  it('a store row waiting for a retry is RETRYING; reading the screen never starts a post or fetches a page', async () => {
    const c = await push(courseUrl('c'), at(NOW, -30), { title: 'Waiting for retry' });
    await liRow(PAGE, pk(c), c, 'PENDING', { nextAttemptAt: at(NOW, 3), error: 'HTTP 429' });
    const rows = (await get(app(), PAGE)).body.rows as Row[];
    expect(rows[0]).toMatchObject({ status: 'RETRYING', error: 'HTTP 429' });
    expect(calls).toEqual([]);
    expect(pageCalls).toEqual([]);
  });
});

describe('13. the Facebook screen: one row per push under the new rule', () => {
  const app = (over: { allPushesFrom?: () => Date | null } = {}) =>
    createApp({
      rateLimit: { publicPerMin: 10000, loginPerMin: 10000 },
      facebook: { enabled: () => true, clock: () => NOW, portals: () => ({ [PORTAL]: FB_PAGE }), postFrom: () => FROM, allPushesFrom: over.allPushesFrom ?? (() => PUSHES_FB), worker: fbDeps() },
    });
  const get = (a: ReturnType<typeof app>) => request(a).get('/api/facebook/posts?date=2026-11-03').set(BEARER);
  type Row = { id: string | null; campaignId: string; headline: string; status: string; error: string | null; postUrl: string | null };

  it('articles keep today\'s rule before the time, every push is its own row after it', async () => {
    const first = await article('a1', ist(7, 30));
    const clone = await push(first.url, ist(8, 10), { title: first.title });
    const course = await push(courseUrl('c'), ist(8, 20), { title: 'A course' });
    const body = (await get(app())).body;
    expect((body.rows as Row[]).map((r) => [r.campaignId, r.status])).toEqual([
      [first.id, 'WAITING'],
      [clone.id, 'WAITING'],
      [course.id, 'WAITING'],
    ]);
    expect(body.counts).toMatchObject({ waiting: 3, notPosted: 0, all: 3 });
  });
  it('the answer says the page posts every push (everyPushFrom) only while it does', async () => {
    expect((await get(app())).body.everyPushFrom).toBe(PUSHES_FB.toISOString());
    expect((await get(app({ allPushesFrom: () => ist(2, 0) }))).body.everyPushFrom).toBe(FROM.toISOString()); // never before the go-live
    const body = (await get(app({ allPushesFrom: () => null }))).body;
    expect('everyPushFrom' in body).toBe(false);
    expect(Object.keys(body).sort()).toEqual(['counts', 'date', 'login', 'page', 'policy', 'rows']);
  });
  it('without FACEBOOK_ALL_PUSHES_FROM the list is what it was: one row per article', async () => {
    const first = await article('a1', ist(7, 30));
    await push(first.url, ist(9, 0), { title: first.title });
    await push(courseUrl('c'), ist(9, 10));
    expect(((await get(app({ allPushesFrom: () => null }))).body.rows as Row[]).map((r) => r.campaignId)).toEqual([first.id]);
  });
  it('POSTED links to the post; FAILED shows the reason with Retry (posts it now) and Skip', async () => {
    const ok = await push(courseUrl('ok'), at(NOW, -50), { title: 'Will post' });
    const bad = await push(productUrl('bad'), at(NOW, -40), { title: 'Will fail', body: 'Body line' });
    const skip = await push(courseUrl('skip'), at(NOW, -30), { title: 'Will be skipped' });
    await fbRow(pk(ok), ok, 'POSTED', { facebookPostId: '1234567890_99', postedAt: at(NOW, -45) });
    await fbRow(pk(bad), bad, 'FAILED', { attempts: 4, error: 'HTTP 500 code 2' });
    await fbRow(pk(skip), skip, 'FAILED', { attempts: 4, error: FB_DUPLICATE });
    const a = app();
    const rows = (await get(a)).body.rows as Row[];
    expect(rows.map((r) => [r.headline, r.status])).toEqual([
      ['Will post', 'POSTED'],
      ['Will fail', 'FAILED'],
      ['Will be skipped', 'FAILED'],
    ]);
    expect(rows[0].postUrl).toBe('https://www.facebook.com/1234567890_99');
    expect(rows[2]).toMatchObject({ error: 'Facebook says this was already posted' });
    const retried = await request(a).post(`/api/facebook/posts/${rows[1].id}/retry`).set(BEARER).send({});
    expect(retried.body).toEqual({ ok: true, status: 'POSTED' });
    expect(fbCalls[0].message).toBe('Will fail\n\nBody line\n\n#taxscan');
    const skipped = await request(a).post(`/api/facebook/posts/${rows[2].id}/skip`).set(BEARER).send({});
    expect(skipped.body).toEqual({ ok: true, status: 'SKIPPED' });
    expect(((await get(a)).body.rows as Row[]).map((r) => r.status)).toEqual(['POSTED', 'POSTED', 'SKIPPED']);
  });
});


/* ================================================================== */
/* 13. Campaigns: the Channels marks                                    */
/* ================================================================== */

describe('13. Campaigns Channels: a push under the new rule shows the status of its OWN row', () => {
  const CH_RUN = `${RUN}-ch`;
  const chPortal = env.rss.portal;
  const keys: string[] = [];
  const ids: Record<string, string> = {};
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);
  async function seed(name: string, url: string, title: string, lastSentAt: Date) {
    const c = await prisma.campaign.create({ data: { portal: chPortal, title, body: 'b', url, target: { type: 'all' } as Prisma.InputJsonValue, status: 'SENT', lastSentAt } });
    ids[name] = c.id;
    return c;
  }
  const course = (n: string) => `https://academy.taxscan.in/course/chan-${n}-${CH_RUN}`;
  const product = (n: string) => `https://shop.taxscan.in/products/chan-${n}-${CH_RUN}`;
  const articleUrl = (n: string) => `https://www.taxscan.in/gst/chan-${n}-${CH_RUN}`;
  const ak = (c: { id: string; url: string }) => articleKey({ id: c.id, url: c.url });
  const liMark = (page: string, key: string, c: { id: string }, status: 'POSTED' | 'FAILED' | 'SKIPPED', extra: object = {}) => {
    keys.push(key);
    return prisma.linkedInPost.create({ data: { page, articleKey: key, campaignId: c.id, status, attempts: 1, ...extra } });
  };
  const fbMark = (key: string, c: { id: string }, status: 'POSTED' | 'FAILED' | 'SKIPPED', extra: object = {}) => {
    keys.push(key);
    return prisma.facebookPost.create({ data: { page: 'taxscan', articleKey: key, campaignId: c.id, status, attempts: 1, ...extra } });
  };
  const byId = async () => new Map((await listCampaigns(600)).map((r) => [r.id, r]));
  const marks = async (name: string) => {
    const r = (await byId()).get(ids[name])!;
    return { channels: r.channels, details: r.channelDetails, day: r.channelDay };
  };

  beforeEach(() => {
    env.linkedin.enabled = true;
    env.linkedin.postFrom = hoursAgo(10);
    env.facebook.enabled = true;
    env.facebook.postFrom = hoursAgo(10);
  });
  afterEach(async () => {
    await prisma.linkedInPost.deleteMany({ where: { articleKey: { in: keys } } });
    await prisma.facebookPost.deleteMany({ where: { articleKey: { in: keys } } });
    await prisma.campaign.deleteMany({ where: { url: { contains: CH_RUN } } });
    keys.length = 0;
    for (const k of Object.keys(ids)) delete ids[k];
    env.whatsapp.queueEnabled = saved.waQueue;
  });

  it('both times unset: a course has no marks (as today) whatever rows exist, an article has the article\'s mark; only an ARTICLE\'s own push key is queried (follow-up 1), never a course\'s', async () => {
    const c = await seed('off', course('off'), 'Offer off', hoursAgo(1));
    const art = await seed('art', articleUrl('off'), 'Article off', hoursAgo(1));
    await liMark('taxscan', pk(c), c, 'POSTED', { linkedinPostId: 'urn:li:share:9', postedAt: hoursAgo(1) });
    const li = jest.spyOn(prisma.linkedInPost, 'findMany');
    const fb = jest.spyOn(prisma.facebookPost, 'findMany');
    try {
      const m = await marks('off');
      expect(m.channels).toEqual({ whatsapp: null, linkedin: null, facebook: null });
      expect(m.details).toEqual({});
      expect((await marks('art')).channels).toEqual({ whatsapp: null, linkedin: 'PENDING', facebook: 'PENDING' });
      const asked = [...li.mock.calls, ...fb.mock.calls].map((x) => JSON.stringify(x[0])).join('');
      expect(asked).toContain(`push:${art.id}:`); // an article's own push key (it may have been handled by the new rule before an unset)
      expect(asked).not.toContain(c.id); // a course's never: a course is not an article under today's rule
    } finally {
      li.mockRestore();
      fb.mockRestore();
    }
  });
  it('the LinkedIn time alone: a course, a product and an article\'s repeat show their own row; before the time the article keeps its mark; Facebook is untouched', async () => {
    env.linkedin.allPushesFrom = { taxscan: hoursAgo(5) };
    await seed('waiting', course('waiting'), 'Offer waiting', hoursAgo(1));
    const done = await seed('done', product('done'), 'Offer done', hoursAgo(2));
    const bad = await seed('bad', course('bad'), 'Offer bad', hoursAgo(3));
    const first = await seed('first', articleUrl('same'), 'Same article', hoursAgo(8)); // before the time: today's rule
    await seed('clone', articleUrl('same'), 'Same article', hoursAgo(1)); // after it: its own row, no row yet
    const clone2 = await seed('clone2', articleUrl('same'), 'Same article', hoursAgo(2));
    await liMark('taxscan', pk(done), done, 'POSTED', { linkedinPostId: 'urn:li:share:9', postedAt: hoursAgo(1) });
    await liMark('taxscan', pk(bad), bad, 'FAILED', { error: 'HTTP 422: nope' });
    await liMark('taxscan', ak(first), first, 'POSTED', { linkedinPostId: 'urn:li:share:1', postedAt: hoursAgo(7) });
    await liMark('taxscan', pk(clone2), clone2, 'FAILED', { error: 'LinkedIn says this was already posted' });
    expect((await marks('waiting')).channels).toEqual({ whatsapp: null, linkedin: 'PENDING', facebook: null });
    const d = await marks('done');
    expect(d.channels).toEqual({ whatsapp: null, linkedin: 'POSTED', facebook: null });
    expect(d.details).toMatchObject({ linkedin: { error: null, postUrl: 'https://www.linkedin.com/feed/update/urn%3Ali%3Ashare%3A9/' } });
    expect(d.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((await marks('bad')).channels).toMatchObject({ linkedin: 'FAILED' });
    expect((await marks('bad')).details).toMatchObject({ linkedin: { error: 'HTTP 422: nope', postUrl: null } });
    // the article: its first push (before the time) keeps the article's mark; its repeats are their own rows, whatever the first one did
    expect((await marks('first')).channels).toMatchObject({ linkedin: 'POSTED', facebook: 'PENDING' });
    expect((await marks('clone')).channels).toMatchObject({ linkedin: 'PENDING', facebook: 'PENDING' });
    expect((await marks('clone2')).channels).toMatchObject({ linkedin: 'FAILED' });
    expect((await marks('clone2')).details).toMatchObject({ linkedin: { error: 'LinkedIn says this was already posted' } });
  });
  it('the Facebook time alone: the same, for Facebook only', async () => {
    env.facebook.allPushesFrom = hoursAgo(5);
    const p = await seed('fb', product('fb'), 'Offer fb', hoursAgo(2));
    const a = await seed('art', articleUrl('fb'), 'Article fb', hoursAgo(1));
    const rep = await seed('rep', articleUrl('fb'), 'Article fb', hoursAgo(1));
    expect((await marks('fb')).channels).toEqual({ whatsapp: null, linkedin: null, facebook: 'PENDING' });
    await fbMark(pk(p), p, 'POSTED', { facebookPostId: '1234567890_5', postedAt: hoursAgo(1) });
    await fbMark(pk(a), a, 'POSTED', { facebookPostId: '1234567890_6', postedAt: hoursAgo(1) });
    const m = await marks('fb');
    expect(m.channels).toEqual({ whatsapp: null, linkedin: null, facebook: 'POSTED' });
    expect(m.details).toMatchObject({ facebook: { postUrl: 'https://www.facebook.com/1234567890_5' } });
    expect((await marks('art')).channels).toMatchObject({ linkedin: 'PENDING', facebook: 'POSTED' }); // LinkedIn: today's rule (no row)
    expect((await marks('rep')).channels).toMatchObject({ facebook: 'PENDING' }); // its own row, not the first push's
    void rep;
  });
  it('a time earlier than the page\'s own go-live gives no mark to a push from before that go-live', async () => {
    env.linkedin.allPushesFrom = { taxscan: hoursAgo(20) }; // earlier than LINKEDIN_POST_FROM (10 hours ago)
    env.facebook.allPushesFrom = hoursAgo(20);
    await seed('before', course('before'), 'Offer before', hoursAgo(12));
    await seed('after', course('after'), 'Offer after', hoursAgo(1));
    expect((await marks('before')).channels).toEqual({ whatsapp: null, linkedin: null, facebook: null });
    expect((await marks('after')).channels).toEqual({ whatsapp: null, linkedin: 'PENDING', facebook: 'PENDING' });
  });
  it('18. after an UNSET (both times absent): an article with a push: row shows THAT row\'s status, not "waiting"; one without still reads waiting; a course gets no mark', async () => {
    const posted = await seed('p', articleUrl('p'), 'Posted article', hoursAgo(3));
    const failed = await seed('f', articleUrl('f'), 'Failed article', hoursAgo(2));
    await seed('w', articleUrl('w'), 'Waiting article', hoursAgo(1));
    const c = await seed('c', course('c'), 'A course', hoursAgo(1));
    await liMark('taxscan', pk(posted), posted, 'POSTED', { linkedinPostId: 'urn:li:share:9', postedAt: hoursAgo(3) });
    await fbMark(pk(posted), posted, 'POSTED', { facebookPostId: '1234567890_9', postedAt: hoursAgo(3) });
    await liMark('taxscan', pk(failed), failed, 'FAILED', { error: 'HTTP 422: nope' });
    await liMark('taxscan', pk(c), c, 'POSTED', { linkedinPostId: 'urn:li:share:8', postedAt: hoursAgo(1) }); // never read: a course is not an article
    const p = await marks('p');
    expect(p.channels).toEqual({ whatsapp: null, linkedin: 'POSTED', facebook: 'POSTED' });
    expect(p.details).toMatchObject({ linkedin: { postUrl: 'https://www.linkedin.com/feed/update/urn%3Ali%3Ashare%3A9/' }, facebook: { postUrl: 'https://www.facebook.com/1234567890_9' } });
    expect((await marks('f')).channels).toEqual({ whatsapp: null, linkedin: 'FAILED', facebook: 'PENDING' });
    expect((await marks('f')).details).toMatchObject({ linkedin: { error: 'HTTP 422: nope' } });
    expect((await marks('w')).channels).toEqual({ whatsapp: null, linkedin: 'PENDING', facebook: 'PENDING' });
    expect((await marks('c')).channels).toEqual({ whatsapp: null, linkedin: null, facebook: null });
  });
  it('18. after an UNSET, every push of an article whose only row is a push: row reads THAT row (a repeat, and the oldest push), the later row wins, and the channels stay apart', async () => {
    // r: the oldest push has no row, the repeat has
    await seed('r1', articleUrl('r'), 'Repeat article', hoursAgo(5));
    const r2 = await seed('r2', articleUrl('r'), 'Repeat article', hoursAgo(2));
    await liMark('taxscan', pk(r2), r2, 'POSTED', { linkedinPostId: 'urn:li:share:3', postedAt: hoursAgo(2) });
    await fbMark(pk(r2), r2, 'SKIPPED');
    // q: the oldest push has the row, the repeat has none
    const q1 = await seed('q1', articleUrl('q'), 'Other article', hoursAgo(5));
    await seed('q2', articleUrl('q'), 'Other article', hoursAgo(2));
    await liMark('taxscan', pk(q1), q1, 'FAILED', { error: 'HTTP 500' });
    await fbMark(pk(q1), q1, 'POSTED', { facebookPostId: '1_7', postedAt: hoursAgo(5) });
    // m: two pushes with rows of different ages; a third push with none shows the LATER row
    const m1 = await seed('m1', articleUrl('m'), 'Third article', hoursAgo(6));
    const m2 = await seed('m2', articleUrl('m'), 'Third article', hoursAgo(4));
    await seed('m3', articleUrl('m'), 'Third article', hoursAgo(1));
    await liMark('taxscan', pk(m1), m1, 'POSTED', { linkedinPostId: 'urn:li:share:4', postedAt: hoursAgo(6), createdAt: hoursAgo(6) });
    await liMark('taxscan', pk(m2), m2, 'FAILED', { error: 'HTTP 500', createdAt: hoursAgo(4) });
    // n: an article with no row on any of its pushes still reads waiting
    await seed('n1', articleUrl('n'), 'Fourth article', hoursAgo(3));
    await seed('n2', articleUrl('n'), 'Fourth article', hoursAgo(1));
    for (const n of ['r1', 'r2']) expect((await marks(n)).channels).toEqual({ whatsapp: null, linkedin: 'POSTED', facebook: 'SKIPPED' });
    expect((await marks('r1')).details).toMatchObject({ linkedin: { postUrl: 'https://www.linkedin.com/feed/update/urn%3Ali%3Ashare%3A3/' } });
    for (const n of ['q1', 'q2']) expect((await marks(n)).channels).toEqual({ whatsapp: null, linkedin: 'FAILED', facebook: 'POSTED' });
    expect((await marks('m1')).channels).toMatchObject({ linkedin: 'POSTED' }); // its own row first
    expect((await marks('m2')).channels).toMatchObject({ linkedin: 'FAILED' });
    expect((await marks('m3')).channels).toEqual({ whatsapp: null, linkedin: 'FAILED', facebook: 'PENDING' });
    for (const n of ['n1', 'n2']) expect((await marks(n)).channels).toEqual({ whatsapp: null, linkedin: 'PENDING', facebook: 'PENDING' });
  });
  it('18. an article-key row still wins over a push: row (an article handled by today\'s rule keeps its mark)', async () => {
    const a = await seed('both', articleUrl('both'), 'Both rows', hoursAgo(2));
    await liMark('taxscan', ak(a), a, 'POSTED', { linkedinPostId: 'urn:li:share:1', postedAt: hoursAgo(2) });
    await liMark('taxscan', pk(a), a, 'FAILED', { error: 'HTTP 500' });
    await fbMark(ak(a), a, 'FAILED', { error: 'HTTP 500 code 2' });
    await fbMark(pk(a), a, 'POSTED', { facebookPostId: '1_9', postedAt: hoursAgo(2) });
    expect((await marks('both')).channels).toMatchObject({ linkedin: 'POSTED', facebook: 'FAILED' });
  });
  it('both set: both marks; the Academy page has no mark of its own, whatever its rows say', async () => {
    env.linkedin.allPushesFrom = { taxscan: hoursAgo(5), academy: hoursAgo(5) };
    env.facebook.allPushesFrom = hoursAgo(5);
    const c = await seed('both', course('both'), 'Offer both', hoursAgo(1));
    await liMark('taxscan', pk(c), c, 'POSTED', { linkedinPostId: 'urn:li:share:1', postedAt: hoursAgo(1) });
    await liMark('academy', pk(c), c, 'FAILED', { error: 'Academy only' });
    expect((await marks('both')).channels).toEqual({ whatsapp: null, linkedin: 'POSTED', facebook: 'PENDING' });
    expect(JSON.stringify(await marks('both'))).not.toContain('Academy only');
  });
  it('a time that lies after every push changes nothing: the same marks as with it unset', async () => {
    await seed('c', course('same'), 'A course', hoursAgo(1));
    await seed('p', product('same'), 'A product', hoursAgo(1));
    const first = await seed('a', articleUrl('same'), 'An article', hoursAgo(3));
    await seed('a2', articleUrl('same'), 'An article', hoursAgo(1));
    await liMark('taxscan', ak(first), first, 'POSTED', { linkedinPostId: 'urn:li:share:1', postedAt: hoursAgo(2) });
    const snapshot = async () => JSON.stringify(await Promise.all(Object.keys(ids).sort().map((n) => marks(n))));
    const off = await snapshot();
    env.linkedin.allPushesFrom = { taxscan: new Date(Date.now() + 3600_000) };
    env.facebook.allPushesFrom = new Date(Date.now() + 3600_000);
    expect(await snapshot()).toBe(off);
  });
  it('WhatsApp never changes: a course has no mark, and its query only ever sees article keys', async () => {
    env.whatsapp.queueEnabled = true;
    env.linkedin.allPushesFrom = { taxscan: hoursAgo(5) };
    await seed('wa', course('wa'), 'Offer wa', hoursAgo(1));
    await seed('waart', articleUrl('wa'), 'Article wa', hoursAgo(1));
    const wa = jest.spyOn(prisma.whatsAppPost, 'findMany');
    try {
      expect((await marks('wa')).channels).toMatchObject({ whatsapp: null, linkedin: 'PENDING' });
      expect((await marks('waart')).channels).toMatchObject({ whatsapp: 'TODO' });
      expect(wa.mock.calls.map((x) => JSON.stringify(x[0])).join('')).not.toContain('push:');
    } finally {
      wa.mockRestore();
    }
  });
  it('still ONE batched query per channel, for the article keys and the push keys together', async () => {
    env.linkedin.allPushesFrom = { taxscan: hoursAgo(5) };
    env.facebook.allPushesFrom = hoursAgo(5);
    await seed('art', articleUrl('q'), 'An article', hoursAgo(1));
    await seed('s1', course('q1'), 'Q one', hoursAgo(1));
    await seed('s2', product('q2'), 'Q two', hoursAgo(1));
    const li = jest.spyOn(prisma.linkedInPost, 'findMany');
    const fb = jest.spyOn(prisma.facebookPost, 'findMany');
    try {
      await listCampaigns(600);
      for (const spy of [li, fb]) {
        expect(spy.mock.calls).toHaveLength(1);
        const where = (spy.mock.calls[0][0] as { where: { page: string; articleKey: { in: string[] } } }).where;
        expect(where.page).toBe('taxscan');
        const mine = where.articleKey.in.filter((k) => k.includes(CH_RUN) || k.includes(ids.art) || k.includes(ids.s1) || k.includes(ids.s2));
        expect(mine.filter(isPushKey)).toHaveLength(3); // the article's own push key as well as the two others
        expect(mine.filter((k) => !isPushKey(k))).toHaveLength(1); // plus today's key for the article
      }
    } finally {
      li.mockRestore();
      fb.mockRestore();
    }
  });
});

/* ================================================================== */
/* The boot lines                                                       */
/* ================================================================== */

describe('the boot lines: one per page saying whether every push posts, and if not why (never the value)', () => {
  const VARS = Object.values(ALL_PUSHES_FROM_VARS);
  const realEnv = Object.fromEntries(VARS.map((n) => [n, process.env[n]]));
  const pushLines = () => logs.filter((l) => l.includes('all pushes'));
  let schedule: jest.SpyInstance;
  beforeEach(() => {
    schedule = jest.spyOn(cron, 'schedule').mockImplementation((() => ({ start: () => undefined, stop: () => undefined })) as never);
    for (const n of VARS) delete process.env[n]; // the "off" reason is read from the process env: start from a known state
  });
  afterEach(() => {
    schedule.mockRestore();
    for (const n of VARS) {
      if (realEnv[n] === undefined) delete process.env[n];
      else process.env[n] = realEnv[n];
    }
    env.linkedin.enabled = saved.enabled;
    env.facebook.enabled = saved.fbEnabled;
    env.facebook.pages.taxscan = saved.fbTaxscan;
  });
  const linkedinReady = () => {
    env.linkedin.enabled = true;
    env.linkedin.pages.taxscan = { orgUrn: 'urn:li:organization:5', accessToken: 'tok-taxscan' };
  };
  const TODAY = "(today's rule: one post per article)";

  it('LinkedIn, nothing set: each page says which variable is not set (the Academy one says its page is off); the worker still starts', () => {
    linkedinReady();
    env.linkedin.sharedPages = {};
    startLinkedInWorker();
    expect(schedule).toHaveBeenCalledWith('* * * * *', expect.any(Function));
    expect(pushLines()).toEqual([
      `[linkedin] all pushes off: LINKEDIN_TAXSCAN_ALL_PUSHES_FROM is not set ${TODAY}`,
      `[linkedin] all pushes off: LINKEDIN_ACADEMY_ALL_PUSHES_FROM is ignored while the Academy page is off ${TODAY}`,
    ]);
  });
  it('LinkedIn, invalid values: the line names the variable, never the value', () => {
    linkedinReady();
    env.linkedin.sharedPages = { academy: { orgUrn: ORG_AC, postFrom: FROM_AC, tokenFrom: 'taxscan' } };
    process.env.LINKEDIN_TAXSCAN_ALL_PUSHES_FROM = 'sometime-soon';
    process.env.LINKEDIN_ACADEMY_ALL_PUSHES_FROM = '04/11/2026';
    startLinkedInWorker();
    expect(pushLines()).toEqual([
      `[linkedin] all pushes off: LINKEDIN_TAXSCAN_ALL_PUSHES_FROM is not a valid ISO time ${TODAY}`,
      `[linkedin] all pushes off: LINKEDIN_ACADEMY_ALL_PUSHES_FROM is not a valid ISO time ${TODAY}`,
    ]);
    expect(pushLines().join('')).not.toMatch(/sometime-soon|04\/11\/2026/);
  });
  it('LinkedIn, both on: each line carries its page\'s time', () => {
    linkedinReady();
    env.linkedin.sharedPages = { academy: { orgUrn: ORG_AC, postFrom: FROM_AC, tokenFrom: 'taxscan' } };
    env.linkedin.allPushesFrom = { taxscan: PUSHES, academy: PUSHES_AC };
    startLinkedInWorker();
    expect(pushLines()).toEqual([`[linkedin] all pushes on for LINKEDIN_TAXSCAN_ALL_PUSHES_FROM (from ${PUSHES.toISOString()})`, `[linkedin] all pushes on for LINKEDIN_ACADEMY_ALL_PUSHES_FROM (from ${PUSHES_AC.toISOString()})`]);
  });
  it('LinkedIn, the Academy variable is set but its page is off: the line says the page is off (the variable alone does nothing)', () => {
    linkedinReady();
    env.linkedin.sharedPages = {};
    env.linkedin.allPushesFrom = { taxscan: PUSHES, academy: PUSHES_AC };
    process.env.LINKEDIN_ACADEMY_ALL_PUSHES_FROM = PUSHES_AC.toISOString();
    startLinkedInWorker();
    expect(pushLines()).toEqual([`[linkedin] all pushes on for LINKEDIN_TAXSCAN_ALL_PUSHES_FROM (from ${PUSHES.toISOString()})`, `[linkedin] all pushes off: LINKEDIN_ACADEMY_ALL_PUSHES_FROM is ignored while the Academy page is off ${TODAY}`]);
  });
  it('LinkedIn, the Academy page is on but its own variable is not set: the line names it', () => {
    linkedinReady();
    env.linkedin.sharedPages = { academy: { orgUrn: ORG_AC, postFrom: FROM_AC, tokenFrom: 'taxscan' } };
    env.linkedin.allPushesFrom = { taxscan: PUSHES };
    startLinkedInWorker();
    expect(pushLines()[1]).toBe(`[linkedin] all pushes off: LINKEDIN_ACADEMY_ALL_PUSHES_FROM is not set ${TODAY}`);
  });
  it('LinkedIn, the existing boot lines are untouched: the academy line is still exactly one and says nothing about this', () => {
    linkedinReady();
    env.linkedin.sharedPages = {};
    startLinkedInWorker();
    expect(logs.filter((l) => l.includes('academy'))).toEqual(['[linkedin] academy page off: not configured (it needs both LINKEDIN_ACADEMY_ORG_URN and LINKEDIN_ACADEMY_POST_FROM)']);
  });
  it('LinkedIn posting switched off, or a worker that cannot start, prints no such line at all', () => {
    env.linkedin.enabled = false;
    startLinkedInWorker();
    expect(schedule).not.toHaveBeenCalled();
    expect(pushLines()).toEqual([]);
    linkedinReady();
    env.linkedin.pages.taxscan = { orgUrn: '', accessToken: '' };
    startLinkedInWorker();
    expect(schedule).not.toHaveBeenCalled();
    expect(pushLines()).toEqual([]);
  });
  const facebookReady = () => {
    env.facebook.enabled = true;
    env.facebook.postFrom = FROM;
    env.facebook.pages.taxscan = { pageId: FB_PAGE_ID, accessToken: FB_TOKEN };
  };
  it('Facebook: not set / invalid / on, one line each', () => {
    facebookReady();
    startFacebookWorker();
    expect(pushLines()).toEqual([`[facebook] all pushes off: FACEBOOK_ALL_PUSHES_FROM is not set ${TODAY}`]);
    expect(schedule).toHaveBeenCalledWith('* * * * *', expect.any(Function));
    logs.length = 0;
    process.env.FACEBOOK_ALL_PUSHES_FROM = 'whenever';
    startFacebookWorker();
    expect(pushLines()).toEqual([`[facebook] all pushes off: FACEBOOK_ALL_PUSHES_FROM is not a valid ISO time ${TODAY}`]);
    expect(pushLines().join('')).not.toContain('whenever');
    logs.length = 0;
    env.facebook.allPushesFrom = PUSHES_FB;
    startFacebookWorker();
    expect(pushLines()).toEqual([`[facebook] all pushes on for FACEBOOK_ALL_PUSHES_FROM (from ${PUSHES_FB.toISOString()})`]);
  });
  it('Facebook posting switched off prints no such line', () => {
    env.facebook.enabled = false;
    startFacebookWorker();
    expect(pushLines()).toEqual([]);
    expect(schedule).not.toHaveBeenCalled();
  });
});

/* ================================================================== */
/* Follow-up 1: turning a switch off (or moving it later) must not repost articles */
/* ================================================================== */

describe('15. LinkedIn: the all-pushes time removed or moved later reposts nothing', () => {
  const sendTicks = async (over: LiDeps) => {
    for (const m of [1, 2, 3, 15, 60, 600]) await runLinkedInTick(liDeps({ ...ONE, now: () => at(NOW, m), ...over }));
  };
  async function threeOnTheNewRule() {
    const arts = [await article('a1', after(10)), await article('a2', after(20)), await article('a3', after(30))];
    await runLinkedInTick(liDeps(ONE)); // the new rule is on: three posts, three `push:` rows
    expect(calls).toHaveLength(3);
    sameKeys(await keysOf(PAGE), arts.map(pk));
    calls = [];
    return arts;
  }
  it.each([['null', null], ['undefined (the env alone, and nothing is set there)', undefined]])('three articles posted with push: rows, the variable then REMOVED (%s): no new row and no post call over several ticks', async (_n, value) => {
    const arts = await threeOnTheNewRule();
    await sendTicks({ allPushesFrom: value as LiDeps['allPushesFrom'] });
    expect(calls).toEqual([]);
    sameKeys(await keysOf(PAGE), arts.map(pk));
    expect(pageCalls).toEqual([]);
  });
  it('the time MOVED LATER than those pushes: the same', async () => {
    const arts = await threeOnTheNewRule();
    await sendTicks({ allPushesFrom: { [PAGE]: after(60) } });
    expect(calls).toEqual([]);
    sameKeys(await keysOf(PAGE), arts.map(pk));
  });
  it.each(['POSTED', 'FAILED', 'SKIPPED'] as const)('whatever status the push: row has (%s): nothing is reposted', async (status) => {
    const arts = [await article('a1', after(10)), await article('a2', after(20)), await article('a3', after(30))];
    for (const a of arts) await liRow(PAGE, pk(a), a, status, status === 'FAILED' ? { attempts: 4, error: 'HTTP 500' } : {});
    await sendTicks({ allPushesFrom: null });
    expect(calls).toEqual([]);
    sameKeys(await keysOf(PAGE), arts.map(pk));
    expect((await liRows(PAGE)).every((r) => r.status === status)).toBe(true); // untouched
  });
  it('ANY push of the article counts: a repeat with a push: row covers its oldest push, which has none', async () => {
    const orig = await article('orig', after(10)); // no row of any kind
    const clone = await push(orig.url, after(20), { title: orig.title });
    await liRow(PAGE, pk(clone), clone, 'POSTED', { linkedinPostId: 'urn:li:share:1', postedAt: after(21) });
    await sendTicks({ allPushesFrom: null });
    expect(calls).toEqual([]);
    expect(await keysOf(PAGE)).toEqual([pk(clone)]);
  });
  it('the guard is per page: the Taxscan page\'s push: rows do not stop the Academy page from posting what it never posted', async () => {
    const arts = [await article('a1', at(NOW, -60)), await article('a2', at(NOW, -50))]; // after both pages\' go-lives
    for (const a of arts) await liRow(PAGE, pk(a), a, 'POSTED', { linkedinPostId: 'urn:li:share:1', postedAt: at(NOW, -40) });
    await runLinkedInTick(liDeps({ allPushesFrom: null }));
    expect(calls.map((x) => x.orgUrn)).toEqual([ORG_AC, ORG_AC]); // Academy (no rows of its own) posts each once; Taxscan nothing
    sameKeys(await keysOf(PAGE_AC), arts.map(articleKey));
    sameKeys(await keysOf(PAGE), arts.map(pk));
  });
});

describe('16. LinkedIn: after the removal, today\'s rule is back — new articles post once, handled ones never again', () => {
  it('a NEW article posts once; one that never got a push: row still gets its one post; a repeat of a handled article posts nothing', async () => {
    const handled = await article('handled', after(10));
    await runLinkedInTick(liDeps(ONE)); // the new rule is on: a push: row for `handled`
    const never = await article('never', after(20)); // pushed while the new rule was on, but the worker never saw it
    const repeat = await push(handled.url, after(25), { title: handled.title }); // a repeat of the handled article
    calls = [];
    const off = (m: number) => liDeps({ ...ONE, allPushesFrom: null, now: () => at(NOW, m) });
    await runLinkedInTick(off(1));
    const fresh = await article('fresh', after(40)); // pushed after the removal
    await runLinkedInTick(off(2));
    await runLinkedInTick(off(3));
    expect(calls.map(headOf).sort()).toEqual(['Story fresh', 'Story never']);
    sameKeys(await keysOf(PAGE), [pk(handled), articleKey(never), articleKey(fresh)]); // today\'s keys for the two; nothing for the repeat
    expect((await liRows(PAGE)).some((r) => r.campaignId === repeat.id)).toBe(false);
  });
});

describe('17. LinkedIn: set again later — every push from the new time posts, the past does not', () => {
  it('pushes at or after the new time post every time (a repeat of a handled article, a course); past pushes post nothing', async () => {
    const a = await article('a', after(10));
    await runLinkedInTick(liDeps(ONE)); // handled under the first time (08:00)
    const past = await push(courseUrl('c-past'), after(40), { title: 'Past course' }); // pushed while the variable was removed
    calls = [];
    await runLinkedInTick(liDeps({ ...ONE, allPushesFrom: null, now: () => at(NOW, 1) }));
    expect(calls).toEqual([]);
    const T2 = after(60);
    const e1 = await push(a.url, after(70), { title: a.title });
    const e2 = await push(a.url, after(80), { title: a.title });
    const c1 = await push(courseUrl('c-new'), after(90), { title: 'New course' });
    await runLinkedInTick(liDeps({ ...ONE, allPushesFrom: { [PAGE]: T2 }, now: () => at(NOW, 2) }));
    expect(calls.map(headOf)).toEqual([a.title, a.title, 'New course']); // every push from the new time, in order
    sameKeys(await keysOf(PAGE), [pk(a), pk(e1), pk(e2), pk(c1)]);
    expect((await liRows(PAGE)).some((r) => r.campaignId === past.id)).toBe(false); // the past does not
    await runLinkedInTick(liDeps({ ...ONE, allPushesFrom: { [PAGE]: T2 }, now: () => at(NOW, 3) }));
    expect(calls).toHaveLength(3); // and nothing more
  });
});

describe('15 + 16 + 17. Facebook: removal, moving later and setting again', () => {
  it('three articles posted with push: rows, the variable REMOVED, then MOVED LATER: no new row and no post over several ticks', async () => {
    const arts = [await article('a1', after(10)), await article('a2', after(20)), await article('a3', after(30))];
    await fbTicks([0, 11, 22]);
    expect(fbCalls).toHaveLength(3);
    sameKeys(await fbKeys(), arts.map(pk));
    fbCalls = [];
    await fbTicks([40, 51, 62, 73, 600], { allPushesFrom: null });
    await fbTicks([700, 711, 722], { allPushesFrom: after(60) });
    await fbTicks([800], { allPushesFrom: undefined });
    expect(fbCalls).toEqual([]);
    sameKeys(await fbKeys(), arts.map(pk));
  });
  it.each(['POSTED', 'FAILED', 'SKIPPED'] as const)('whatever status the push: row has (%s)', async (status) => {
    const arts = [await article('a1', after(10)), await article('a2', after(20)), await article('a3', after(30))];
    for (const a of arts) await fbRow(pk(a), a, status, status === 'FAILED' ? { attempts: 4, error: 'HTTP 500 code 2' } : {});
    await fbTicks([0, 11, 22, 33, 600], { allPushesFrom: null });
    expect(fbCalls).toEqual([]);
    sameKeys(await fbKeys(), arts.map(pk));
    expect((await fbRows()).every((r) => r.status === status)).toBe(true);
  });
  it('ANY push of the article counts: a repeat with a push: row covers its oldest push', async () => {
    const orig = await article('orig', after(10));
    const clone = await push(orig.url, after(20), { title: orig.title });
    await fbRow(pk(clone), clone, 'POSTED', { facebookPostId: '1_1', postedAt: after(21) });
    await fbTicks([0, 11, 22], { allPushesFrom: null });
    expect(fbCalls).toEqual([]);
    expect(await fbKeys()).toEqual([pk(clone)]);
  });
  it('after the removal a NEW article posts once, an article that never got a push: row still gets its one post, a repeat of a handled one posts nothing', async () => {
    const handled = await article('handled', after(10));
    await fbTicks([0]);
    const never = await article('never', after(20));
    await push(handled.url, after(25), { title: handled.title });
    fbCalls = [];
    await fbTicks([11], { allPushesFrom: null });
    const fresh = await article('fresh', after(40));
    await fbTicks([22, 33, 44, 55], { allPushesFrom: null });
    expect(fbCalls.map((c) => c.message.split('\n')[0]).sort()).toEqual(['Story fresh', 'Story never']);
    sameKeys(await fbKeys(), [pk(handled), articleKey(never), articleKey(fresh)]);
  });
  it('set again later: every push from the new time posts, the past does not', async () => {
    const a = await article('a', after(10));
    await fbTicks([0]);
    const past = await push(courseUrl('c-past'), after(40), { title: 'Past course' });
    fbCalls = [];
    await fbTicks([11], { allPushesFrom: null });
    expect(fbCalls).toEqual([]);
    const T2 = after(60);
    const e1 = await push(a.url, after(70), { title: a.title });
    const e2 = await push(a.url, after(80), { title: a.title });
    await fbTicks([22, 33, 44, 55], { allPushesFrom: T2 });
    expect(fbCalls).toHaveLength(2);
    sameKeys(await fbKeys(), [pk(a), pk(e1), pk(e2)]);
    expect((await fbRows()).some((r) => r.campaignId === past.id)).toBe(false);
  });
});

describe('18. the screens after a removal: an article with a push: row shows that row\'s status, not WAITING', () => {
  const liApp = (allPushesFrom: () => unknown = () => null) =>
    createApp({
      rateLimit: { publicPerMin: 10000, loginPerMin: 10000 },
      linkedin: { enabled: () => true, clock: () => NOW, portals: () => ({ [PORTAL]: [PAGE, PAGE_AC] }), postFrom: () => ({ [PAGE]: FROM, [PAGE_AC]: FROM_AC }), allPushesFrom: allPushesFrom as never, worker: liDeps() },
    });
  const fbApp = () =>
    createApp({
      rateLimit: { publicPerMin: 10000, loginPerMin: 10000 },
      facebook: { enabled: () => true, clock: () => NOW, portals: () => ({ [PORTAL]: FB_PAGE }), postFrom: () => FROM, allPushesFrom: () => null, worker: fbDeps() },
    });
  type Row = { id: string | null; campaignId: string; status: string; error: string | null; postUrl: string | null };
  it('LinkedIn: POSTED / FAILED / SKIPPED push rows show their own status (with their ids, so Retry and Skip work); an article without any row still reads WAITING', async () => {
    const posted = await article('p', ist(8, 10));
    const failed = await article('f', ist(8, 20));
    const skipped = await article('s', ist(8, 30));
    const fresh = await article('n', ist(9, 0));
    await liRow(PAGE, pk(posted), posted, 'POSTED', { linkedinPostId: 'urn:li:share:5', postedAt: ist(8, 12) });
    await liRow(PAGE, pk(failed), failed, 'FAILED', { attempts: 4, error: 'HTTP 500' });
    await liRow(PAGE, pk(skipped), skipped, 'SKIPPED');
    const a = liApp();
    const rows = (await request(a).get(`/api/linkedin/posts?date=2026-11-03&page=${PAGE}`).set(BEARER)).body.rows as Row[];
    expect(rows.map((r) => [r.campaignId, r.status])).toEqual([
      [posted.id, 'POSTED'],
      [failed.id, 'FAILED'],
      [skipped.id, 'SKIPPED'],
      [fresh.id, 'WAITING'],
    ]);
    expect(rows[0].postUrl).toBe('https://www.linkedin.com/feed/update/urn%3Ali%3Ashare%3A5/');
    expect(rows[1]).toMatchObject({ error: 'HTTP 500' });
    expect(rows.slice(0, 3).every((r) => r.id !== null)).toBe(true);
    // Retry from the article's row posts through the article builder
    const retried = await request(a).post(`/api/linkedin/posts/${rows[1].id}/retry`).set(BEARER).send({});
    expect(retried.body).toEqual({ ok: true, status: 'POSTED' });
    expect(headOf(calls[0])).toBe('Story f');
  });
  it('LinkedIn: when only a REPEAT has the push: row, the article row shows that row (the worker skips the article)', async () => {
    const orig = await article('orig', ist(8, 10));
    const clone = await push(orig.url, ist(8, 40), { title: orig.title });
    await liRow(PAGE, pk(clone), clone, 'POSTED', { linkedinPostId: 'urn:li:share:7', postedAt: ist(8, 41) });
    const rows = (await request(liApp()).get(`/api/linkedin/posts?date=2026-11-03&page=${PAGE}`).set(BEARER)).body.rows as Row[];
    expect(rows.map((r) => [r.campaignId, r.status])).toEqual([[orig.id, 'POSTED']]);
  });
  it('LinkedIn: an article-key row still wins over a push: row; a page with no push: rows reads exactly as before', async () => {
    const both = await article('both', ist(8, 10));
    await liRow(PAGE, articleKey(both), both, 'FAILED', { attempts: 4, error: 'HTTP 422' });
    await liRow(PAGE, pk(both), both, 'POSTED', { linkedinPostId: 'urn:li:share:9' });
    const w = await article('w', ist(8, 50));
    const rows = (await request(liApp()).get(`/api/linkedin/posts?date=2026-11-03&page=${PAGE}`).set(BEARER)).body.rows as Row[];
    expect(rows.map((r) => [r.campaignId, r.status])).toEqual([
      [both.id, 'FAILED'],
      [w.id, 'WAITING'],
    ]);
  });
  it('LinkedIn: a campaign row sent again has two push: rows: the article row shows the LATER one, whichever order the database returns them in', async () => {
    const a = await article('twice-a', ist(8, 10));
    const b = await article('twice-b', ist(8, 20));
    const older = new Date(Date.UTC(2026, 10, 1));
    const later = new Date(Date.UTC(2026, 10, 2));
    // a: the older row is created first; b: the later row is created first
    await liRow(PAGE, `push:${a.id}:1`, a, 'POSTED', { linkedinPostId: 'urn:li:share:1', createdAt: older });
    await liRow(PAGE, `push:${a.id}:2`, a, 'FAILED', { attempts: 4, error: 'HTTP 500', createdAt: later });
    await liRow(PAGE, `push:${b.id}:2`, b, 'FAILED', { attempts: 4, error: 'HTTP 500', createdAt: later });
    await liRow(PAGE, `push:${b.id}:1`, b, 'POSTED', { linkedinPostId: 'urn:li:share:2', createdAt: older });
    const rows = (await request(liApp()).get(`/api/linkedin/posts?date=2026-11-03&page=${PAGE}`).set(BEARER)).body.rows as Row[];
    expect(rows.map((r) => [r.campaignId, r.status])).toEqual([
      [a.id, 'FAILED'],
      [b.id, 'FAILED'],
    ]);
  });
  it('Facebook: a campaign row sent again has two push: rows: the article row shows the LATER one, whichever order the database returns them in', async () => {
    const a = await article('twice-a', ist(8, 10));
    const b = await article('twice-b', ist(8, 20));
    const older = new Date(Date.UTC(2026, 10, 1));
    const later = new Date(Date.UTC(2026, 10, 2));
    await fbRow(`push:${a.id}:1`, a, 'POSTED', { facebookPostId: '1_1', createdAt: older });
    await fbRow(`push:${a.id}:2`, a, 'FAILED', { attempts: 4, error: 'HTTP 500 code 2', createdAt: later });
    await fbRow(`push:${b.id}:2`, b, 'FAILED', { attempts: 4, error: 'HTTP 500 code 2', createdAt: later });
    await fbRow(`push:${b.id}:1`, b, 'POSTED', { facebookPostId: '1_2', createdAt: older });
    const rows = (await request(fbApp()).get('/api/facebook/posts?date=2026-11-03').set(BEARER)).body.rows as Row[];
    expect(rows.map((r) => [r.campaignId, r.status])).toEqual([
      [a.id, 'FAILED'],
      [b.id, 'FAILED'],
    ]);
  });
  it('Facebook: an article-key row still wins over a push: row', async () => {
    const both = await article('both', ist(8, 10));
    await fbRow(articleKey(both), both, 'FAILED', { attempts: 4, error: 'HTTP 500 code 2' });
    await fbRow(pk(both), both, 'POSTED', { facebookPostId: '1_9' });
    const rows = (await request(fbApp()).get('/api/facebook/posts?date=2026-11-03').set(BEARER)).body.rows as Row[];
    expect(rows.map((r) => [r.campaignId, r.status])).toEqual([[both.id, 'FAILED']]);
  });
  it('Facebook: the same', async () => {
    const posted = await article('p', ist(8, 10));
    const failed = await article('f', ist(8, 20));
    const fresh = await article('n', ist(9, 0));
    await fbRow(pk(posted), posted, 'POSTED', { facebookPostId: '1234567890_5', postedAt: ist(8, 12) });
    await fbRow(pk(failed), failed, 'FAILED', { attempts: 4, error: 'HTTP 500 code 2' });
    const orig = await article('orig', ist(8, 30));
    const clone = await push(orig.url, ist(8, 40), { title: orig.title });
    await fbRow(pk(clone), clone, 'SKIPPED');
    const rows = (await request(fbApp()).get('/api/facebook/posts?date=2026-11-03').set(BEARER)).body.rows as Row[];
    expect(rows.map((r) => [r.campaignId, r.status])).toEqual([
      [posted.id, 'POSTED'],
      [failed.id, 'FAILED'],
      [orig.id, 'SKIPPED'], // via its repeat's push: row
      [fresh.id, 'WAITING'],
    ]);
    expect(rows[0].postUrl).toBe('https://www.facebook.com/1234567890_5');
  });
});
