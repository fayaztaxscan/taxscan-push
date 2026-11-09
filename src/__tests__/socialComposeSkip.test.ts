import { randomBytes } from 'node:crypto';
import request from 'supertest';
import type { Campaign, Prisma } from '@prisma/client';
import { createApp } from '../app';
import { env } from '../lib/env';
import { prisma } from '../lib/prisma';
import { listCampaigns } from '../services/metrics';
import { cloneForResend } from '../services/pacer';
import { dispatchCampaign, executeCampaign, type Sender } from '../services/send';
import { runLinkedInTick, postsCreatedToday, resetLinkedInStops, authKey as liAuthKey, type WorkerDeps as LiDeps } from '../services/linkedin/worker';
import { runFacebookTick, resetFacebookStops, authKey as fbAuthKey, policyKey as fbPolicyKey, type WorkerDeps as FbDeps } from '../services/facebook/worker';
import type { LinkedInRequest, LinkedInResult } from '../services/linkedin/client';
import type { FacebookResult } from '../services/facebook/client';
import { getQueue, markArticle } from '../services/whatsapp/queue';
import { pushKey } from '../services/social/allPushes';
import { composeSkippedPushes, skipRows } from '../services/social/composeSkip';
import { COMPOSE_SKIP, WHATSAPP_SKIP_KEY, activeSocialPages, facebookSkipKey, isComposeSkipped, linkedinSkipKey, unknownSocialKeys } from '../services/social/pages';
import { articleKey } from '../services/reports';

/**
 * Brief 2026-11-09-compose-skip-pages: Compose can untick social pages for ONE push. Everything here is mocked: no LinkedIn, Facebook or
 * e-mail call. ISOLATION (as the Academy / Shopscan tests): the workers run on PRIVATE pages (`cskli-t` plays Taxscan and owns the token,
 * `cskli-a` plays Academy, `cskli-s` Shopscan, `cskfb` the Facebook page) on a unique `test-csk-*` portal, so no real page's rows, stops or
 * tokens are read or written; the skip key of a page is a pure function of its name (`linkedin:<page>`), so the private pages exercise the
 * very same code the real ones do. The list route and the send route are checked with the REAL names (env only). The Channels marks only
 * exist on the real `taxscan` portal, so those rows carry run-unique URLs and are removed after (like campaignChannels.test.ts).
 */
const logs: string[] = [];
jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
jest.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
jest.spyOn(console, 'warn').mockImplementation(() => undefined);

const RUN = `${Date.now()}-${randomBytes(3).toString('hex')}`;
const PORTAL = `test-csk-${RUN}`;
const LI_T = 'cskli-t';
const LI_A = 'cskli-a';
const LI_S = 'cskli-s';
const LI_PAGES = [LI_T, LI_A, LI_S];
const FB = 'cskfb';
const ORG_T = 'urn:li:organization:101';
const ORG_A = 'urn:li:organization:91100022';
const ORG_S = 'urn:li:organization:80241094';
const LI_TOKEN = `CSK-LI-TOKEN-${RUN}`;
const FB_TOKEN = `CSK-FB-TOKEN-${RUN}-EAAB1234567890`;
const IST_MS = (5 * 60 + 30) * 60_000;
const ist = (h: number, m = 0, day = 24) => new Date(Date.UTC(2026, 10, day, h, m) - IST_MS);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const at = (base: Date, min: number) => new Date(base.getTime() + min * MIN);
const NOW = ist(10, 0);
const FROM = ist(4, 0);
const DAY_STR = '2026-11-24';
const BEARER = { Authorization: `Bearer ${process.env.ADMIN_TOKEN}` };
const okSender: Sender = async () => ({ ok: true, statusCode: 201 });

/* ---------------------------- LinkedIn + Facebook fakes ---------------------------- */
const posted = (id = 'urn:li:share:1'): LinkedInResult => ({ kind: 'posted', postId: id });
const orgName = (o: string) => (o === ORG_T ? 'T' : o === ORG_A ? 'A' : 'S');
let liCalls: LinkedInRequest[] = [];
let liScript: (r: LinkedInRequest) => LinkedInResult = (r) => posted(`urn:li:share:${orgName(r.orgUrn)}${liCalls.length}`);
const liPost: NonNullable<LiDeps['post']> = async (r) => {
  liCalls.push(r);
  return liScript(r);
};
const liOrgs = () => liCalls.map((c) => c.orgUrn);
const liDeps = (over: LiDeps = {}): LiDeps => ({
  now: () => NOW,
  post: liPost,
  fetchCms: async () => null,
  fetchStorePage: async () => ({ ok: true, tags: { title: 'A page', description: 'About it.', imageUrl: null, imageReason: 'no_tag' } }),
  waitImage: async () => ({ ok: true }),
  emailSender: async () => ({ ok: true }),
  isEmailConfigured: () => false,
  recipients: async () => ['admin@team.test'],
  portals: { [PORTAL]: LI_PAGES },
  postFrom: { [LI_T]: FROM },
  quiet: { start: '23:00', end: '07:00' },
  ...over,
});
let fbCalls: { pageId: string; accessToken: string; message: string; link: string }[] = [];
const fbPost: NonNullable<FbDeps['post']> = async (r) => {
  fbCalls.push(r);
  return { kind: 'posted', postId: `123_${fbCalls.length}` } as FacebookResult;
};
const fbDeps = (over: FbDeps = {}): FbDeps => ({
  now: () => NOW,
  post: fbPost,
  fetchCms: async () => null,
  emailSender: async () => ({ ok: true }),
  isEmailConfigured: () => false,
  recipients: async () => ['admin@team.test'],
  portals: { [PORTAL]: FB },
  postFrom: FROM,
  quiet: { start: '23:00', end: '07:00' },
  minGapMinutes: 10,
  dailyCap: 30,
  ...over,
});

/* ---------------------------- campaigns + rows ---------------------------- */
let seq = 0;
const articleUrl = (slug: string) => `https://www.taxscan.in/gst/${slug}-${RUN}-${++seq}`;
async function camp(slug: string, lastSentAt: Date, o: { url?: string; skip?: string[]; createdByUserId?: string | null; portal?: string } = {}): Promise<Campaign> {
  return prisma.campaign.create({
    data: {
      portal: o.portal ?? PORTAL,
      title: `Story ${slug}`,
      body: 'b',
      url: o.url ?? articleUrl(slug),
      target: {},
      status: 'SENT',
      lastSentAt,
      authority: 'Supreme Court',
      categories: ['GST'],
      socialSkip: o.skip ?? [],
      createdByUserId: o.createdByUserId ?? null,
    } as never,
  });
}
const ids = async () => (await prisma.campaign.findMany({ where: { portal: PORTAL }, select: { id: true } })).map((c) => c.id);
const liRows = async (page: string) => prisma.linkedInPost.findMany({ where: { page, campaignId: { in: await ids() } }, orderBy: { createdAt: 'asc' } });
const fbRows = async () => prisma.facebookPost.findMany({ where: { page: FB, campaignId: { in: await ids() } }, orderBy: { createdAt: 'asc' } });
const pk = (c: Campaign) => pushKey({ id: c.id, lastSentAt: c.lastSentAt! });
const statusOf = async (page: string, c: Campaign) => (await prisma.linkedInPost.findFirst({ where: { page, campaignId: c.id } }))?.status ?? null;

const saved = {
  shared: env.linkedin.sharedPages,
  headroom: env.linkedin.dailyHeadroom,
  allPushes: env.linkedin.allPushesFrom,
  liPage: env.linkedin.pages[LI_T],
  taxscanLi: env.linkedin.pages.taxscan,
  liFrom: env.linkedin.postFrom,
  liEnabled: env.linkedin.enabled,
  fbEnabled: env.facebook.enabled,
  fbPages: { ...env.facebook.pages },
  fbFrom: env.facebook.postFrom,
  fbAll: env.facebook.allPushesFrom,
  waQueue: env.whatsapp.queueEnabled,
  anyLink: env.social.anyLinkFrom,
};
const REAL_FB_CONFIG = { pageId: '1234567890', accessToken: FB_TOKEN };

async function wipe() {
  const cids = await ids();
  await prisma.linkedInPost.deleteMany({ where: { OR: [{ page: { in: [...LI_PAGES, 'cskli-seed'] } }, { campaignId: { in: cids } }] } });
  await prisma.facebookPost.deleteMany({ where: { OR: [{ page: FB }, { campaignId: { in: cids } }] } });
  await prisma.whatsAppPost.deleteMany({ where: { portal: PORTAL } });
  await prisma.digestSetting.deleteMany({ where: { key: { in: [...LI_PAGES.map(liAuthKey), fbAuthKey(FB), fbPolicyKey(FB)] } } });
  await prisma.campaign.deleteMany({ where: { portal: PORTAL } });
}
/** The auditable state the send route leaves: swept after the file (the audit log is append-only; the carve-out is the tests' way). */
const auditedCampaigns: string[] = [];

beforeAll(() => {
  env.linkedin.sharedPages = {};
});
beforeEach(async () => {
  liCalls = [];
  fbCalls = [];
  logs.length = 0;
  liScript = (r) => posted(`urn:li:share:${orgName(r.orgUrn)}${liCalls.length}`);
  env.linkedin.pages[LI_T] = { orgUrn: ORG_T, accessToken: LI_TOKEN };
  env.linkedin.pages.taxscan = { orgUrn: '', accessToken: '' };
  env.linkedin.sharedPages = { [LI_A]: { orgUrn: ORG_A, postFrom: FROM, tokenFrom: LI_T }, [LI_S]: { orgUrn: ORG_S, postFrom: FROM, tokenFrom: LI_T } };
  env.linkedin.dailyHeadroom = {}; // no quota guard unless a test sets one
  env.linkedin.allPushesFrom = { [LI_T]: FROM, [LI_A]: FROM, [LI_S]: FROM }; // every page posts EVERY push, as in production
  env.linkedin.postFrom = FROM;
  env.facebook.pages[FB] = { ...REAL_FB_CONFIG };
  env.social.anyLinkFrom = null;
  resetLinkedInStops();
  resetFacebookStops();
  await wipe();
});
afterAll(async () => {
  env.linkedin.sharedPages = saved.shared;
  env.linkedin.dailyHeadroom = saved.headroom;
  env.linkedin.allPushesFrom = saved.allPushes;
  if (saved.liPage) env.linkedin.pages[LI_T] = saved.liPage;
  else delete env.linkedin.pages[LI_T];
  env.linkedin.pages.taxscan = saved.taxscanLi;
  env.linkedin.postFrom = saved.liFrom;
  env.linkedin.enabled = saved.liEnabled;
  env.facebook.enabled = saved.fbEnabled;
  env.facebook.postFrom = saved.fbFrom;
  env.facebook.allPushesFrom = saved.fbAll;
  env.facebook.pages = saved.fbPages;
  delete env.facebook.pages[FB];
  env.whatsapp.queueEnabled = saved.waQueue;
  env.social.anyLinkFrom = saved.anyLink;
  await wipe();
  // campaigns the send route made on the real portal tests below and their audit rows
  if (auditedCampaigns.length) {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL audit_log.allow_purge = 'true'`);
      await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "resourceId" = ANY(${auditedCampaigns}::text[])`;
    });
  }
  await prisma.$disconnect();
});

/* ================================================================== */
/* The list of social pages                                            */
/* ================================================================== */

/** Switch destinations on or off with the REAL names (env only; no database). */
function setActive(o: { li?: boolean; academy?: boolean; shopscan?: boolean; fb?: boolean; wa?: boolean }) {
  env.linkedin.enabled = !!o.li;
  env.linkedin.sharedPages = {
    ...(o.academy ? { academy: { orgUrn: ORG_A, postFrom: FROM, tokenFrom: 'taxscan' } } : {}),
    ...(o.shopscan ? { shopscan: { orgUrn: ORG_S, postFrom: FROM, tokenFrom: 'taxscan' } } : {}),
  };
  env.facebook.enabled = !!o.fb;
  env.facebook.pages.taxscan = { ...REAL_FB_CONFIG };
  env.whatsapp.queueEnabled = !!o.wa;
}
const ALL_ON = { li: true, academy: true, shopscan: true, fb: true, wa: true };

describe('1. GET /api/social/pages lists exactly the ACTIVE pages, in order', () => {
  const app = () => createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 } });
  const get = () => request(app()).get('/api/social/pages').set(BEARER);

  it('everything on: LinkedIn Taxscan, Academy, Shopscan, Facebook Taxscan, WhatsApp channel, with their labels', async () => {
    setActive(ALL_ON);
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      pages: [
        { key: 'linkedin:taxscan', label: 'LinkedIn · Taxscan' },
        { key: 'linkedin:academy', label: 'LinkedIn · Academy' },
        { key: 'linkedin:shopscan', label: 'LinkedIn · Shopscan' },
        { key: 'facebook:taxscan', label: 'Facebook · Taxscan' },
        { key: 'whatsapp', label: 'WhatsApp channel' },
      ],
    });
  });

  it('an inactive LinkedIn page (Academy / Shopscan variables unset) is absent; so is Facebook when off, and WhatsApp when its queue is off', async () => {
    setActive({ li: true, academy: false, shopscan: true, fb: true, wa: true });
    expect((await get()).body.pages.map((p: { key: string }) => p.key)).toEqual(['linkedin:taxscan', 'linkedin:shopscan', 'facebook:taxscan', 'whatsapp']);
    setActive({ li: true, academy: true, shopscan: false, fb: false, wa: true });
    expect((await get()).body.pages.map((p: { key: string }) => p.key)).toEqual(['linkedin:taxscan', 'linkedin:academy', 'whatsapp']);
    setActive({ li: true, academy: true, shopscan: true, fb: true, wa: false });
    expect((await get()).body.pages.map((p: { key: string }) => p.key)).toEqual(['linkedin:taxscan', 'linkedin:academy', 'linkedin:shopscan', 'facebook:taxscan']);
  });

  it('LINKEDIN_POSTING_ENABLED off removes every LinkedIn page, whatever their variables say; nothing on = an empty list', async () => {
    setActive({ li: false, academy: true, shopscan: true, fb: true, wa: true });
    expect((await get()).body.pages.map((p: { key: string }) => p.key)).toEqual(['facebook:taxscan', 'whatsapp']);
    setActive({});
    expect((await get()).body).toEqual({ pages: [] });
  });

  it('a Facebook page without a valid id / token is not offered (the worker would not post there)', async () => {
    setActive({ fb: true });
    env.facebook.pages.taxscan = { pageId: '', accessToken: '' };
    expect(activeSocialPages()).toEqual([]);
  });

  it('a later Facebook page joins by its own name: the label is built from the page key, nothing in Compose changes', () => {
    setActive({ fb: true });
    env.facebook.pages.taxscan = { ...REAL_FB_CONFIG };
    expect(activeSocialPages().map((p) => p.key)).toEqual(['facebook:taxscan']);
    expect(facebookSkipKey('academy')).toBe('facebook:academy');
    expect(linkedinSkipKey('shopscan')).toBe('linkedin:shopscan');
  });

  it('401 without a login; the bearer is accepted', async () => {
    setActive(ALL_ON);
    expect((await request(app()).get('/api/social/pages')).status).toBe(401);
    expect((await get()).status).toBe(200);
  });

  it('unknownSocialKeys: each unknown key once, in the order given; known keys never', () => {
    setActive(ALL_ON);
    expect(unknownSocialKeys(['linkedin:academy', 'nope', 'facebook:nope', 'nope', 'whatsapp'])).toEqual(['nope', 'facebook:nope']);
    expect(unknownSocialKeys([])).toEqual([]);
  });
});

/* ================================================================== */
/* The send route                                                      */
/* ================================================================== */

describe('POST /api/send: validation, storage, scheduling, audit', () => {
  const app = () => createApp({ sender: okSender, rateLimit: { publicPerMin: 10000, loginPerMin: 10000 } });
  const body = (extra: Record<string, unknown> = {}) => ({ portal: PORTAL, title: `Story send ${++seq}`, body: 'b', url: articleUrl('send'), target: { type: 'all' }, breaking: true, ...extra });
  const send = (extra: Record<string, unknown> = {}) => request(app()).post('/api/send').set(BEARER).send(body(extra));
  const campaignsNamed = (title: string) => prisma.campaign.findMany({ where: { portal: PORTAL, title } });
  beforeEach(() => setActive(ALL_ON));

  it('2. no socialSkip: the campaign stores an empty list (today\'s behaviour: every page)', async () => {
    const r = await send();
    expect(r.status).toBe(200);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: r.body.campaignId } })).socialSkip).toEqual([]);
    const empty = await send({ socialSkip: [] });
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: empty.body.campaignId } })).socialSkip).toEqual([]);
  });

  it('3. the unticked keys are stored as sent (each once, in the order given)', async () => {
    const r = await send({ socialSkip: ['linkedin:academy', 'facebook:taxscan', 'linkedin:academy'] });
    expect(r.status).toBe(200);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: r.body.campaignId } })).socialSkip).toEqual(['linkedin:academy', 'facebook:taxscan']);
  });

  it('5. an unknown or inactive key is 400 unknown_social_page: no campaign, no send, no rows (and the one-time id stays usable)', async () => {
    const calls: string[] = [];
    const counting: Sender = async () => (calls.push('sent'), { ok: true, statusCode: 201 });
    const a = createApp({ sender: counting, rateLimit: { publicPerMin: 10000, loginPerMin: 10000 } });
    const title = `Story refused ${RUN}`;
    const reqId = `csk-req-${RUN}`;
    for (const keys of [['nope'], ['linkedin:academy', 'facebook:nope'], ['LinkedIn · Academy'], ['linkedin:']]) {
      const r = await request(a).post('/api/send').set(BEARER).send(body({ title, socialSkip: keys, clientRequestId: reqId }));
      expect(r.status).toBe(400);
      expect(r.body).toMatchObject({ error: 'unknown_social_page' });
      expect(r.body.keys).toEqual(keys.filter((k) => !['linkedin:academy'].includes(k)));
      expect(r.body.message).toMatch(/nothing was sent/i);
    }
    expect(calls).toEqual([]);
    expect(await campaignsNamed(title)).toHaveLength(0);
    // an INACTIVE page: Academy switched off meanwhile
    setActive({ li: true, academy: false, shopscan: true, fb: true, wa: true });
    const off = await request(a).post('/api/send').set(BEARER).send(body({ title, socialSkip: ['linkedin:academy'], clientRequestId: reqId }));
    expect([off.status, off.body.error, off.body.keys]).toEqual([400, 'unknown_social_page', ['linkedin:academy']]);
    expect(await campaignsNamed(title)).toHaveLength(0);
    // the same one-time id, valid this time, is accepted: the refused attempts never "used" it
    const ok = await request(a).post('/api/send').set(BEARER).send(body({ title, socialSkip: ['whatsapp'], clientRequestId: reqId }));
    expect(ok.status).toBe(200);
    expect(calls).toEqual([]); // still no subscribers on this portal: nothing was pushed to anyone
    expect(await campaignsNamed(title)).toHaveLength(1);
  });

  it('a body that is not a list of short strings is the ordinary 400 invalid_request', async () => {
    for (const bad of ['whatsapp', [1], [''], Array.from({ length: 41 }, (_, i) => `k${i}`)]) {
      const r = await send({ socialSkip: bad });
      expect([r.status, r.body.error]).toEqual([400, 'invalid_request']);
    }
  });

  it('7. a scheduled send keeps its socialSkip; it is still there when it fires, and the workers honour it', async () => {
    const r = await send({ breaking: false, scheduledAt: new Date(Date.now() + 2 * DAY).toISOString(), socialSkip: ['linkedin:academy', 'whatsapp'] });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('SCHEDULED');
    const stored = await prisma.campaign.findUniqueOrThrow({ where: { id: r.body.campaignId } });
    expect([stored.status, stored.socialSkip]).toEqual(['SCHEDULED', ['linkedin:academy', 'whatsapp']]);
    // it fires (the sweeper's own two steps: claim, then execute; the sweeper sweeps EVERY scheduled row in the database)
    await prisma.campaign.update({ where: { id: stored.id }, data: { status: 'DRAFT' } });
    await executeCampaign(await prisma.campaign.findUniqueOrThrow({ where: { id: stored.id } }), { sender: okSender });
    const fired = await prisma.campaign.findUniqueOrThrow({ where: { id: stored.id } });
    expect([fired.status, fired.socialSkip]).toEqual(['SENT', ['linkedin:academy', 'whatsapp']]);
    // and a worker honours what a scheduled send carries: the same shape with a private page's key (the send path stamps the REAL send
    // time, so it is moved onto the test clock; the key and `scheduledAt` are what the send path wrote)
    const d = await prisma.campaign.create({ data: { portal: PORTAL, title: 'Story sched-fire', body: 'b', url: articleUrl('sched-fire'), target: { type: 'all' }, status: 'DRAFT', scheduledAt: at(NOW, -40), socialSkip: [linkedinSkipKey(LI_A)] } });
    await executeCampaign(d, { sender: okSender });
    const c = await prisma.campaign.update({ where: { id: d.id }, data: { lastSentAt: at(NOW, -30) } });
    // this describe switched the REAL page names on for the list and the route; the worker below runs on the private pages
    env.linkedin.sharedPages = { [LI_A]: { orgUrn: ORG_A, postFrom: FROM, tokenFrom: LI_T }, [LI_S]: { orgUrn: ORG_S, postFrom: FROM, tokenFrom: LI_T } };
    await runLinkedInTick(liDeps());
    expect(liOrgs()).toEqual([ORG_T, ORG_S]);
    expect(await statusOf(LI_A, c)).toBe('SKIPPED');
  });

  it('11. the send\'s audit entry carries the skipped keys (keys only), and has no such field when nothing was unticked', async () => {
    const r = await send({ socialSkip: ['linkedin:academy', 'whatsapp'] });
    const plain = await send();
    auditedCampaigns.push(r.body.campaignId, plain.body.campaignId);
    const entry = await prisma.auditLog.findFirstOrThrow({ where: { resourceId: r.body.campaignId, action: 'CAMPAIGN_DISPATCHED' } });
    expect((entry.metadata as { socialSkip?: string[] }).socialSkip).toEqual(['linkedin:academy', 'whatsapp']);
    expect(JSON.stringify(entry.metadata)).not.toMatch(/@|token/i);
    const clean = await prisma.auditLog.findFirstOrThrow({ where: { resourceId: plain.body.campaignId, action: 'CAMPAIGN_DISPATCHED' } });
    expect(Object.keys(clean.metadata as object)).not.toContain('socialSkip');
  });

  it('Compose with Breaking ticked still honours the unticked pages (the sender chose them on the same form)', async () => {
    const r = await send({ breaking: true, socialSkip: ['facebook:taxscan'] });
    expect(r.status).toBe(200);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: r.body.campaignId } })).socialSkip).toEqual(['facebook:taxscan']);
  });
});

describe('8. every other door posts everywhere: no socialSkip', () => {
  const NOON = ist(12, 0);
  const sessionless = () => createApp({ sender: okSender, clock: () => NOON, linkCheck: false, rateLimit: { publicPerMin: 10000, loginPerMin: 10000 } });
  beforeEach(() => setActive(ALL_ON));

  it('Queue Push now and Review Push now (with or without Breaking) ignore any socialSkip in the body and store none', async () => {
    const q = await prisma.campaign.create({ data: { portal: PORTAL, title: 'Story q', body: 'b', url: articleUrl('q'), target: { type: 'all' }, status: 'DRAFT', sendQueue: 'QUALIFIED' } });
    const qr = await request(sessionless()).post(`/api/queue/${q.id}/push`).set(BEARER).send({ socialSkip: ['whatsapp'] });
    expect(qr.status).toBe(200);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: q.id } })).socialSkip).toEqual([]);
    const rv = await prisma.campaign.create({ data: { portal: PORTAL, title: 'Story r', body: 'b', url: articleUrl('r'), target: { type: 'all' }, status: 'DRAFT', sendQueue: 'REVIEW' } });
    const rr = await request(sessionless()).post(`/api/review/${rv.id}/push`).set(BEARER).send({ breaking: true, socialSkip: ['linkedin:academy'] });
    expect(rr.status).toBe(200);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: rv.id } })).socialSkip).toEqual([]);
    auditedCampaigns.push(q.id, rv.id);
  });

  it('the pacer / RSS capture default, a dispatch without the field, and the morning-backfill clone of a Compose push that skipped pages', async () => {
    const plain = await prisma.campaign.create({ data: { portal: PORTAL, title: 'Story pacer', body: 'b', url: articleUrl('pacer'), target: {}, status: 'DRAFT', sendQueue: 'QUALIFIED' } });
    expect(plain.socialSkip).toEqual([]);
    const d = await dispatchCampaign({ portal: PORTAL, title: 'Story d', body: 'b', url: articleUrl('d'), target: { type: 'all' }, breaking: true }, { sender: okSender, now: NOON });
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: d.campaignId } })).socialSkip).toEqual([]);
    auditedCampaigns.push(d.campaignId);
    const composed = await camp('orig', at(NOW, -60), { skip: ['linkedin:academy', 'whatsapp'] });
    const clone = await cloneForResend(composed);
    expect(clone.socialSkip).toEqual([]); // the backfill posts everywhere, even the clone of a push that skipped pages
  });
});

/* ================================================================== */
/* The helper's rules                                                  */
/* ================================================================== */

describe('the shared rule: which unticked pushes get a row, under which key', () => {
  const home = { id: 'h1', url: 'https://www.taxscan.in/', target: {}, lastSentAt: at(NOW, -5) };
  const article = { id: 'a1', url: 'https://www.taxscan.in/gst/some-story-1234', target: {}, lastSentAt: at(NOW, -5) };
  const course = { id: 'c1', url: 'https://academy.taxscan.in/course/gst-masterclass', target: {}, lastSentAt: at(NOW, -5) };
  const testOnly = { id: 't1', url: 'https://www.taxscan.in/gst/some-story-1234', target: { type: 'topics', topics: [env.testSegmentTopic] }, lastSentAt: at(NOW, -5) };

  it('always the push\'s own key; under today\'s rule only a public article would have posted; under the new rule any qualifying push', () => {
    const key = (c: { id: string; lastSentAt: Date }) => pushKey({ id: c.id, lastSentAt: c.lastSentAt });
    expect(skipRows([article, course], null).map((r) => r.key)).toEqual([key(article)]);
    expect(skipRows([article, course], FROM).map((r) => r.key)).toEqual([key(article), key(course)]);
    expect(skipRows([home], FROM)).toEqual([]); // a site page qualifies only from SOCIAL_ANY_LINK_FROM
    expect(skipRows([testOnly], FROM)).toEqual([]); // posts nowhere anyway: nothing to skip
    expect(skipRows([{ ...article, lastSentAt: null }], FROM)).toEqual([]);
    // a push BEFORE the page's all-pushes time follows today's rule even when the time is set
    expect(skipRows([{ ...course, lastSentAt: at(FROM, -10) }], FROM)).toEqual([]);
  });

  it('the one read: SENT pushes since go-live on the page\'s portals whose list names the key, oldest first', async () => {
    const a = await camp('r1', at(NOW, -30), { skip: [linkedinSkipKey(LI_A)] });
    await camp('r2', at(NOW, -20), { skip: [linkedinSkipKey(LI_S)] });
    await camp('r3', at(NOW, -10));
    await camp('r4', at(FROM, -60), { skip: [linkedinSkipKey(LI_A)] }); // before go-live
    await camp('r5', at(NOW, -5), { skip: [linkedinSkipKey(LI_A)], portal: `${PORTAL}-other` });
    const r = await composeSkippedPushes([PORTAL], linkedinSkipKey(LI_A), FROM);
    expect(r.map((c) => c.id)).toEqual([a.id]);
    await prisma.campaign.deleteMany({ where: { portal: `${PORTAL}-other` } });
  });

  it('isComposeSkipped: only the named key; a campaign that never had the choice is never skipped', () => {
    expect(isComposeSkipped({ socialSkip: ['linkedin:academy'] }, 'linkedin:academy')).toBe(true);
    expect(isComposeSkipped({ socialSkip: ['linkedin:academy'] }, 'linkedin:taxscan')).toBe(false);
    expect(isComposeSkipped({ socialSkip: [] }, 'whatsapp')).toBe(false);
    expect(isComposeSkipped({}, 'whatsapp')).toBe(false);
    expect(isComposeSkipped({ socialSkip: null }, 'whatsapp')).toBe(false);
    expect(WHATSAPP_SKIP_KEY).toBe('whatsapp');
  });
});

/* ================================================================== */
/* LinkedIn worker                                                     */
/* ================================================================== */

describe('LinkedIn worker', () => {
  it('2. no socialSkip: every page posts (regression)', async () => {
    const c = await camp('li-all', at(NOW, -30));
    await runLinkedInTick(liDeps());
    expect(liOrgs()).toEqual([ORG_T, ORG_A, ORG_S]);
    for (const p of LI_PAGES) expect(await statusOf(p, c)).toBe('POSTED');
  });

  it('3. one page unticked: the others post; that page gets ONE SKIPPED compose_skip row, under the push\'s own key, and NO API call', async () => {
    const c = await camp('li-one', at(NOW, -30), { skip: [linkedinSkipKey(LI_A)] });
    await runLinkedInTick(liDeps());
    expect(liOrgs()).toEqual([ORG_T, ORG_S]);
    expect(await statusOf(LI_T, c)).toBe('POSTED');
    expect(await statusOf(LI_S, c)).toBe('POSTED');
    const rows = await liRows(LI_A);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'SKIPPED', error: COMPOSE_SKIP, attempts: 0, campaignId: c.id, articleKey: pk(c), nextAttemptAt: null, linkedinPostId: null, postedAt: null });
  });

  it('every LinkedIn page unticked: no LinkedIn call at all, one skip row per page', async () => {
    const c = await camp('li-every', at(NOW, -30), { skip: LI_PAGES.map(linkedinSkipKey) });
    await runLinkedInTick(liDeps());
    expect(liCalls).toHaveLength(0);
    for (const p of LI_PAGES) expect((await liRows(p)).map((r) => [r.status, r.error, r.campaignId])).toEqual([['SKIPPED', COMPOSE_SKIP, c.id]]);
  });

  it('idempotent: more ticks add no second row; the skip costs no tick budget (three other pushes still post three times)', async () => {
    await camp('li-skip-first', at(NOW, -50), { skip: [linkedinSkipKey(LI_T)] });
    for (let i = 0; i < 3; i++) await camp(`li-n${i}`, at(NOW, -40 + i), { skip: [linkedinSkipKey(LI_A), linkedinSkipKey(LI_S)] });
    for (let i = 0; i < 4; i++) await runLinkedInTick(liDeps({ now: () => at(NOW, i) }));
    expect(await liRows(LI_T)).toHaveLength(4);
    expect((await liRows(LI_T)).filter((r) => r.status === 'SKIPPED')).toHaveLength(1);
    // Academy: the three pushes it was unticked for are skipped (their rows come first: the skip is written before anything posts);
    // the one push nobody unticked for Academy posts
    expect((await liRows(LI_A)).map((r) => r.status).sort()).toEqual(['POSTED', 'SKIPPED', 'SKIPPED', 'SKIPPED']);
    expect(liCalls.filter((c) => c.orgUrn === ORG_T)).toHaveLength(3);
  });

  it('6a. NEW RULE: a later push of the SAME URL from another door posts on the page that was skipped in Compose', async () => {
    const url = articleUrl('li-same');
    const first = await camp('li-s1', at(NOW, -40), { url, skip: [linkedinSkipKey(LI_A)] });
    const later = await camp('li-s2', at(NOW, -20), { url }); // Push now / the pacer: no socialSkip
    await runLinkedInTick(liDeps());
    await runLinkedInTick(liDeps());
    expect((await liRows(LI_A)).map((r) => [r.campaignId, r.status])).toEqual([[first.id, 'SKIPPED'], [later.id, 'POSTED']]);
    expect(liCalls.filter((c) => c.orgUrn === ORG_A)).toHaveLength(1);
  });

  it('6b. TODAY\'S RULE (no all-pushes time): the skipped push is not the article\'s oldest push any more, so the later push posts and takes the article\'s one post', async () => {
    const url = articleUrl('li-same-old');
    const first = await camp('li-o1', at(NOW, -40), { url, skip: [linkedinSkipKey(LI_A)] });
    const later = await camp('li-o2', at(NOW, -20), { url });
    await runLinkedInTick(liDeps({ allPushesFrom: null }));
    await runLinkedInTick(liDeps({ allPushesFrom: null }));
    const rows = await liRows(LI_A);
    expect(rows.map((r) => [r.campaignId, r.status, r.articleKey === pk(first) || r.articleKey === articleKey(later) ? 'ok' : r.articleKey])).toEqual([[first.id, 'SKIPPED', 'ok'], [later.id, 'POSTED', 'ok']]);
    expect(rows.find((r) => r.campaignId === first.id)!.articleKey).toBe(pk(first)); // never the article's key
    expect(rows.find((r) => r.campaignId === later.id)!.articleKey).toBe(articleKey(later));
    // and the other pages, which were not unticked, posted ONE post for the article (its oldest push), exactly as today
    expect((await liRows(LI_T)).map((r) => r.campaignId)).toEqual([first.id]);
  });

  it('6c. an article already posted by an earlier push, then a Compose push that skips the page: only the skip row is added, no second post', async () => {
    const url = articleUrl('li-after');
    const early = await camp('li-a1', at(NOW, -60), { url });
    await runLinkedInTick(liDeps({ allPushesFrom: null }));
    expect(liCalls).toHaveLength(3);
    const composed = await camp('li-a2', at(NOW, -10), { url, skip: [linkedinSkipKey(LI_A)] });
    await runLinkedInTick(liDeps({ allPushesFrom: null }));
    expect(liCalls).toHaveLength(3);
    expect((await liRows(LI_A)).map((r) => [r.campaignId, r.status])).toEqual([[early.id, 'POSTED'], [composed.id, 'SKIPPED']]);
  });

  it('a push that would never have posted (a site page without SOCIAL_ANY_LINK_FROM) or came before go-live gets no row', async () => {
    await camp('li-home', at(NOW, -30), { url: 'https://www.taxscan.in/', skip: [linkedinSkipKey(LI_A)] });
    await camp('li-before', at(FROM, -30), { skip: [linkedinSkipKey(LI_A)] });
    await runLinkedInTick(liDeps());
    expect(await liRows(LI_A)).toHaveLength(0);
  });

  it('a login stop on the page does not stop its skip rows', async () => {
    await camp('li-stop-1', at(NOW, -30));
    liScript = (r) => (r.orgUrn === ORG_A ? { kind: 'auth', status: 403, error: 'HTTP 403' } : posted(`urn:li:share:${orgName(r.orgUrn)}${liCalls.length}`));
    await runLinkedInTick(liDeps());
    const later = await camp('li-stop-2', at(NOW, -10), { skip: [linkedinSkipKey(LI_A)] });
    await runLinkedInTick(liDeps({ now: () => at(NOW, 2) }));
    expect(await statusOf(LI_A, later)).toBe('SKIPPED');
  });

  it('a compose skip comes before the daily quota guard: the row says compose_skip, not quota_headroom', async () => {
    env.linkedin.dailyHeadroom = { [LI_A]: 1 };
    await prisma.linkedInPost.create({ data: { page: 'cskli-seed', articleKey: `seed-${RUN}`, campaignId: 'seed', status: 'POSTED', attempts: 5, createdAt: NOW, updatedAt: NOW } });
    try {
      expect(await postsCreatedToday(NOW)).toBeGreaterThanOrEqual(5);
      const skipped = await camp('li-guard-1', at(NOW, -30), { skip: [linkedinSkipKey(LI_A)] });
      const plain = await camp('li-guard-2', at(NOW, -20));
      await runLinkedInTick(liDeps());
      expect((await liRows(LI_A)).map((r) => [r.campaignId, r.status, r.error])).toEqual([[skipped.id, 'SKIPPED', COMPOSE_SKIP], [plain.id, 'SKIPPED', 'quota_headroom']]);
    } finally {
      await prisma.linkedInPost.deleteMany({ where: { page: 'cskli-seed' } });
    }
  });
});

/* ================================================================== */
/* Facebook worker                                                     */
/* ================================================================== */

describe('Facebook worker', () => {
  it('2. no socialSkip: it posts (regression)', async () => {
    const c = await camp('fb-all', at(NOW, -30));
    await runFacebookTick(fbDeps({ allPushesFrom: FROM }));
    expect(fbCalls).toHaveLength(1);
    expect((await fbRows()).map((r) => [r.campaignId, r.status])).toEqual([[c.id, 'POSTED']]);
  });

  it('4. unticked: NO Facebook call, one SKIPPED compose_skip row under the push\'s own key', async () => {
    const c = await camp('fb-skip', at(NOW, -30), { skip: [facebookSkipKey(FB), WHATSAPP_SKIP_KEY] });
    await runFacebookTick(fbDeps({ allPushesFrom: FROM }));
    await runFacebookTick(fbDeps({ allPushesFrom: FROM, now: () => at(NOW, 1) }));
    expect(fbCalls).toHaveLength(0);
    const rows = await fbRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'SKIPPED', error: COMPOSE_SKIP, attempts: 0, campaignId: c.id, articleKey: pk(c), nextAttemptAt: null, facebookPostId: null });
  });

  it('6. a later push of the same URL posts on Facebook: under the new rule and under today\'s rule', async () => {
    for (const rule of [FROM, null]) {
      const url = articleUrl(`fb-same-${rule ? 'new' : 'old'}`);
      const first = await camp(`fb-f1-${rule ? 'n' : 'o'}`, at(NOW, -40), { url, skip: [facebookSkipKey(FB)] });
      const later = await camp(`fb-f2-${rule ? 'n' : 'o'}`, at(NOW, -20), { url });
      for (let i = 0; i < 2; i++) await runFacebookTick(fbDeps({ allPushesFrom: rule, now: () => at(NOW, 20 * i) }));
      const rows = (await fbRows()).filter((r) => r.campaignId === first.id || r.campaignId === later.id);
      expect(rows.map((r) => [r.campaignId, r.status])).toEqual([[first.id, 'SKIPPED'], [later.id, 'POSTED']]);
      expect(rows.find((r) => r.campaignId === first.id)!.articleKey).toBe(pk(first));
      expect(rows.find((r) => r.campaignId === later.id)!.articleKey).toBe(rule ? pk(later) : articleKey(later));
      await prisma.facebookPost.deleteMany({ where: { page: FB } });
      await prisma.campaign.deleteMany({ where: { portal: PORTAL } }); // the next rule starts from nothing
      fbCalls = [];
    }
  });

  it('the skip row is written at once, whatever the page is waiting for (the gap between two posts), and costs the tick\'s one attempt nothing', async () => {
    await camp('fb-w1', at(NOW, -30));
    await runFacebookTick(fbDeps({ allPushesFrom: FROM }));
    expect(fbCalls).toHaveLength(1);
    const skipped = await camp('fb-w2', at(NOW, -5), { skip: [facebookSkipKey(FB)] });
    await runFacebookTick(fbDeps({ allPushesFrom: FROM, now: () => at(NOW, 1) })); // inside the 10-minute gap
    expect(fbCalls).toHaveLength(1);
    expect((await fbRows()).find((r) => r.campaignId === skipped.id)).toMatchObject({ status: 'SKIPPED', error: COMPOSE_SKIP });
    // an older skipped push beside a normal one: the normal one still posts in the same tick
    await prisma.facebookPost.deleteMany({ where: { page: FB } });
    await prisma.campaign.deleteMany({ where: { portal: PORTAL } });
    fbCalls = [];
    const s = await camp('fb-w3', at(NOW, -50), { skip: [facebookSkipKey(FB)] });
    const n = await camp('fb-w4', at(NOW, -40));
    await runFacebookTick(fbDeps({ allPushesFrom: FROM }));
    expect(fbCalls).toHaveLength(1);
    expect((await fbRows()).map((r) => [r.campaignId, r.status]).sort()).toEqual([[s.id, 'SKIPPED'], [n.id, 'POSTED']].sort());
  });

  it('a push that would never have posted gets no row', async () => {
    await camp('fb-home', at(NOW, -30), { url: 'https://www.taxscan.in/', skip: [facebookSkipKey(FB)] });
    await runFacebookTick(fbDeps({ allPushesFrom: FROM }));
    expect(await fbRows()).toHaveLength(0);
  });
});

/* ================================================================== */
/* WhatsApp                                                            */
/* ================================================================== */

describe('WhatsApp queue', () => {
  const opts = (allPushesFrom: Date | null) => ({ allPushesFrom });
  const queue = (rule: Date | null = null) => getQueue(PORTAL, DAY_STR, opts(rule));

  it('2. no socialSkip: a pushed article is To do, as always', async () => {
    await camp('wa-todo', at(NOW, -30));
    const q = await queue();
    expect(q.rows.map((r) => r.status)).toEqual(['TODO']);
    expect(Object.keys(q.rows[0])).not.toContain('skipReason');
  });

  it('4. unticked: the push is a SKIPPED row, never To do, with no actor and no WhatsAppPost row needed; counts agree', async () => {
    const c = await camp('wa-skip', at(NOW, -30), { skip: [WHATSAPP_SKIP_KEY] });
    for (const rule of [null, FROM]) {
      const q = await queue(rule);
      expect(q.rows).toHaveLength(1);
      expect(q.rows[0]).toMatchObject({ campaignId: c.id, status: 'SKIPPED', skipReason: COMPOSE_SKIP, actedBy: null, actedAt: null, articleKey: pk(c), rule: 'push' });
      expect(q.rows[0].text).toContain('*'); // the post text is still there to read
      expect(q.counts).toEqual({ todo: 0, posted: 0, skipped: 1, all: 1 });
    }
    expect(await prisma.whatsAppPost.count({ where: { portal: PORTAL } })).toBe(0);
  });

  it('another channel\'s key does not touch WhatsApp', async () => {
    await camp('wa-other', at(NOW, -30), { skip: ['linkedin:academy', 'facebook:taxscan'] });
    expect((await queue()).rows.map((r) => r.status)).toEqual(['TODO']);
  });

  it('6. a later push of the same URL lists as To do: today\'s rule and the new rule', async () => {
    for (const rule of [null, FROM]) {
      await prisma.campaign.deleteMany({ where: { portal: PORTAL } });
      const url = articleUrl('wa-same');
      const first = await camp('wa-s1', at(NOW, -40), { url, skip: [WHATSAPP_SKIP_KEY] });
      const later = await camp('wa-s2', at(NOW, -20), { url });
      const q = await queue(rule);
      expect(q.rows.map((r) => [r.campaignId, r.status])).toEqual([[first.id, 'SKIPPED'], [later.id, 'TODO']]);
      expect(q.counts).toEqual({ todo: 1, posted: 0, skipped: 1, all: 2 });
    }
  });

  it('the Posted / Skipped / undo API refuses a push the sender unticked: nothing is written', async () => {
    const c = await camp('wa-mark', at(NOW, -30), { skip: [WHATSAPP_SKIP_KEY] });
    for (const s of ['POSTED', 'SKIPPED', 'TODO'] as const) expect(await markArticle(PORTAL, c.id, s, null, NOW, opts(FROM))).toEqual({ ok: false, reason: 'compose_skip' });
    expect(await prisma.whatsAppPost.count({ where: { portal: PORTAL } })).toBe(0);
    env.whatsapp.queueEnabled = true;
    const app = createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 }, whatsapp: { enabled: () => true, clock: () => NOW, portal: () => PORTAL, allPushesFrom: () => FROM } });
    const r = await request(app).post(`/api/whatsapp/queue/${c.id}`).set(BEARER).send({ status: 'POSTED' });
    expect([r.status, r.body]).toEqual([409, { error: 'compose_skip' }]);
    // an ordinary push is still markable
    const plain = await camp('wa-mark-ok', at(NOW, -20));
    expect((await request(app).post(`/api/whatsapp/queue/${plain.id}`).set(BEARER).send({ status: 'POSTED' })).status).toBe(200);
  });

  it('the list route carries skipReason on that row only', async () => {
    const c = await camp('wa-route', at(NOW, -30), { skip: [WHATSAPP_SKIP_KEY] });
    const plain = await camp('wa-route-2', at(NOW, -20));
    const app = createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 }, whatsapp: { enabled: () => true, clock: () => NOW, portal: () => PORTAL, allPushesFrom: () => null } });
    const r = await request(app).get(`/api/whatsapp/queue?date=${DAY_STR}`).set(BEARER);
    expect(r.status).toBe(200);
    const by = new Map<string, { skipReason?: string; status: string }>(r.body.rows.map((x: { campaignId: string; skipReason?: string; status: string }) => [x.campaignId, x]));
    expect(by.get(c.id)).toMatchObject({ status: 'SKIPPED', skipReason: COMPOSE_SKIP });
    expect(by.get(plain.id)!.status).toBe('TODO');
    expect(Object.keys(by.get(plain.id)!)).not.toContain('skipReason');
  });
});

/* ================================================================== */
/* The screens' lists                                                  */
/* ================================================================== */

describe('10. the LinkedIn and Facebook screens show an unticked push as "skipped in Compose"', () => {
  const liApp = (over: Record<string, unknown> = {}) =>
    createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 }, linkedin: { enabled: () => true, clock: () => NOW, portals: () => ({ [PORTAL]: LI_PAGES }), postFrom: () => ({ [LI_T]: FROM }), worker: liDeps(), ...over } });
  const fbApp = (over: Record<string, unknown> = {}) =>
    createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 }, facebook: { enabled: () => true, clock: () => NOW, portals: () => ({ [PORTAL]: FB }), postFrom: () => FROM, allPushesFrom: () => FROM, worker: fbDeps(), ...over } });
  const liGet = (app: ReturnType<typeof createApp>, page: string) => request(app).get(`/api/linkedin/posts?date=${DAY_STR}&page=${page}`).set(BEARER);

  it('LinkedIn: SKIPPED + skipReason on that page BEFORE any worker tick, and the same after it; the other pages are unaffected; no action on it', async () => {
    const c = await camp('scr-li', at(NOW, -30), { skip: [linkedinSkipKey(LI_A)] });
    for (const afterTick of [false, true]) {
      if (afterTick) await runLinkedInTick(liDeps());
      const a = await liGet(liApp(), LI_A);
      expect(a.status).toBe(200);
      expect(a.body.rows).toHaveLength(1);
      expect(a.body.rows[0]).toMatchObject({ campaignId: c.id, status: 'SKIPPED', skipReason: COMPOSE_SKIP, error: null });
      expect(a.body.counts).toMatchObject({ skipped: 1, waiting: 0, all: 1 });
      const t = await liGet(liApp(), LI_T);
      expect(t.body.rows[0].status).toBe(afterTick ? 'POSTED' : 'WAITING');
      expect(Object.keys(t.body.rows[0])).not.toContain('skipReason');
    }
    // the row has an id once the worker wrote it, but Retry / Skip refuse it
    const row = (await liRows(LI_A))[0];
    const rr = await request(liApp()).post(`/api/linkedin/posts/${row.id}/retry`).set(BEARER);
    const sk = await request(liApp()).post(`/api/linkedin/posts/${row.id}/skip`).set(BEARER);
    expect([rr.status, sk.status]).toEqual([409, 409]);
  });

  it('LinkedIn: a later push of the same URL shows as an ordinary row next to it, under both rules', async () => {
    const url = articleUrl('scr-li-same');
    const first = await camp('scr-l1', at(NOW, -40), { url, skip: [linkedinSkipKey(LI_A)] });
    const later = await camp('scr-l2', at(NOW, -20), { url });
    for (const rule of [FROM, null]) {
      const a = await liGet(liApp({ allPushesFrom: () => rule }), LI_A);
      expect(a.body.rows.map((r: { campaignId: string; status: string }) => [r.campaignId, r.status])).toEqual([[first.id, 'SKIPPED'], [later.id, 'WAITING']]);
    }
  });

  it('Facebook: SKIPPED + skipReason before and after the worker; a later push of the same URL is an ordinary row', async () => {
    const url = articleUrl('scr-fb');
    const first = await camp('scr-f1', at(NOW, -40), { url, skip: [facebookSkipKey(FB)] });
    const later = await camp('scr-f2', at(NOW, -20), { url });
    for (const afterTick of [false, true]) {
      if (afterTick) await runFacebookTick(fbDeps({ allPushesFrom: FROM }));
      const r = await request(fbApp()).get(`/api/facebook/posts?date=${DAY_STR}`).set(BEARER);
      expect(r.status).toBe(200);
      const by = new Map<string, { status: string; skipReason?: string }>(r.body.rows.map((x: { campaignId: string; status: string; skipReason?: string }) => [x.campaignId, x]));
      expect(by.get(first.id)).toMatchObject({ status: 'SKIPPED', skipReason: COMPOSE_SKIP });
      expect(by.get(later.id)!.status).toBe(afterTick ? 'POSTED' : 'WAITING');
      expect(Object.keys(by.get(later.id)!)).not.toContain('skipReason');
    }
  });
});

describe('10. the Campaigns Channels marks read SKIPPED with a reason', () => {
  const REAL = env.rss.portal;
  const mine = new Set<string>();
  const seedReal = async (key: string, skip: string[]) => {
    const c = await prisma.campaign.create({
      data: { portal: REAL, title: `Csk ${key}`, body: 'b', url: `https://www.taxscan.in/gst/csk-${key}-${RUN}`, target: { type: 'all' } as Prisma.InputJsonValue, status: 'SENT', lastSentAt: new Date(Date.now() - 60_000), socialSkip: skip },
    });
    mine.add(c.id);
    return c;
  };
  afterAll(async () => {
    await prisma.linkedInPost.deleteMany({ where: { campaignId: { in: [...mine] } } });
    await prisma.facebookPost.deleteMany({ where: { campaignId: { in: [...mine] } } });
    await prisma.whatsAppPost.deleteMany({ where: { campaignId: { in: [...mine] } } });
    await prisma.campaign.deleteMany({ where: { id: { in: [...mine] } } });
  });

  it('a channel unticked for the push reads SKIPPED (with the reason); a channel not unticked reads as ever', async () => {
    env.whatsapp.queueEnabled = true;
    env.linkedin.enabled = true;
    env.linkedin.postFrom = new Date(Date.now() - 6 * 3600_000);
    env.facebook.enabled = true;
    env.facebook.postFrom = new Date(Date.now() - 6 * 3600_000);
    const all = await seedReal('all', ['linkedin:taxscan', 'facebook:taxscan', 'whatsapp']);
    const onlyWa = await seedReal('wa', ['whatsapp']);
    const none = await seedReal('none', []);
    const other = await seedReal('other', ['linkedin:academy', 'facebook:academy']); // not the Taxscan page: no mark of its own, so unchanged
    const by = new Map((await listCampaigns(600)).map((r) => [r.id, r]));
    const a = by.get(all.id)!;
    expect(a.channels).toMatchObject({ whatsapp: 'SKIPPED', linkedin: 'SKIPPED', facebook: 'SKIPPED' });
    expect(a.channelDetails?.linkedin).toMatchObject({ skipReason: COMPOSE_SKIP, error: null, postUrl: null });
    expect(a.channelDetails?.facebook).toMatchObject({ skipReason: COMPOSE_SKIP, postUrl: null });
    expect(a.channelDetails?.whatsapp).toMatchObject({ skipReason: COMPOSE_SKIP, by: null });
    expect(by.get(onlyWa.id)!.channels).toMatchObject({ whatsapp: 'SKIPPED', linkedin: 'PENDING', facebook: 'PENDING' });
    expect(by.get(none.id)!.channels).toMatchObject({ whatsapp: 'TODO', linkedin: 'PENDING', facebook: 'PENDING' });
    expect(by.get(other.id)!.channels).toMatchObject({ whatsapp: 'TODO', linkedin: 'PENDING', facebook: 'PENDING' });
    expect(Object.keys(by.get(none.id)!.channelDetails ?? {})).not.toContain('linkedin');
  });

  it('wins over a row another push of the same article left: an article posted earlier, then a Compose push that unticked LinkedIn', async () => {
    env.linkedin.enabled = true;
    env.linkedin.postFrom = new Date(Date.now() - 6 * 3600_000);
    const first = await seedReal('earlier', []);
    await prisma.linkedInPost.create({ data: { page: 'taxscan', articleKey: articleKey(first), campaignId: first.id, status: 'POSTED', attempts: 1, postedAt: new Date(), linkedinPostId: 'urn:li:share:9' } });
    const again = await prisma.campaign.create({
      data: { portal: REAL, title: 'Csk again', body: 'b', url: first.url, target: { type: 'all' }, status: 'SENT', lastSentAt: new Date(Date.now() - 30_000), socialSkip: ['linkedin:taxscan'] },
    });
    mine.add(again.id);
    const by = new Map((await listCampaigns(600)).map((r) => [r.id, r]));
    expect(by.get(first.id)!.channels?.linkedin).toBe('POSTED');
    expect(by.get(again.id)!.channels?.linkedin).toBe('SKIPPED');
  });
});
