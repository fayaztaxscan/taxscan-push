import bcrypt from 'bcrypt';
import request from 'supertest';
import { randomBytes } from 'node:crypto';
import type { Campaign, User } from '@prisma/client';
import { createApp } from '../app';
import { env, LINKEDIN_HEADROOM_DEFAULTS, type SharedLinkedInPage } from '../lib/env';
import { prisma } from '../lib/prisma';
import { isOrgDailyLimitAnswer, postToLinkedIn, type LinkedInRequest, type LinkedInResult } from '../services/linkedin/client';
import {
  ORG_DAILY_LIMIT,
  authKey,
  isOrgHeld,
  nextUtcMidnight,
  resetLinkedInStops,
  retryNow,
  runLinkedInTick,
  skipPost,
  type WorkerDeps,
} from '../services/linkedin/worker';

/**
 * Brief 2026-11-09-small-fixes, item 5 (found live 9 Nov): LinkedIn answers HTTP 429 `Organization post creation limit reached` for ONE
 * page. The page is then held until the next 00:00 UTC: that row is SKIPPED `org_daily_limit` after ONE call, every later push to the page
 * the same UTC day is SKIPPED with NO call, the other pages are untouched, and any other 429 keeps the retry path. ALL LinkedIn calls are
 * mocked. Rows live under a unique `test-orglim-*` portal and PRIVATE pages (`orglim-t` plays Taxscan and owns the token, `orglim-a`
 * Academy, `orglim-s` Shopscan), registered in `env` for the length of the file, so the real pages' rows are never touched.
 */
const logs: string[] = [];
jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
jest.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
jest.spyOn(console, 'warn').mockImplementation(() => undefined);

const RUN = `${Date.now()}-${randomBytes(3).toString('hex')}`;
const PORTAL = `test-orglim-${RUN}`;
const PAGE_T = 'orglim-t';
const PAGE_A = 'orglim-a';
const PAGE_S = 'orglim-s';
const ORG_T = 'urn:li:organization:101';
const ORG_A = 'urn:li:organization:91100022';
const ORG_S = 'urn:li:organization:80241094';
const TOKEN = `ORGLIM-TOKEN-${RUN}`;
const IST_MS = (5 * 60 + 30) * 60_000;
const ist = (h: number, m = 0, day = 20) => new Date(Date.UTC(2026, 10, day, h, m) - IST_MS);
const MIN = 60_000;
const at = (base: Date, min: number) => new Date(base.getTime() + min * MIN);
const NOW = ist(10, 0); // 20 Nov 2026 10:00 IST = 04:30 UTC
const HOLD_END = new Date(Date.UTC(2026, 10, 21)); // the next 00:00 UTC = 05:30 IST on 21 Nov
const FROM = ist(4, 0);
const FROM_S = ist(8, 0);
const BEARER = { Authorization: `Bearer ${env.adminToken}` };
const PAGES = [PAGE_T, PAGE_A, PAGE_S];
const SHARED_A: SharedLinkedInPage = { orgUrn: ORG_A, postFrom: FROM, tokenFrom: PAGE_T };
const SHARED_S: SharedLinkedInPage = { orgUrn: ORG_S, postFrom: FROM_S, tokenFrom: PAGE_T };

const posted = (id = 'urn:li:share:1'): LinkedInResult => ({ kind: 'posted', postId: id });
const orgLimit: LinkedInResult = { kind: 'org_limit', status: 429, error: 'HTTP 429: Organization post creation limit reached' };
const retry429: LinkedInResult = { kind: 'retry', status: 429, error: 'HTTP 429: Too Many Requests' };
const orgName = (o: string) => (o === ORG_T ? 'T' : o === ORG_A ? 'A' : 'S');

let calls: LinkedInRequest[] = [];
let script: (r: LinkedInRequest, n: number) => LinkedInResult = (r) => posted(`urn:li:share:${orgName(r.orgUrn)}${calls.length}`);
const post: NonNullable<WorkerDeps['post']> = async (r) => {
  calls.push(r);
  return script(r, calls.length);
};
/** Everything posts normally except ORG `org`, which answers `answer`. */
const only = (org: string, answer: LinkedInResult) => (r: LinkedInRequest): LinkedInResult => (r.orgUrn === org ? answer : posted(`urn:li:share:${orgName(r.orgUrn)}${calls.length}`));
const callsTo = (org: string) => calls.filter((c) => c.orgUrn === org).length;
const deps = (over: WorkerDeps = {}): WorkerDeps => ({
  now: () => NOW,
  post,
  fetchCms: async () => null,
  waitImage: async () => ({ ok: true }),
  emailSender: async () => ({ ok: true }),
  isEmailConfigured: () => false,
  recipients: async () => [],
  portals: { [PORTAL]: PAGES },
  postFrom: { [PAGE_T]: FROM },
  quiet: { start: '23:00', end: '07:00' },
  ...over,
});

let seq = 0;
async function camp(slug: string, lastSentAt: Date, o: { createdByUserId?: string | null; scheduledAt?: Date | null } = {}): Promise<Campaign> {
  return prisma.campaign.create({
    data: {
      portal: PORTAL,
      title: `Story ${slug}`,
      body: 'b',
      url: `https://www.taxscan.in/gst/${slug}-${RUN}-${++seq}`,
      target: {},
      status: 'SENT',
      lastSentAt,
      authority: 'Supreme Court',
      categories: ['GST'],
      ...(o.createdByUserId !== undefined ? { createdByUserId: o.createdByUserId } : {}),
      ...(o.scheduledAt !== undefined ? { scheduledAt: o.scheduledAt } : {}),
    } as never,
  });
}
const campIds = async () => (await prisma.campaign.findMany({ where: { portal: PORTAL }, select: { id: true } })).map((c) => c.id);
const rowOf = async (page: string, c: Campaign) => prisma.linkedInPost.findFirst({ where: { page, campaignId: c.id } });
const rowsOf = async (page: string) => prisma.linkedInPost.findMany({ where: { page, campaignId: { in: await campIds() } }, orderBy: { createdAt: 'asc' } });
const heldLines = (page: string) => logs.filter((l) => l.startsWith(`[linkedin] page=${page} ${ORG_DAILY_LIMIT} held until`));
/** Ticks (one minute apart) until a tick makes no call and creates no row: MAX_PER_TICK spreads a backlog over ticks. */
async function drain(start: Date = NOW, over: WorkerDeps = {}, max = 12): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    const ids = await campIds();
    const before = [calls.length, await prisma.linkedInPost.count({ where: { campaignId: { in: ids } } })];
    await runLinkedInTick(deps({ now: () => at(start, i), ...over }));
    if (calls.length === before[0] && (await prisma.linkedInPost.count({ where: { campaignId: { in: ids } } })) === before[1]) return;
  }
}

const saved = {
  shared: env.linkedin.sharedPages,
  headroom: env.linkedin.dailyHeadroom,
  allPushes: env.linkedin.allPushesFrom,
  taxscan: env.linkedin.pages.taxscan,
  liPage: env.linkedin.pages[PAGE_T],
  from: env.linkedin.postFrom,
  anyLink: env.social.anyLinkFrom,
  tr: { ...env.linkedin.tokenRefresh },
};
let USER: User;
async function wipe() {
  const ids = await campIds();
  await prisma.linkedInPost.deleteMany({ where: { OR: [{ campaignId: { in: ids } }, { page: { in: PAGES } }] } });
  await prisma.digestSetting.deleteMany({ where: { key: { in: PAGES.map(authKey) } } });
  await prisma.campaign.deleteMany({ where: { portal: PORTAL } });
}
beforeAll(async () => {
  env.linkedin.sharedPages = {};
  USER = await prisma.user.create({ data: { email: `orglim-${RUN}@example.com`, passwordHash: await bcrypt.hash('OrgLimPw1Aa', 4), role: 'ADMIN', isActive: true } });
});
beforeEach(async () => {
  calls = [];
  logs.length = 0;
  script = (r) => posted(`urn:li:share:${orgName(r.orgUrn)}${calls.length}`);
  env.linkedin.pages[PAGE_T] = { orgUrn: ORG_T, accessToken: TOKEN };
  env.linkedin.pages.taxscan = { orgUrn: '', accessToken: '' };
  env.linkedin.sharedPages = { [PAGE_A]: { ...SHARED_A }, [PAGE_S]: { ...SHARED_S } };
  // the quota guard is not under test here: keep it out of the way
  env.linkedin.dailyHeadroom = { [PAGE_A]: LINKEDIN_HEADROOM_DEFAULTS.academy, [PAGE_S]: LINKEDIN_HEADROOM_DEFAULTS.shopscan };
  env.linkedin.allPushesFrom = { [PAGE_T]: FROM, [PAGE_A]: FROM, [PAGE_S]: FROM_S };
  env.linkedin.postFrom = FROM;
  env.social.anyLinkFrom = null;
  Object.assign(env.linkedin.tokenRefresh, { ...saved.tr, enabled: false });
  resetLinkedInStops();
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
  env.social.anyLinkFrom = saved.anyLink;
  Object.assign(env.linkedin.tokenRefresh, saved.tr);
  resetLinkedInStops();
  await wipe();
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL audit_log.allow_purge = 'true'`);
    await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "userId" = ${USER.id}`;
  });
  await prisma.user.deleteMany({ where: { id: USER.id } });
  await prisma.$disconnect();
});

describe('the client: only a 429 that says "Organization post creation limit reached" is the page limit', () => {
  const reply = (status: number, body: unknown) => (async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;
  const req: LinkedInRequest = { orgUrn: ORG_S, accessToken: TOKEN, commentary: 'c', title: 't', link: 'https://www.taxscan.in/gst/a-1' };

  it('isOrgDailyLimitAnswer: 429 + that message (any case) yes; a plain 429, a 422 with the message, other statuses, no body no', () => {
    expect(isOrgDailyLimitAnswer(429, { message: 'Organization post creation limit reached' })).toBe(true);
    expect(isOrgDailyLimitAnswer(429, { message: 'ORGANIZATION POST CREATION LIMIT REACHED for urn:li:organization:1' })).toBe(true);
    expect(isOrgDailyLimitAnswer(429, { message: 'Resource level throttle APPLICATION DAY limit reached' })).toBe(false);
    expect(isOrgDailyLimitAnswer(429, { message: 'Too Many Requests' })).toBe(false);
    expect(isOrgDailyLimitAnswer(429, {})).toBe(false);
    expect(isOrgDailyLimitAnswer(429, null)).toBe(false);
    expect(isOrgDailyLimitAnswer(422, { message: 'Organization post creation limit reached' })).toBe(false);
    expect(isOrgDailyLimitAnswer(500, { message: 'Organization post creation limit reached' })).toBe(false);
  });

  it('postToLinkedIn: that 429 is `org_limit`; every other 429 (other message, no JSON) is still `retry`', async () => {
    expect(await postToLinkedIn(req, reply(429, { message: 'Organization post creation limit reached', status: 429 }))).toEqual({ kind: 'org_limit', status: 429, error: 'HTTP 429: Organization post creation limit reached' });
    expect(await postToLinkedIn(req, reply(429, { message: 'Too Many Requests' }))).toMatchObject({ kind: 'retry', status: 429 });
    expect(await postToLinkedIn(req, reply(429, 'not json'))).toMatchObject({ kind: 'retry', status: 429 });
    expect(await postToLinkedIn(req, reply(503, { message: 'Organization post creation limit reached' }))).toMatchObject({ kind: 'retry', status: 503 });
    expect(await postToLinkedIn(req, reply(403, { message: 'nope' }))).toMatchObject({ kind: 'auth' });
  });

  it('the token never reaches the verdict', async () => {
    const r = await postToLinkedIn(req, reply(429, { message: `Organization post creation limit reached ${TOKEN}` }));
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });
});

describe('nextUtcMidnight / isOrgHeld', () => {
  it('the next 00:00 UTC strictly after the instant (05:30 IST), across month and year ends', () => {
    expect(nextUtcMidnight(new Date('2026-11-20T04:30:00Z')).toISOString()).toBe('2026-11-21T00:00:00.000Z');
    expect(nextUtcMidnight(new Date('2026-11-20T23:59:59.999Z')).toISOString()).toBe('2026-11-21T00:00:00.000Z');
    expect(nextUtcMidnight(new Date('2026-11-21T00:00:00.000Z')).toISOString()).toBe('2026-11-22T00:00:00.000Z');
    expect(nextUtcMidnight(new Date('2026-11-30T12:00:00Z')).toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(nextUtcMidnight(new Date('2026-12-31T12:00:00Z')).toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
  it('a page is not held until a 429 sets it, and the hold ends exactly at 00:00 UTC', async () => {
    expect(isOrgHeld(PAGE_S, NOW)).toBe(false);
    await camp('probe', at(NOW, -30));
    script = only(ORG_S, orgLimit);
    await runLinkedInTick(deps());
    expect(isOrgHeld(PAGE_S, NOW)).toBe(true);
    expect(isOrgHeld(PAGE_S, new Date(HOLD_END.getTime() - 1))).toBe(true);
    expect(isOrgHeld(PAGE_S, HOLD_END)).toBe(false);
    expect(isOrgHeld(PAGE_T, NOW)).toBe(false);
  });
});

describe('6. the worker: a page that LinkedIn refuses for the day is held until 00:00 UTC', () => {
  it('429 + the limit message on Shopscan: that row is SKIPPED org_daily_limit after ONE call; Taxscan and Academy post normally', async () => {
    const c = await camp('first', at(NOW, -30));
    script = only(ORG_S, orgLimit);
    await drain();
    expect(callsTo(ORG_S)).toBe(1); // ONE call, not four
    expect(await rowOf(PAGE_S, c)).toMatchObject({ status: 'SKIPPED', error: ORG_DAILY_LIMIT, attempts: 1, nextAttemptAt: null });
    expect(await rowOf(PAGE_T, c)).toMatchObject({ status: 'POSTED' });
    expect(await rowOf(PAGE_A, c)).toMatchObject({ status: 'POSTED' });
    expect(callsTo(ORG_T)).toBe(1);
    expect(callsTo(ORG_A)).toBe(1);
  });

  it('a backlog: the first refused call holds the page; the other pushes in the SAME run are SKIPPED with no call', async () => {
    const cs = [await camp('b1', at(NOW, -50)), await camp('b2', at(NOW, -40)), await camp('b3', at(NOW, -30))];
    script = only(ORG_S, orgLimit);
    await drain();
    expect(callsTo(ORG_S)).toBe(1);
    const rows = await rowsOf(PAGE_S);
    expect(rows.map((r) => [r.campaignId, r.status, r.error])).toEqual(cs.map((c) => [c.id, 'SKIPPED', ORG_DAILY_LIMIT]));
    expect((await rowsOf(PAGE_T)).every((r) => r.status === 'POSTED')).toBe(true);
    expect((await rowsOf(PAGE_A)).every((r) => r.status === 'POSTED')).toBe(true);
    expect(callsTo(ORG_T)).toBe(3);
  });

  it('the NEXT Shopscan push the same UTC day makes no call; later ticks make none either; other pages still post', async () => {
    await camp('seed', at(NOW, -30));
    script = only(ORG_S, orgLimit);
    await drain();
    expect(callsTo(ORG_S)).toBe(1);
    const later = at(NOW, 120); // 12:00 IST, still the same UTC day
    const c = await camp('later', at(NOW, 90));
    await drain(later);
    expect(callsTo(ORG_S)).toBe(1); // no new call
    expect(await rowOf(PAGE_S, c)).toMatchObject({ status: 'SKIPPED', error: ORG_DAILY_LIMIT, attempts: 0 });
    expect(await rowOf(PAGE_T, c)).toMatchObject({ status: 'POSTED' });
    expect(await rowOf(PAGE_A, c)).toMatchObject({ status: 'POSTED' });
    await drain(at(later, 30));
    expect(callsTo(ORG_S)).toBe(1);
  });

  it('after 00:00 UTC Shopscan posts again; what was skipped is never posted later', async () => {
    const early = await camp('early', at(NOW, -30));
    script = only(ORG_S, orgLimit);
    await drain();
    script = (r) => posted(`urn:li:share:${orgName(r.orgUrn)}${calls.length}`);
    // one second before the hold ends: still held
    const justBefore = new Date(HOLD_END.getTime() - 1000);
    const mid = await camp('mid', at(NOW, 60));
    await drain(justBefore);
    expect(callsTo(ORG_S)).toBe(1);
    expect(await rowOf(PAGE_S, mid)).toMatchObject({ status: 'SKIPPED', error: ORG_DAILY_LIMIT });
    // at 00:00 UTC (05:30 IST) the page is open again, for pushes sent from then on
    const next = await camp('next', at(HOLD_END, 5));
    await drain(at(HOLD_END, 6));
    expect(callsTo(ORG_S)).toBe(2);
    expect(await rowOf(PAGE_S, next)).toMatchObject({ status: 'POSTED' });
    expect(await rowOf(PAGE_S, early)).toMatchObject({ status: 'SKIPPED', error: ORG_DAILY_LIMIT });
    expect(await rowOf(PAGE_S, mid)).toMatchObject({ status: 'SKIPPED', error: ORG_DAILY_LIMIT });
    await drain(at(HOLD_END, 20));
    expect(callsTo(ORG_S)).toBe(2); // the skipped ones are not picked up again
  });

  it('a plain 429 (any other body) keeps the retry path: +1 minute, no skip, no hold, the next push still calls the page', async () => {
    const c = await camp('plain', at(NOW, -30));
    script = only(ORG_S, retry429);
    await runLinkedInTick(deps());
    const row = await rowOf(PAGE_S, c);
    expect(row).toMatchObject({ status: 'PENDING', attempts: 1 });
    expect(row!.nextAttemptAt).toEqual(at(NOW, 1));
    expect(row!.error).not.toBe(ORG_DAILY_LIMIT);
    expect(isOrgHeld(PAGE_S, NOW)).toBe(false);
    expect(heldLines(PAGE_S)).toHaveLength(0);
    // the next push still calls Shopscan (and is refused with a plain 429 too): it is retried, never skipped for the day
    const d = await camp('plain-2', at(NOW, 10));
    const before = callsTo(ORG_S);
    await drain(at(NOW, 11));
    expect(callsTo(ORG_S)).toBeGreaterThan(before);
    const rowD = (await rowOf(PAGE_S, d))!;
    expect(rowD.status).not.toBe('SKIPPED');
    expect(rowD.error).not.toBe(ORG_DAILY_LIMIT);
    expect(isOrgHeld(PAGE_S, at(NOW, 11))).toBe(false);
    expect(heldLines(PAGE_S)).toHaveLength(0);
  });

  it('a plain 429 still ends FAILED after four attempts (+1, +5, +15 minutes), never SKIPPED', async () => {
    const c = await camp('plain-four', at(NOW, -30));
    script = only(ORG_S, retry429);
    for (const m of [0, 1, 6, 21]) await runLinkedInTick(deps({ now: () => at(NOW, m) }));
    expect(callsTo(ORG_S)).toBe(4);
    expect(await rowOf(PAGE_S, c)).toMatchObject({ status: 'FAILED', attempts: 4 });
  });

  it('one log line per hold: `[linkedin] page=<page> org_daily_limit held until <ISO>`, never for another page', async () => {
    for (let i = 0; i < 3; i += 1) await camp(`log${i}`, at(NOW, -40 + i));
    script = only(ORG_S, orgLimit);
    await drain();
    expect(heldLines(PAGE_S)).toEqual([`[linkedin] page=${PAGE_S} ${ORG_DAILY_LIMIT} held until ${HOLD_END.toISOString()}`]);
    expect(heldLines(PAGE_T)).toHaveLength(0);
    expect(heldLines(PAGE_A)).toHaveLength(0);
    await camp('log-later', at(NOW, 90));
    await drain(at(NOW, 120));
    expect(heldLines(PAGE_S)).toHaveLength(1); // still one: the later pushes are skipped silently
  });

  it('a retry that is waiting for its turn when the page is held is SKIPPED too, with no call', async () => {
    const waiting = await camp('waiting', at(NOW, -30));
    script = only(ORG_S, retry429);
    await runLinkedInTick(deps()); // a plain 429: the row waits for +1 minute
    expect(await rowOf(PAGE_S, waiting)).toMatchObject({ status: 'PENDING' });
    const trigger = await camp('trigger', at(NOW, -20));
    script = only(ORG_S, orgLimit);
    await runLinkedInTick(deps({ now: () => at(NOW, 0.5) })); // not due yet: only the new push is tried, and met the limit
    expect(await rowOf(PAGE_S, trigger)).toMatchObject({ status: 'SKIPPED', error: ORG_DAILY_LIMIT });
    const before = callsTo(ORG_S);
    await runLinkedInTick(deps({ now: () => at(NOW, 2) })); // the waiting retry is due now, but the page is held
    expect(callsTo(ORG_S)).toBe(before);
    expect(await rowOf(PAGE_S, waiting)).toMatchObject({ status: 'SKIPPED', error: ORG_DAILY_LIMIT, nextAttemptAt: null });
  });

  it('a manual immediate push is not exempt (LinkedIn would refuse it too): SKIPPED, no call', async () => {
    await camp('seed-m', at(NOW, -30));
    script = only(ORG_S, orgLimit);
    await drain();
    const manual = await camp('manual', at(NOW, 60), { createdByUserId: USER.id, scheduledAt: null });
    await drain(at(NOW, 61));
    expect(callsTo(ORG_S)).toBe(1);
    expect(await rowOf(PAGE_S, manual)).toMatchObject({ status: 'SKIPPED', error: ORG_DAILY_LIMIT });
    expect(await rowOf(PAGE_T, manual)).toMatchObject({ status: 'POSTED' });
  });

  it('the hold is per page: Academy refused does not stop Shopscan or Taxscan, and it holds only Academy', async () => {
    const c = await camp('academy-only', at(NOW, -30));
    script = only(ORG_A, orgLimit);
    await drain();
    expect(await rowOf(PAGE_A, c)).toMatchObject({ status: 'SKIPPED', error: ORG_DAILY_LIMIT });
    expect(await rowOf(PAGE_S, c)).toMatchObject({ status: 'POSTED' });
    expect(await rowOf(PAGE_T, c)).toMatchObject({ status: 'POSTED' });
    expect(isOrgHeld(PAGE_A, NOW)).toBe(true);
    expect(isOrgHeld(PAGE_S, NOW)).toBe(false);
    expect(isOrgHeld(PAGE_T, NOW)).toBe(false);
    const d = await camp('academy-only-2', at(NOW, 30));
    await drain(at(NOW, 31));
    expect(callsTo(ORG_A)).toBe(1);
    expect(await rowOf(PAGE_S, d)).toMatchObject({ status: 'POSTED' });
    expect(await rowOf(PAGE_T, d)).toMatchObject({ status: 'POSTED' });
  });

  it('in memory only: a restart forgets the hold and the next 429 sets it again (one more line)', async () => {
    await camp('r1', at(NOW, -30));
    script = only(ORG_S, orgLimit);
    await drain();
    expect(callsTo(ORG_S)).toBe(1);
    resetLinkedInStops(); // what a restart does
    expect(isOrgHeld(PAGE_S, NOW)).toBe(false);
    const c = await camp('r2', at(NOW, 30));
    await drain(at(NOW, 31));
    expect(callsTo(ORG_S)).toBe(2); // asked LinkedIn again…
    expect(await rowOf(PAGE_S, c)).toMatchObject({ status: 'SKIPPED', error: ORG_DAILY_LIMIT }); // …and was refused again
    expect(isOrgHeld(PAGE_S, at(NOW, 31))).toBe(true);
    expect(heldLines(PAGE_S)).toHaveLength(2);
  });

  it('a skipped row has no Retry and no Skip (they belong to FAILED / waiting rows), and is never reposted', async () => {
    const c = await camp('noactions', at(NOW, -30));
    script = only(ORG_S, orgLimit);
    await drain();
    const row = (await rowOf(PAGE_S, c))!;
    expect(await skipPost(row.id)).toBe(false);
    expect(await retryNow(row.id, deps())).toEqual({ ok: false, reason: 'not_failed' });
    expect(callsTo(ORG_S)).toBe(1);
  });
});

describe('the screen API: the row says why (skipReason), on that row only', () => {
  const appWith = () => createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 }, linkedin: { enabled: () => true, clock: () => NOW, portals: () => ({ [PORTAL]: PAGES }), worker: deps() } });
  it('GET /api/linkedin/posts?page=<shopscan>: skipReason "org_daily_limit" and the count under Skipped; Taxscan\'s row has none', async () => {
    const c = await camp('api', at(NOW, -30));
    script = only(ORG_S, orgLimit);
    await drain();
    const app = appWith();
    const sh = await request(app).get(`/api/linkedin/posts?date=2026-11-20&page=${PAGE_S}`).set(BEARER);
    expect(sh.status).toBe(200);
    const row = sh.body.rows.find((r: { campaignId: string }) => r.campaignId === c.id);
    expect(row).toMatchObject({ status: 'SKIPPED', skipReason: ORG_DAILY_LIMIT, id: expect.any(String) });
    expect(sh.body.counts).toMatchObject({ skipped: 1, posted: 0 });
    const tx = await request(app).get(`/api/linkedin/posts?date=2026-11-20&page=${PAGE_T}`).set(BEARER);
    expect(Object.keys(tx.body.rows[0])).not.toContain('skipReason');
  });
});
