import cron from 'node-cron';
import request from 'supertest';
import { randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { createApp } from '../app';
import { env, parseLinkedInAcademyEnv, type SharedLinkedInPage } from '../lib/env';
import { prisma } from '../lib/prisma';
import { listCampaigns } from '../services/metrics';
import type { LinkedInRouterOptions } from '../routes/linkedin';
import { articleKey } from '../services/reports';
import type { LinkedInRequest, LinkedInResult } from '../services/linkedin/client';
import type { CoverImage } from '../services/linkedin/image';
import { buildPost } from '../services/linkedin/post';
import { PAGE_ACADEMY, PAGE_TAXSCAN, academyActive, normalizePortals, pageConfig, pagesOf, portalPages, resolvePostFrom, withLinkedInUtm } from '../services/linkedin/pages';
import { ACCESS_TOKEN_URL, INTROSPECT_URL, cachedAccessToken, decryptSecret, keyBytes, refreshActiveTokens, resetTokenCache, runTokenCheck, tokenPageOf, tokenStatus, type TokenDeps } from '../services/linkedin/token';
import { MAX_PER_TICK, authKey, loginProblem, resetLinkedInStops, retryNow, runLinkedInTick, startLinkedInWorker, startupProblem, type WorkerDeps } from '../services/linkedin/worker';

/**
 * Brief 2026-11-04-linkedin-academy-page, acceptance 1-9 and 11: the Taxscan Academy LinkedIn page posts the same articles as the
 * Taxscan page, with its own rows, org URN and go-live time, and the Taxscan page's token. ALL LinkedIn, CMS and e-mail calls are
 * mocked.
 *
 * ISOLATION: rows live in a shared dev DB, so these tests never read or write the state of the REAL pages `taxscan` / `academy`
 * (except the Channels column, whose mark is hard-wired to `taxscan`: its rows carry run-unique article keys and are removed
 * after every test). They use private pages instead: `liacad` stands for Taxscan (it owns the token) and `liacad-ac` for Academy
 * (it takes its token from `liacad`, has its own org URN and go-live time), both registered in `env` for the length of the file. Where
 * the real defaults must be shown (`portalPages()`, `pageConfig('academy')`, a default-wired tick or request) the database
 * calls are mocked, so nothing real is read.
 */
const logs: string[] = [];
jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
jest.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
jest.spyOn(console, 'warn').mockImplementation(() => undefined);

const RUN = `${Date.now()}-${randomBytes(3).toString('hex')}`;
const PORTAL = `test-lia-${RUN}`;
const PAGE = 'liacad'; // plays the Taxscan page: owns the token
const PAGE_AC = 'liacad-ac'; // plays the Academy page: shares PAGE's token
const ORG = 'urn:li:organization:101';
const ORG_AC = 'urn:li:organization:91100022';
const TOKEN = `ACAD-SHARED-TOKEN-${RUN}`;
const NEW_TOKEN = `ACAD-RENEWED-TOKEN-${RUN}`;
const IST_MS = (5 * 60 + 30) * 60_000;
const ist = (h: number, m = 0, day = 3) => new Date(Date.UTC(2026, 10, day, h, m) - IST_MS);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const at = (base: Date, min: number) => new Date(base.getTime() + min * MIN);
const NOW = ist(10, 0); // 3 Nov 2026 10:00 IST
const FROM = ist(4, 0); // the Taxscan page's go-live (LINKEDIN_POST_FROM)
const FROM_AC = ist(7, 0); // the Academy page's own go-live (LINKEDIN_ACADEMY_POST_FROM): three hours later
const ACADEMY: SharedLinkedInPage = { orgUrn: ORG_AC, postFrom: FROM_AC, tokenFrom: PAGE };
const BEARER = { Authorization: `Bearer ${env.adminToken}` };

const posted = (id = 'urn:li:share:1'): LinkedInResult => ({ kind: 'posted', postId: id });
const auth401: LinkedInResult = { kind: 'auth', status: 401, error: 'HTTP 401' };
const auth403: LinkedInResult = { kind: 'auth', status: 403, error: 'HTTP 403' };
const failed422: LinkedInResult = { kind: 'failed', status: 422, error: 'HTTP 422: invalid content' };

let calls: LinkedInRequest[] = [];
/** What LinkedIn answers; the default posts everything, with an id that says which page it went to. */
let script: (r: LinkedInRequest, n: number) => LinkedInResult | Promise<LinkedInResult> = (r) => posted(`urn:li:share:${r.orgUrn === ORG ? 'T' : 'A'}${calls.length}`);
const post: NonNullable<WorkerDeps['post']> = async (r) => {
  calls.push(r);
  return script(r, calls.length);
};
const only = (orgUrn: string, answer: LinkedInResult) => (r: LinkedInRequest): LinkedInResult => (r.orgUrn === orgUrn ? answer : posted(`urn:li:share:${r.orgUrn === ORG ? 'T' : 'A'}${calls.length}`));
const orgs = () => calls.map((c) => c.orgUrn);
let mails: { to: string; subject: string; text: string }[] = [];
const deps = (over: WorkerDeps = {}): WorkerDeps => ({
  now: () => NOW,
  post,
  fetchCms: async () => null,
  waitImage: async () => ({ ok: true }), // never reach LinkedIn's status endpoint from a test
  emailSender: async (m) => {
    mails.push(m);
    return { ok: true };
  },
  isEmailConfigured: () => true,
  recipients: async () => ['admin@team.test'],
  portals: { [PORTAL]: [PAGE, PAGE_AC] },
  postFrom: { [PAGE]: FROM, [PAGE_AC]: FROM_AC },
  quiet: { start: '23:00', end: '07:00' },
  ...over,
});

let seq = 0;
async function camp(slug: string, lastSentAt: Date, o: { title?: string; portal?: string; extra?: Record<string, unknown> } = {}) {
  return prisma.campaign.create({
    data: { portal: o.portal ?? PORTAL, title: o.title ?? `Story ${slug}`, body: 'b', url: `https://www.taxscan.in/gst/${slug}-${RUN}-${++seq}`, target: {}, status: 'SENT', lastSentAt, authority: 'Supreme Court', categories: ['GST'], ...(o.extra ?? {}) } as never,
  });
}
const repush = (url: string, lastSentAt: Date) => prisma.campaign.create({ data: { portal: PORTAL, title: 'again', body: 'b', url, target: {}, status: 'SENT', lastSentAt } });
const rowsOf = (page: string) => prisma.linkedInPost.findMany({ where: { page }, orderBy: { createdAt: 'asc' } });
const rowFor = (page: string, c: { id: string; url: string }, data: object = {}) => prisma.linkedInPost.create({ data: { page, articleKey: articleKey(c), campaignId: c.id, attempts: 1, ...data } as never });
const urnOf = (r: LinkedInRequest) => new URL(r.link).searchParams;

const saved = { shared: env.linkedin.sharedPages, taxscan: env.linkedin.pages.taxscan, liPage: env.linkedin.pages[PAGE], from: env.linkedin.postFrom, enabled: env.linkedin.enabled, tr: { ...env.linkedin.tokenRefresh } };

async function wipe() {
  await prisma.linkedInPost.deleteMany({ where: { page: { in: [PAGE, PAGE_AC] } } });
  await prisma.linkedInToken.deleteMany({ where: { page: { in: [PAGE, PAGE_AC] } } });
  await prisma.digestSetting.deleteMany({ where: { key: { in: [authKey(PAGE), authKey(PAGE_AC), `linkedin:token:state:${PAGE}`, `linkedin:token:state:${PAGE_AC}`] } } });
  await prisma.campaign.deleteMany({ where: { portal: { startsWith: PORTAL } } });
}
beforeAll(() => {
  env.linkedin.sharedPages = {}; // hermetic: whatever the developer's .env says about the real Academy page
});
beforeEach(async () => {
  calls = [];
  mails = [];
  logs.length = 0;
  script = (r) => posted(`urn:li:share:${r.orgUrn === ORG ? 'T' : 'A'}${calls.length}`);
  env.linkedin.pages[PAGE] = { orgUrn: ORG, accessToken: TOKEN };
  env.linkedin.pages.taxscan = { orgUrn: '', accessToken: '' };
  env.linkedin.sharedPages = { [PAGE_AC]: { ...ACADEMY } };
  env.linkedin.postFrom = FROM;
  Object.assign(env.linkedin.tokenRefresh, { ...saved.tr, enabled: false });
  resetLinkedInStops();
  resetTokenCache();
  await wipe();
});
afterAll(async () => {
  env.linkedin.sharedPages = saved.shared;
  env.linkedin.pages.taxscan = saved.taxscan;
  if (saved.liPage) env.linkedin.pages[PAGE] = saved.liPage;
  else delete env.linkedin.pages[PAGE];
  env.linkedin.postFrom = saved.from;
  env.linkedin.enabled = saved.enabled;
  Object.assign(env.linkedin.tokenRefresh, saved.tr);
  await wipe();
  await prisma.$disconnect();
});

/* ------------------------------------------------------------------ */
/* 1. The Academy variables: off unless BOTH are valid                 */
/* ------------------------------------------------------------------ */

describe('1. the Academy page is off unless BOTH variables are valid, and then nothing about it changes today\'s behaviour', () => {
  const URN = 'urn:li:organization:91100022';
  const TIME = '2026-11-04T10:00:00Z';
  const parse = (urn?: string, from?: string) => parseLinkedInAcademyEnv({ LINKEDIN_ACADEMY_ORG_URN: urn, LINKEDIN_ACADEMY_POST_FROM: from } as NodeJS.ProcessEnv);

  it('both valid → active, with the org URN, its OWN go-live time and the Taxscan page as the token owner (trimmed; a date-only value is UTC midnight)', () => {
    expect(parse(URN, TIME)).toEqual({ page: { orgUrn: URN, postFrom: new Date(TIME), tokenFrom: 'taxscan' }, off: null });
    expect(parse(`  ${URN}  `, `  ${TIME} `).page).toMatchObject({ orgUrn: URN, postFrom: new Date(TIME) });
    expect(parse(URN, '2026-11-04').page!.postFrom.toISOString()).toBe('2026-11-04T00:00:00.000Z');
    expect(parse(URN, '2026-11-04T10:00:00+05:30').page!.postFrom.toISOString()).toBe('2026-11-04T04:30:00.000Z');
  });

  it.each<[string, string | undefined, string | undefined, RegExp]>([
    ['neither is set', undefined, undefined, /not configured/],
    ['both empty', '', '   ', /not configured/],
    ['only the URN is set', URN, undefined, /LINKEDIN_ACADEMY_POST_FROM is missing/],
    ['only the time is set', undefined, TIME, /LINKEDIN_ACADEMY_ORG_URN is missing/],
    ['a URN of another kind', 'urn:li:person:12345', TIME, /LINKEDIN_ACADEMY_ORG_URN/],
    ['a URN with no digits', 'urn:li:organization:', TIME, /LINKEDIN_ACADEMY_ORG_URN/],
    ['a URN with letters', 'urn:li:organization:abc', TIME, /LINKEDIN_ACADEMY_ORG_URN/],
    ['a bare number', '91100022', TIME, /LINKEDIN_ACADEMY_ORG_URN/],
    ['the page URL', 'https://www.linkedin.com/company/91100022/', TIME, /LINKEDIN_ACADEMY_ORG_URN/],
    ['a URN with trailing junk', `${URN}/admin`, TIME, /LINKEDIN_ACADEMY_ORG_URN/],
    ['a time that is not a time', URN, 'tomorrow morning', /LINKEDIN_ACADEMY_POST_FROM is missing or not a valid ISO time/],
    ['an impossible month', URN, '2026-13-01T00:00:00Z', /LINKEDIN_ACADEMY_POST_FROM/],
    ['an impossible hour', URN, '2026-11-04T25:00:00Z', /LINKEDIN_ACADEMY_POST_FROM/],
    ['a bare year (Date.parse would take it as 1 January: a flood of every push since)', URN, '2026', /LINKEDIN_ACADEMY_POST_FROM/],
    ['a slash date (Date.parse would read 04/11 as April)', URN, '04/11/2026', /LINKEDIN_ACADEMY_POST_FROM/],
    ['a month name', URN, 'Nov 4 2026', /LINKEDIN_ACADEMY_POST_FROM/],
    ['both invalid', 'nope', 'never', /LINKEDIN_ACADEMY_ORG_URN.*LINKEDIN_ACADEMY_POST_FROM/],
  ])('INACTIVE: %s', (_what, urn, from, why) => {
    const r = parse(urn, from);
    expect(r.page).toBeNull();
    expect(r.off).toMatch(why);
    // fixed words naming the variables: the reason never echoes a value (the one exception is a value that IS the format's own prefix)
    for (const v of [urn, from]) if (v && v.trim().length > 5 && v.trim() !== 'urn:li:organization:') expect(r.off).not.toContain(v.trim());
  });

  it('the real env object is built from it: nothing set here → no shared page', () => {
    expect(parseLinkedInAcademyEnv({} as NodeJS.ProcessEnv)).toEqual({ page: null, off: expect.stringContaining('not configured') });
  });

  it('inactive: the portal maps to the Taxscan page ONLY, and the worker has no startup problem', () => {
    env.linkedin.sharedPages = {};
    expect(academyActive()).toBe(false);
    expect(portalPages()).toEqual({ taxscan: [PAGE_TAXSCAN] });
    expect(pageConfig(PAGE_ACADEMY)).toBeNull();
    env.linkedin.pages.taxscan = { orgUrn: 'urn:li:organization:5', accessToken: 'tok-taxscan' };
    expect(startupProblem()).toBeNull();
  });

  it('active: the portal maps to Taxscan FIRST, then Academy; Academy = its own org URN + the Taxscan token (the one in use) + its own go-live', async () => {
    env.linkedin.pages.taxscan = { orgUrn: 'urn:li:organization:5', accessToken: 'tok-taxscan' };
    env.linkedin.sharedPages = { academy: { orgUrn: URN, postFrom: new Date(TIME), tokenFrom: 'taxscan' } };
    expect(academyActive()).toBe(true);
    expect(portalPages()).toEqual({ taxscan: [PAGE_TAXSCAN, PAGE_ACADEMY] });
    expect(pageConfig(PAGE_TAXSCAN)).toEqual({ orgUrn: 'urn:li:organization:5', accessToken: 'tok-taxscan' });
    expect(pageConfig(PAGE_ACADEMY)).toEqual({ orgUrn: URN, accessToken: 'tok-taxscan' });
    expect(tokenPageOf(PAGE_ACADEMY)).toBe('taxscan');
    expect(tokenPageOf(PAGE_TAXSCAN)).toBe('taxscan');
    expect(resolvePostFrom(undefined, PAGE_ACADEMY)).toEqual(new Date(TIME));
    expect(resolvePostFrom(undefined, PAGE_TAXSCAN)).toEqual(FROM); // env.linkedin.postFrom, set in beforeEach
    expect(startupProblem()).toBeNull();
    // the renewed token (the cache) is what BOTH pages use: the active-token cache resolves academy through taxscan
    await refreshActiveTokens();
    expect(cachedAccessToken(PAGE_ACADEMY)).toBe(cachedAccessToken(PAGE_TAXSCAN));
    // Academy is never the reason the worker refuses to start: only the Taxscan page's own config can be
    env.linkedin.pages.taxscan = { orgUrn: '', accessToken: '' };
    expect(startupProblem()).toMatch(/LINKEDIN_TAXSCAN_ORG_URN/);
    env.linkedin.pages.taxscan = { orgUrn: 'urn:li:organization:5', accessToken: 'tok-taxscan' };
    env.linkedin.postFrom = null;
    expect(startupProblem()).toMatch(/^LINKEDIN_POST_FROM is missing/);
  });

  it('a default-wired tick with Academy OFF asks about the taxscan page only: not one query, row or log line mentions academy', async () => {
    env.linkedin.sharedPages = {};
    env.linkedin.pages.taxscan = { orgUrn: 'urn:li:organization:5', accessToken: 'tok-taxscan' };
    const stale = jest.spyOn(prisma.linkedInPost, 'updateMany').mockResolvedValue({ count: 0 });
    const rows = jest.spyOn(prisma.linkedInPost, 'findMany').mockResolvedValue([]);
    const camps = jest.spyOn(prisma.campaign, 'findMany').mockResolvedValue([]);
    try {
      const t = await runLinkedInTick({ now: () => NOW, post, fetchCms: async () => null, quiet: { start: '23:00', end: '07:00' } });
      expect(t).toEqual({ posted: 0, retried: 0, failed: 0, staleClosed: 0, authStopped: false, refused: null });
      expect((stale.mock.calls[0][0] as { where: { page: { in: string[] } } }).where.page.in).toEqual(['taxscan']);
      expect(rows.mock.calls.map((c) => (c[0] as { where: { page: string } }).where.page)).toEqual(['taxscan']); // the due-retries read
      expect(camps.mock.calls.map((c) => (c[0] as { where: { portal: { in: string[] }; lastSentAt: { gte: Date } } }).where)).toEqual([{ portal: { in: ['taxscan'] }, status: 'SENT', lastSentAt: { gte: FROM } }]);
      expect(JSON.stringify([stale.mock.calls, rows.mock.calls, camps.mock.calls, logs])).not.toContain('academy');
    } finally {
      stale.mockRestore();
      rows.mockRestore();
      camps.mockRestore();
    }
  });

  it('a default-wired tick with Academy ON asks about both pages, Taxscan first, each with its OWN go-live time', async () => {
    env.linkedin.pages.taxscan = { orgUrn: 'urn:li:organization:5', accessToken: 'tok-taxscan' };
    env.linkedin.sharedPages = { academy: { orgUrn: URN, postFrom: FROM_AC, tokenFrom: 'taxscan' } };
    const stale = jest.spyOn(prisma.linkedInPost, 'updateMany').mockResolvedValue({ count: 0 });
    const rows = jest.spyOn(prisma.linkedInPost, 'findMany').mockResolvedValue([]);
    const camps = jest.spyOn(prisma.campaign, 'findMany').mockResolvedValue([]);
    try {
      await runLinkedInTick({ now: () => NOW, post, fetchCms: async () => null, quiet: { start: '23:00', end: '07:00' } });
      expect((stale.mock.calls[0][0] as { where: { page: { in: string[] } } }).where.page.in).toEqual(['taxscan', 'academy']);
      expect(rows.mock.calls.map((c) => (c[0] as { where: { page: string } }).where.page)).toEqual(['taxscan', 'academy']);
      expect(camps.mock.calls.map((c) => (c[0] as { where: { lastSentAt: { gte: Date } } }).where.lastSentAt.gte)).toEqual([FROM, FROM_AC]);
    } finally {
      stale.mockRestore();
      rows.mockRestore();
      camps.mockRestore();
    }
  });

  it('with a go-live time injected as ONE Date (the old shape) every page uses it; a per-page record falls back to the page\'s own for a page it omits', () => {
    expect(resolvePostFrom(FROM, PAGE_AC)).toEqual(FROM);
    expect(resolvePostFrom(null, PAGE)).toBeNull();
    expect(resolvePostFrom({ [PAGE]: FROM }, PAGE_AC)).toEqual(FROM_AC); // the page's own (sharedPages)
    expect(resolvePostFrom({ [PAGE]: FROM, [PAGE_AC]: null }, PAGE_AC)).toBeNull();
    expect(normalizePortals({ a: 'p', b: ['p', 'q', 'p'] })).toEqual({ a: ['p'], b: ['p', 'q'] });
    expect(pagesOf({ a: ['p', 'q'], b: ['q', 'r'] })).toEqual(['p', 'q', 'r']);
  });

  describe('the one boot line from startLinkedInWorker', () => {
    const lines = () => logs.filter((l) => l.includes('academy'));
    const realEnv = { urn: process.env.LINKEDIN_ACADEMY_ORG_URN, from: process.env.LINKEDIN_ACADEMY_POST_FROM };
    const restoreVar = (name: string, v: string | undefined): void => {
      if (v === undefined) delete process.env[name];
      else process.env[name] = v;
    };
    let schedule: jest.SpyInstance;
    beforeEach(() => {
      schedule = jest.spyOn(cron, 'schedule').mockImplementation((() => ({ start: () => undefined, stop: () => undefined })) as never);
      env.linkedin.enabled = true;
      env.linkedin.pages.taxscan = { orgUrn: 'urn:li:organization:5', accessToken: 'tok-taxscan' };
      delete process.env.LINKEDIN_ACADEMY_ORG_URN; // the "off" reason is read from the process env: start from a known state
      delete process.env.LINKEDIN_ACADEMY_POST_FROM;
    });
    afterEach(() => {
      schedule.mockRestore();
      env.linkedin.enabled = saved.enabled;
      restoreVar('LINKEDIN_ACADEMY_ORG_URN', realEnv.urn);
      restoreVar('LINKEDIN_ACADEMY_POST_FROM', realEnv.from);
    });
    it('off: ONE line says so, naming what is needed; the worker still starts', () => {
      env.linkedin.sharedPages = {};
      startLinkedInWorker();
      expect(schedule).toHaveBeenCalledWith('* * * * *', expect.any(Function));
      expect(lines()).toHaveLength(1);
      expect(lines()[0]).toMatch(/^\[linkedin\] academy page off: not configured \(it needs both LINKEDIN_ACADEMY_ORG_URN and LINKEDIN_ACADEMY_POST_FROM\)$/);
      expect(logs.filter((l) => l.includes('refusing'))).toEqual([]); // no refusal to start
    });
    it('off because only one is set: the line says which one is missing, never its value', () => {
      env.linkedin.sharedPages = {};
      process.env.LINKEDIN_ACADEMY_ORG_URN = 'urn:li:organization:91100022';
      startLinkedInWorker();
      expect(lines()).toHaveLength(1);
      expect(lines()[0]).toBe('[linkedin] academy page off: LINKEDIN_ACADEMY_POST_FROM is missing or not a valid ISO time');
      expect(schedule).toHaveBeenCalled();
    });
    it('on: ONE line with its post-from', () => {
      env.linkedin.sharedPages = { academy: { orgUrn: URN, postFrom: new Date(TIME), tokenFrom: 'taxscan' } };
      startLinkedInWorker();
      expect(lines()).toEqual([`[linkedin] academy page on (post from ${new Date(TIME).toISOString()})`]);
    });
    it('LINKEDIN_POSTING_ENABLED off still governs everything: with valid Academy variables there is no cron, no Academy line, and the API answers 404 for either page', async () => {
      env.linkedin.enabled = false;
      env.linkedin.sharedPages = { academy: { orgUrn: URN, postFrom: new Date(TIME), tokenFrom: 'taxscan' } };
      startLinkedInWorker();
      expect(schedule).not.toHaveBeenCalled();
      expect(lines()).toHaveLength(0);
      expect(logs.some((l) => l.includes('[linkedin] disabled'))).toBe(true);
      const app = createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 }, linkedin: { enabled: () => env.linkedin.enabled } });
      for (const q of ['', '?page=academy', '?page=taxscan']) expect((await request(app).get(`/api/linkedin/posts${q}`).set(BEARER)).status).toBe(404);
    });
    it('a worker that cannot start (no Taxscan config) prints no Academy line at all', () => {
      env.linkedin.pages.taxscan = { orgUrn: '', accessToken: '' };
      startLinkedInWorker();
      expect(schedule).not.toHaveBeenCalled();
      expect(lines()).toHaveLength(0);
    });
  });
});

/* ------------------------------------------------------------------ */
/* 2. Two pages, two rows, two calls                                    */
/* ------------------------------------------------------------------ */

describe('2. an article pushed after both go-live times is posted to BOTH pages', () => {
  it('two rows, two post calls (one per org URN, Taxscan first), each with its own UTM link; the same text; the one shared token', async () => {
    const c = await camp('both', at(NOW, -30), { title: 'Order (2) [Read Order]' });
    const t = await runLinkedInTick(deps());
    expect(t).toMatchObject({ posted: 2, authStopped: false, refused: null });
    expect(orgs()).toEqual([ORG, ORG_AC]);
    expect(calls.map((x) => urnOf(x).get('utm_campaign'))).toEqual([`linkedin-${PAGE}`, `linkedin-${PAGE_AC}`]);
    for (const x of calls) {
      const q = urnOf(x);
      expect(q.get('utm_source')).toBe('taxscan-linkedin');
      expect(q.get('utm_medium')).toBe('social');
      expect(q.get('utm_content')).toMatch(/^both-/);
    }
    // the same headline, hashtags (#taxscan last) and description on both pages
    expect(calls[1].commentary).toBe(calls[0].commentary);
    expect(calls[0].commentary).toBe('Order \\(2\\) \\[Read Order\\]\n\n{hashtag|\\#|SupremeCourt} {hashtag|\\#|GST} {hashtag|\\#|taxscan}');
    expect([calls[1].title, calls[1].description]).toEqual([calls[0].title, calls[0].description]);
    // ONE token serves both pages
    expect(calls.map((x) => x.accessToken)).toEqual([TOKEN, TOKEN]);
    // two independent rows
    const [tax, aca] = [await rowsOf(PAGE), await rowsOf(PAGE_AC)];
    expect([tax.length, aca.length]).toEqual([1, 1]);
    expect(tax[0]).toMatchObject({ campaignId: c.id, articleKey: articleKey(c), status: 'POSTED', attempts: 1, linkedinPostId: 'urn:li:share:T1' });
    expect(aca[0]).toMatchObject({ campaignId: c.id, articleKey: articleKey(c), status: 'POSTED', attempts: 1, linkedinPostId: 'urn:li:share:A2' });
    // the next tick has nothing to do
    await runLinkedInTick(deps());
    expect(calls).toHaveLength(2);
    // one log line per page, keyed by it
    expect(logs.filter((l) => l.startsWith('[linkedin] page=') && l.includes('outcome=posted')).map((l) => /page=(\S+)/.exec(l)![1])).toEqual([PAGE, PAGE_AC]);
  });

  it('the literal page names: academy → utm_campaign=linkedin-academy, taxscan → linkedin-taxscan; hashtags, headline and picture do not depend on the page', async () => {
    const c = { id: 'c1', title: 'Same title', url: 'https://www.taxscan.in/gst/some-ruling-12345', authority: 'Supreme Court', categories: ['GST'], body: 'b' };
    const cms = async () => ({ keywords: [], courts: [], category: null, coverImageUrl: 'https://documents.taxscan.in/cms/media/c.jpg', excerpt: 'ex' });
    const tax = (await buildPost(c, PAGE_TAXSCAN, cms))!;
    const aca = (await buildPost(c, PAGE_ACADEMY, cms))!;
    expect(new URL(tax.link).searchParams.get('utm_campaign')).toBe('linkedin-taxscan');
    expect(new URL(aca.link).searchParams.get('utm_campaign')).toBe('linkedin-academy');
    expect(new URL(withLinkedInUtm(c.url, PAGE_ACADEMY, '12345')).searchParams.get('utm_campaign')).toBe('linkedin-academy');
    expect({ ...aca, link: '' }).toEqual({ ...tax, link: '' }); // commentary, title, hashtags, description, cover: identical
    expect(aca.commentary.endsWith('{hashtag|\\#|taxscan}')).toBe(true);
  });

  it('the cover picture is uploaded SEPARATELY under each page\'s own org URN, and each post carries its own image', async () => {
    await camp('pic', at(NOW, -30));
    const uploads: { orgUrn: string; accessToken: string }[] = [];
    let n = 0;
    const fetched: string[] = [];
    const fetchImage: NonNullable<WorkerDeps['fetchImage']> = async (u): Promise<CoverImage> => {
      fetched.push(u);
      return { ok: true, bytes: new Uint8Array([0xff, 0xd8, 1]), contentType: 'image/jpeg' };
    };
    const uploadImage: NonNullable<WorkerDeps['uploadImage']> = async (r) => {
      uploads.push({ orgUrn: r.orgUrn, accessToken: r.accessToken });
      return { kind: 'ok', urn: `urn:li:image:IMG${++n}` };
    };
    await runLinkedInTick(
      deps({
        fetchCms: async () => ({ keywords: [], courts: [], category: null, coverImageUrl: 'https://documents.taxscan.in/cms/media/c.jpg', excerpt: 'An excerpt.' }),
        fetchImage,
        uploadImage,
      }),
    );
    expect(uploads.map((u) => u.orgUrn)).toEqual([ORG, ORG_AC]);
    expect(uploads.map((u) => u.accessToken)).toEqual([TOKEN, TOKEN]);
    expect(orgs()).toEqual([ORG, ORG_AC]);
    expect(calls.map((c) => c.thumbnail)).toEqual(['urn:li:image:IMG1', 'urn:li:image:IMG2']);
    expect(new Set(fetched).size).toBe(1); // the same cover picture
    expect(logs.join('\n')).toMatch(new RegExp(`page=${PAGE} campaign=\\S+ outcome=posted hashtags=fallback image=ok`));
    expect(logs.join('\n')).toMatch(new RegExp(`page=${PAGE_AC} campaign=\\S+ outcome=posted hashtags=fallback image=ok`));
  });

  it('an Academy picture problem never fails the post and never touches the Taxscan page\'s', async () => {
    await camp('pic-soft', at(NOW, -30));
    await runLinkedInTick(
      deps({
        fetchCms: async () => ({ keywords: [], courts: [], category: null, coverImageUrl: 'https://documents.taxscan.in/cms/media/c.jpg', excerpt: 'ex' }),
        fetchImage: async () => ({ ok: true, bytes: new Uint8Array([1, 2]), contentType: 'image/jpeg' }),
        uploadImage: async (r) => (r.orgUrn === ORG_AC ? { kind: 'soft', reason: 'init_http_500' } : { kind: 'ok', urn: 'urn:li:image:ONLYTAX' }),
      }),
    );
    expect(calls.map((c) => c.thumbnail)).toEqual(['urn:li:image:ONLYTAX', undefined]);
    expect((await rowsOf(PAGE_AC))[0].status).toBe('POSTED');
    expect(logs.join('\n')).toContain('image=none:init_http_500');
  });

  it('with no go-live time injected, each page uses its OWN configured one (LINKEDIN_POST_FROM for Taxscan, the shared page\'s for Academy)', async () => {
    const between = await camp('own-from', at(FROM_AC, -30)); // after FROM, before FROM_AC
    const after = await camp('own-from-2', at(FROM_AC, 30));
    await runLinkedInTick(deps({ postFrom: undefined }));
    expect((await rowsOf(PAGE)).map((r) => r.campaignId)).toEqual([between.id, after.id]);
    expect((await rowsOf(PAGE_AC)).map((r) => r.campaignId)).toEqual([after.id]);
  });
});

/* ------------------------------------------------------------------ */
/* 3. Academy's own go-live time                                        */
/* ------------------------------------------------------------------ */

describe('3. Academy has its own go-live time (LINKEDIN_ACADEMY_POST_FROM)', () => {
  it('an article pushed after the Taxscan go-live but before the Academy one posts to Taxscan ONLY, and its repeat after the Academy time adds no Academy row', async () => {
    const early = await camp('early', at(FROM_AC, -60)); // 06:00: after FROM (04:00), before FROM_AC (07:00)
    const late = await camp('late', at(FROM_AC, 30)); // 07:30: both pages
    await runLinkedInTick(deps({ now: () => at(FROM_AC, 40) }));
    expect(calls.map((c) => [c.orgUrn, c.title])).toEqual([[ORG, 'Story early'], [ORG, 'Story late'], [ORG_AC, 'Story late']]);
    // its repeat, pushed after the Academy go-live (a manual re-push; the morning-backfill clone looks the same)
    await repush(early.url, at(FROM_AC, 45));
    await runLinkedInTick(deps({ now: () => at(FROM_AC, 50) }));
    await runLinkedInTick(deps({ now: () => at(FROM_AC, 55) }));
    expect(calls).toHaveLength(3);
    expect((await rowsOf(PAGE)).map((r) => r.campaignId)).toEqual([early.id, late.id]);
    expect((await rowsOf(PAGE_AC)).map((r) => r.campaignId)).toEqual([late.id]);
  });

  it('nothing pushed before the Academy go-live is posted to Academy, at any age; one pushed exactly AT it is', async () => {
    const early = { [PAGE]: at(FROM_AC, -500 * 1440), [PAGE_AC]: FROM_AC }; // Taxscan went live long ago; Academy at FROM_AC
    for (const [i, ago] of [1, 59, 25 * 60, 3 * 1440, 20 * 1440, 400 * 1440].entries()) await camp(`before-${i}`, at(FROM_AC, -ago));
    await camp('exactly-at', FROM_AC);
    for (let i = 0; i < 6; i += 1) await runLinkedInTick(deps({ postFrom: early, now: () => at(FROM_AC, 30 + i) }));
    expect(calls.filter((c) => c.orgUrn === ORG)).toHaveLength(7); // Taxscan posts all seven
    expect(calls.filter((c) => c.orgUrn === ORG_AC).map((c) => c.title)).toEqual(['Story exactly-at']); // Academy only the one at its own go-live
    expect((await rowsOf(PAGE_AC)).length).toBe(1);
  });

  it('a repeat of an article first pushed BEFORE the Academy go-live (up to 14 days) adds no Academy row, however long after', async () => {
    const a = await camp('orig-30-min-before', at(FROM_AC, -30)); // 06:30, after the Taxscan go-live
    const b = await camp('orig-10-days-before', at(FROM_AC, -10 * 1440)); // inside the 14-day look-back before ITS go-live
    // repeats after the Academy go-live: the next day, three days on, and just before the tick five days after go-live
    await repush(a.url, ist(12, 0, 4));
    await repush(a.url, ist(9, 0, 6));
    await repush(b.url, ist(12, 0, 4));
    await repush(b.url, ist(9, 0, 7));
    const later = ist(10, 0, 8);
    await runLinkedInTick(deps({ now: () => later }));
    await runLinkedInTick(deps({ now: () => at(later, 5) }));
    expect(await rowsOf(PAGE_AC)).toHaveLength(0);
    expect(calls.filter((c) => c.orgUrn === ORG_AC)).toHaveLength(0);
    expect((await rowsOf(PAGE)).map((r) => r.campaignId)).toEqual([a.id]); // Taxscan: a once; b's repeats follow the same look-back rule there
  });
});

/* ------------------------------------------------------------------ */
/* 4. Re-pushes                                                         */
/* ------------------------------------------------------------------ */

describe('4. a re-push adds no row on either page', () => {
  it.each(['POSTED', 'SKIPPED', 'FAILED'] as const)('an article whose rows are %s on both pages, re-pushed later: no row added, no call, no insert even attempted', async (status) => {
    const first = await camp(`rp-${status}`, at(NOW, -120)); // 08:00: after both go-live times
    const data = { status, ...(status === 'POSTED' ? { linkedinPostId: 'urn:li:share:9', postedAt: at(NOW, -115) } : {}), ...(status === 'FAILED' ? { error: 'HTTP 422: invalid content' } : {}) };
    await rowFor(PAGE, first, data);
    await rowFor(PAGE_AC, first, data);
    for (const ago of [90, 60, 40]) await repush(first.url, at(NOW, -ago));
    const insert = jest.spyOn(prisma.linkedInPost, 'create');
    try {
      const t = await runLinkedInTick(deps());
      expect(t).toMatchObject({ posted: 0, retried: 0, failed: 0 });
      expect(insert).not.toHaveBeenCalled();
    } finally {
      insert.mockRestore();
    }
    expect(calls).toHaveLength(0);
    for (const page of [PAGE, PAGE_AC]) {
      const rows = await rowsOf(page);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ campaignId: first.id, status });
    }
  });

  it('a normal re-push after both pages posted: exactly 2 rows in all, 2 calls in all', async () => {
    const first = await camp('rp-live', at(NOW, -60));
    await runLinkedInTick(deps());
    expect(calls).toHaveLength(2);
    await repush(first.url, at(NOW, -30));
    await repush(first.url, at(NOW, -5));
    await runLinkedInTick(deps());
    await runLinkedInTick(deps({ now: () => at(NOW, 3) }));
    expect(calls).toHaveLength(2);
    expect([(await rowsOf(PAGE)).length, (await rowsOf(PAGE_AC)).length]).toEqual([1, 1]);
  });

  it('two overlapping ticks never post an article twice on either page (the unique (page, articleKey) row is created first)', async () => {
    await camp('race-a', at(NOW, -30));
    await camp('race-b', at(NOW, -20));
    script = async (r) => {
      await new Promise((res) => setTimeout(res, 40));
      return posted(`urn:li:share:${r.orgUrn === ORG ? 'T' : 'A'}${Math.random()}`);
    };
    await Promise.all([runLinkedInTick(deps()), runLinkedInTick(deps())]);
    script = (r) => posted(`urn:li:share:${r.orgUrn === ORG ? 'T' : 'A'}${calls.length}`);
    await runLinkedInTick(deps({ now: () => at(NOW, 1) })); // finishes whatever the budget left over
    const perOrg = (o: string) => calls.filter((c) => c.orgUrn === o).map((c) => c.title).sort();
    expect(perOrg(ORG)).toEqual(['Story race-a', 'Story race-b']);
    expect(perOrg(ORG_AC)).toEqual(['Story race-a', 'Story race-b']);
    expect([(await rowsOf(PAGE)).length, (await rowsOf(PAGE_AC)).length]).toEqual([2, 2]);
  });
});

/* ------------------------------------------------------------------ */
/* 5. Stops are per page                                                */
/* ------------------------------------------------------------------ */

describe('5. a login error stops its OWN page only', () => {
  it('a 403 on Academy alone: Taxscan posts in the same tick and in every later one; Academy stops with its own banner and its own e-mail', async () => {
    await camp('s-a1', at(NOW, -30));
    script = only(ORG_AC, auth403);
    const t1 = await runLinkedInTick(deps());
    expect(t1).toMatchObject({ posted: 1, authStopped: true }); // authStopped = "some page stopped"
    expect(orgs()).toEqual([ORG, ORG_AC]); // Taxscan went first and posted; Academy tried once and was refused
    expect(await loginProblem(PAGE)).toBeNull();
    expect(await loginProblem(PAGE_AC)).toMatchObject({ status: 403 });
    expect((await rowsOf(PAGE))[0].status).toBe('POSTED');
    expect((await rowsOf(PAGE_AC))[0]).toMatchObject({ status: 'PENDING', attempts: 0 }); // kept: it posts once posting resumes
    expect((await rowsOf(PAGE_AC))[0].nextAttemptAt).not.toBeNull();
    // ONE e-mail, about the Academy page
    expect(mails).toHaveLength(1);
    expect(mails[0].subject).toContain(`the ${PAGE_AC} page`);

    // later ticks: new articles keep reaching Taxscan; Academy makes NO call at all
    await camp('s-a2', at(NOW, -20));
    const t2 = await runLinkedInTick(deps({ now: () => at(NOW, 3) }));
    await camp('s-a3', at(NOW, 4));
    const t3 = await runLinkedInTick(deps({ now: () => at(NOW, 6) }));
    expect([t2.posted, t3.posted]).toEqual([1, 1]);
    expect(t2.authStopped && t3.authStopped).toBe(true);
    expect(orgs()).toEqual([ORG, ORG_AC, ORG, ORG]);
    expect((await rowsOf(PAGE)).map((r) => r.status)).toEqual(['POSTED', 'POSTED', 'POSTED']);
    expect(mails).toHaveLength(1);

    // a restart the same IST day: Academy tries once, fails again, and does NOT e-mail again; Taxscan is unaffected
    resetLinkedInStops();
    await runLinkedInTick(deps({ now: () => at(NOW, 9) }));
    expect(orgs()).toEqual([ORG, ORG_AC, ORG, ORG, ORG_AC]);
    expect(mails).toHaveLength(1);
    // a restart the next IST day: one more e-mail, for Academy again; none for Taxscan
    resetLinkedInStops();
    await runLinkedInTick(deps({ now: () => ist(10, 0, 4) }));
    expect(mails).toHaveLength(2);
    expect(mails.every((m) => m.subject.includes(`the ${PAGE_AC} page`))).toBe(true);
    expect(await loginProblem(PAGE)).toBeNull();
  });

  it('the alert for a page that SHARES the token names the OWNER\'s variable, says there is no token of its own, and explains a 403 as a missing page role', async () => {
    await camp('mail-403', at(NOW, -30));
    script = only(ORG_AC, auth403);
    await runLinkedInTick(deps());
    const text = mails[0].text;
    expect(text).toContain(`Taxscan Push could not post to the ${PAGE_AC} LinkedIn page: LinkedIn answered 403`);
    expect(text).toContain(`The ${PAGE_AC} page posts with the same LinkedIn token as the ${PAGE} page`);
    expect(text).toContain(`LINKEDIN_${PAGE.toUpperCase()}_ACCESS_TOKEN`);
    expect(text).not.toContain(`LINKEDIN_${PAGE_AC.toUpperCase()}_ACCESS_TOKEN`);
    expect(text).toMatch(/no admin role on the liacad-ac page/);
    expect(text).toContain('Articles pushed meanwhile are kept: they post once posting resumes.');
    expect(text).not.toMatch(/24 ?h/i);
    // a 401 is a token problem: no "role" talk
    mails = [];
    resetLinkedInStops();
    await prisma.digestSetting.deleteMany({ where: { key: authKey(PAGE_AC) } });
    script = only(ORG_AC, auth401);
    await runLinkedInTick(deps({ now: () => at(NOW, 2) }));
    expect(mails).toHaveLength(1);
    expect(mails[0].text).toContain(`LINKEDIN_${PAGE.toUpperCase()}_ACCESS_TOKEN`);
    expect(mails[0].text).not.toMatch(/admin role/);
  });

  it('the Taxscan page\'s own alert is unchanged (its own variable, no talk of sharing)', async () => {
    await camp('mail-tax', at(NOW, -30));
    script = only(ORG, auth401);
    await runLinkedInTick(deps());
    const m = mails.find((x) => x.subject.includes(`the ${PAGE} page`))!;
    expect(m.text).toBe(
      `Taxscan Push could not post to the ${PAGE} LinkedIn page: LinkedIn answered 401 (the access token expired, was revoked or lacks permission).\n\n` +
        `No further posts are attempted for this page until a new token is set in Railway (LINKEDIN_${PAGE.toUpperCase()}_ACCESS_TOKEN) or the app restarts. Articles pushed meanwhile are kept: they post once posting resumes.\n\n` +
        `The LinkedIn screen in the admin shows this notice too. (${NOW.toISOString()})`,
    );
  });

  it('a 401 on Taxscan does NOT prevent Academy\'s attempt in that tick: it fails 401 too, stops itself, and alerts on its own; one alert per page per IST day', async () => {
    await camp('s-401', at(NOW, -30));
    script = () => auth401;
    const t1 = await runLinkedInTick(deps());
    expect(t1.authStopped).toBe(true);
    expect(orgs()).toEqual([ORG, ORG_AC]); // both pages were attempted
    expect(await loginProblem(PAGE)).toMatchObject({ status: 401 });
    expect(await loginProblem(PAGE_AC)).toMatchObject({ status: 401 });
    expect(mails.map((m) => m.subject)).toEqual([expect.stringContaining(`the ${PAGE} page`), expect.stringContaining(`the ${PAGE_AC} page`)]);
    // stopped: no calls at all, no more e-mails
    await runLinkedInTick(deps({ now: () => at(NOW, 3) }));
    await runLinkedInTick(deps({ now: () => at(NOW, 6) }));
    expect(calls).toHaveLength(2);
    expect(mails).toHaveLength(2);
    // a restart the same day: each page tries once more, neither e-mails again
    resetLinkedInStops();
    await runLinkedInTick(deps({ now: () => at(NOW, 9) }));
    expect(calls).toHaveLength(4);
    expect(mails).toHaveLength(2);
    // the next IST day: one more e-mail PER PAGE
    resetLinkedInStops();
    await runLinkedInTick(deps({ now: () => ist(10, 0, 4) }));
    expect(mails).toHaveLength(4);
    expect(mails.slice(2).map((m) => m.subject)).toEqual([expect.stringContaining(`the ${PAGE} page`), expect.stringContaining(`the ${PAGE_AC} page`)]);
  });

  it('a new token resumes BOTH pages on the next tick (the stop keys on the token in use, which both pages share), and both banners clear', async () => {
    await camp('s-resume', at(NOW, -30));
    script = () => auth401;
    await runLinkedInTick(deps());
    expect(calls).toHaveLength(2);
    script = (r) => posted(`urn:li:share:${r.orgUrn === ORG ? 'T' : 'A'}${calls.length}`);
    await runLinkedInTick(deps({ now: () => at(NOW, 2) }));
    expect(calls).toHaveLength(2); // still stopped
    env.linkedin.pages[PAGE] = { orgUrn: ORG, accessToken: NEW_TOKEN };
    await runLinkedInTick(deps({ now: () => at(NOW, 3) }));
    expect(calls.slice(2).map((c) => [c.orgUrn, c.accessToken])).toEqual([[ORG, NEW_TOKEN], [ORG_AC, NEW_TOKEN]]);
    expect((await rowsOf(PAGE))[0].status).toBe('POSTED');
    expect((await rowsOf(PAGE_AC))[0].status).toBe('POSTED');
    expect(await loginProblem(PAGE)).toBeNull();
    expect(await loginProblem(PAGE_AC)).toBeNull();
  });

  it('a stopped Taxscan page never holds back a later page: in the SAME tick and in later ones Academy keeps posting', async () => {
    await camp('s-held-1', at(NOW, -30));
    script = only(ORG, auth401); // only the first page is refused
    const t1 = await runLinkedInTick(deps());
    expect(t1).toMatchObject({ posted: 1, authStopped: true });
    expect(orgs()).toEqual([ORG, ORG_AC]);
    expect((await rowsOf(PAGE_AC))[0].status).toBe('POSTED');
    await camp('s-held-2', at(NOW, -10));
    const t2 = await runLinkedInTick(deps({ now: () => at(NOW, 3) }));
    expect(t2).toMatchObject({ posted: 1, authStopped: true });
    expect(orgs()).toEqual([ORG, ORG_AC, ORG_AC]); // Taxscan is skipped (stopped); Academy posts the new article
    expect(await loginProblem(PAGE_AC)).toBeNull();
    expect(await loginProblem(PAGE)).toMatchObject({ status: 401 });
  });

  it('a login error while retrying a DUE row of one page also leaves the other page\'s turn alone', async () => {
    await camp('s-retry', at(NOW, -30));
    script = (r) => (r.orgUrn === ORG ? { kind: 'retry', status: 503, error: 'HTTP 503' } : posted('urn:li:share:A1'));
    await runLinkedInTick(deps()); // Taxscan: retry in a minute; Academy: posted
    expect((await rowsOf(PAGE))[0]).toMatchObject({ status: 'PENDING', attempts: 1 });
    await camp('s-retry-2', at(NOW, -5));
    script = only(ORG, auth403); // the retry of Taxscan's row is now refused
    const t = await runLinkedInTick(deps({ now: () => at(NOW, 1) }));
    expect(t.authStopped).toBe(true);
    // Taxscan's due retry was the stop; Academy still posted the new article in the same tick
    expect(calls.slice(2).map((c) => [c.orgUrn, c.title])).toEqual([[ORG, 'Story s-retry'], [ORG_AC, 'Story s-retry-2']]);
  });
});

/* ------------------------------------------------------------------ */
/* 6. Independent rows                                                  */
/* ------------------------------------------------------------------ */

describe('6. a rejected post, Skip or Retry on one page leaves the other page\'s row untouched', () => {
  const appWith = () => createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 }, linkedin: { enabled: () => true, clock: () => NOW, portals: () => ({ [PORTAL]: [PAGE, PAGE_AC] }), postFrom: () => ({ [PAGE]: FROM, [PAGE_AC]: FROM_AC }), worker: deps() } });
  const snap = async (page: string) => {
    const r = (await rowsOf(page))[0];
    return { id: r.id, status: r.status, attempts: r.attempts, error: r.error, linkedinPostId: r.linkedinPostId, nextAttemptAt: r.nextAttemptAt, updatedAt: r.updatedAt.getTime() };
  };

  it('Academy\'s post is rejected (422): its row is FAILED, Taxscan\'s stays POSTED and is never written again, however many ticks follow', async () => {
    await camp('rej', at(NOW, -30));
    script = only(ORG_AC, failed422);
    const t = await runLinkedInTick(deps());
    expect(t).toMatchObject({ posted: 1, failed: 1, authStopped: false });
    const tax = await snap(PAGE);
    expect(tax).toMatchObject({ status: 'POSTED', linkedinPostId: 'urn:li:share:T1', error: null });
    expect(await snap(PAGE_AC)).toMatchObject({ status: 'FAILED', error: 'HTTP 422: invalid content', linkedinPostId: null });
    await runLinkedInTick(deps({ now: () => at(NOW, 5) }));
    await runLinkedInTick(deps({ now: () => at(NOW, 30) }));
    expect(calls).toHaveLength(2); // FAILED is final: nothing retried automatically
    expect(await snap(PAGE)).toEqual(tax);
    // and the other way round: Taxscan rejected, Academy posted
    await wipe();
    calls = [];
    await camp('rej-2', at(NOW, -30));
    script = only(ORG, failed422);
    await runLinkedInTick(deps());
    expect([(await snap(PAGE)).status, (await snap(PAGE_AC)).status]).toEqual(['FAILED', 'POSTED']);
  });

  it('Skip on one page\'s row leaves the other page\'s row (same article) untouched; Retry too', async () => {
    const c = await camp('skip', at(NOW, -30));
    await rowFor(PAGE, c, { status: 'FAILED', attempts: 4, error: 'HTTP 500' });
    await rowFor(PAGE_AC, c, { status: 'FAILED', attempts: 4, error: 'HTTP 500' });
    const [tax0, aca0] = [await snap(PAGE), await snap(PAGE_AC)];
    const app = appWith();
    // Skip Academy's
    const skip = await request(app).post(`/api/linkedin/posts/${aca0.id}/skip`).set(BEARER);
    expect(skip.body).toEqual({ ok: true, status: 'SKIPPED' });
    expect(await snap(PAGE)).toEqual(tax0);
    expect((await snap(PAGE_AC)).status).toBe('SKIPPED');
    expect(calls).toHaveLength(0);
    // Retry Taxscan's: ONE call, for the Taxscan org; Academy's SKIPPED row is not touched
    const aca1 = await snap(PAGE_AC);
    const retry = await request(app).post(`/api/linkedin/posts/${tax0.id}/retry`).set(BEARER);
    expect(retry.body).toEqual({ ok: true, status: 'POSTED' });
    expect(orgs()).toEqual([ORG]);
    expect(await snap(PAGE_AC)).toEqual(aca1);
    expect((await snap(PAGE)).status).toBe('POSTED');
  });

  it('Retry on Academy\'s FAILED row makes exactly one call, under the Academy org URN with the shared token; Taxscan\'s row is not written', async () => {
    const c = await camp('retry-ac', at(NOW, -30));
    await rowFor(PAGE, c, { status: 'FAILED', attempts: 4, error: 'HTTP 500' });
    await rowFor(PAGE_AC, c, { status: 'FAILED', attempts: 4, error: 'HTTP 500' });
    const tax0 = await snap(PAGE);
    const r = await retryNow((await rowsOf(PAGE_AC))[0].id, deps());
    expect(r).toEqual({ ok: true, status: 'POSTED' });
    expect(calls.map((x) => [x.orgUrn, x.accessToken])).toEqual([[ORG_AC, TOKEN]]);
    expect(new URL(calls[0].link).searchParams.get('utm_campaign')).toBe(`linkedin-${PAGE_AC}`);
    expect(await snap(PAGE)).toEqual(tax0);
    // a Retry of a row whose page is no longer active is refused, not failed
    env.linkedin.sharedPages = {};
    await prisma.linkedInPost.updateMany({ where: { page: PAGE_AC }, data: { status: 'FAILED' } });
    expect(await retryNow((await rowsOf(PAGE_AC))[0].id, deps())).toEqual({ ok: false, reason: 'not_configured' });
    expect((await rowsOf(PAGE_AC))[0].status).toBe('FAILED');
  });

  it('Academy switched off later: its rows are kept as they were, no FAILED row appears, and a tick posts to Taxscan as before', async () => {
    const c = await camp('off-later', at(NOW, -30));
    await rowFor(PAGE_AC, c, { status: 'PENDING', attempts: 1, nextAttemptAt: at(NOW, -1), error: 'HTTP 503' });
    env.linkedin.sharedPages = {};
    const before = await snap(PAGE_AC);
    const t = await runLinkedInTick(deps({ portals: { [PORTAL]: [PAGE] } })); // what the default map is when Academy is off
    expect(t).toMatchObject({ posted: 1, failed: 0 });
    expect(orgs()).toEqual([ORG]);
    expect(await snap(PAGE_AC)).toEqual(before);
  });
});

/* ------------------------------------------------------------------ */
/* 7. One budget for both pages                                         */
/* ------------------------------------------------------------------ */

describe('7. MAX_PER_TICK is shared by both pages; Taxscan goes first', () => {
  it('three waiting articles: the first tick spends all three posts on Taxscan, a later tick posts Academy\'s', async () => {
    for (const [i, ago] of [30, 20, 10].entries()) await camp(`b${i}`, at(NOW, -ago));
    const t1 = await runLinkedInTick(deps());
    expect(t1.posted).toBe(MAX_PER_TICK);
    expect(orgs()).toEqual([ORG, ORG, ORG]);
    expect(await rowsOf(PAGE_AC)).toHaveLength(0); // not even a row yet: a busy Taxscan page only DELAYS Academy
    const t2 = await runLinkedInTick(deps({ now: () => at(NOW, 1) }));
    expect(t2.posted).toBe(MAX_PER_TICK);
    expect(orgs().slice(3)).toEqual([ORG_AC, ORG_AC, ORG_AC]);
    expect(calls.slice(3).map((c) => c.title)).toEqual(['Story b0', 'Story b1', 'Story b2']); // oldest push first
    expect((await runLinkedInTick(deps({ now: () => at(NOW, 2) }))).posted).toBe(0);
    expect(calls).toHaveLength(6);
  });

  it('never more than MAX_PER_TICK posts in one tick, across both pages, over a longer backlog; every article ends up on both pages exactly once', async () => {
    for (let i = 0; i < 5; i += 1) await camp(`long-${i}`, at(NOW, -50 + i));
    let seen = 0;
    const perTick: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      await runLinkedInTick(deps({ now: () => at(NOW, i) }));
      perTick.push(calls.length - seen);
      seen = calls.length;
    }
    expect(perTick.every((n) => n <= MAX_PER_TICK)).toBe(true);
    expect(perTick).toEqual([3, 3, 3, 1, 0, 0]);
    for (const o of [ORG, ORG_AC]) expect(calls.filter((c) => c.orgUrn === o).map((c) => c.title)).toEqual(['Story long-0', 'Story long-1', 'Story long-2', 'Story long-3', 'Story long-4']);
  });

  it('a mixed tick: one article → Taxscan then Academy in the SAME tick; with two, Taxscan\'s two and Academy\'s first (3 in all), Academy\'s second next tick', async () => {
    await camp('mix-1', at(NOW, -30));
    await camp('mix-2', at(NOW, -20));
    const t1 = await runLinkedInTick(deps());
    expect(t1.posted).toBe(3);
    expect(calls.map((c) => [c.orgUrn, c.title])).toEqual([[ORG, 'Story mix-1'], [ORG, 'Story mix-2'], [ORG_AC, 'Story mix-1']]);
    await runLinkedInTick(deps({ now: () => at(NOW, 1) }));
    expect(calls.slice(3).map((c) => [c.orgUrn, c.title])).toEqual([[ORG_AC, 'Story mix-2']]);
  });

  it('due retries spend the same budget: a retry on Taxscan\'s row counts against the tick before Academy gets its turn', async () => {
    const c1 = await camp('due-1', at(NOW, -40));
    await rowFor(PAGE, c1, { status: 'PENDING', attempts: 1, nextAttemptAt: at(NOW, -1), error: 'HTTP 503' });
    for (const [i, ago] of [30, 20].entries()) await camp(`due-new-${i}`, at(NOW, -ago));
    const t = await runLinkedInTick(deps());
    expect(t.posted).toBe(3);
    // Taxscan: the due retry, then its new articles until the budget is gone; Academy is last in line
    expect(orgs()).toEqual([ORG, ORG, ORG]);
  });
});

/* ------------------------------------------------------------------ */
/* 8. One token, one row, one renewal                                   */
/* ------------------------------------------------------------------ */

describe('8. renewal runs ONCE, for the page that owns the token, and both pages then post with the new token', () => {
  const KEY = randomBytes(32).toString('base64');
  let fetches: { url: string; body: URLSearchParams }[] = [];
  let introDays = 12;
  const response = (status: number, json: unknown) => ({ status, json: async () => json }) as unknown as Response;
  const fetchMock = (async (url: string, init: RequestInit) => {
    fetches.push({ url, body: new URLSearchParams(String(init.body)) });
    if (url === INTROSPECT_URL) return response(200, { active: true, status: 'active', expires_at: Math.floor((NOW.getTime() + introDays * DAY) / 1000) });
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
    introDays = 12;
    Object.assign(env.linkedin.tokenRefresh, { enabled: true, clientId: 'client-id-1', clientSecret: `CLIENT-SECRET-${RUN}`, key: KEY });
    env.linkedin.pages[PAGE] = { orgUrn: ORG, accessToken: TOKEN, refreshToken: `REFRESH-${RUN}`, refreshExpiresAt: null };
  });

  it('one check, one introspection, ONE renewal call and ONE LinkedInToken row, with Academy active; none for the shared page', async () => {
    const r = await runTokenCheck(tokenDeps());
    expect(r.refused).toBeNull();
    expect(r.pages.map((p) => [p.page, p.action])).toEqual([[PAGE, 'renewed']]);
    expect(fetches.filter((f) => f.url === ACCESS_TOKEN_URL)).toHaveLength(1);
    expect(fetches.filter((f) => f.url === INTROSPECT_URL)).toHaveLength(1);
    const rows = await prisma.linkedInToken.findMany({ where: { page: { in: [PAGE, PAGE_AC] } } });
    expect(rows.map((x) => x.page)).toEqual([PAGE]);
    expect(decryptSecret(rows[0].accessTokenEnc, keyBytes(KEY)!)).toBe(NEW_TOKEN);
    // asking for the shared page explicitly cannot make a second row or a second renewal either
    await runTokenCheck({ ...tokenDeps(), pages: [PAGE_AC] });
    expect(await prisma.linkedInToken.count({ where: { page: PAGE_AC } })).toBe(0);
    expect(fetches.filter((f) => f.url === ACCESS_TOKEN_URL)).toHaveLength(1);
    // the daily log line is per owning page only
    expect(logs.filter((l) => l.startsWith('[linkedin-token] page=') && l.includes('action='))).toHaveLength(1);
  });

  it('the screen status of the shared page is its owner\'s: the one token', async () => {
    await runTokenCheck(tokenDeps());
    const own = await tokenStatus(PAGE, NOW);
    expect(own).not.toBeNull();
    expect(await tokenStatus(PAGE_AC, NOW)).toEqual(own);
    env.linkedin.tokenRefresh.enabled = false;
    expect(await tokenStatus(PAGE_AC, NOW)).toBeNull(); // renewal off → nothing on either page
  });

  it('before the renewal both pages post with the env token; after it, the NEXT tick posts on both with the new one', async () => {
    await camp('rn-1', at(NOW, -30));
    await runLinkedInTick(deps());
    expect(calls.map((c) => c.accessToken)).toEqual([TOKEN, TOKEN]);
    await runTokenCheck(tokenDeps()); // renews
    expect(cachedAccessToken(PAGE)).toBe(NEW_TOKEN);
    expect(cachedAccessToken(PAGE_AC)).toBe(NEW_TOKEN); // the cache resolves the shared page through its owner
    expect(pageConfig(PAGE_AC)).toEqual({ orgUrn: ORG_AC, accessToken: NEW_TOKEN });
    await camp('rn-2', at(NOW, -5));
    await runLinkedInTick(deps({ now: () => at(NOW, 1) }));
    expect(calls.slice(2).map((c) => [c.orgUrn, c.accessToken])).toEqual([[ORG, NEW_TOKEN], [ORG_AC, NEW_TOKEN]]);
    // and a Retry of a row on either page uses it as well
    const only2 = await rowsOf(PAGE_AC);
    await prisma.linkedInPost.update({ where: { id: only2[1].id }, data: { status: 'FAILED' } });
    await retryNow(only2[1].id, deps());
    expect(calls[calls.length - 1]).toMatchObject({ orgUrn: ORG_AC, accessToken: NEW_TOKEN });
  });

  it('both pages stopped on the old token: the renewal ends BOTH stops and BOTH banners at once, and the next tick resumes both', async () => {
    await camp('rn-stop', at(NOW, -30));
    script = () => auth401;
    await runLinkedInTick(deps());
    expect(orgs()).toEqual([ORG, ORG_AC]);
    expect(await loginProblem(PAGE)).not.toBeNull();
    expect(await loginProblem(PAGE_AC)).not.toBeNull();
    await runLinkedInTick(deps({ now: () => at(NOW, 1) }));
    expect(calls).toHaveLength(2); // stopped
    script = (r) => posted(`urn:li:share:${r.orgUrn === ORG ? 'T' : 'A'}${calls.length}`);
    await runTokenCheck(tokenDeps()); // a successful renewal
    expect(await loginProblem(PAGE)).toBeNull();
    expect(await loginProblem(PAGE_AC)).toBeNull(); // the shared page's banner is cleared by the same renewal
    await runLinkedInTick(deps({ now: () => at(NOW, 2) }));
    expect(calls.slice(2).map((c) => [c.orgUrn, c.accessToken])).toEqual([[ORG, NEW_TOKEN], [ORG_AC, NEW_TOKEN]]);
    expect((await rowsOf(PAGE)).map((r) => r.status)).toEqual(['POSTED']);
    expect((await rowsOf(PAGE_AC)).map((r) => r.status)).toEqual(['POSTED']);
  });

  it('no secret reaches a log line, a row, an e-mail or the screen answer on either page', async () => {
    await camp('leak-1', at(NOW, -30));
    script = only(ORG_AC, auth403);
    await runLinkedInTick(deps());
    await runTokenCheck(tokenDeps());
    await camp('leak-2', at(NOW, -5));
    await runLinkedInTick(deps({ now: () => at(NOW, 1) }));
    const app = createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 }, linkedin: { enabled: () => true, clock: () => NOW, portals: () => ({ [PORTAL]: [PAGE, PAGE_AC] }), postFrom: () => ({ [PAGE]: FROM, [PAGE_AC]: FROM_AC }), worker: deps() } });
    const answers = [await request(app).get('/api/linkedin/posts?date=2026-11-03').set(BEARER), await request(app).get(`/api/linkedin/posts?date=2026-11-03&page=${PAGE_AC}`).set(BEARER)];
    const everything = JSON.stringify({
      logs,
      mails,
      rows: [...(await rowsOf(PAGE)), ...(await rowsOf(PAGE_AC))],
      state: await prisma.digestSetting.findMany({ where: { key: { startsWith: 'linkedin:' }, AND: { key: { contains: PAGE } } } }),
      api: answers.map((a) => a.body),
    });
    for (const secret of [TOKEN, NEW_TOKEN, KEY, `CLIENT-SECRET-${RUN}`, `REFRESH-${RUN}`]) expect(everything).not.toContain(secret);
  });
});

/* ------------------------------------------------------------------ */
/* 9. The screen's API                                                  */
/* ------------------------------------------------------------------ */

describe('9. GET /api/linkedin/posts?page=', () => {
  const opts = (over: LinkedInRouterOptions = {}): LinkedInRouterOptions => ({ enabled: () => true, clock: () => NOW, portals: () => ({ [PORTAL]: [PAGE, PAGE_AC] }), postFrom: () => ({ [PAGE]: FROM, [PAGE_AC]: FROM_AC }), worker: deps(), ...over });
  const appWith = (over: LinkedInRouterOptions = {}) => createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 }, linkedin: opts(over) });
  const get = (app: ReturnType<typeof createApp>, q = '') => request(app).get(`/api/linkedin/posts?date=2026-11-03${q}`).set(BEARER);

  it('default is the first (Taxscan) page; ?page=<academy> returns ITS rows, counts and banner; `pages` lists the active pages, Taxscan first', async () => {
    const both = await camp('api-both', at(NOW, -30));
    const early = await camp('api-early', at(FROM_AC, -60)); // Taxscan-only
    await rowFor(PAGE, both, { status: 'POSTED', linkedinPostId: 'urn:li:share:77', postedAt: at(NOW, -29) });
    await rowFor(PAGE_AC, both, { status: 'FAILED', error: 'HTTP 422: invalid content' });
    await rowFor(PAGE, early, { status: 'POSTED', linkedinPostId: 'urn:li:share:78', postedAt: at(FROM_AC, -59) });
    await prisma.digestSetting.create({ data: { key: authKey(PAGE_AC), value: JSON.stringify({ stoppedAt: NOW.toISOString(), alertedDay: '2026-11-03', status: 403 }) } });
    const app = appWith();

    const def = await get(app);
    expect(def.status).toBe(200);
    expect(def.body).toMatchObject({ date: '2026-11-03', page: PAGE, pages: [PAGE, PAGE_AC], login: null });
    expect(def.body.rows.map((r: { headline: string; status: string }) => [r.headline, r.status])).toEqual([['Story api-early', 'POSTED'], ['Story api-both', 'POSTED']]);
    expect(def.body.counts).toMatchObject({ posted: 2, failed: 0, all: 2 });
    expect(def.body.rows[1].postUrl).toBe('https://www.linkedin.com/feed/update/urn%3Ali%3Ashare%3A77/');
    expect((await get(app, `&page=${PAGE}`)).body).toEqual(def.body); // explicit Taxscan = the default

    const ac = await get(app, `&page=${PAGE_AC}`);
    expect(ac.status).toBe(200);
    expect(ac.body).toMatchObject({ page: PAGE_AC, pages: [PAGE, PAGE_AC], login: { status: 403 } });
    // Academy: the early article was pushed before ITS go-live → NOT_POSTED; the other has Academy's own FAILED row
    expect(ac.body.rows.map((r: { headline: string; status: string; error: string | null }) => [r.headline, r.status, r.error])).toEqual([['Story api-early', 'NOT_POSTED', null], ['Story api-both', 'FAILED', 'HTTP 422: invalid content']]);
    expect(ac.body.counts).toMatchObject({ failed: 1, notPosted: 1, posted: 0, all: 2 });
    expect(ac.body.rows[1].id).not.toBe(def.body.rows[1].id); // its own row
    expect(ac.body.rows[1].postUrl).toBeNull();
  });

  it('WAITING / NOT_POSTED follow THAT page\'s go-live time, with no age limit', async () => {
    await camp('wait-early', at(FROM_AC, -60)); // Taxscan: WAITING; Academy: NOT_POSTED
    await camp('wait-late', at(FROM_AC, 60)); // both WAITING
    const later = ist(10, 0, 6); // three days later: still no age limit
    const app = appWith({ clock: () => later });
    const q = (page: string) => request(app).get(`/api/linkedin/posts?date=2026-11-03&page=${page}`).set(BEARER);
    expect((await q(PAGE)).body.rows.map((r: { status: string }) => r.status)).toEqual(['WAITING', 'WAITING']);
    expect((await q(PAGE_AC)).body.rows.map((r: { status: string }) => r.status)).toEqual(['NOT_POSTED', 'WAITING']);
  });

  it('an unknown page, or `academy` while it is not active, is 400 invalid_page and reads nothing', async () => {
    const reads = jest.spyOn(prisma.campaign, 'findMany');
    try {
      const app = appWith();
      for (const q of ['&page=bogus', '&page=academy', '&page=Taxscan', `&page=${PAGE}&page=${PAGE_AC}`, '&page[]=x']) {
        const r = await get(app, q);
        expect([q, r.status, r.body]).toEqual([q, 400, { error: 'invalid_page' }]);
      }
      // a single-page world (Academy off): the Academy page is refused, the Taxscan page still answers
      const solo = appWith({ portals: () => ({ [PORTAL]: PAGE }), postFrom: () => FROM });
      expect(await get(solo, `&page=${PAGE_AC}`).then((r) => [r.status, r.body])).toEqual([400, { error: 'invalid_page' }]);
      expect(await get(solo, '&page=academy').then((r) => [r.status, r.body])).toEqual([400, { error: 'invalid_page' }]);
      expect(reads).not.toHaveBeenCalled();
      expect((await get(solo, `&page=${PAGE}`)).status).toBe(200);
    } finally {
      reads.mockRestore();
    }
    // an empty value is "not given"
    expect((await get(appWith(), '&page=')).body.page).toBe(PAGE);
    // a bad date is still the old 400
    expect((await request(appWith()).get('/api/linkedin/posts?date=2026-11-04').set(BEARER)).body.error).toBe('invalid_date');
  });

  it('with Academy OFF the answer is the old one plus `pages` only: no tokenShared, nothing about a second page', async () => {
    await camp('solo', at(NOW, -30));
    const solo = appWith({ portals: () => ({ [PORTAL]: PAGE }), postFrom: () => FROM });
    const r = await get(solo);
    expect(Object.keys(r.body).sort()).toEqual(['counts', 'date', 'login', 'page', 'pages', 'rows']);
    expect(r.body).toMatchObject({ page: PAGE, pages: [PAGE], login: null });
    expect(r.body.rows[0].status).toBe('WAITING');
  });

  it('the token status is on BOTH pages and says it is the one shared token (tokenShared), without ever containing a token', async () => {
    Object.assign(env.linkedin.tokenRefresh, { enabled: true, clientId: 'c', clientSecret: 's-secret-1', key: randomBytes(32).toString('base64') });
    env.linkedin.pages[PAGE] = { orgUrn: ORG, accessToken: TOKEN, refreshToken: 'r-1', refreshExpiresAt: null };
    await prisma.linkedInToken.create({ data: { page: PAGE, accessTokenEnc: 'v1:x:y:z', envFingerprint: 'f', accessExpiresAt: at(NOW, 40 * 24 * 60), accessExpiresSource: 'linkedin', refreshExpiresAt: at(NOW, 300 * 24 * 60) } });
    const app = appWith();
    const [tax, aca] = [await get(app), await get(app, `&page=${PAGE_AC}`)];
    expect(tax.body.tokenShared).toBe(true);
    expect(aca.body.tokenShared).toBe(true);
    expect(aca.body.token).toEqual(tax.body.token);
    expect(aca.body.token).toMatchObject({ validUntilSource: 'linkedin', status: 'ok' });
    expect(Object.keys(aca.body.token).sort()).toEqual(['autoRenew', 'refreshUntil', 'renewalFailed', 'renewedAt', 'status', 'validUntil', 'validUntilSource']);
    expect(JSON.stringify([tax.body, aca.body])).not.toContain(TOKEN);
    // renewal off: no token block on either page, but the pages still say they share one
    env.linkedin.tokenRefresh.enabled = false;
    const off = await get(app, `&page=${PAGE_AC}`);
    expect(off.body.token).toBeUndefined();
    expect(off.body.tokenShared).toBe(true);
  });

  it('two pages with SEPARATE tokens are not "shared"', async () => {
    delete env.linkedin.sharedPages[PAGE_AC];
    env.linkedin.pages[PAGE_AC] = { orgUrn: ORG_AC, accessToken: 'its-own-token' };
    try {
      const r = await get(appWith());
      expect(r.body.pages).toEqual([PAGE, PAGE_AC]);
      expect(r.body.tokenShared).toBeUndefined();
    } finally {
      delete env.linkedin.pages[PAGE_AC];
    }
  });

  it('the DEFAULT wiring (no injected portals): ?page=academy answers 200 only while Academy is active, and every read names the academy page and portal taxscan (database mocked: nothing real is read)', async () => {
    const campaigns = jest.spyOn(prisma.campaign, 'findMany').mockResolvedValue([
      { id: 'c-1', title: 'Default wired', url: 'https://www.taxscan.in/gst/default-wired-90001', target: {}, lastSentAt: at(NOW, -20) },
    ] as never);
    const rows = jest.spyOn(prisma.linkedInPost, 'findMany').mockResolvedValue([]);
    const setting = jest.spyOn(prisma.digestSetting, 'findUnique').mockResolvedValue(null);
    try {
      const app = createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 }, linkedin: { enabled: () => true, clock: () => NOW } });
      // Academy ACTIVE (in memory)
      env.linkedin.sharedPages = { academy: { orgUrn: ORG_AC, postFrom: FROM_AC, tokenFrom: 'taxscan' } };
      const ac = await get(app, '&page=academy');
      expect(ac.status).toBe(200);
      expect(ac.body).toMatchObject({ page: 'academy', pages: ['taxscan', 'academy'] });
      expect(ac.body.rows.map((r: { status: string }) => r.status)).toEqual(['WAITING']); // pushed after the (mocked) Academy go-live
      expect((campaigns.mock.calls[0][0] as { where: { portal: { in: string[] } } }).where.portal.in).toEqual(['taxscan']);
      expect((rows.mock.calls[0][0] as { where: { page: string } }).where.page).toBe('academy');
      expect((setting.mock.calls[0][0] as { where: { key: string } }).where.key).toBe('linkedin:auth:academy');
      const def = await get(app);
      expect(def.body).toMatchObject({ page: 'taxscan', pages: ['taxscan', 'academy'] });
      expect((rows.mock.calls[1][0] as { where: { page: string } }).where.page).toBe('taxscan');
      // Academy INACTIVE: the same request is refused before any read
      env.linkedin.sharedPages = {};
      campaigns.mockClear();
      const off = await get(app, '&page=academy');
      expect([off.status, off.body]).toEqual([400, { error: 'invalid_page' }]);
      expect(campaigns).not.toHaveBeenCalled();
      expect((await get(app)).body).toMatchObject({ page: 'taxscan', pages: ['taxscan'] });
    } finally {
      campaigns.mockRestore();
      rows.mockRestore();
      setting.mockRestore();
    }
  });

  it('roles are unchanged: no session is 401; the flag off is 404 on every page', async () => {
    expect((await request(appWith()).get('/api/linkedin/posts?page=academy')).status).toBe(401);
    expect((await request(appWith({ enabled: () => false })).get(`/api/linkedin/posts?page=${PAGE_AC}`).set(BEARER)).status).toBe(404);
  });
});

/* ------------------------------------------------------------------ */
/* 11. The Campaigns Channels mark is the Taxscan page's, Academy on or off */
/* ------------------------------------------------------------------ */

describe('11. Campaigns Channels keeps meaning the TAXSCAN page, with Academy on or off', () => {
  const CH_RUN = `${RUN}-ch`;
  const keys: string[] = [];
  const ids: Record<string, string> = {};
  const chPortal = env.rss.portal;
  const academyOn = (): void => {
    env.linkedin.sharedPages = { academy: { orgUrn: ORG_AC, postFrom: FROM_AC, tokenFrom: 'taxscan' } };
  };
  async function seed(key: string, at_: Date) {
    const url = `https://www.taxscan.in/gst/chan-${key}-${CH_RUN}`;
    const c = await prisma.campaign.create({ data: { portal: chPortal, title: `Chan ${key}`, body: 'b', url, target: { type: 'all' } as Prisma.InputJsonValue, status: 'SENT', lastSentAt: at_ } });
    ids[key] = c.id;
    keys.push(articleKey({ id: c.id, url }));
    return c;
  }
  const mark = (page: string, c: { id: string; url: string }, status: 'POSTED' | 'FAILED' | 'SKIPPED', extra: object = {}) =>
    prisma.linkedInPost.create({ data: { page, articleKey: articleKey(c), campaignId: c.id, status, attempts: 1, ...extra } });
  const byId = async () => new Map((await listCampaigns(600)).map((r) => [r.id, r]));

  beforeEach(() => {
    env.linkedin.enabled = true;
    env.linkedin.postFrom = new Date(Date.now() - 6 * 3600_000);
  });
  afterEach(async () => {
    await prisma.linkedInPost.deleteMany({ where: { articleKey: { in: keys } } });
    await prisma.campaign.deleteMany({ where: { url: { contains: CH_RUN } } });
    keys.length = 0;
  });

  it('the mark and its details are byte-identical with Academy off and on, whatever Academy\'s rows say', async () => {
    const recent = new Date(Date.now() - 60_000);
    const posted = await seed('posted', recent);
    const failed = await seed('failed', recent);
    const pending = await seed('pending', recent);
    const academyOnly = await seed('academy-only', recent);
    const before = await seed('before-golive', new Date(Date.now() - 8 * 3600_000));
    await mark('taxscan', posted, 'POSTED', { linkedinPostId: 'urn:li:share:5', postedAt: recent });
    await mark('academy', posted, 'FAILED', { error: 'HTTP 422: nope' }); // Academy disagrees: not shown
    await mark('taxscan', failed, 'FAILED', { error: 'HTTP 500' });
    await mark('academy', failed, 'POSTED', { linkedinPostId: 'urn:li:share:6', postedAt: recent });
    await mark('academy', academyOnly, 'POSTED', { linkedinPostId: 'urn:li:share:7', postedAt: recent }); // no Taxscan row
    void pending;
    void before;
    const pick = async () => {
      const m = await byId();
      return Object.fromEntries(Object.keys(ids).map((k) => [k, { channels: m.get(ids[k])!.channels, details: m.get(ids[k])!.channelDetails, day: m.get(ids[k])!.channelDay }]));
    };
    env.linkedin.sharedPages = {};
    const off = await pick();
    academyOn();
    expect(academyActive()).toBe(true);
    const on = await pick();
    expect(JSON.stringify(on)).toBe(JSON.stringify(off));
    expect(on.posted.channels).toMatchObject({ linkedin: 'POSTED' });
    expect(on.posted.details).toMatchObject({ linkedin: { error: null, postUrl: 'https://www.linkedin.com/feed/update/urn%3Ali%3Ashare%3A5/' } });
    expect(on.failed.channels).toMatchObject({ linkedin: 'FAILED' });
    expect(on.failed.details).toMatchObject({ linkedin: { error: 'HTTP 500', postUrl: null } });
    expect(on['academy-only'].channels).toMatchObject({ linkedin: 'PENDING' }); // Academy's POSTED row does not count
    expect(on.pending.channels).toMatchObject({ linkedin: 'PENDING' });
    expect(on['before-golive'].channels).toMatchObject({ linkedin: null }); // LINKEDIN_POST_FROM (Taxscan's), not Academy's
    expect(JSON.stringify(on)).not.toContain('HTTP 422'); // Academy's failure never leaks into the Taxscan mark
  });

  it('still ONE batched LinkedIn query per page of the list, and it asks for the taxscan page only', async () => {
    academyOn();
    await seed('q1', new Date(Date.now() - 60_000));
    const li = jest.spyOn(prisma.linkedInPost, 'findMany');
    try {
      await listCampaigns(50);
      expect(li.mock.calls).toHaveLength(1);
      expect((li.mock.calls[0][0] as { where: { page: string } }).where.page).toBe('taxscan');
    } finally {
      li.mockRestore();
    }
  });
});
