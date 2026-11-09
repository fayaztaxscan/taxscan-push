import cron from 'node-cron';
import bcrypt from 'bcrypt';
import request from 'supertest';
import { randomBytes } from 'node:crypto';
import type { Campaign, User } from '@prisma/client';
import { createApp } from '../app';
import {
  env,
  LINKEDIN_HEADROOM_DEFAULTS,
  parseLinkedInAcademyEnv,
  parseLinkedInHeadroom,
  parseLinkedInShopscanEnv,
  parseSharedLinkedInPage,
  type SharedLinkedInPage,
} from '../lib/env';
import { prisma } from '../lib/prisma';
import type { LinkedInRouterOptions } from '../routes/linkedin';
import { cloneForResend } from '../services/pacer';
import { pushKey } from '../services/social/allPushes';
import { dispatchCampaign, executeCampaign, type Sender } from '../services/send';
import type { LinkedInRequest, LinkedInResult } from '../services/linkedin/client';
import { buildPost } from '../services/linkedin/post';
import { PAGE_ACADEMY, PAGE_SHOPSCAN, PAGE_TAXSCAN, academyActive, pageAllPushesFrom, pageConfig, pageHeadroom, portalPages, shopscanActive, liUtmCampaign, withLinkedInUtm } from '../services/linkedin/pages';
import { ACCESS_TOKEN_URL, INTROSPECT_URL, cachedAccessToken, decryptSecret, keyBytes, pagesSharingToken, resetTokenCache, runTokenCheck, tokenPageOf, type TokenDeps } from '../services/linkedin/token';
import { MAX_PER_TICK, QUOTA_HEADROOM, authKey, isManualImmediatePush, loginProblem, postsCreatedToday, resetLinkedInStops, retryNow, runLinkedInTick, skipPost, startLinkedInWorker, startupProblem, type WorkerDeps } from '../services/linkedin/worker';

/**
 * Brief 2026-11-09-linkedin-shopscan-page (+ Follow-up 1: Academy is held too; + Follow-up 2: a manual immediate push is never held):
 * the Shopscan LinkedIn page, built like Academy, and the daily quota guard. ALL LinkedIn, CMS and e-mail calls are mocked.
 *
 * ISOLATION: rows live in a shared dev DB, so these tests never read or write the REAL pages `taxscan` / `academy` / `shopscan` (their
 * auth keys, rows, token). They use private pages: `lishop-t` plays Taxscan (it owns the token), `lishop-a` plays Academy and `lishop-s`
 * plays Shopscan (both borrow `lishop-t`'s token), registered in `env` for the length of the file. The guard is by `env.linkedin.dailyHeadroom[page]`,
 * so a private page gets Academy's 75 and Shopscan's 85 exactly as the real ones do; where the REAL names matter (the page list, its order,
 * the all-pushes time, the UTM, the boot lines, the defaults) the functions are pure or touch only `env`.
 *
 * COUNTING: `postsCreatedToday` reads rows by `updatedAt`, which the database stamps with the REAL time, so the clock these tests inject
 * is a day that is not today (20 Nov 2026) and the "creates already made today" are seeded rows with an explicit `updatedAt` on that day.
 * Rows other test files write at the real time never fall on it.
 */
const logs: string[] = [];
jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
jest.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
jest.spyOn(console, 'warn').mockImplementation(() => undefined);

const RUN = `${Date.now()}-${randomBytes(3).toString('hex')}`;
const PORTAL = `test-lish-${RUN}`;
const PAGE_T = 'lishop-t'; // plays the Taxscan page: owns the token, never held
const PAGE_A = 'lishop-a'; // plays Academy: holds at 75
const PAGE_S = 'lishop-s'; // plays Shopscan: holds at 85
const SEED_PAGE = 'lishop-seed'; // rows that stand for "creates already made today" (a page no tick handles)
const ORG_T = 'urn:li:organization:101';
const ORG_A = 'urn:li:organization:91100022';
const ORG_S = 'urn:li:organization:80241094';
const TOKEN = `SHOP-SHARED-TOKEN-${RUN}`;
const NEW_TOKEN = `SHOP-RENEWED-TOKEN-${RUN}`;
const IST_MS = (5 * 60 + 30) * 60_000;
const ist = (h: number, m = 0, day = 20) => new Date(Date.UTC(2026, 10, day, h, m) - IST_MS);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const at = (base: Date, min: number) => new Date(base.getTime() + min * MIN);
const NOW = ist(10, 0); // 20 Nov 2026 10:00 IST
const NEXT_DAY = ist(10, 0, 21);
const FROM = ist(4, 0); // every page's go-live except Shopscan's
const FROM_S = ist(8, 0); // Shopscan's own go-live: four hours after the others
const SHARED_A: SharedLinkedInPage = { orgUrn: ORG_A, postFrom: FROM, tokenFrom: PAGE_T };
const SHARED_S: SharedLinkedInPage = { orgUrn: ORG_S, postFrom: FROM_S, tokenFrom: PAGE_T };
const BEARER = { Authorization: `Bearer ${env.adminToken}` };
const PAGES = [PAGE_T, PAGE_A, PAGE_S];

const posted = (id = 'urn:li:share:1'): LinkedInResult => ({ kind: 'posted', postId: id });
const auth403: LinkedInResult = { kind: 'auth', status: 403, error: 'HTTP 403' };
const retry429: LinkedInResult = { kind: 'retry', status: 429, error: 'HTTP 429: quota' };
const orgName = (o: string) => (o === ORG_T ? 'T' : o === ORG_A ? 'A' : 'S');

let calls: LinkedInRequest[] = [];
let script: (r: LinkedInRequest, n: number) => LinkedInResult | Promise<LinkedInResult> = (r) => posted(`urn:li:share:${orgName(r.orgUrn)}${calls.length}`);
const post: NonNullable<WorkerDeps['post']> = async (r) => {
  calls.push(r);
  return script(r, calls.length);
};
const only = (orgUrn: string, answer: LinkedInResult) => (r: LinkedInRequest): LinkedInResult => (r.orgUrn === orgUrn ? answer : posted(`urn:li:share:${orgName(r.orgUrn)}${calls.length}`));
const orgs = () => calls.map((c) => c.orgUrn);
let mails: { to: string; subject: string; text: string }[] = [];
const deps = (over: WorkerDeps = {}): WorkerDeps => ({
  now: () => NOW,
  post,
  fetchCms: async () => null,
  fetchStorePage: async () => ({ ok: true, tags: { title: 'A page', description: 'About it.', imageUrl: null, imageReason: 'no_tag' } }),
  waitImage: async () => ({ ok: true }), // never reach LinkedIn's status endpoint from a test
  emailSender: async (m) => {
    mails.push(m);
    return { ok: true };
  },
  isEmailConfigured: () => true,
  recipients: async () => ['admin@team.test'],
  portals: { [PORTAL]: PAGES },
  postFrom: { [PAGE_T]: FROM }, // the others use their own configured go-live (sharedPages)
  quiet: { start: '23:00', end: '07:00' },
  ...over,
});

let seq = 0;
const articleUrl = (slug: string) => `https://www.taxscan.in/gst/${slug}-${RUN}-${++seq}`;
async function camp(slug: string, lastSentAt: Date, o: { url?: string; createdByUserId?: string | null; scheduledAt?: Date | null; sendQueue?: 'QUALIFIED' | null } = {}): Promise<Campaign> {
  return prisma.campaign.create({
    data: { portal: PORTAL, title: `Story ${slug}`, body: 'b', url: o.url ?? articleUrl(slug), target: {}, status: 'SENT', lastSentAt, authority: 'Supreme Court', categories: ['GST'], createdByUserId: o.createdByUserId ?? null, scheduledAt: o.scheduledAt ?? null, sendQueue: o.sendQueue ?? null } as never,
  });
}
const campIds = async () => (await prisma.campaign.findMany({ where: { portal: PORTAL }, select: { id: true } })).map((c) => c.id);
const rowsOf = async (page: string) => (await prisma.linkedInPost.findMany({ where: { page, campaignId: { in: await campIds() } }, orderBy: { createdAt: 'asc' } }));
const statusOf = async (page: string, c: Campaign) => (await prisma.linkedInPost.findFirst({ where: { page, campaignId: c.id } }))?.status ?? null;
/** "n creates already made today": n rows updated on the IST day of `day`. */
async function seedCreates(n: number, day: Date = NOW): Promise<void> {
  await prisma.linkedInPost.createMany({
    data: Array.from({ length: n }, (_, i) => ({ page: SEED_PAGE, articleKey: `seed-${RUN}-${day.getTime()}-${i}`, campaignId: 'seed', status: 'POSTED' as const, attempts: 1, createdAt: day, updatedAt: day })),
  });
}
const heldLine = (page: string) => logs.filter((l) => l.startsWith(`[linkedin] page=${page} ${QUOTA_HEADROOM} skipped=`));
/** Ticks until a tick makes no call and creates no row (a busy backlog is spread over ticks: MAX_PER_TICK). */
async function drain(over: WorkerDeps = {}, max = 12): Promise<void> {
  for (let i = 0; i < max; i++) {
    const before = [calls.length, await prisma.linkedInPost.count({ where: { campaignId: { in: await campIds() } } })];
    await runLinkedInTick(deps(over));
    if (calls.length === before[0] && (await prisma.linkedInPost.count({ where: { campaignId: { in: await campIds() } } })) === before[1]) return;
  }
}

const saved = {
  shared: env.linkedin.sharedPages,
  headroom: env.linkedin.dailyHeadroom,
  allPushes: env.linkedin.allPushesFrom,
  taxscan: env.linkedin.pages.taxscan,
  liPage: env.linkedin.pages[PAGE_T],
  from: env.linkedin.postFrom,
  enabled: env.linkedin.enabled,
  anyLink: env.social.anyLinkFrom,
  tr: { ...env.linkedin.tokenRefresh },
};

let USER: User;
const PASSWORD = 'ShopscanPw1Aa';
async function wipe() {
  const ids = await campIds();
  await prisma.linkedInPost.deleteMany({ where: { OR: [{ page: SEED_PAGE }, { campaignId: { in: ids } }, { page: { in: PAGES } }] } });
  await prisma.linkedInToken.deleteMany({ where: { page: { in: PAGES } } });
  await prisma.digestSetting.deleteMany({ where: { key: { in: [...PAGES.map(authKey), ...PAGES.map((p) => `linkedin:token:state:${p}`)] } } });
  await prisma.campaign.deleteMany({ where: { portal: PORTAL } });
}
beforeAll(async () => {
  env.linkedin.sharedPages = {}; // hermetic: whatever the developer's .env says about the real Academy / Shopscan pages
  USER = await prisma.user.create({ data: { email: `lishop-${RUN}@example.com`.toLowerCase(), passwordHash: await bcrypt.hash(PASSWORD, 4), role: 'ADMIN', isActive: true } });
});
beforeEach(async () => {
  calls = [];
  mails = [];
  logs.length = 0;
  script = (r) => posted(`urn:li:share:${orgName(r.orgUrn)}${calls.length}`);
  env.linkedin.pages[PAGE_T] = { orgUrn: ORG_T, accessToken: TOKEN };
  env.linkedin.pages.taxscan = { orgUrn: '', accessToken: '' };
  env.linkedin.sharedPages = { [PAGE_A]: { ...SHARED_A }, [PAGE_S]: { ...SHARED_S } };
  env.linkedin.dailyHeadroom = { [PAGE_A]: LINKEDIN_HEADROOM_DEFAULTS.academy, [PAGE_S]: LINKEDIN_HEADROOM_DEFAULTS.shopscan };
  // production: every page posts EVERY push (Taxscan + Academy by their variables, Shopscan from its go-live)
  env.linkedin.allPushesFrom = { [PAGE_T]: FROM, [PAGE_A]: FROM, [PAGE_S]: FROM_S };
  env.linkedin.postFrom = FROM;
  env.social.anyLinkFrom = null;
  Object.assign(env.linkedin.tokenRefresh, { ...saved.tr, enabled: false });
  resetLinkedInStops();
  resetTokenCache();
  await wipe();
});
afterAll(async () => {
  env.linkedin.sharedPages = saved.shared;
  env.linkedin.dailyHeadroom = saved.headroom;
  env.linkedin.allPushesFrom = saved.allPushes;
  env.linkedin.pages.taxscan = saved.taxscan;
  if (saved.liPage) env.linkedin.pages[PAGE_T] = saved.liPage;
  else delete env.linkedin.pages[PAGE_T];
  env.linkedin.postFrom = saved.from;
  env.linkedin.enabled = saved.enabled;
  env.social.anyLinkFrom = saved.anyLink;
  Object.assign(env.linkedin.tokenRefresh, saved.tr);
  await wipe();
  // the audit log is append-only; the carve-out lets the test sweep the rows its doors wrote
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL audit_log.allow_purge = 'true'`);
    await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "userId" = ${USER.id}`;
  });
  await prisma.user.deleteMany({ where: { id: USER.id } });
  await prisma.$disconnect();
});

/* ------------------------------------------------------------------ */
/* 1. The Shopscan variables: off unless BOTH are valid                */
/* ------------------------------------------------------------------ */

describe('1. the Shopscan page is off unless BOTH variables are valid, and then nothing about today\'s behaviour changes', () => {
  const URN = 'urn:li:organization:80241094';
  it('unset / only one / invalid time / invalid URN → off, with a reason that names the variable and never a value', () => {
    expect(parseLinkedInShopscanEnv({})).toEqual({ page: null, off: 'not configured (it needs both LINKEDIN_SHOPSCAN_ORG_URN and LINKEDIN_SHOPSCAN_POST_FROM)' });
    expect(parseLinkedInShopscanEnv({ LINKEDIN_SHOPSCAN_ORG_URN: URN })).toEqual({ page: null, off: 'LINKEDIN_SHOPSCAN_POST_FROM is missing or not a valid ISO time' });
    expect(parseLinkedInShopscanEnv({ LINKEDIN_SHOPSCAN_POST_FROM: '2026-11-09T10:00:00Z' })).toEqual({ page: null, off: 'LINKEDIN_SHOPSCAN_ORG_URN is missing or not urn:li:organization:<digits>' });
    for (const bad of ['04/11/2026', '2026', 'Nov 9', 'soon', '2026-13-45']) {
      const r = parseLinkedInShopscanEnv({ LINKEDIN_SHOPSCAN_ORG_URN: URN, LINKEDIN_SHOPSCAN_POST_FROM: bad });
      expect(r.page).toBeNull();
      expect(r.off).toBe('LINKEDIN_SHOPSCAN_POST_FROM is missing or not a valid ISO time');
      expect(r.off).not.toContain(bad);
    }
    for (const bad of ['80241094', 'urn:li:person:1', 'urn:li:organization:', 'urn:li:organization:12ab']) {
      const r = parseLinkedInShopscanEnv({ LINKEDIN_SHOPSCAN_ORG_URN: bad, LINKEDIN_SHOPSCAN_POST_FROM: '2026-11-09T10:00:00Z' });
      expect(r).toEqual({ page: null, off: 'LINKEDIN_SHOPSCAN_ORG_URN is missing or not urn:li:organization:<digits>' });
    }
    expect(parseLinkedInShopscanEnv({ LINKEDIN_SHOPSCAN_ORG_URN: 'bad', LINKEDIN_SHOPSCAN_POST_FROM: 'bad' }).off).toBe('LINKEDIN_SHOPSCAN_ORG_URN is missing or not urn:li:organization:<digits>; LINKEDIN_SHOPSCAN_POST_FROM is missing or not a valid ISO time');
  });

  it('both valid → active with the Taxscan page as the token owner (trimmed; a date-only value is UTC midnight)', () => {
    expect(parseLinkedInShopscanEnv({ LINKEDIN_SHOPSCAN_ORG_URN: `  ${URN} `, LINKEDIN_SHOPSCAN_POST_FROM: ' 2026-11-09T10:00:00Z ' })).toEqual({
      page: { orgUrn: URN, postFrom: new Date('2026-11-09T10:00:00Z'), tokenFrom: 'taxscan' },
      off: null,
    });
    expect(parseLinkedInShopscanEnv({ LINKEDIN_SHOPSCAN_ORG_URN: URN, LINKEDIN_SHOPSCAN_POST_FROM: '2026-11-09' }).page!.postFrom.toISOString()).toBe('2026-11-09T00:00:00.000Z');
  });

  it('Academy goes through the SAME parser and its answers (and wording) are exactly what they were', () => {
    expect(parseLinkedInAcademyEnv({})).toEqual({ page: null, off: 'not configured (it needs both LINKEDIN_ACADEMY_ORG_URN and LINKEDIN_ACADEMY_POST_FROM)' });
    expect(parseLinkedInAcademyEnv({ LINKEDIN_ACADEMY_ORG_URN: 'urn:li:organization:91100022' }).off).toBe('LINKEDIN_ACADEMY_POST_FROM is missing or not a valid ISO time');
    expect(parseLinkedInAcademyEnv({ LINKEDIN_ACADEMY_ORG_URN: 'x', LINKEDIN_ACADEMY_POST_FROM: 'y' }).off).toBe('LINKEDIN_ACADEMY_ORG_URN is missing or not urn:li:organization:<digits>; LINKEDIN_ACADEMY_POST_FROM is missing or not a valid ISO time');
    expect(parseLinkedInAcademyEnv({ LINKEDIN_ACADEMY_ORG_URN: 'urn:li:organization:91100022', LINKEDIN_ACADEMY_POST_FROM: '2026-11-04T10:00:00Z' }).page).toEqual({ orgUrn: 'urn:li:organization:91100022', postFrom: new Date('2026-11-04T10:00:00Z'), tokenFrom: 'taxscan' });
    expect(parseSharedLinkedInPage({ LINKEDIN_ACADEMY_ORG_URN: 'urn:li:organization:5', LINKEDIN_ACADEMY_POST_FROM: '2026-11-04' }, 'ACADEMY')).toEqual(parseLinkedInAcademyEnv({ LINKEDIN_ACADEMY_ORG_URN: 'urn:li:organization:5', LINKEDIN_ACADEMY_POST_FROM: '2026-11-04' }));
  });

  it('the guard defaults are Academy 75 and Shopscan 85, and nothing set means no Shopscan page', () => {
    expect(LINKEDIN_HEADROOM_DEFAULTS).toEqual({ academy: 75, shopscan: 85 });
    expect(parseLinkedInShopscanEnv({}).page).toBeNull();
  });

  it('inactive: the portal maps to Taxscan (+ Academy) only; with only Shopscan on it is Taxscan then Shopscan; both → Taxscan, Academy, Shopscan', () => {
    env.linkedin.sharedPages = {};
    expect(portalPages()).toEqual({ taxscan: [PAGE_TAXSCAN] });
    expect(shopscanActive()).toBe(false);
    env.linkedin.sharedPages = { [PAGE_ACADEMY]: { ...SHARED_A } };
    expect(portalPages()).toEqual({ taxscan: [PAGE_TAXSCAN, PAGE_ACADEMY] });
    env.linkedin.sharedPages = { [PAGE_SHOPSCAN]: { ...SHARED_S } };
    expect(portalPages()).toEqual({ taxscan: [PAGE_TAXSCAN, PAGE_SHOPSCAN] });
    // order does not depend on the order they were registered in
    env.linkedin.sharedPages = { [PAGE_SHOPSCAN]: { ...SHARED_S }, [PAGE_ACADEMY]: { ...SHARED_A } };
    expect(portalPages()).toEqual({ taxscan: [PAGE_TAXSCAN, PAGE_ACADEMY, PAGE_SHOPSCAN] });
    expect(academyActive() && shopscanActive()).toBe(true);
  });

  it('the real Shopscan page: its go-live IS its every-push time (no variable of its own), and only while it is active', () => {
    env.linkedin.sharedPages = {};
    expect(pageAllPushesFrom(PAGE_SHOPSCAN)).toBeNull();
    env.linkedin.sharedPages = { [PAGE_SHOPSCAN]: { ...SHARED_S } };
    expect(pageAllPushesFrom(PAGE_SHOPSCAN)).toEqual(FROM_S);
    env.linkedin.allPushesFrom = { ...env.linkedin.allPushesFrom, [PAGE_SHOPSCAN]: ist(1, 0) }; // a stray entry changes nothing
    expect(pageAllPushesFrom(PAGE_SHOPSCAN)).toEqual(FROM_S);
  });

  it('the real Shopscan page is the Taxscan page\'s token + its own org URN; it never has a token of its own', () => {
    env.linkedin.sharedPages = { [PAGE_SHOPSCAN]: { ...SHARED_S, tokenFrom: PAGE_T } };
    expect(tokenPageOf(PAGE_SHOPSCAN)).toBe(PAGE_T);
    expect(pagesSharingToken(PAGE_T)).toEqual([PAGE_SHOPSCAN]);
    expect(pageConfig(PAGE_SHOPSCAN)).toEqual({ orgUrn: ORG_S, accessToken: TOKEN });
  });

  it('the UTM is linkedin-shopscan, on the real page name', () => {
    expect(liUtmCampaign(PAGE_SHOPSCAN)).toBe('linkedin-shopscan');
    const u = new URL(withLinkedInUtm('https://www.taxscan.in/gst/x-1', PAGE_SHOPSCAN, 'c1'));
    expect([u.searchParams.get('utm_source'), u.searchParams.get('utm_medium'), u.searchParams.get('utm_campaign')]).toEqual(['taxscan-linkedin', 'social', 'linkedin-shopscan']);
  });

  it('startupProblem: no problem with the pages active; a Shopscan page with no usable go-live names ITS variable', () => {
    expect(startupProblem(deps())).toBeNull();
    expect(startupProblem({ portals: { [PORTAL]: [PAGE_T] }, postFrom: { [PAGE_T]: null } })).toBe('LINKEDIN_POST_FROM is missing or not a valid ISO time (nothing would be safe to post)');
    env.linkedin.sharedPages = { [PAGE_SHOPSCAN]: { ...SHARED_S } };
    expect(startupProblem({ portals: { [PORTAL]: [PAGE_T, PAGE_SHOPSCAN] }, postFrom: { [PAGE_T]: FROM, [PAGE_SHOPSCAN]: null } })).toBe('LINKEDIN_SHOPSCAN_POST_FROM is missing or not a valid ISO time (nothing would be safe to post)');
  });

  describe('the boot lines from startLinkedInWorker', () => {
    const shopLines = () => logs.filter((l) => l.includes('shopscan'));
    const acadLines = () => logs.filter((l) => l.includes('academy'));
    const VARS = ['LINKEDIN_SHOPSCAN_ORG_URN', 'LINKEDIN_SHOPSCAN_POST_FROM', 'LINKEDIN_ACADEMY_ORG_URN', 'LINKEDIN_ACADEMY_POST_FROM', 'LINKEDIN_ACADEMY_DAILY_HEADROOM', 'LINKEDIN_SHOPSCAN_DAILY_HEADROOM'];
    const realEnv = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
    let schedule: jest.SpyInstance;
    beforeEach(() => {
      schedule = jest.spyOn(cron, 'schedule').mockImplementation((() => ({ start: () => undefined, stop: () => undefined })) as never);
      env.linkedin.enabled = true;
      env.linkedin.pages.taxscan = { orgUrn: 'urn:li:organization:5', accessToken: 'tok-taxscan' };
      for (const v of VARS) delete process.env[v]; // the "off" reasons are read from the process env: start from a known state
      env.linkedin.dailyHeadroom = { academy: 75, shopscan: 85 }; // the REAL names: the guard line prints them
    });
    afterEach(() => {
      schedule.mockRestore();
      env.linkedin.enabled = saved.enabled;
      for (const v of VARS) {
        if (realEnv[v] === undefined) delete process.env[v];
        else process.env[v] = realEnv[v];
      }
    });

    it('both off: ONE Shopscan line says so, naming what is needed; Academy\'s line is the one it always was; no guard line; the worker starts', () => {
      env.linkedin.sharedPages = {};
      startLinkedInWorker();
      expect(schedule).toHaveBeenCalledWith('* * * * *', expect.any(Function));
      expect(shopLines()).toEqual(['[linkedin] shopscan page off: not configured (it needs both LINKEDIN_SHOPSCAN_ORG_URN and LINKEDIN_SHOPSCAN_POST_FROM)']);
      expect(acadLines()).toEqual(['[linkedin] academy page off: not configured (it needs both LINKEDIN_ACADEMY_ORG_URN and LINKEDIN_ACADEMY_POST_FROM)']);
      expect(logs.filter((l) => l.includes('quota guard'))).toEqual([]);
      expect(logs.filter((l) => l.includes('refusing'))).toEqual([]);
    });

    it('off because only one is set: the line says which one is missing, never its value', () => {
      env.linkedin.sharedPages = {};
      process.env.LINKEDIN_SHOPSCAN_ORG_URN = 'urn:li:organization:80241094';
      startLinkedInWorker();
      expect(shopLines()).toEqual(['[linkedin] shopscan page off: LINKEDIN_SHOPSCAN_POST_FROM is missing or not a valid ISO time']);
      expect(schedule).toHaveBeenCalled();
    });

    it('on: ONE Shopscan line with its go-live; the guard line names the pages it holds, capitalised, with their numbers', () => {
      env.linkedin.sharedPages = { [PAGE_SHOPSCAN]: { orgUrn: ORG_S, postFrom: new Date('2026-11-09T10:00:00Z'), tokenFrom: 'taxscan' } };
      env.linkedin.dailyHeadroom = { academy: 75, shopscan: 85 };
      startLinkedInWorker();
      expect(shopLines()).toEqual(['[linkedin] shopscan page on (post from 2026-11-09T10:00:00.000Z; every push from then)']);
      expect(logs.filter((l) => l.includes('daily quota guard'))).toEqual(['[linkedin] daily quota guard: Shopscan held at 85 posts a day, counted across all pages (Taxscan never held)']);
      env.linkedin.sharedPages = { [PAGE_ACADEMY]: { ...SHARED_A }, [PAGE_SHOPSCAN]: { ...SHARED_S } };
      logs.length = 0;
      startLinkedInWorker();
      expect(logs.filter((l) => l.includes('daily quota guard'))).toEqual(['[linkedin] daily quota guard: Academy held at 75, Shopscan held at 85 posts a day, counted across all pages (Taxscan never held)']);
      expect(acadLines()).toEqual([`[linkedin] academy page on (post from ${FROM.toISOString()})`]);
    });

    it('4c. an invalid number says so and the default is used; a valid one is used; neither says anything when unset', () => {
      env.linkedin.sharedPages = { [PAGE_ACADEMY]: { ...SHARED_A }, [PAGE_SHOPSCAN]: { ...SHARED_S } };
      process.env.LINKEDIN_ACADEMY_DAILY_HEADROOM = 'plenty';
      process.env.LINKEDIN_SHOPSCAN_DAILY_HEADROOM = '60';
      startLinkedInWorker();
      expect(logs.filter((l) => l.includes('[linkedin] quota guard:'))).toEqual(['[linkedin] quota guard: LINKEDIN_ACADEMY_DAILY_HEADROOM is not a whole number from 1 to 100 (using 75)']);
      logs.length = 0;
      delete process.env.LINKEDIN_ACADEMY_DAILY_HEADROOM;
      delete process.env.LINKEDIN_SHOPSCAN_DAILY_HEADROOM;
      startLinkedInWorker();
      expect(logs.filter((l) => l.includes('[linkedin] quota guard:'))).toEqual([]);
    });

    it('LINKEDIN_POSTING_ENABLED off still governs everything: no cron, no Shopscan line, and the API answers 404 for every page', async () => {
      env.linkedin.enabled = false;
      env.linkedin.sharedPages = { [PAGE_SHOPSCAN]: { ...SHARED_S } };
      startLinkedInWorker();
      expect(schedule).not.toHaveBeenCalled();
      expect(shopLines()).toHaveLength(0);
      const app = createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 }, linkedin: { enabled: () => env.linkedin.enabled } });
      for (const q of ['', '?page=shopscan', '?page=taxscan']) expect((await request(app).get(`/api/linkedin/posts${q}`).set(BEARER)).status).toBe(404);
    });

    it('a worker that cannot start (no Taxscan config) prints no Shopscan line at all', () => {
      env.linkedin.pages.taxscan = { orgUrn: '', accessToken: '' };
      startLinkedInWorker();
      expect(schedule).not.toHaveBeenCalled();
      expect(shopLines()).toHaveLength(0);
    });
  });

  it('with the Shopscan page NOT in the portal map a tick behaves as it did: Taxscan + Academy rows only, and not one log line, row or call mentions Shopscan', async () => {
    await camp('off-1', at(NOW, -30));
    await runLinkedInTick(deps({ portals: { [PORTAL]: [PAGE_T, PAGE_A] } }));
    expect(orgs()).toEqual([ORG_T, ORG_A]);
    expect(await rowsOf(PAGE_S)).toHaveLength(0);
    expect(logs.filter((l) => /shopscan|lishop-s/.test(l))).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 2. Three pages: three rows, three calls, in order                   */
/* ------------------------------------------------------------------ */

describe('2. one push → three rows and three post calls, Taxscan → Academy → Shopscan, Shopscan with its own UTM', () => {
  it('the order, the org URNs, the one shared token, the same text, and the per-page link', async () => {
    const c = await camp('three', at(NOW, -30));
    const r = await runLinkedInTick(deps());
    expect(r).toMatchObject({ posted: 3, failed: 0, authStopped: false });
    expect(orgs()).toEqual([ORG_T, ORG_A, ORG_S]);
    expect(calls.map((x) => x.accessToken)).toEqual([TOKEN, TOKEN, TOKEN]);
    expect(new Set(calls.map((x) => x.commentary.replace(/https?:\S+/g, ''))).size).toBe(1); // the same words on every page
    expect(calls.map((x) => new URL(x.link).searchParams.get('utm_campaign'))).toEqual([`linkedin-${PAGE_T}`, `linkedin-${PAGE_A}`, `linkedin-${PAGE_S}`]);
    for (const p of PAGES) expect((await rowsOf(p)).map((x) => [x.status, x.campaignId])).toEqual([['POSTED', c.id]]);
  });

  it('the buildPost UTM for the real Shopscan page name is linkedin-shopscan', async () => {
    const c = await camp('utm', at(NOW, -30));
    const p = await buildPost(c, PAGE_SHOPSCAN, async () => null);
    expect(new URL(p!.link).searchParams.get('utm_campaign')).toBe('linkedin-shopscan');
  });

  it('an exact repeat of a push is its OWN push: it posts once more on each page, and then never again (the unique page + push key)', async () => {
    const c = await camp('repush-orig', at(NOW, -60), { url: articleUrl('repush') });
    await runLinkedInTick(deps());
    expect(calls).toHaveLength(3);
    await camp('repush-again', at(NOW, -5), { url: c.url }); // the same link pushed again
    await drain();
    expect(calls).toHaveLength(6);
    await drain();
    expect(calls).toHaveLength(6);
  });
});

/* ------------------------------------------------------------------ */
/* 3. Every push from go-live                                           */
/* ------------------------------------------------------------------ */

describe('3. Shopscan posts EVERY push from its own go-live (courses, products, site pages, exact repeats) and never one before it', () => {
  it('a course, a product, a site page (with SOCIAL_ANY_LINK_FROM set) and an exact repeat each post to Shopscan; a push before its go-live does not', async () => {
    env.social.anyLinkFrom = FROM;
    const course = await camp('course', at(NOW, -50), { url: `https://academy.taxscan.in/course/gst-masterclass-${RUN}` });
    const product = await camp('product', at(NOW, -45), { url: `https://shop.taxscan.in/products/draft-replies-${RUN}` });
    const sitePage = await camp('page', at(NOW, -40), { url: 'https://www.taxscan.in/pricing' });
    const repeat1 = await camp('repeat-1', at(NOW, -35), { url: articleUrl('rep') });
    const repeat2 = await camp('repeat-2', at(NOW, -30), { url: repeat1.url });
    const early = await camp('early', at(FROM_S, -60)); // after the others' go-live (04:00), before Shopscan's (08:00)
    await drain();
    for (const c of [course, product, sitePage, repeat1, repeat2]) expect(await statusOf(PAGE_S, c)).toBe('POSTED');
    expect(await statusOf(PAGE_S, early)).toBeNull(); // never a row, never a call
    expect(await statusOf(PAGE_T, early)).toBe('POSTED'); // the others had gone live
    expect(await statusOf(PAGE_A, early)).toBe('POSTED');
    expect((await rowsOf(PAGE_S)).map((r) => r.articleKey).filter((k) => k.startsWith('push:'))).toHaveLength(5);
    expect(calls.filter((c) => c.orgUrn === ORG_S)).toHaveLength(5);
  });

  it('a push sent exactly AT its go-live is posted; one a minute before is not, at any age, however much later the tick runs', async () => {
    const atLive = await camp('at-live', FROM_S);
    const before = await camp('before-live', at(FROM_S, -1));
    await drain();
    expect(await statusOf(PAGE_S, atLive)).toBe('POSTED');
    expect(await statusOf(PAGE_S, before)).toBeNull();
    await drain({ now: () => NEXT_DAY });
    expect(await statusOf(PAGE_S, before)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 4. The daily quota guard                                             */
/* ------------------------------------------------------------------ */

describe('4. the daily quota guard (Academy at 75, Shopscan at 85, Taxscan never)', () => {
  it('postsCreatedToday: the sum of attempts of the rows touched on the IST day, across ALL pages; attempts 0 and other days do not count', async () => {
    expect(await postsCreatedToday(NOW)).toBe(0);
    await seedCreates(3);
    await prisma.linkedInPost.create({ data: { page: PAGE_T, articleKey: `k-${RUN}-multi`, campaignId: 'x', status: 'FAILED', attempts: 4, createdAt: NOW, updatedAt: NOW } });
    await prisma.linkedInPost.create({ data: { page: PAGE_A, articleKey: `k-${RUN}-zero`, campaignId: 'x', status: 'SKIPPED', attempts: 0, error: QUOTA_HEADROOM, createdAt: NOW, updatedAt: NOW } });
    expect(await postsCreatedToday(NOW)).toBe(7);
    // the IST day boundary, both ends
    await prisma.linkedInPost.create({ data: { page: PAGE_S, articleKey: `k-${RUN}-last`, campaignId: 'x', status: 'POSTED', attempts: 1, createdAt: ist(0, 0), updatedAt: at(ist(0, 0), 24 * 60 - 1) } }); // 23:59 IST
    expect(await postsCreatedToday(NOW)).toBe(8);
    await prisma.linkedInPost.create({ data: { page: PAGE_S, articleKey: `k-${RUN}-next`, campaignId: 'x', status: 'POSTED', attempts: 1, createdAt: ist(0, 0, 21), updatedAt: ist(0, 0, 21) } }); // 00:00 IST next day
    expect(await postsCreatedToday(NOW)).toBe(8);
    expect(await postsCreatedToday(ist(0, 0, 21))).toBe(1);
  });

  describe('4a. below the numbers everything posts; at 75 Academy is held', () => {
    it('74 creates today → all three pages post', async () => {
      await seedCreates(74);
      const c = await camp('g74', at(NOW, -30));
      await runLinkedInTick(deps());
      expect(orgs()).toEqual([ORG_T, ORG_A, ORG_S]);
      for (const p of PAGES) expect(await statusOf(p, c)).toBe('POSTED');
      expect(heldLine(PAGE_A)).toEqual([]);
    });

    it('75 → Academy SKIPPED quota_headroom with NO call; Taxscan and Shopscan post, in the same tick', async () => {
      await seedCreates(75);
      const c = await camp('g75', at(NOW, -30));
      await runLinkedInTick(deps());
      expect(orgs()).toEqual([ORG_T, ORG_S]);
      expect(await statusOf(PAGE_T, c)).toBe('POSTED');
      expect(await statusOf(PAGE_S, c)).toBe('POSTED');
      const held = await rowsOf(PAGE_A);
      expect(held).toHaveLength(1);
      expect(held[0]).toMatchObject({ status: 'SKIPPED', error: QUOTA_HEADROOM, attempts: 0, nextAttemptAt: null, campaignId: c.id });
      expect(heldLine(PAGE_A)).toEqual([`[linkedin] page=${PAGE_A} quota_headroom skipped=1`]);
    });

    it('the count is read ONCE per tick, before anything posts: Taxscan\'s own post is not what holds Academy (74 + that push\'s three posts)', async () => {
      await seedCreates(74);
      await camp('g74b', at(NOW, -30));
      await runLinkedInTick(deps());
      expect(calls).toHaveLength(3);
    });
  });

  describe('4b. at 85 Shopscan is held too; Taxscan is never held; a new IST day resets both', () => {
    it('85 → Academy and Shopscan SKIPPED quota_headroom, Taxscan posts', async () => {
      await seedCreates(85);
      const c = await camp('g85', at(NOW, -30));
      await drain();
      expect(orgs()).toEqual([ORG_T]);
      expect(await statusOf(PAGE_T, c)).toBe('POSTED');
      for (const p of [PAGE_A, PAGE_S]) expect((await rowsOf(p)).map((r) => [r.status, r.error])).toEqual([['SKIPPED', QUOTA_HEADROOM]]);
      expect(heldLine(PAGE_A)).toHaveLength(1);
      expect(heldLine(PAGE_S)).toHaveLength(1);
    });

    it('84 → Shopscan still posts (Academy, past 75, does not)', async () => {
      await seedCreates(84);
      await camp('g84', at(NOW, -30));
      await drain();
      expect(orgs()).toEqual([ORG_T, ORG_S]);
    });

    it('Taxscan is never held: 150 creates today and it still posts', async () => {
      await seedCreates(150);
      const c = await camp('g150', at(NOW, -30));
      await drain();
      expect(await statusOf(PAGE_T, c)).toBe('POSTED');
      expect(orgs()).toEqual([ORG_T]);
      expect(pageHeadroom(PAGE_T)).toBeNull();
    });

    it('a new IST day resets both: 90 creates yesterday → today\'s first push posts on all three pages', async () => {
      await seedCreates(90, NOW);
      const held = await camp('day-1', at(NOW, -30));
      await drain();
      expect(orgs()).toEqual([ORG_T]);
      calls = [];
      const fresh = await camp('day-2', at(NEXT_DAY, -30));
      await drain({ now: () => NEXT_DAY });
      expect(orgs()).toEqual([ORG_T, ORG_A, ORG_S]);
      for (const p of PAGES) expect(await statusOf(p, fresh)).toBe('POSTED');
      // yesterday's skipped push is NOT posted late
      for (const p of [PAGE_A, PAGE_S]) expect(await statusOf(p, held)).toBe('SKIPPED');
    });

    it('a held page skips ALL its waiting pushes, at no cost to the tick\'s budget; none is left to post after midnight', async () => {
      await seedCreates(90);
      const cs: Campaign[] = [];
      for (let i = 0; i < 5; i++) cs.push(await camp(`many-${i}`, at(NOW, -50 + i)));
      await drain();
      expect(calls.every((c) => c.orgUrn === ORG_T)).toBe(true);
      expect(calls).toHaveLength(5);
      for (const p of [PAGE_A, PAGE_S]) expect((await rowsOf(p)).map((r) => r.status)).toEqual(Array(5).fill('SKIPPED'));
      // later, with the count reset, a tick posts none of them
      calls = [];
      await drain({ now: () => NEXT_DAY });
      expect(calls).toHaveLength(0);
    });

    it('ONE log line per held page per IST day: the first tick that skipped, with how many; not again the same day; again the next', async () => {
      await seedCreates(90);
      await camp('l1', at(NOW, -30));
      await camp('l2', at(NOW, -29));
      await runLinkedInTick(deps());
      await runLinkedInTick(deps()); // Taxscan's second post
      await runLinkedInTick(deps());
      expect(heldLine(PAGE_A)).toHaveLength(1);
      expect(heldLine(PAGE_S)).toHaveLength(1);
      expect(heldLine(PAGE_A)[0]).toBe(`[linkedin] page=${PAGE_A} quota_headroom skipped=2`);
      await camp('l3', at(NOW, 5));
      await drain();
      expect(heldLine(PAGE_A)).toHaveLength(1); // the same IST day
      await seedCreates(90, NEXT_DAY);
      await camp('l4', at(NEXT_DAY, -30));
      await drain({ now: () => NEXT_DAY });
      expect(heldLine(PAGE_A)).toHaveLength(2);
      expect(heldLine(PAGE_A)[1]).toBe(`[linkedin] page=${PAGE_A} quota_headroom skipped=1`);
    });
  });

  describe('4c. the numbers override their defaults', () => {
    it('parseLinkedInHeadroom: unset → default; 1..100 → that; anything else → default WITH a note naming the variable', () => {
      expect(parseLinkedInHeadroom({}, 'academy')).toEqual({ value: 75, note: null });
      expect(parseLinkedInHeadroom({}, 'shopscan')).toEqual({ value: 85, note: null });
      expect(parseLinkedInHeadroom({ LINKEDIN_ACADEMY_DAILY_HEADROOM: '60' }, 'academy')).toEqual({ value: 60, note: null });
      expect(parseLinkedInHeadroom({ LINKEDIN_SHOPSCAN_DAILY_HEADROOM: ' 100 ' }, 'shopscan')).toEqual({ value: 100, note: null });
      expect(parseLinkedInHeadroom({ LINKEDIN_SHOPSCAN_DAILY_HEADROOM: '1' }, 'shopscan')).toEqual({ value: 1, note: null });
      for (const bad of ['0', '101', '-5', '7.5', 'many', '8o', '1e1', '0x10', '+5']) {
        expect(parseLinkedInHeadroom({ LINKEDIN_SHOPSCAN_DAILY_HEADROOM: bad }, 'shopscan')).toEqual({ value: 85, note: 'LINKEDIN_SHOPSCAN_DAILY_HEADROOM is not a whole number from 1 to 100 (using 85)' });
        expect(parseLinkedInHeadroom({ LINKEDIN_ACADEMY_DAILY_HEADROOM: bad }, 'academy')).toEqual({ value: 75, note: 'LINKEDIN_ACADEMY_DAILY_HEADROOM is not a whole number from 1 to 100 (using 75)' });
      }
    });

    it('with lowered numbers (40 / 60) 39 creates still post on all three pages', async () => {
      env.linkedin.dailyHeadroom = { [PAGE_A]: 40, [PAGE_S]: 60 };
      await seedCreates(39);
      const a = await camp('o39', at(NOW, -30));
      await drain();
      expect(orgs()).toEqual([ORG_T, ORG_A, ORG_S]);
      for (const p of PAGES) expect(await statusOf(p, a)).toBe('POSTED');
    });

    it('the numbers apply from the number itself: exactly at it is held, one below is not', async () => {
      env.linkedin.dailyHeadroom = { [PAGE_A]: 40, [PAGE_S]: 60 };
      await seedCreates(40);
      const c = await camp('o40', at(NOW, -30));
      await drain();
      expect(orgs()).toEqual([ORG_T, ORG_S]); // 40: Academy held; Shopscan (60) not
      await prisma.linkedInPost.deleteMany({ where: { page: SEED_PAGE } });
      await seedCreates(60);
      const d2 = await camp('o60', at(NOW, -20));
      calls = [];
      await drain();
      expect(orgs()).toEqual([ORG_T]);
      expect(await statusOf(PAGE_S, d2)).toBe('SKIPPED');
      expect(await statusOf(PAGE_S, c)).toBe('POSTED');
    });
  });

  describe('4d. with Shopscan inactive the Academy guard still works', () => {
    it('Shopscan not in the page list: 75 creates still hold Academy; 74 do not', async () => {
      const over = { portals: { [PORTAL]: [PAGE_T, PAGE_A] } };
      env.linkedin.sharedPages = { [PAGE_A]: { ...SHARED_A } };
      await seedCreates(74);
      await camp('d74', at(NOW, -30));
      await drain(over);
      expect(orgs()).toEqual([ORG_T, ORG_A]);
      await prisma.linkedInPost.deleteMany({ where: { page: SEED_PAGE } });
      await seedCreates(75);
      calls = [];
      const c = await camp('d75', at(NOW, -20));
      await drain(over);
      expect(orgs()).toEqual([ORG_T]);
      expect(await statusOf(PAGE_A, c)).toBe('SKIPPED');
      expect(await rowsOf(PAGE_S)).toHaveLength(0);
    });

    it('no page with a number in the list (Taxscan alone) → the count is not even read', async () => {
      const spy = jest.spyOn(prisma.linkedInPost, 'aggregate');
      await camp('solo', at(NOW, -30));
      await runLinkedInTick(deps({ portals: { [PORTAL]: [PAGE_T] } }));
      expect(spy).not.toHaveBeenCalled();
      expect(orgs()).toEqual([ORG_T]);
      await runLinkedInTick(deps()); // with a held-able page in the list it is read, once
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });
  });

  it('a held (SKIPPED quota_headroom) row is never retried, never skipped again, never posted later', async () => {
    await seedCreates(90);
    const c = await camp('nr', at(NOW, -30));
    await drain();
    const row = (await rowsOf(PAGE_S))[0];
    expect(row.status).toBe('SKIPPED');
    expect(await retryNow(row.id, deps())).toEqual({ ok: false, reason: 'not_failed' });
    expect(await skipPost(row.id)).toBe(false);
    const app = createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 }, linkedin: { enabled: () => true, clock: () => NOW, portals: () => ({ [PORTAL]: PAGES }), worker: deps() } });
    expect((await request(app).post(`/api/linkedin/posts/${row.id}/retry`).set(BEARER)).status).toBe(409);
    const sk = await request(app).post(`/api/linkedin/posts/${row.id}/skip`).set(BEARER);
    expect([sk.status, sk.body]).toEqual([409, { error: 'not_skippable' }]);
    // the count falls (a new day) and a tick does not post it
    calls = [];
    await runLinkedInTick(deps({ now: () => NEXT_DAY }));
    expect(calls).toHaveLength(0);
    expect(await statusOf(PAGE_S, c)).toBe('SKIPPED');
  });
});

/* ------------------------------------------------------------------ */
/* 4e–4g. A manual immediate push is never held                         */
/* ------------------------------------------------------------------ */

describe('4e–4g. a manual immediate push (Compose Send now, Breaking, Queue / Review Push now) is never held; anything automatic or scheduled still is', () => {
  const NOON = ist(12, 0);
  const NIGHT = ist(23, 30);
  const sendOk: Sender = async () => ({ ok: true, statusCode: 201 });
  /** The send path stamps `lastSentAt` with the REAL time; the worker tests need it on the test clock. */
  const stamp = async (id: string, when: Date): Promise<Campaign> => prisma.campaign.update({ where: { id }, data: { status: 'SENT', lastSentAt: when } });
  const composeNow = async (slug: string, when: Date, o: { breaking?: boolean; now?: Date } = {}) => {
    const r = await dispatchCampaign({ portal: PORTAL, title: `Story ${slug}`, body: 'b', url: articleUrl(slug), target: { type: 'all' }, createdByUserId: USER.id, ...(o.breaking ? { breaking: true } : {}) }, { sender: sendOk, now: o.now ?? NOON });
    return stamp(r.campaignId, when);
  };
  let cookie = '';
  const doorApp = createApp({ sender: sendOk, clock: () => NOON, linkCheck: false, rateLimit: { publicPerMin: 10000, loginPerMin: 10000 } });
  const door = () => doorApp;
  beforeAll(async () => {
    const res = await request(door()).post('/api/auth/login').send({ email: USER.email, password: PASSWORD });
    expect(res.status).toBe(200);
    const sc = res.headers['set-cookie'];
    cookie = (Array.isArray(sc) ? sc : [sc as string]).map((l) => l.split(';')[0]).join('; ');
  });
  const queuePushNow = async (slug: string, when: Date) => {
    const d = await prisma.campaign.create({ data: { portal: PORTAL, title: `Story ${slug}`, body: 'b', url: articleUrl(slug), target: { type: 'all' }, status: 'DRAFT', sendQueue: 'QUALIFIED' } });
    const res = await request(door()).post(`/api/queue/${d.id}/push`).set('Cookie', cookie).send({});
    expect(res.status).toBe(200);
    return stamp(d.id, when);
  };
  const reviewPushNow = async (slug: string, when: Date) => {
    const d = await prisma.campaign.create({ data: { portal: PORTAL, title: `Story ${slug}`, body: 'b', url: articleUrl(slug), target: { type: 'all' }, status: 'DRAFT', sendQueue: 'REVIEW' } });
    const res = await request(door()).post(`/api/review/${d.id}/push`).set('Cookie', cookie).send({});
    expect(res.status).toBe(200);
    return stamp(d.id, when);
  };
  /** A scheduled Compose send, as /api/send stores it, then the sweeper's own two steps (claim, execute): the sweeper itself sweeps EVERY scheduled row in the database, so a test does not run it. */
  const composeScheduled = async (slug: string, when: Date) => {
    const s = await prisma.campaign.create({ data: { portal: PORTAL, title: `Story ${slug}`, body: 'b', url: articleUrl(slug), target: { type: 'all' }, status: 'SCHEDULED', scheduledAt: at(NOON, -30), createdByUserId: USER.id } });
    await prisma.campaign.update({ where: { id: s.id }, data: { status: 'DRAFT' } });
    await executeCampaign((await prisma.campaign.findUniqueOrThrow({ where: { id: s.id } })), { sender: sendOk, now: NOON });
    return stamp(s.id, when);
  };
  const pacerPush = (slug: string, when: Date) => camp(slug, when, { sendQueue: 'QUALIFIED' }); // the pacer sets neither createdByUserId nor scheduledAt

  describe('what the send path records (no new column)', () => {
    it('every manual door leaves createdByUserId set and scheduledAt empty', async () => {
      const compose = await composeNow('rec-compose', at(NOW, -30));
      const breaking = await composeNow('rec-breaking', at(NOW, -29), { breaking: true, now: NIGHT });
      const queue = await queuePushNow('rec-queue', at(NOW, -28));
      const review = await reviewPushNow('rec-review', at(NOW, -27));
      for (const c of [compose, breaking, queue, review]) {
        expect(c).toMatchObject({ status: 'SENT', createdByUserId: USER.id, scheduledAt: null });
        expect(isManualImmediatePush(c)).toBe(true);
      }
    });

    it('a scheduled Compose send and a Compose send the night rule deferred keep their scheduledAt after they go out, so they are NOT manual', async () => {
      const scheduled = await composeScheduled('rec-sched', at(NOW, -30));
      expect(scheduled).toMatchObject({ status: 'SENT', createdByUserId: USER.id });
      expect(scheduled.scheduledAt).not.toBeNull();
      expect(isManualImmediatePush(scheduled)).toBe(false);
      // Send now (not Breaking) in quiet hours: stored SCHEDULED for 07:00, then sent by the sweeper
      const night = await dispatchCampaign({ portal: PORTAL, title: 'Story night', body: 'b', url: articleUrl('rec-night'), target: { type: 'all' }, createdByUserId: USER.id }, { sender: sendOk, now: NIGHT });
      expect(night.status).toBe('SCHEDULED');
      await prisma.campaign.update({ where: { id: night.campaignId }, data: { status: 'DRAFT' } });
      await executeCampaign(await prisma.campaign.findUniqueOrThrow({ where: { id: night.campaignId } }), { sender: sendOk, now: ist(7, 30, 21) });
      const sent = await stamp(night.campaignId, at(NOW, -29));
      expect(sent.scheduledAt).not.toBeNull();
      expect(isManualImmediatePush(sent)).toBe(false);
    });

    it('the pacer, an RSS capture, a bearer / curl send and the morning-backfill clone (even of a manual push) are not manual', async () => {
      const pacer = await pacerPush('rec-pacer', at(NOW, -30));
      expect(isManualImmediatePush(pacer)).toBe(false);
      const manual = await composeNow('rec-orig', at(NOW, -29));
      expect(isManualImmediatePush(manual)).toBe(true);
      const clone = await cloneForResend(manual);
      expect(clone.createdByUserId).toBeNull();
      expect(isManualImmediatePush(clone)).toBe(false);
      const bearer = await dispatchCampaign({ portal: PORTAL, title: 'Story bearer', body: 'b', url: articleUrl('rec-bearer'), target: { type: 'all' } }, { sender: sendOk, now: NOON });
      expect(isManualImmediatePush(await prisma.campaign.findUniqueOrThrow({ where: { id: bearer.campaignId } }))).toBe(false);
    });

    it('isManualImmediatePush on the two columns alone', () => {
      expect(isManualImmediatePush({ createdByUserId: 'u1', scheduledAt: null })).toBe(true);
      expect(isManualImmediatePush({ createdByUserId: 'u1', scheduledAt: NOW })).toBe(false);
      expect(isManualImmediatePush({ createdByUserId: null, scheduledAt: null })).toBe(false);
      expect(isManualImmediatePush({})).toBe(false);
    });
  });

  it('4e. with 90 creates today: Compose Send now, Push now (Queue and Review) and Breaking each post on all three pages; a pacer push the same minute posts on Taxscan only', async () => {
    await seedCreates(90);
    const minute = at(NOW, -30);
    const compose = await composeNow('e-compose', minute);
    const queue = await queuePushNow('e-queue', minute);
    const review = await reviewPushNow('e-review', minute);
    const breaking = await composeNow('e-breaking', minute, { breaking: true, now: NIGHT });
    const pacer = await pacerPush('e-pacer', minute);
    await drain();
    for (const c of [compose, queue, review, breaking]) for (const p of PAGES) expect([p, await statusOf(p, c)]).toEqual([p, 'POSTED']);
    expect(await statusOf(PAGE_T, pacer)).toBe('POSTED');
    expect(await statusOf(PAGE_A, pacer)).toBe('SKIPPED');
    expect(await statusOf(PAGE_S, pacer)).toBe('SKIPPED');
    expect((await rowsOf(PAGE_A)).find((r) => r.campaignId === pacer.id)).toMatchObject({ error: QUOTA_HEADROOM, attempts: 0 });
    expect(calls).toHaveLength(4 * 3 + 1);
    expect(calls.filter((c) => c.orgUrn !== ORG_T)).toHaveLength(4 * 2);
  });

  it('4e. the exemption is per push, not per tick: a manual push and an automatic one in the SAME tick are treated each its own way, in either order', async () => {
    await seedCreates(90);
    const auto = await pacerPush('e-auto-first', at(NOW, -40));
    const manual = await composeNow('e-manual-second', at(NOW, -30));
    const auto2 = await pacerPush('e-auto-third', at(NOW, -20));
    await drain();
    expect([await statusOf(PAGE_A, auto), await statusOf(PAGE_A, manual), await statusOf(PAGE_A, auto2)]).toEqual(['SKIPPED', 'POSTED', 'SKIPPED']);
    expect([await statusOf(PAGE_S, auto), await statusOf(PAGE_S, manual), await statusOf(PAGE_S, auto2)]).toEqual(['SKIPPED', 'POSTED', 'SKIPPED']);
    expect(calls.filter((c) => c.orgUrn === ORG_T)).toHaveLength(3);
  });

  it('4e. a manual push below the numbers posts as ever (nothing changes for a normal day)', async () => {
    await seedCreates(10);
    const c = await composeNow('e-normal', at(NOW, -30));
    await drain();
    for (const p of PAGES) expect(await statusOf(p, c)).toBe('POSTED');
  });

  it('4f. a scheduled Compose send firing at 90 creates is held like a pacer push', async () => {
    await seedCreates(90);
    const scheduled = await composeScheduled('f-sched', at(NOW, -30));
    await drain();
    expect(await statusOf(PAGE_T, scheduled)).toBe('POSTED');
    expect(await statusOf(PAGE_A, scheduled)).toBe('SKIPPED');
    expect(await statusOf(PAGE_S, scheduled)).toBe('SKIPPED');
    expect(orgs()).toEqual([ORG_T]);
  });

  it('4f. the morning-backfill clone of a manual push, and a bearer send, are held too', async () => {
    await seedCreates(90);
    const manual = await composeNow('f-orig', at(NOW, -60));
    const clone = await stamp((await cloneForResend(manual)).id, at(NOW, -30));
    const bearer = await dispatchCampaign({ portal: PORTAL, title: 'Story f-bearer', body: 'b', url: articleUrl('f-bearer'), target: { type: 'all' } }, { sender: sendOk, now: NOON });
    await stamp(bearer.campaignId, at(NOW, -20));
    await drain();
    expect(await statusOf(PAGE_A, manual)).toBe('POSTED');
    for (const id of [clone.id, bearer.campaignId]) {
      expect((await prisma.linkedInPost.findFirst({ where: { page: PAGE_A, campaignId: id } }))?.status).toBe('SKIPPED');
      expect((await prisma.linkedInPost.findFirst({ where: { page: PAGE_S, campaignId: id } }))?.status).toBe('SKIPPED');
    }
  });

  it('4g. a manual push that gets a real LinkedIn 429 follows the existing retry path (+1 min, then posts); nothing new', async () => {
    await seedCreates(90);
    const c = await composeNow('g-429', at(NOW, -30));
    let first = true;
    script = (r) => {
      if (r.orgUrn === ORG_A && first) {
        first = false;
        return retry429;
      }
      return posted(`urn:li:share:${orgName(r.orgUrn)}${calls.length}`);
    };
    await runLinkedInTick(deps());
    const row = (await rowsOf(PAGE_A)).find((r) => r.campaignId === c.id)!;
    expect(row).toMatchObject({ status: 'PENDING', attempts: 1 });
    expect(row.nextAttemptAt!.getTime()).toBe(at(NOW, 1).getTime());
    expect(row.error).toBe('HTTP 429: quota');
    await runLinkedInTick(deps({ now: () => at(NOW, 1) }));
    expect((await rowsOf(PAGE_A)).find((r) => r.campaignId === c.id)).toMatchObject({ status: 'POSTED', attempts: 2 });
    expect(await statusOf(PAGE_S, c)).toBe('POSTED');
  });

  it('4g. and a manual push that keeps getting 429 ends FAILED after the usual four attempts (+1, +5, +15 min)', async () => {
    await seedCreates(90);
    const c = await composeNow('g-fail', at(NOW, -30));
    script = only(ORG_A, retry429);
    for (const m of [0, 1, 6, 21]) await runLinkedInTick(deps({ now: () => at(NOW, m) }));
    expect((await rowsOf(PAGE_A)).find((r) => r.campaignId === c.id)).toMatchObject({ status: 'FAILED', attempts: 4 });
  });

  it('a manual post still counts toward the day\'s total for the automatic pushes after it', async () => {
    await seedCreates(90);
    const c = await composeNow('count-manual', at(NOW, -30));
    await drain();
    const rows = (await rowsOf(PAGE_S)).concat(await rowsOf(PAGE_A), await rowsOf(PAGE_T)).filter((r) => r.campaignId === c.id);
    expect(rows).toHaveLength(3);
    // the rows are real, with attempts, stamped now: on the day they were made they are in the count (never fewer than their own attempts)
    expect(rows.every((r) => r.attempts >= 1)).toBe(true);
    expect(await postsCreatedToday(rows[0].updatedAt)).toBeGreaterThanOrEqual(3);
  });
});

/* ------------------------------------------------------------------ */
/* 5. A login error stops its OWN page only                             */
/* ------------------------------------------------------------------ */

describe('5. a 403 on Shopscan stops Shopscan only; one alert per page per IST day', () => {
  it('Taxscan and Academy post in the same and later ticks; Shopscan keeps its own banner and its own e-mail', async () => {
    await camp('s1', at(NOW, -30));
    script = only(ORG_S, auth403);
    const t1 = await runLinkedInTick(deps());
    expect(t1).toMatchObject({ posted: 2, authStopped: true });
    expect(orgs()).toEqual([ORG_T, ORG_A, ORG_S]);
    expect(await loginProblem(PAGE_T)).toBeNull();
    expect(await loginProblem(PAGE_A)).toBeNull();
    expect(await loginProblem(PAGE_S)).toMatchObject({ status: 403 });
    expect((await rowsOf(PAGE_S))[0]).toMatchObject({ status: 'PENDING', attempts: 0 }); // kept: it posts once posting resumes
    expect(mails).toHaveLength(1);
    expect(mails[0].subject).toContain(`the ${PAGE_S} page`);
    expect(mails[0].text).toContain(`LINKEDIN_${PAGE_T.toUpperCase()}_ACCESS_TOKEN`); // the OWNER's variable: Shopscan has none of its own
    await camp('s2', at(NOW, -20));
    await runLinkedInTick(deps({ now: () => at(NOW, 3) }));
    expect(orgs()).toEqual([ORG_T, ORG_A, ORG_S, ORG_T, ORG_A]); // Shopscan makes no call at all while stopped
    expect(mails).toHaveLength(1);
    resetLinkedInStops(); // a restart the next IST day → one more e-mail, again only for Shopscan
    await runLinkedInTick(deps({ now: () => NEXT_DAY }));
    expect(mails).toHaveLength(2);
    expect(mails.every((m) => m.subject.includes(`the ${PAGE_S} page`))).toBe(true);
  });

  it('a 403 on Academy alone does not hold Shopscan back: it posts in the same tick, and only Academy is e-mailed', async () => {
    await camp('s-acad', at(NOW, -30));
    script = only(ORG_A, auth403);
    const t1 = await runLinkedInTick(deps());
    expect(t1).toMatchObject({ posted: 2, authStopped: true });
    expect(orgs()).toEqual([ORG_T, ORG_A, ORG_S]);
    expect(await loginProblem(PAGE_A)).toMatchObject({ status: 403 });
    expect(await loginProblem(PAGE_S)).toBeNull();
    expect(mails.map((m) => m.subject.includes(`the ${PAGE_A} page`))).toEqual([true]);
  });
});

/* ------------------------------------------------------------------ */
/* 6. Retry / Skip on one page leaves the others untouched              */
/* ------------------------------------------------------------------ */

describe('6. Retry / Skip on a Shopscan row leaves the other pages\' rows untouched', () => {
  it('Shopscan\'s post is rejected (422): its row is FAILED while Taxscan\'s and Academy\'s stay POSTED; Skip and Retry touch only Shopscan\'s', async () => {
    const c = await camp('r1', at(NOW, -30));
    script = only(ORG_S, { kind: 'failed', status: 422, error: 'HTTP 422: invalid content' });
    await runLinkedInTick(deps());
    const before = [await rowsOf(PAGE_T), await rowsOf(PAGE_A)].map((rs) => rs.map((r) => [r.id, r.status, r.updatedAt.getTime()]));
    const sRow = (await rowsOf(PAGE_S))[0];
    expect(sRow.status).toBe('FAILED');
    expect(await skipPost(sRow.id)).toBe(true);
    expect((await rowsOf(PAGE_S))[0].status).toBe('SKIPPED');
    await prisma.linkedInPost.update({ where: { id: sRow.id }, data: { status: 'FAILED' } });
    script = (r) => posted(`urn:li:share:${orgName(r.orgUrn)}${calls.length}`);
    calls = [];
    expect(await retryNow(sRow.id, deps())).toEqual({ ok: true, status: 'POSTED' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ orgUrn: ORG_S, accessToken: TOKEN });
    expect([await rowsOf(PAGE_T), await rowsOf(PAGE_A)].map((rs) => rs.map((r) => [r.id, r.status, r.updatedAt.getTime()]))).toEqual(before);
    expect(await statusOf(PAGE_S, c)).toBe('POSTED');
  });
});

/* ------------------------------------------------------------------ */
/* 7. Renewal                                                           */
/* ------------------------------------------------------------------ */

describe('7. renewal runs ONCE for the page that owns the token, and all three pages then post with the new token', () => {
  const KEY = randomBytes(32).toString('base64');
  let fetches: { url: string; body: URLSearchParams }[] = [];
  const response = (status: number, json: unknown) => ({ status, json: async () => json }) as unknown as Response;
  const fetchMock = (async (url: string, init: RequestInit) => {
    fetches.push({ url, body: new URLSearchParams(String(init.body)) });
    if (url === INTROSPECT_URL) return response(200, { active: true, status: 'active', expires_at: Math.floor((NOW.getTime() + 12 * DAY) / 1000) });
    return response(200, { access_token: NEW_TOKEN, expires_in: 5_184_000, refresh_token: `REFRESH-${RUN}`, refresh_token_expires_in: 30_000_000 });
  }) as unknown as typeof fetch;
  const tokenDeps = (): TokenDeps => ({
    now: () => NOW,
    fetch: fetchMock,
    emailSender: async (m) => {
      mails.push(m);
      return { ok: true };
    },
    isEmailConfigured: () => true,
    recipients: async () => ['admin@team.test'],
  });
  beforeEach(() => {
    fetches = [];
    Object.assign(env.linkedin.tokenRefresh, { enabled: true, clientId: 'client-id-1', clientSecret: `CLIENT-SECRET-${RUN}`, key: KEY });
    env.linkedin.pages[PAGE_T] = { orgUrn: ORG_T, accessToken: TOKEN, refreshToken: `REFRESH-${RUN}`, refreshExpiresAt: null };
  });

  it('one check, one introspection, ONE renewal call and ONE LinkedInToken row, with both shared pages active; none for either of them', async () => {
    const r = await runTokenCheck(tokenDeps());
    expect(r.refused).toBeNull();
    expect(r.pages.map((p) => [p.page, p.action])).toEqual([[PAGE_T, 'renewed']]);
    expect(fetches.filter((f) => f.url === ACCESS_TOKEN_URL)).toHaveLength(1);
    expect(fetches.filter((f) => f.url === INTROSPECT_URL)).toHaveLength(1);
    const rows = await prisma.linkedInToken.findMany({ where: { page: { in: PAGES } } });
    expect(rows.map((x) => x.page)).toEqual([PAGE_T]);
    expect(decryptSecret(rows[0].accessTokenEnc, keyBytes(KEY)!)).toBe(NEW_TOKEN);
    await runTokenCheck({ ...tokenDeps(), pages: [PAGE_S] });
    expect(await prisma.linkedInToken.count({ where: { page: { in: [PAGE_A, PAGE_S] } } })).toBe(0);
    expect(fetches.filter((f) => f.url === ACCESS_TOKEN_URL)).toHaveLength(1);
  });

  it('before the renewal all three pages post with the env token; after it, the NEXT tick posts on all three with the new one', async () => {
    await camp('rn-1', at(NOW, -30));
    await runLinkedInTick(deps());
    expect(calls.map((c) => c.accessToken)).toEqual([TOKEN, TOKEN, TOKEN]);
    await runTokenCheck(tokenDeps());
    for (const p of PAGES) expect(cachedAccessToken(p)).toBe(NEW_TOKEN);
    expect(pageConfig(PAGE_S)).toEqual({ orgUrn: ORG_S, accessToken: NEW_TOKEN });
    await camp('rn-2', at(NOW, -5));
    await runLinkedInTick(deps({ now: () => at(NOW, 1) }));
    expect(calls.slice(3).map((c) => [c.orgUrn, c.accessToken])).toEqual([[ORG_T, NEW_TOKEN], [ORG_A, NEW_TOKEN], [ORG_S, NEW_TOKEN]]);
  });

  it('all three stopped on the old token: the renewal ends every stop and banner at once, and the next tick resumes all three', async () => {
    await camp('rn-stop', at(NOW, -30));
    script = () => ({ kind: 'auth', status: 401, error: 'HTTP 401' });
    await runLinkedInTick(deps());
    expect(orgs()).toEqual([ORG_T, ORG_A, ORG_S]);
    for (const p of PAGES) expect(await loginProblem(p)).not.toBeNull();
    script = (r) => posted(`urn:li:share:${orgName(r.orgUrn)}${calls.length}`);
    await runTokenCheck(tokenDeps());
    for (const p of PAGES) expect(await loginProblem(p)).toBeNull();
    await runLinkedInTick(deps({ now: () => at(NOW, 2) }));
    expect(calls.slice(3).map((c) => [c.orgUrn, c.accessToken])).toEqual([[ORG_T, NEW_TOKEN], [ORG_A, NEW_TOKEN], [ORG_S, NEW_TOKEN]]);
  });
});

/* ------------------------------------------------------------------ */
/* 8. GET /api/linkedin/posts?page=                                     */
/* ------------------------------------------------------------------ */

describe('8. GET /api/linkedin/posts?page=shopscan', () => {
  const opts = (over: LinkedInRouterOptions = {}): LinkedInRouterOptions => ({ enabled: () => true, clock: () => NOW, portals: () => ({ [PORTAL]: PAGES }), postFrom: () => ({ [PAGE_T]: FROM }), worker: deps(), ...over });
  const appWith = (over: LinkedInRouterOptions = {}) => createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 }, linkedin: opts(over) });
  const get = (app: ReturnType<typeof createApp>, q = '') => request(app).get(`/api/linkedin/posts?date=2026-11-20${q}`).set(BEARER);

  it('the default is still the first (Taxscan) page; ?page=<shopscan> returns ITS rows and banner; `pages` lists the active pages in order', async () => {
    const c = await camp('api-1', at(NOW, -30));
    await camp('api-early', at(FROM_S, -60)); // before Shopscan's go-live
    await prisma.linkedInPost.createMany({
      data: [
        // every page posts EVERY push, so a push's row is keyed by the push itself
        { page: PAGE_T, articleKey: pushKey({ id: c.id, lastSentAt: c.lastSentAt! }), campaignId: c.id, status: 'POSTED', linkedinPostId: 'urn:li:share:77', postedAt: at(NOW, -29), attempts: 1 },
        { page: PAGE_S, articleKey: pushKey({ id: c.id, lastSentAt: c.lastSentAt! }), campaignId: c.id, status: 'FAILED', error: 'HTTP 422: invalid content', attempts: 1 },
      ],
    });
    await prisma.digestSetting.create({ data: { key: authKey(PAGE_S), value: JSON.stringify({ stoppedAt: NOW.toISOString(), alertedDay: '2026-11-20', status: 403 }) } });
    const app = appWith();
    const def = await get(app);
    expect(def.status).toBe(200);
    expect(def.body).toMatchObject({ date: '2026-11-20', page: PAGE_T, pages: PAGES, login: null });
    expect((await get(app, `&page=${PAGE_T}`)).body).toEqual(def.body);
    const sh = await get(app, `&page=${PAGE_S}`);
    expect(sh.status).toBe(200);
    expect(sh.body).toMatchObject({ page: PAGE_S, pages: PAGES, login: { status: 403 } });
    expect(sh.body.rows.map((r: { headline: string; status: string }) => [r.headline, r.status])).toEqual([['Story api-early', 'NOT_POSTED'], ['Story api-1', 'FAILED']]);
    expect(sh.body.tokenShared).toBe(true);
  });

  it('a row the guard held says so: skipReason "quota_headroom" on that row only; every other row\'s shape is what it was', async () => {
    await seedCreates(90);
    const c = await camp('api-held', at(NOW, -30));
    await drain();
    const app = appWith();
    const sh = await get(app, `&page=${PAGE_S}`);
    const row = sh.body.rows.find((r: { campaignId: string }) => r.campaignId === c.id);
    expect(row).toMatchObject({ status: 'SKIPPED', skipReason: QUOTA_HEADROOM, id: expect.any(String) });
    expect(sh.body.counts).toMatchObject({ skipped: 1, posted: 0, all: 1 });
    const tx = await get(app, `&page=${PAGE_T}`);
    expect(tx.body.rows[0].status).toBe('POSTED');
    expect(Object.keys(tx.body.rows[0])).not.toContain('skipReason');
    // a row skipped by a person has no skipReason either
    await prisma.linkedInPost.updateMany({ where: { page: PAGE_T, campaignId: c.id }, data: { status: 'FAILED' } });
    const t = (await rowsOf(PAGE_T))[0];
    await skipPost(t.id);
    const again = await get(app, `&page=${PAGE_T}`);
    expect(again.body.rows[0]).toMatchObject({ status: 'SKIPPED' });
    expect(Object.keys(again.body.rows[0])).not.toContain('skipReason');
  });

  it('an unknown page, or Shopscan while it is not in the list, is 400 invalid_page and reads nothing', async () => {
    const app = appWith({ portals: () => ({ [PORTAL]: [PAGE_T, PAGE_A] }) });
    for (const q of [`&page=${PAGE_S}`, '&page=nope', '&page=Shopscan']) {
      const r = await get(app, q);
      expect([r.status, r.body]).toEqual([400, { error: 'invalid_page' }]);
    }
    expect((await get(app)).body.pages).toEqual([PAGE_T, PAGE_A]);
  });

  it('with the real pages: ?page=shopscan answers 200 only while Shopscan is active (the portal map is the default one, the database is not asked about other pages)', async () => {
    const app = createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 }, linkedin: { enabled: () => true, clock: () => NOW } });
    env.linkedin.sharedPages = {};
    expect((await request(app).get('/api/linkedin/posts?date=2026-11-20&page=shopscan').set(BEARER)).status).toBe(400);
    env.linkedin.sharedPages = { [PAGE_SHOPSCAN]: { ...SHARED_S, tokenFrom: PAGE_T } };
    const ok = await request(app).get('/api/linkedin/posts?date=2026-11-20&page=shopscan').set(BEARER);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ page: 'shopscan', pages: ['taxscan', 'shopscan'] });
  });
});

/* ------------------------------------------------------------------ */
/* 10. The Compose picture                                              */
/* ------------------------------------------------------------------ */

describe('10. a push with a Compose picture uploads it under each active page\'s own org URN, Shopscan included', () => {
  it('three uploads (one per org URN, the shared token), three image posts', async () => {
    const id = randomBytes(32).toString('hex');
    await prisma.socialImage.create({ data: { id, mime: 'image/jpeg', width: 1080, height: 1080, size: 4, bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) } });
    try {
      const c = await camp('pic', at(NOW, -30));
      await prisma.campaign.update({ where: { id: c.id }, data: { socialImageId: id } });
      const uploads: { orgUrn: string; accessToken: string }[] = [];
      let n = 0;
      await runLinkedInTick(
        deps({
          socialPicture: true,
          uploadImage: async (r) => {
            uploads.push({ orgUrn: r.orgUrn, accessToken: r.accessToken });
            return { kind: 'ok', urn: `urn:li:image:PIC${++n}` };
          },
        }),
      );
      expect(uploads.map((u) => u.orgUrn)).toEqual([ORG_T, ORG_A, ORG_S]);
      expect(uploads.map((u) => u.accessToken)).toEqual([TOKEN, TOKEN, TOKEN]);
      expect(orgs()).toEqual([ORG_T, ORG_A, ORG_S]);
      expect(calls.map((x) => x.image)).toEqual(['urn:li:image:PIC1', 'urn:li:image:PIC2', 'urn:li:image:PIC3']);
    } finally {
      await prisma.socialImage.deleteMany({ where: { id } });
    }
  });
});

describe('the tick budget is still shared by all pages', () => {
  it('never more than MAX_PER_TICK posts in one tick across Taxscan, Academy and Shopscan', async () => {
    for (let i = 0; i < 4; i++) await camp(`b${i}`, at(NOW, -40 + i));
    let last = calls.length;
    for (let i = 0; i < 6; i++) {
      await runLinkedInTick(deps());
      expect(calls.length - last).toBeLessThanOrEqual(MAX_PER_TICK);
      last = calls.length;
    }
    expect(calls).toHaveLength(12); // four pushes on three pages, each exactly once
  });
});
