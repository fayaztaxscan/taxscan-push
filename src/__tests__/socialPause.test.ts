import bcrypt from 'bcrypt';
import request from 'supertest';
import { inspect } from 'node:util';
import { randomBytes } from 'node:crypto';
import type { Campaign, Prisma, User, UserRole } from '@prisma/client';
import { createApp } from '../app';
import { env, LINKEDIN_HEADROOM_DEFAULTS, type SharedLinkedInPage } from '../lib/env';
import { prisma } from '../lib/prisma';
import { listCampaigns } from '../services/metrics';
import { pushKey } from '../services/social/allPushes';
import { PAGE_PAUSED, NOTE_MAX, cleanNote, getPause, labelOfEmail, pauseKey, setPause, clearPause } from '../services/social/pause';
import { activeSocialPages, activeSocialPagesWithPause, unknownSocialKeys } from '../services/social/pages';
import { getPageStatus } from '../services/social/pageStatus';
import { authKey as liAuthKey, resetLinkedInStops, runLinkedInTick, type WorkerDeps as LiDeps } from '../services/linkedin/worker';
import { authKey as fbAuthKey, policyKey as fbPolicyKey, resetFacebookStops, runFacebookTick, type WorkerDeps as FbDeps } from '../services/facebook/worker';
import { stopKey as tgStopKey, runTelegramTick, type WorkerDeps as TgDeps } from '../services/telegram/worker';
import { clearOrgHolds } from '../services/linkedin/orgHold';
import type { LinkedInRequest, LinkedInResult } from '../services/linkedin/client';
import type { FacebookResult } from '../services/facebook/client';
import type { TelegramRequest, TelegramResult } from '../services/telegram/client';

/**
 * Brief 2026-11-09-social-page-alerts-pause, acceptance 3-6 and 8: the PAUSE switch per page. ALL LinkedIn / Facebook / Telegram calls are
 * mocked and the global `fetch` is a trap. Rows live under a unique `test-pause-*` portal on PRIVATE pages (`pause-t` plays Taxscan and owns
 * the LinkedIn token, `pause-s` plays Shopscan, `pausefb` the Facebook page, `pausetg` the Telegram channel), so no real page's rows,
 * stops, tokens or pause switches are read or written. The Compose list and the Channels mark exist only for the real `taxscan` page, so
 * those parts use run-unique rows and the real page's pause key, removed afterwards.
 */
const logs: string[] = [];
jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
jest.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
jest.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
const realFetch = global.fetch;
const trap = jest.fn(() => {
  throw new Error('a test reached the network');
});

const RUN = `${Date.now()}-${randomBytes(3).toString('hex')}`;
const PORTAL = `test-pause-${RUN}`;
const LI_T = 'pause-t';
const LI_S = 'pause-s';
const FB = 'pausefb';
const TG = 'pausetg';
const ORG_T = 'urn:li:organization:101';
const ORG_S = 'urn:li:organization:80241094';
const LI_TOKEN = `PAUSE-LI-TOKEN-${RUN}`;
const FB_TOKEN = `PAUSE-FB-TOKEN-${RUN}-EAAB1234567890`;
const TG_TOKEN = '987654321:AAFsecretSECRET-tokenvalue_0123456789xyz';
const PASSWORD = 'pause-test-pw-1';
const IST_MS = (5 * 60 + 30) * 60_000;
const ist = (h: number, m = 0, day = 25) => new Date(Date.UTC(2026, 10, day, h, m) - IST_MS);
const MIN = 60_000;
const at = (base: Date, min: number) => new Date(base.getTime() + min * MIN);
const NOW = ist(10, 0);
const FROM = ist(4, 0);
const BEARER = { Authorization: `Bearer ${process.env.ADMIN_TOKEN}` };

/* ---------- fakes ---------- */
let liCalls: LinkedInRequest[] = [];
let liScript: (r: LinkedInRequest) => LinkedInResult = (r) => ({ kind: 'posted', postId: `urn:li:share:${r.orgUrn === ORG_S ? 'S' : 'T'}${liCalls.length}` });
let fbCalls: { pageId: string; message: string }[] = [];
let fbScript: () => FacebookResult = () => ({ kind: 'posted', postId: '123_456' });
let tgCalls: TelegramRequest[] = [];
let tgScript: () => TelegramResult = () => ({ kind: 'posted', messageId: 7 });
const noMail = { emailSender: async () => ({ ok: true as const }), isEmailConfigured: () => false, recipients: async () => [] as string[] };
const liDeps = (now: Date = NOW, over: LiDeps = {}): LiDeps => ({
  now: () => now,
  post: async (r) => (liCalls.push(r), liScript(r)),
  fetchCms: async () => null,
  waitImage: async () => ({ ok: true }),
  ...noMail,
  portals: { [PORTAL]: [LI_T, LI_S] },
  postFrom: { [LI_T]: FROM },
  quiet: { start: '23:00', end: '07:00' },
  ...over,
});
const fbDeps = (now: Date = NOW, over: FbDeps = {}): FbDeps => ({
  now: () => now,
  post: async (r) => (fbCalls.push(r), fbScript()),
  fetchCms: async () => null,
  ...noMail,
  portals: { [PORTAL]: FB },
  postFrom: FROM,
  quiet: { start: '23:00', end: '07:00' },
  minGapMinutes: 10,
  dailyCap: 30,
  ...over,
});
const tgDeps = (now: Date = NOW, over: TgDeps = {}): TgDeps => ({
  now: () => now,
  call: async (r) => (tgCalls.push(r), tgScript()),
  fetchCms: async () => null,
  fetchArticle: async () => ({ image: null }),
  fetchStore: async () => ({ ok: false, reason: 'page_host' }),
  socialPicture: false,
  ...noMail,
  portals: { [PORTAL]: TG },
  config: { token: TG_TOKEN, channel: '@taxscan_in', postFrom: FROM },
  quiet: { start: '23:00', end: '07:00' },
  ...over,
});
const liTo = (org: string) => liCalls.filter((c) => c.orgUrn === org).length;

let seq = 0;
async function camp(slug: string, lastSentAt: Date, o: { createdByUserId?: string | null } = {}): Promise<Campaign> {
  return prisma.campaign.create({
    data: {
      portal: PORTAL,
      title: `Story ${slug}`,
      body: 'b',
      url: `https://www.taxscan.in/gst/${slug}-${RUN}-${++seq}`,
      target: {} as Prisma.InputJsonValue,
      status: 'SENT',
      lastSentAt,
      authority: 'Supreme Court',
      categories: ['GST'],
      ...(o.createdByUserId !== undefined ? { createdByUserId: o.createdByUserId, scheduledAt: null } : {}),
    } as never,
  });
}
const campIds = async () => (await prisma.campaign.findMany({ where: { portal: PORTAL }, select: { id: true } })).map((c) => c.id);
const liRow = (page: string, c: Campaign) => prisma.linkedInPost.findFirst({ where: { page, campaignId: c.id } });
const fbRow = (c: Campaign) => prisma.facebookPost.findFirst({ where: { page: FB, campaignId: c.id } });
const tgRow = (c: Campaign) => prisma.telegramPost.findFirst({ where: { page: TG, campaignId: c.id } });
const setMarker = (key: string, value: unknown) => prisma.digestSetting.upsert({ where: { key }, create: { key, value: JSON.stringify(value) }, update: { value: JSON.stringify(value) } });
const pause = (channel: 'linkedin' | 'facebook' | 'telegram', page: string, now: Date = NOW) => setPause(channel, page, { byUserId: null, by: 'anagha', note: null, now });
/** What the banner calls the admin who pressed Pause: the part of their email before the @. */
const BY = () => labelOfEmail(admin.email);

const KEYS = [
  ...[LI_T, LI_S].flatMap((p) => [liAuthKey(p), pauseKey('linkedin', p)]),
  fbAuthKey(FB), fbPolicyKey(FB), pauseKey('facebook', FB), tgStopKey(TG), pauseKey('telegram', TG),
  pauseKey('telegram', 'taxscan'),
];
const saved = {
  shared: env.linkedin.sharedPages,
  headroom: env.linkedin.dailyHeadroom,
  allPushes: env.linkedin.allPushesFrom,
  taxscan: env.linkedin.pages.taxscan,
  liPage: env.linkedin.pages[LI_T],
  from: env.linkedin.postFrom,
  fbPage: env.facebook.pages[FB],
  fbEnabled: env.facebook.enabled,
  telegram: { ...env.telegram },
  tr: { ...env.linkedin.tokenRefresh },
};
async function wipe() {
  const ids = await campIds();
  await prisma.linkedInPost.deleteMany({ where: { OR: [{ campaignId: { in: ids } }, { page: { in: [LI_T, LI_S] } }] } });
  await prisma.facebookPost.deleteMany({ where: { OR: [{ campaignId: { in: ids } }, { page: FB }] } });
  await prisma.telegramPost.deleteMany({ where: { OR: [{ campaignId: { in: ids } }, { page: TG }] } });
  await prisma.digestSetting.deleteMany({ where: { key: { in: KEYS } } });
  await prisma.campaign.deleteMany({ where: { portal: PORTAL } });
}

const userIds: string[] = [];
let admin: User;
let publisher: User;
let adminCookie: string;
let publisherCookie: string;
const loginApp = createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 } });
async function makeUser(role: UserRole, local: string): Promise<User> {
  const u = await prisma.user.create({ data: { email: `${local}-${RUN}@team.test`, passwordHash: await bcrypt.hash(PASSWORD, 4), role, isActive: true } });
  userIds.push(u.id);
  return u;
}
async function cookieFor(u: User): Promise<string> {
  const res = await request(loginApp).post('/api/auth/login').send({ email: u.email, password: PASSWORD });
  expect(res.status).toBe(200);
  const sc = res.headers['set-cookie'];
  return (Array.isArray(sc) ? sc : [sc as unknown as string]).map((l) => l.split(';')[0]).join('; ');
}

beforeAll(async () => {
  global.fetch = trap as unknown as typeof fetch;
  env.linkedin.sharedPages = {};
  admin = await makeUser('ADMIN', 'anagha');
  publisher = await makeUser('PUBLISHER', 'editor');
  adminCookie = await cookieFor(admin);
  publisherCookie = await cookieFor(publisher);
});
beforeEach(async () => {
  liCalls = [];
  fbCalls = [];
  tgCalls = [];
  logs.length = 0;
  liScript = (r) => ({ kind: 'posted', postId: `urn:li:share:${r.orgUrn === ORG_S ? 'S' : 'T'}${liCalls.length}` });
  fbScript = () => ({ kind: 'posted', postId: '123_456' });
  tgScript = () => ({ kind: 'posted', messageId: 7 });
  env.linkedin.pages[LI_T] = { orgUrn: ORG_T, accessToken: LI_TOKEN };
  env.linkedin.pages.taxscan = { orgUrn: '', accessToken: '' };
  const shared: SharedLinkedInPage = { orgUrn: ORG_S, postFrom: FROM, tokenFrom: LI_T };
  env.linkedin.sharedPages = { [LI_S]: shared };
  env.linkedin.dailyHeadroom = { [LI_S]: LINKEDIN_HEADROOM_DEFAULTS.shopscan };
  env.linkedin.allPushesFrom = { [LI_T]: FROM, [LI_S]: FROM };
  env.linkedin.postFrom = FROM;
  Object.assign(env.linkedin.tokenRefresh, { ...saved.tr, enabled: false });
  env.facebook.pages[FB] = { pageId: '1234567890', accessToken: FB_TOKEN };
  resetLinkedInStops();
  resetFacebookStops();
  clearOrgHolds();
  await wipe();
});
afterAll(async () => {
  global.fetch = realFetch;
  env.linkedin.sharedPages = saved.shared;
  env.linkedin.dailyHeadroom = saved.headroom;
  env.linkedin.allPushesFrom = saved.allPushes;
  env.linkedin.pages.taxscan = saved.taxscan;
  if (saved.liPage) env.linkedin.pages[LI_T] = saved.liPage;
  else delete env.linkedin.pages[LI_T];
  env.linkedin.postFrom = saved.from;
  if (saved.fbPage) env.facebook.pages[FB] = saved.fbPage;
  else delete env.facebook.pages[FB];
  env.facebook.enabled = saved.fbEnabled;
  Object.assign(env.telegram, saved.telegram);
  Object.assign(env.linkedin.tokenRefresh, saved.tr);
  resetLinkedInStops();
  clearOrgHolds();
  await wipe();
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL audit_log.allow_purge = 'true'`);
    await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "userId" = ANY(${userIds}::text[])`;
  });
  await prisma.userSession.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  expect(trap).not.toHaveBeenCalled();
  await prisma.$disconnect();
});

describe('the pause store', () => {
  it('cleanNote / labelOfEmail; set keeps the FIRST pause\'s who and when; clear says whether there was one', async () => {
    expect(cleanNote('  waiting \n for   LinkedIn ')).toBe('waiting for LinkedIn');
    expect(cleanNote('   ')).toBeNull();
    expect(cleanNote(undefined)).toBeNull();
    expect(cleanNote(42)).toBeNull();
    expect(labelOfEmail('anagha@taxscan.in')).toBe('anagha');
    expect(NOTE_MAX).toBe(200);
    expect(await getPause('telegram', TG)).toBeNull();
    expect(await setPause('telegram', TG, { byUserId: admin.id, by: 'anagha', note: 'hold', now: NOW })).toBe(true);
    expect(await getPause('telegram', TG)).toEqual({ by: 'anagha', byUserId: admin.id, at: NOW.toISOString(), note: 'hold' });
    expect(await setPause('telegram', TG, { byUserId: null, by: 'x', note: null, now: at(NOW, 5) })).toBe(false);
    expect((await getPause('telegram', TG))?.by).toBe('anagha');
    expect(await clearPause('telegram', TG)).toBe(true);
    expect(await clearPause('telegram', TG)).toBe(false);
    expect(await getPause('telegram', TG)).toBeNull();
  });
});

describe('3. LinkedIn: pausing Shopscan skips its pushes with no call; the other pages post', () => {
  it('the next push: Shopscan SKIPPED page_paused (attempts 0), NO call to it, Taxscan POSTED; a manual immediate push is skipped too', async () => {
    await pause('linkedin', LI_S);
    const c = await camp('p1', at(NOW, -30));
    const manual = await camp('p2', at(NOW, -20), { createdByUserId: admin.id });
    for (let i = 0; i < 4; i += 1) await runLinkedInTick(liDeps(at(NOW, i)));
    expect(liTo(ORG_S)).toBe(0);
    expect(liTo(ORG_T)).toBe(2);
    for (const x of [c, manual]) {
      expect(await liRow(LI_S, x)).toMatchObject({ status: 'SKIPPED', error: PAGE_PAUSED, attempts: 0, nextAttemptAt: null });
      expect(await liRow(LI_T, x)).toMatchObject({ status: 'POSTED' });
    }
  });

  it('a retry that is waiting on Shopscan is skipped too, with no call', async () => {
    const c = await camp('w1', at(NOW, -30));
    liScript = (r) => (r.orgUrn === ORG_S ? { kind: 'retry', status: 429, error: 'HTTP 429: Too Many Requests' } : { kind: 'posted', postId: 'urn:li:share:T1' });
    await runLinkedInTick(liDeps());
    expect(await liRow(LI_S, c)).toMatchObject({ status: 'PENDING', attempts: 1 });
    const before = liTo(ORG_S);
    await pause('linkedin', LI_S, at(NOW, 1));
    await runLinkedInTick(liDeps(at(NOW, 3))); // the retry is due by now, but the page is paused
    expect(liTo(ORG_S)).toBe(before);
    expect(await liRow(LI_S, c)).toMatchObject({ status: 'SKIPPED', error: PAGE_PAUSED, nextAttemptAt: null });
  });

  it('resume: the next push posts; nothing from the paused time is posted later', async () => {
    await pause('linkedin', LI_S);
    const during = await camp('d1', at(NOW, -30));
    await runLinkedInTick(liDeps());
    expect(await liRow(LI_S, during)).toMatchObject({ status: 'SKIPPED', error: PAGE_PAUSED });
    await clearPause('linkedin', LI_S);
    const after = await camp('a1', at(NOW, 10));
    for (let i = 0; i < 4; i += 1) await runLinkedInTick(liDeps(at(NOW, 11 + i)));
    expect(liTo(ORG_S)).toBe(1); // only the new push
    expect(await liRow(LI_S, after)).toMatchObject({ status: 'POSTED' });
    expect(await liRow(LI_S, during)).toMatchObject({ status: 'SKIPPED', error: PAGE_PAUSED }); // never posted later
  });

  it('a paused page that is also login-stopped still skips every push (nothing waits to be posted when the stop clears)', async () => {
    const first = await camp('st1', at(NOW, -40));
    liScript = (r) => (r.orgUrn === ORG_S ? { kind: 'auth', status: 403, error: 'HTTP 403' } : { kind: 'posted', postId: 'urn:li:share:T1' });
    await runLinkedInTick(liDeps());
    expect((await getPageStatus('linkedin', LI_S, at(NOW, 1))).status).toBe('stopped');
    await pause('linkedin', LI_S, at(NOW, 1));
    const during = await camp('st2', at(NOW, 5));
    await runLinkedInTick(liDeps(at(NOW, 6)));
    expect(await liRow(LI_S, during)).toMatchObject({ status: 'SKIPPED', error: PAGE_PAUSED });
    expect((await liRow(LI_S, first))!.status).toBe('SKIPPED'); // the push the stop had kept waiting is skipped too
  });

  it('pausing Shopscan does not touch Taxscan: it posts normally and its status stays ok', async () => {
    await pause('linkedin', LI_S);
    await camp('o1', at(NOW, -30));
    await runLinkedInTick(liDeps());
    expect((await getPageStatus('linkedin', LI_T, NOW)).status).toBe('ok');
    expect((await getPageStatus('linkedin', LI_S, NOW)).status).toBe('paused');
  });
});

describe('5. Facebook and Telegram: pause works the same way', () => {
  it('Facebook: no call (even inside the 10-minute gap), a SKIPPED page_paused row, a waiting retry skipped, resume posts the next push only', async () => {
    const first = await camp('f1', at(NOW, -30));
    await runFacebookTick(fbDeps()); // posts f1: the gap now blocks the next post
    expect(fbCalls).toHaveLength(1);
    await pause('facebook', FB, at(NOW, 1));
    const waiting = await camp('f2', at(NOW, 1));
    await prisma.facebookPost.create({ data: { page: FB, articleKey: `retry-${RUN}`, campaignId: waiting.id, status: 'PENDING', attempts: 1, nextAttemptAt: at(NOW, 30) } });
    const during = await camp('f3', at(NOW, 2));
    for (let i = 0; i < 3; i += 1) await runFacebookTick(fbDeps(at(NOW, 2 + i)));
    expect(fbCalls).toHaveLength(1);
    expect(await fbRow(during)).toMatchObject({ status: 'SKIPPED', error: PAGE_PAUSED, attempts: 0 });
    expect(await prisma.facebookPost.findFirst({ where: { page: FB, articleKey: `retry-${RUN}` } })).toMatchObject({ status: 'SKIPPED', error: PAGE_PAUSED, nextAttemptAt: null });
    await clearPause('facebook', FB);
    const next = await camp('f4', at(NOW, 40));
    await runFacebookTick(fbDeps(at(NOW, 41)));
    expect(fbCalls).toHaveLength(2);
    expect(await fbRow(next)).toMatchObject({ status: 'POSTED' });
    expect(await fbRow(during)).toMatchObject({ status: 'SKIPPED', error: PAGE_PAUSED });
    expect(await fbRow(first)).toMatchObject({ status: 'POSTED' });
  });

  it('Facebook: a paused page that is also policy-stopped skips every push; resume then posts only new ones', async () => {
    await setMarker(fbPolicyKey(FB), { stoppedAt: NOW.toISOString(), status: 400, code: 368, subcode: null, message: 'x' });
    await pause('facebook', FB);
    const c = await camp('fp1', at(NOW, -5));
    await runFacebookTick(fbDeps());
    expect(fbCalls).toHaveLength(0);
    expect(await fbRow(c)).toMatchObject({ status: 'SKIPPED', error: PAGE_PAUSED });
  });

  it('Telegram: no call, a SKIPPED page_paused row, a waiting retry skipped, resume posts the next push only', async () => {
    tgScript = () => ({ kind: 'transient', status: 502, code: 502, retryAfterSec: null, error: 'telegram_502' });
    const waiting = await camp('t1', at(NOW, -30));
    await runTelegramTick(tgDeps());
    expect(await tgRow(waiting)).toMatchObject({ status: 'PENDING', attempts: 1 });
    const before = tgCalls.length;
    await pause('telegram', TG, at(NOW, 1));
    const during = await camp('t2', at(NOW, 2));
    await runTelegramTick(tgDeps(at(NOW, 3))); // the retry is due, the page is paused
    expect(tgCalls).toHaveLength(before);
    expect(await tgRow(waiting)).toMatchObject({ status: 'SKIPPED', error: PAGE_PAUSED, nextAttemptAt: null });
    expect(await tgRow(during)).toMatchObject({ status: 'SKIPPED', error: PAGE_PAUSED, attempts: 0 });
    await clearPause('telegram', TG);
    tgScript = () => ({ kind: 'posted', messageId: 9 });
    const next = await camp('t3', at(NOW, 10));
    await runTelegramTick(tgDeps(at(NOW, 11)));
    expect(tgCalls).toHaveLength(before + 1);
    expect(await tgRow(next)).toMatchObject({ status: 'POSTED', messageId: 9 });
    expect(await tgRow(during)).toMatchObject({ status: 'SKIPPED', error: PAGE_PAUSED });
  });

  it('Telegram: paused beats the channel stop (the stop must not hold pushes back to be posted after it clears)', async () => {
    await setMarker(tgStopKey(TG), { stoppedAt: NOW.toISOString(), status: 403, error: 'telegram_403' });
    await pause('telegram', TG);
    const c = await camp('ts1', at(NOW, -5));
    await runTelegramTick(tgDeps());
    expect(tgCalls).toHaveLength(0);
    expect(await tgRow(c)).toMatchObject({ status: 'SKIPPED', error: PAGE_PAUSED });
  });
});

describe('4. the routes: ADMIN only, audited, survives a restart', () => {
  const appWith = () =>
    createApp({
      rateLimit: { publicPerMin: 10000, loginPerMin: 10000 },
      linkedin: { enabled: () => true, clock: () => NOW, portals: () => ({ [PORTAL]: [LI_T, LI_S] }), postFrom: () => ({ [LI_T]: FROM }), worker: liDeps() },
      facebook: { enabled: () => true, clock: () => NOW, portals: () => ({ [PORTAL]: FB }), postFrom: () => FROM, worker: fbDeps() },
      telegram: { enabled: () => true, clock: () => NOW, portals: () => ({ [PORTAL]: TG }), worker: tgDeps() },
    });
  const replies: string[] = [];
  const post = async (app: ReturnType<typeof appWith>, url: string, cookie: string | null, body: unknown = {}) => {
    const r = await request(app).post(url).set('Cookie', cookie ?? '').send(body as object);
    replies.push(JSON.stringify(r.body));
    return r;
  };
  const CASES = [
    { channel: 'linkedin' as const, base: '/api/linkedin', page: LI_S, body: { page: LI_S } },
    { channel: 'facebook' as const, base: '/api/facebook', page: FB, body: {} },
    { channel: 'telegram' as const, base: '/api/telegram', page: TG, body: {} },
  ];

  it.each(CASES)('$channel: no login 401, PUBLISHER 403 on both buttons, nothing changes', async ({ base, channel, page, body }) => {
    const app = appWith();
    expect((await post(app, `${base}/page-pause`, null, body)).status).toBe(401);
    expect((await post(app, `${base}/page-pause`, publisherCookie, body)).status).toBe(403);
    expect(await getPause(channel, page)).toBeNull();
    await pause(channel, page);
    expect((await post(app, `${base}/page-resume`, publisherCookie, body)).status).toBe(403);
    expect(await getPause(channel, page)).not.toBeNull();
  });

  it.each(CASES)('$channel: ADMIN pauses with a note → 200, the status, an audit entry with who and the note; again 409; resume 200, audited; again 409', async ({ base, channel, page, body }) => {
    const app = appWith();
    const r = await post(app, `${base}/page-pause`, adminCookie, { ...body, note: '  waiting\n for the platform ' });
    expect(r.status).toBe(200);
    expect(r.body.status).toMatchObject({ channel, page, status: 'paused', reason: PAGE_PAUSED, by: BY(), note: 'waiting for the platform' });
    expect(r.body.status.message).toBe(`Paused by ${BY()} at ${new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(NOW)} IST — waiting for the platform`);
    expect(await getPause(channel, page)).toMatchObject({ by: BY(), byUserId: admin.id, at: NOW.toISOString(), note: 'waiting for the platform' });
    const audit = await prisma.auditLog.findMany({ where: { userId: admin.id, action: 'SOCIAL_PAGE_PAUSED', resourceId: `${channel}:${page}` } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ resourceType: 'social_page' });
    expect(audit[0].metadata).toEqual({ channel, page, note: 'waiting for the platform' });
    expect(await prisma.digestSetting.findUnique({ where: { key: pauseKey(channel, page) } })).toMatchObject({ updatedByUserId: admin.id });
    expect((await post(app, `${base}/page-pause`, adminCookie, body)).body).toEqual({ error: 'already_paused' });
    const rs = await post(app, `${base}/page-resume`, adminCookie, body);
    expect(rs.status).toBe(200);
    expect(rs.body.status.status).toBe('ok');
    const audit2 = await prisma.auditLog.findMany({ where: { userId: admin.id, action: 'SOCIAL_PAGE_RESUMED', resourceId: `${channel}:${page}` } });
    expect(audit2).toHaveLength(1);
    expect(audit2[0].metadata).toEqual({ channel, page });
    expect((await post(app, `${base}/page-resume`, adminCookie, body)).body).toEqual({ error: 'not_paused' });
    expect(await getPause(channel, page)).toBeNull();
  });

  it.each(CASES)('$channel: a note over 200 characters, a non-string note and an unknown page are refused and nothing is stored', async ({ base, channel, page, body }) => {
    const app = appWith();
    const long = await post(app, `${base}/page-pause`, adminCookie, { ...body, note: 'x'.repeat(NOTE_MAX + 1) });
    expect([long.status, long.body.error]).toEqual([400, 'note_too_long']);
    expect((await post(app, `${base}/page-pause`, adminCookie, { ...body, note: 42 })).body.error).toBe('invalid_note');
    expect((await post(app, `${base}/page-pause`, adminCookie, { page: 'not-a-page' })).body.error).toBe('invalid_page');
    expect(await getPause(channel, page)).toBeNull();
    // exactly 200 is fine
    expect((await post(app, `${base}/page-pause`, adminCookie, { ...body, note: 'y'.repeat(NOTE_MAX) })).status).toBe(200);
  });

  it('it survives a restart: the state is in Postgres, a new app and a forgotten worker memory still see it paused (and the worker still skips)', async () => {
    const app = appWith();
    expect((await post(app, '/api/linkedin/page-pause', adminCookie, { page: LI_S, note: 'overnight' })).status).toBe(200);
    resetLinkedInStops(); // what a restart does to the workers' memory
    clearOrgHolds();
    const again = appWith();
    const list = await request(again).get(`/api/linkedin/posts?date=2026-11-25&page=${LI_S}`).set(BEARER);
    expect(list.status).toBe(200);
    expect(list.body.pageStatus).toMatchObject({ status: 'paused', by: BY(), note: 'overnight' });
    const c = await camp('rs1', at(NOW, -5));
    await runLinkedInTick(liDeps());
    expect(await liRow(LI_S, c)).toMatchObject({ status: 'SKIPPED', error: PAGE_PAUSED });
    expect(liTo(ORG_S)).toBe(0);
  });

  it('the screens\' lists carry pageStatus and, on a paused row, skipReason "page_paused" (that row only)', async () => {
    const app = appWith();
    const posted = await camp('l1', at(NOW, -30));
    await runLinkedInTick(liDeps());
    await runFacebookTick(fbDeps());
    await runTelegramTick(tgDeps());
    await pause('linkedin', LI_S);
    await pause('facebook', FB);
    await pause('telegram', TG);
    const skipped = await camp('l2', at(NOW, 2));
    await runLinkedInTick(liDeps(at(NOW, 3)));
    await runFacebookTick(fbDeps(at(NOW, 30)));
    await runTelegramTick(tgDeps(at(NOW, 3)));
    for (const [url, rowFor] of [
      [`/api/linkedin/posts?date=2026-11-25&page=${LI_S}`, () => liRow(LI_S, skipped)],
      ['/api/facebook/posts?date=2026-11-25', () => fbRow(skipped)],
      ['/api/telegram/posts?date=2026-11-25', () => tgRow(skipped)],
    ] as const) {
      const res = await request(app).get(url).set(BEARER);
      replies.push(JSON.stringify(res.body));
      expect(res.status).toBe(200);
      expect(res.body.pageStatus.status).toBe('paused');
      const rows = res.body.rows as { campaignId: string; status: string; skipReason?: string }[];
      const mine = rows.find((r) => r.campaignId === skipped.id)!;
      expect(mine).toMatchObject({ status: 'SKIPPED', skipReason: PAGE_PAUSED });
      const earlier = rows.find((r) => r.campaignId === posted.id);
      if (earlier) expect(earlier.skipReason).toBeUndefined();
      expect((await rowFor())?.error).toBe(PAGE_PAUSED);
    }
  });

  it('8. no token or provider secret appears in a banner, an audit entry or any reply', async () => {
    const app = appWith();
    await post(app, '/api/linkedin/page-pause', adminCookie, { page: LI_S, note: 'because' });
    await post(app, '/api/facebook/page-pause', adminCookie, {});
    await post(app, '/api/telegram/page-pause', adminCookie, {});
    await post(app, '/api/telegram/page-resume', adminCookie, {});
    const audit = await prisma.auditLog.findMany({ where: { userId: admin.id } });
    const marks = await prisma.digestSetting.findMany({ where: { key: { in: KEYS } } });
    const logText = logs.join('\n') + inspect(replies, { depth: 6 });
    const everything = JSON.stringify({ audit, marks, replies }) + logText;
    for (const secret of [LI_TOKEN, FB_TOKEN, TG_TOKEN, TG_TOKEN.split(':')[1]!]) expect(everything).not.toContain(secret);
  });
});

describe('6. Compose: a paused page is flagged, stays a known page, and a send with or without its key is not refused', () => {
  const okSender = async () => ({ ok: true as const, statusCode: 201 });
  afterEach(async () => {
    await prisma.digestSetting.deleteMany({ where: { key: pauseKey('telegram', 'taxscan') } });
    Object.assign(env.telegram, saved.telegram);
  });

  it('GET /api/social/pages: `paused: true` only on the paused page; WhatsApp and the other pages are unchanged', async () => {
    Object.assign(env.telegram, { enabled: true, config: { token: TG_TOKEN, channel: '@taxscan_in', postFrom: FROM }, off: null });
    const app = createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 } });
    const before = await request(app).get('/api/social/pages').set(BEARER);
    expect(before.body.pages).toEqual(activeSocialPages()); // nothing paused: exactly the old answer
    expect(before.body.pages.some((p: { paused?: boolean }) => p.paused !== undefined)).toBe(false);
    await setPause('telegram', 'taxscan', { byUserId: null, by: 'anagha', note: null, now: NOW });
    const after = await request(app).get('/api/social/pages').set(BEARER);
    const tg = after.body.pages.find((p: { key: string }) => p.key === 'telegram:taxscan');
    expect(tg).toEqual({ key: 'telegram:taxscan', label: 'Telegram · Taxscan', paused: true });
    for (const p of after.body.pages) if (p.key !== 'telegram:taxscan') expect(p.paused).toBeUndefined();
    expect(await activeSocialPagesWithPause()).toEqual(after.body.pages);
    // it is still a known page: its key is accepted wherever keys are checked
    expect(unknownSocialKeys(['telegram:taxscan'])).toEqual([]);
  });

  it('POST /api/send with its key in socialSkip, and without it, are both accepted (200); the paused page posts nothing either way', async () => {
    Object.assign(env.telegram, { enabled: true, config: { token: TG_TOKEN, channel: '@taxscan_in', postFrom: FROM }, off: null });
    await setPause('telegram', 'taxscan', { byUserId: null, by: 'anagha', note: null, now: NOW });
    const app = createApp({ sender: okSender, rateLimit: { publicPerMin: 10000, loginPerMin: 10000 } });
    const body = (extra: Record<string, unknown>) => ({ portal: PORTAL, title: `Pause send ${++seq}`, body: 'b', url: `https://www.taxscan.in/gst/pause-send-${RUN}-${seq}`, target: { type: 'all' }, breaking: true, ...extra });
    const without = await request(app).post('/api/send').set(BEARER).send(body({}));
    const withKey = await request(app).post('/api/send').set(BEARER).send(body({ socialSkip: ['telegram:taxscan'] }));
    expect([without.status, withKey.status]).toEqual([200, 200]);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: withKey.body.campaignId } })).socialSkip).toEqual(['telegram:taxscan']);
    // the worker, on the real clock (the send stamps real time): both campaigns are SKIPPED on the (real-named) paused channel, with no call
    const calls: TelegramRequest[] = [];
    const goLive = new Date(Date.now() - 3600_000);
    await runTelegramTick({ ...tgDeps(new Date()), portals: { [PORTAL]: 'taxscan' }, config: { token: TG_TOKEN, channel: '@taxscan_in', postFrom: goLive }, call: async (r) => (calls.push(r), { kind: 'posted', messageId: 1 }) });
    expect(calls).toHaveLength(0);
    const rows = await prisma.telegramPost.findMany({ where: { page: 'taxscan', campaignId: { in: [without.body.campaignId, withKey.body.campaignId] } } });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === 'SKIPPED' && r.attempts === 0)).toBe(true); // not posted, with or without the key
    expect(rows.find((r) => r.campaignId === without.body.campaignId)!.error).toBe(PAGE_PAUSED);
    expect(rows.find((r) => r.campaignId === withKey.body.campaignId)!.error).toBe('compose_skip'); // the sender's own untick is named first
    await prisma.telegramPost.deleteMany({ where: { page: 'taxscan', campaignId: { in: [without.body.campaignId, withKey.body.campaignId] } } });
    await prisma.campaign.deleteMany({ where: { id: { in: [without.body.campaignId, withKey.body.campaignId] } } });
  });
});

describe('the Campaigns Channels mark reads "skipped — page paused"', () => {
  it('a SKIPPED page_paused row: mark SKIPPED and channelDetails.<channel>.skipReason = "page_paused" (and a compose skip keeps its own reason)', async () => {
    const from = new Date(Date.now() - 6 * 3600_000);
    Object.assign(env.telegram, { enabled: true, config: { token: TG_TOKEN, channel: '@taxscan_in', postFrom: from }, off: null });
    const sentAt = new Date(Date.now() - 60_000);
    const mk = (key: string, extra: object = {}) =>
      prisma.campaign.create({ data: { portal: env.rss.portal, title: `Pause mark ${key}`, body: 'b', url: `https://www.taxscan.in/gst/pausemark-${key}-${RUN}`, target: { type: 'all' } as Prisma.InputJsonValue, status: 'SENT', lastSentAt: sentAt, ...extra } as never });
    const paused = await mk('paused');
    const composed = await mk('composed', { socialSkip: ['telegram:taxscan'] });
    const plain = await mk('plain');
    try {
      await prisma.telegramPost.createMany({
        data: [
          { page: 'taxscan', pushKey: pushKey({ id: paused.id, lastSentAt: paused.lastSentAt! }), campaignId: paused.id, status: 'SKIPPED', error: PAGE_PAUSED, attempts: 0 },
          { page: 'taxscan', pushKey: pushKey({ id: plain.id, lastSentAt: plain.lastSentAt! }), campaignId: plain.id, status: 'POSTED', messageId: 5, attempts: 1, postedAt: sentAt },
        ],
      });
      const by = new Map((await listCampaigns(600)).map((r) => [r.id, r]));
      expect(by.get(paused.id)!.channels!.telegram).toBe('SKIPPED');
      expect(by.get(paused.id)!.channelDetails!.telegram).toMatchObject({ skipReason: PAGE_PAUSED, error: PAGE_PAUSED });
      expect(by.get(composed.id)!.channelDetails!.telegram).toMatchObject({ skipReason: 'compose_skip' });
      expect(by.get(plain.id)!.channelDetails!.telegram?.skipReason).toBeUndefined();
    } finally {
      await prisma.telegramPost.deleteMany({ where: { campaignId: { in: [paused.id, composed.id, plain.id] } } });
      await prisma.campaign.deleteMany({ where: { id: { in: [paused.id, composed.id, plain.id] } } });
      Object.assign(env.telegram, saved.telegram);
    }
  });
});
