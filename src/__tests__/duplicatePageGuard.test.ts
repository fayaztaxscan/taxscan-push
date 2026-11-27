import cron from 'node-cron';
import { randomBytes } from 'node:crypto';
import type { Campaign } from '@prisma/client';
import { env, facebookSharedPages, linkedinSharedPages } from '../lib/env';
import { prisma } from '../lib/prisma';
import { SHARED_PAGES as FB_SHARED, portalPages as fbPortalPages } from '../services/facebook/pages';
import { resetFacebookStops, runFacebookTick, startFacebookWorker, type WorkerDeps as FacebookDeps } from '../services/facebook/worker';
import { SHARED_PAGES as LI_SHARED, portalPages as liPortalPages } from '../services/linkedin/pages';
import { resetLinkedInStops, runLinkedInTick, startLinkedInWorker, type WorkerDeps as LinkedInDeps } from '../services/linkedin/worker';

/**
 * Brief 2026-11-27-duplicate-page-guard: a shared Facebook or LinkedIn page that is given the same page id / org URN as another page of its
 * channel stays OFF (it would post every push twice). Every provider call is a fake.
 *
 * ISOLATION (shared dev DB): the Taxscan page of each tick is a private page (`dpg-fb…` / `dpg-li…`) under a unique portal; the real names
 * appear only in `env` (restored after each test) and in counts scoped to this file's own campaigns, which must be zero.
 */
const logs: string[] = [];
jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
jest.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
jest.spyOn(console, 'warn').mockImplementation(() => undefined);

const RUN = `${Date.now()}-r${randomBytes(3).toString('hex')}`;
const PORTAL = `test-dpg-${RUN}`;
const FB_T = `dpg-fb${randomBytes(4).toString('hex')}`;
const LI_T = `dpg-li${randomBytes(4).toString('hex')}`;
const IST_MS = (5 * 60 + 30) * 60_000;
const ist = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 28, h, m) - IST_MS);
const NOW = ist(10, 0);
const FROM = ist(4, 0);
const FROM_ISO = FROM.toISOString();

// Three different ids per channel; the tests overwrite one to make a clash.
const FB_ID = { TAXSCAN: '1000000001', SHOPSCAN: '1000000002', ACADEMY: '1000000003' };
const LI_URN = { TAXSCAN: 'urn:li:organization:101', ACADEMY: 'urn:li:organization:102', SHOPSCAN: 'urn:li:organization:103' };
type Ids = Partial<Record<keyof typeof FB_ID, string>>;

function fbVars(ids: Ids = {}): Record<string, string> {
  const id = { ...FB_ID, ...ids };
  const out: Record<string, string> = { FACEBOOK_TAXSCAN_PAGE_ID: id.TAXSCAN };
  for (const p of ['SHOPSCAN', 'ACADEMY'] as const) {
    out[`FACEBOOK_${p}_PAGE_ID`] = id[p];
    out[`FACEBOOK_${p}_PAGE_TOKEN`] = `${p}-PAGE-TOKEN-0123456789abcdef`;
    out[`FACEBOOK_${p}_POST_FROM`] = FROM_ISO;
  }
  return out;
}
function liVars(urns: Ids = {}): Record<string, string> {
  const urn = { ...LI_URN, ...urns };
  const out: Record<string, string> = { LINKEDIN_TAXSCAN_ORG_URN: urn.TAXSCAN };
  for (const p of ['ACADEMY', 'SHOPSCAN'] as const) {
    out[`LINKEDIN_${p}_ORG_URN`] = urn[p];
    out[`LINKEDIN_${p}_POST_FROM`] = FROM_ISO;
  }
  return out;
}
const clash = (variable: string, other: string) => `${variable} is the same page as ${other} (it would post every push twice)`;

const VAR_NAMES = [...Object.keys(fbVars()), ...Object.keys(liVars())];
/** Runs `fn` with exactly these page variables in process.env, then puts the environment back. */
function withVars<T>(vars: Record<string, string>, fn: () => T): T {
  const was = Object.fromEntries(VAR_NAMES.map((k) => [k, process.env[k]]));
  try {
    for (const k of VAR_NAMES) delete process.env[k];
    Object.assign(process.env, vars);
    return fn();
  } finally {
    for (const [k, v] of Object.entries(was)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
/** `env` as a fresh boot would build it with these variables. */
function bootEnv(vars: Record<string, string>): typeof env {
  return withVars(vars, () => {
    let loaded: typeof env | undefined;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      loaded = (require('../lib/env') as typeof import('../lib/env')).env;
    });
    return loaded as typeof env;
  });
}

const saved = {
  fb: { enabled: env.facebook.enabled, postFrom: env.facebook.postFrom, shared: env.facebook.sharedPages, taxscan: env.facebook.pages.taxscan },
  li: { enabled: env.linkedin.enabled, postFrom: env.linkedin.postFrom, shared: env.linkedin.sharedPages, taxscan: env.linkedin.pages.taxscan },
};
let schedule: jest.SpyInstance;
beforeEach(() => {
  logs.length = 0;
  resetFacebookStops();
  resetLinkedInStops();
  schedule = jest.spyOn(cron, 'schedule').mockImplementation((() => ({ start: () => undefined, stop: () => undefined })) as never);
});
afterEach(() => {
  schedule.mockRestore();
  Object.assign(env.facebook, { enabled: saved.fb.enabled, postFrom: saved.fb.postFrom, sharedPages: saved.fb.shared });
  env.facebook.pages.taxscan = saved.fb.taxscan;
  delete env.facebook.pages[FB_T];
  Object.assign(env.linkedin, { enabled: saved.li.enabled, postFrom: saved.li.postFrom, sharedPages: saved.li.shared });
  env.linkedin.pages.taxscan = saved.li.taxscan;
  delete env.linkedin.pages[LI_T];
});
afterAll(async () => {
  const ids = (await prisma.campaign.findMany({ where: { portal: { startsWith: PORTAL } }, select: { id: true } })).map((c) => c.id);
  await prisma.facebookPost.deleteMany({ where: { OR: [{ page: FB_T }, { campaignId: { in: ids } }] } });
  await prisma.linkedInPost.deleteMany({ where: { OR: [{ page: LI_T }, { campaignId: { in: ids } }] } });
  await prisma.campaign.deleteMany({ where: { id: { in: ids } } });
  await prisma.$disconnect();
});

let seq = 0;
const camp = (portal: string): Promise<Campaign> =>
  prisma.campaign.create({
    data: { portal, title: `Story dpg ${++seq}`, body: 'b', url: `https://www.taxscan.in/gst/dpg-${seq}-${RUN}`, target: {}, status: 'SENT', lastSentAt: ist(9, 30), authority: 'Supreme Court', categories: ['GST'] } as never,
  });

/* ------------------------------------------------------------------ */
/* Facebook (acceptance 1, 2, 3, 5)                                     */
/* ------------------------------------------------------------------ */

describe('Facebook: a shared page with another page\'s id stays off', () => {
  it('the channel order is one list: Shopscan, then Academy', () => {
    expect(FB_SHARED).toEqual(['shopscan', 'academy']);
  });

  it.each([
    ['all three different: both shared pages on', {}, ['shopscan', 'academy'], {}],
    ['Academy = Taxscan: Academy off', { ACADEMY: FB_ID.TAXSCAN }, ['shopscan'], { academy: clash('FACEBOOK_ACADEMY_PAGE_ID', 'taxscan') }],
    ['Academy = Shopscan: Shopscan on, Academy off', { ACADEMY: FB_ID.SHOPSCAN }, ['shopscan'], { academy: clash('FACEBOOK_ACADEMY_PAGE_ID', 'shopscan') }],
    ['Shopscan = Taxscan: Shopscan off, Academy still on', { SHOPSCAN: FB_ID.TAXSCAN }, ['academy'], { shopscan: clash('FACEBOOK_SHOPSCAN_PAGE_ID', 'taxscan') }],
    [
      'all three the same: both off, each naming Taxscan',
      { SHOPSCAN: FB_ID.TAXSCAN, ACADEMY: FB_ID.TAXSCAN },
      [],
      { shopscan: clash('FACEBOOK_SHOPSCAN_PAGE_ID', 'taxscan'), academy: clash('FACEBOOK_ACADEMY_PAGE_ID', 'taxscan') },
    ],
    ['surrounding spaces do not make it another page (Taxscan)', { ACADEMY: `  ${FB_ID.TAXSCAN} ` }, ['shopscan'], { academy: clash('FACEBOOK_ACADEMY_PAGE_ID', 'taxscan') }],
    ['surrounding spaces do not make it another page (the Taxscan variable has them)', { TAXSCAN: ` ${FB_ID.ACADEMY}  ` }, ['shopscan'], { academy: clash('FACEBOOK_ACADEMY_PAGE_ID', 'taxscan') }],
    ['surrounding spaces do not make it another page (shared pages)', { ACADEMY: ` ${FB_ID.SHOPSCAN}\n` }, ['shopscan'], { academy: clash('FACEBOOK_ACADEMY_PAGE_ID', 'shopscan') }],
  ] as [string, Ids, string[], Record<string, string>][])('%s', (_name, ids, on, off) => {
    const r = facebookSharedPages(fbVars(ids));
    expect(Object.keys(r.pages)).toEqual(on);
    expect(r.off).toEqual(off);
    // what a fresh boot builds is exactly this, and the page list every reader uses follows it
    const booted = bootEnv(fbVars(ids));
    expect(booted.facebook.sharedPages).toEqual(r.pages);
    env.facebook.sharedPages = booted.facebook.sharedPages;
    expect(fbPortalPages()).toEqual({ taxscan: ['taxscan', ...on] });
    for (const id of Object.values(FB_ID)) expect(JSON.stringify(r.off)).not.toContain(id);
  });

  it('an earlier shared page that is itself off holds no id; with no Taxscan id there is nothing to clash with', () => {
    const noToken = { ...fbVars({ ACADEMY: FB_ID.SHOPSCAN }), FACEBOOK_SHOPSCAN_PAGE_TOKEN: '' };
    const r = facebookSharedPages(noToken);
    expect(Object.keys(r.pages)).toEqual(['academy']); // nothing is posted twice: only Academy posts there
    expect(r.off.shopscan).toBe('FACEBOOK_SHOPSCAN_PAGE_TOKEN is missing or not a valid page token');
    expect(Object.keys(facebookSharedPages({ ...fbVars(), FACEBOOK_TAXSCAN_PAGE_ID: '' }).pages)).toEqual(['shopscan', 'academy']);
    expect(facebookSharedPages({}).off.academy).toBe('not configured (it needs FACEBOOK_ACADEMY_PAGE_ID, FACEBOOK_ACADEMY_PAGE_TOKEN and FACEBOOK_ACADEMY_POST_FROM)');
  });

  it.each([
    ['academy', { ACADEMY: FB_ID.TAXSCAN }, clash('FACEBOOK_ACADEMY_PAGE_ID', 'taxscan')],
    ['academy', { ACADEMY: FB_ID.SHOPSCAN }, clash('FACEBOOK_ACADEMY_PAGE_ID', 'shopscan')],
    ['shopscan', { SHOPSCAN: FB_ID.TAXSCAN }, clash('FACEBOOK_SHOPSCAN_PAGE_ID', 'taxscan')],
  ] as [string, Ids, string][])('boot: the %s line names the clash, no id is printed, and the worker still starts', (page, ids, words) => {
    withVars(fbVars(ids), () => {
      env.facebook.enabled = true;
      env.facebook.postFrom = FROM;
      env.facebook.pages.taxscan = { pageId: FB_ID.TAXSCAN, accessToken: 'TAXSCAN-PAGE-TOKEN-0123456789abcdef' };
      env.facebook.sharedPages = facebookSharedPages(process.env).pages;
      startFacebookWorker();
    });
    expect(schedule).toHaveBeenCalledWith('* * * * *', expect.any(Function));
    expect(logs.filter((l) => l.includes(`${page} page`))).toEqual([`[facebook] ${page} page off: ${words}`]);
    const all = logs.join('\n');
    for (const id of Object.values(FB_ID)) expect(all).not.toContain(id);
    expect(all).not.toContain('PAGE-TOKEN-0123456789');
  });

  it('acceptance 6: a tick with clashed pages makes no row and no call for them', async () => {
    env.facebook.sharedPages = facebookSharedPages(fbVars({ SHOPSCAN: FB_ID.TAXSCAN, ACADEMY: FB_ID.TAXSCAN })).pages;
    env.facebook.pages[FB_T] = { pageId: FB_ID.TAXSCAN, accessToken: 'TAXSCAN-PAGE-TOKEN-0123456789abcdef' };
    const portal = `${PORTAL}-fb`;
    const c = await camp(portal);
    const calls: string[] = [];
    const deps = (pages: string[]): FacebookDeps => ({
      now: () => NOW,
      post: async (r) => {
        calls.push(r.pageId);
        return { kind: 'posted', postId: `${r.pageId}_${calls.length}` };
      },
      fetchCms: async () => null,
      portals: { [portal]: pages },
      postFrom: FROM,
      allPushesFrom: { [FB_T]: null },
      quiet: { start: '23:00', end: '07:00' },
      minGapMinutes: 0,
      dailyCap: 30,
    });
    // the page list production would use, with this file's private page in Taxscan's place
    const live = fbPortalPages().taxscan.map((p) => (p === 'taxscan' ? FB_T : p));
    expect(live).toEqual([FB_T]);
    expect((await runFacebookTick(deps(live))).refused).toBeNull();
    // even a list that still names them: skipped, no refusal
    expect((await runFacebookTick(deps([FB_T, 'shopscan', 'academy']))).refused).toBeNull();
    expect(calls).toEqual([FB_ID.TAXSCAN]); // one post, to the one page, once
    expect(await prisma.facebookPost.count({ where: { campaignId: c.id, page: { in: ['shopscan', 'academy'] } } })).toBe(0);
    expect(await prisma.facebookPost.count({ where: { campaignId: c.id } })).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* LinkedIn (acceptance 4, 5)                                           */
/* ------------------------------------------------------------------ */

describe('LinkedIn: a shared page with another page\'s org URN stays off', () => {
  it('the channel order is one list: Academy, then Shopscan', () => {
    expect(LI_SHARED).toEqual(['academy', 'shopscan']);
  });

  it.each([
    ['all three different: both shared pages on', {}, ['academy', 'shopscan'], {}],
    ['Academy = Taxscan: Academy off', { ACADEMY: LI_URN.TAXSCAN }, ['shopscan'], { academy: clash('LINKEDIN_ACADEMY_ORG_URN', 'taxscan') }],
    ['Shopscan = Academy: Academy on, Shopscan off', { SHOPSCAN: LI_URN.ACADEMY }, ['academy'], { shopscan: clash('LINKEDIN_SHOPSCAN_ORG_URN', 'academy') }],
    ['Shopscan = Taxscan: Shopscan off, Academy on', { SHOPSCAN: LI_URN.TAXSCAN }, ['academy'], { shopscan: clash('LINKEDIN_SHOPSCAN_ORG_URN', 'taxscan') }],
    [
      'all three the same: both off, each naming Taxscan',
      { ACADEMY: LI_URN.TAXSCAN, SHOPSCAN: LI_URN.TAXSCAN },
      [],
      { academy: clash('LINKEDIN_ACADEMY_ORG_URN', 'taxscan'), shopscan: clash('LINKEDIN_SHOPSCAN_ORG_URN', 'taxscan') },
    ],
    ['surrounding spaces do not make it another page', { ACADEMY: ` ${LI_URN.TAXSCAN}  ` }, ['shopscan'], { academy: clash('LINKEDIN_ACADEMY_ORG_URN', 'taxscan') }],
    ['surrounding spaces do not make it another page (shared pages)', { SHOPSCAN: `${LI_URN.ACADEMY} ` }, ['academy'], { shopscan: clash('LINKEDIN_SHOPSCAN_ORG_URN', 'academy') }],
    ['URNs compare exactly: another number is another page', { ACADEMY: `${LI_URN.TAXSCAN}0` }, ['academy', 'shopscan'], {}],
  ] as [string, Ids, string[], Record<string, string>][])('%s', (_name, urns, on, off) => {
    const r = linkedinSharedPages(liVars(urns));
    expect(Object.keys(r.pages)).toEqual(on);
    expect(r.off).toEqual(off);
    const booted = bootEnv(liVars(urns));
    expect(booted.linkedin.sharedPages).toEqual(r.pages);
    env.linkedin.sharedPages = booted.linkedin.sharedPages;
    expect(liPortalPages()).toEqual({ taxscan: ['taxscan', ...on] });
    expect(JSON.stringify(r.off)).not.toContain('urn:li');
  });

  it('an earlier shared page that is itself off holds no URN', () => {
    const noFrom = { ...liVars({ SHOPSCAN: LI_URN.ACADEMY }), LINKEDIN_ACADEMY_POST_FROM: '' };
    const r = linkedinSharedPages(noFrom);
    expect(Object.keys(r.pages)).toEqual(['shopscan']);
    expect(r.off.academy).toBe('LINKEDIN_ACADEMY_POST_FROM is missing or not a valid ISO time');
  });

  it.each([
    ['academy', { ACADEMY: LI_URN.TAXSCAN }, clash('LINKEDIN_ACADEMY_ORG_URN', 'taxscan')],
    ['shopscan', { SHOPSCAN: LI_URN.ACADEMY }, clash('LINKEDIN_SHOPSCAN_ORG_URN', 'academy')],
    ['shopscan', { SHOPSCAN: LI_URN.TAXSCAN }, clash('LINKEDIN_SHOPSCAN_ORG_URN', 'taxscan')],
  ] as [string, Ids, string][])('boot: the %s line names the clash, no URN is printed, and the worker still starts', (page, urns, words) => {
    withVars(liVars(urns), () => {
      env.linkedin.enabled = true;
      env.linkedin.postFrom = FROM;
      env.linkedin.pages.taxscan = { orgUrn: LI_URN.TAXSCAN, accessToken: 'tok-taxscan-dpg' };
      env.linkedin.sharedPages = linkedinSharedPages(process.env).pages;
      startLinkedInWorker();
    });
    expect(schedule).toHaveBeenCalledWith('* * * * *', expect.any(Function));
    expect(logs.filter((l) => l.includes(`${page} page`))).toEqual([`[linkedin] ${page} page off: ${words}`]);
    expect(logs.join('\n')).not.toMatch(/urn:li|tok-taxscan-dpg/);
  });

  it('acceptance 6: a tick with clashed pages makes no row and no call for them', async () => {
    env.linkedin.sharedPages = linkedinSharedPages(liVars({ ACADEMY: LI_URN.TAXSCAN, SHOPSCAN: LI_URN.TAXSCAN })).pages;
    env.linkedin.pages[LI_T] = { orgUrn: LI_URN.TAXSCAN, accessToken: 'tok-taxscan-dpg' };
    const portal = `${PORTAL}-li`;
    const c = await camp(portal);
    const calls: string[] = [];
    const live = liPortalPages().taxscan.map((p) => (p === 'taxscan' ? LI_T : p));
    expect(live).toEqual([LI_T]);
    const deps: LinkedInDeps = {
      now: () => NOW,
      post: async (r) => {
        calls.push(r.orgUrn);
        return { kind: 'posted', postId: `urn:li:share:${calls.length}` };
      },
      fetchCms: async () => null,
      waitImage: async () => ({ ok: true }),
      portals: { [portal]: live },
      postFrom: FROM,
      quiet: { start: '23:00', end: '07:00' },
    };
    await runLinkedInTick(deps);
    await runLinkedInTick(deps);
    expect(calls).toEqual([LI_URN.TAXSCAN]); // one post, to the one page, once
    expect(await prisma.linkedInPost.count({ where: { campaignId: c.id, page: { in: ['academy', 'shopscan'] } } })).toBe(0);
    expect(await prisma.linkedInPost.count({ where: { campaignId: c.id } })).toBe(1);
  });
});
