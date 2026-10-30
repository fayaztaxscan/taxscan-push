import request from 'supertest';
import bcrypt from 'bcrypt';
import type { DigestAudience, User, UserRole } from '@prisma/client';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { parseAudienceEnv, parseDigestEnv, type AudienceEnv, type DigestEnv } from '../lib/env';
import { advanceRun, audienceTarget, awaitDigestAlerts, ensureRun, type DigestTrigger } from '../services/digest/runner';
import * as guardModule from '../services/audience/guard';
import { audienceGuard, deviationLimit, pendingLimit, type GuardSnapshot } from '../services/audience/guard';
import { openBreaker } from '../services/audience/breaker';
import { alertCopy } from '../services/digest/alerts';
import { placeholderContent } from './digestPlaceholderContent';
import { FakeSender } from './digestFakeSender';

/**
 * CMS audience sync tasks 7–8 (docs/CMS_AUDIENCE_SYNC_DESIGN.md §7.1, §7.2, §10.2): the send guard (pure units, one
 * per check at its limit and limit + 1), the digest runner with the guard on and off, derived targets, the
 * Audience card routes and the Resume route, and the alert copy. Provider calls go to FakeSender; the guard's
 * database read is stubbed where a runner scenario needs a chosen verdict.
 */

jest.spyOn(console, 'log').mockImplementation(() => undefined);
jest.spyOn(console, 'warn').mockImplementation(() => undefined);

const PORTAL_PREFIX = 'test-audience-guard-';
const QUIET = { start: '23:00', end: '07:00' };
const IST_OFFSET_MIN = 5 * 60 + 30;
const PASSWORD = 'Guard-test-pass-1234';
const AUTH = `Bearer ${process.env.ADMIN_TOKEN}`;
const H = 3_600_000;
const MIN = 60_000;

function ist(h: number, min = 0, day = 23): Date {
  return new Date(Date.UTC(2026, 9, day, h, min) - IST_OFFSET_MIN * 60 * 1000);
}

const aud = (over: NodeJS.ProcessEnv = {}): AudienceEnv =>
  parseAudienceEnv({
    AUDIENCE_SYNC_ENABLED: 'true',
    AUDIENCE_MC_TAG_PREMIUM: 'tag-premium',
    AUDIENCE_MC_TAG_FORMER: 'tag-former',
    AUDIENCE_MC_TAG_NO_MARKETING: 'tag-nomkt',
    ...over,
  });
const AUD_ON = aud({ DIGEST_AUDIENCE_FROM_CMS: 'true' });
const AUD_OFF = aud();

function cfg(over: NodeJS.ProcessEnv = {}): DigestEnv {
  return parseDigestEnv({
    DIGEST_ENABLED: 'true',
    DIGEST_SEND_LIVE: 'true',
    DIGEST_APPROVAL_REQUIRED: 'false',
    DIGEST_FREE_LIST_IDS: 'list-free',
    DIGEST_FREE_EXCLUDE_LIST_IDS: 'list-premium',
    DIGEST_PREMIUM_LIST_IDS: 'list-premium',
    DIGEST_POSTAL_ADDRESS: 'Test address, Kochi',
    ...over,
  });
}

/* ---------------------------------------------------------------- */
/* The guard, pure                                                   */
/* ---------------------------------------------------------------- */

describe('audienceGuard — PREMIUM, one check at its limit and limit + 1', () => {
  const now = new Date('2026-10-30T02:00:00Z');
  const thr = { maxStaleHours: 26, premiumDeviationPct: 2 };
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const healthy = (over: Partial<GuardSnapshot> = {}): GuardSnapshot => ({
    lastFullOkAt: ago(1 * H),
    lastIncrOkAt: ago(1 * H),
    lastWebhookAt: null,
    breakerOpen: false,
    pendingPremium: 0,
    premiumDesired: 1000,
    premiumApplied: 1000,
    driftOurs: 1000,
    driftMailercloud: 1000,
    cmsPremium: 1000,
    ...over,
  });
  const verdict = (over: Partial<GuardSnapshot>, audience: DigestAudience = 'PREMIUM') => audienceGuard(audience, healthy(over), now, thr);

  it('a healthy snapshot passes', () => {
    expect(verdict({})).toEqual({ ok: true });
  });

  it('stale full load: 26 h passes, 26 h 1 min refuses', () => {
    expect(verdict({ lastFullOkAt: ago(26 * H) }).ok).toBe(true);
    expect(verdict({ lastFullOkAt: ago(26 * H + MIN) })).toMatchObject({ ok: false, check: 'stale_full_load' });
    expect(verdict({ lastFullOkAt: null })).toMatchObject({ ok: false, check: 'stale_full_load' });
  });

  it('no activity: 3 h passes, 3 h 1 min refuses (a newer webhook or pull counts)', () => {
    const quiet = (ms: number) => ({ lastFullOkAt: ago(ms), lastIncrOkAt: ago(ms), lastWebhookAt: ago(ms) });
    expect(verdict(quiet(3 * H)).ok).toBe(true);
    expect(verdict(quiet(3 * H + MIN))).toMatchObject({ ok: false, check: 'no_activity' });
    expect(verdict({ ...quiet(5 * H), lastWebhookAt: ago(10 * MIN) }).ok).toBe(true);
  });

  it('breaker open refuses', () => {
    expect(verdict({ breakerOpen: true })).toMatchObject({ ok: false, check: 'breaker_open' });
  });

  it('pending writes: max(1 %, 10) passes, +1 refuses', () => {
    expect(pendingLimit(1000)).toBe(10);
    expect(pendingLimit(5000)).toBe(50);
    expect(verdict({ pendingPremium: 10 }).ok).toBe(true);
    expect(verdict({ pendingPremium: 11 })).toMatchObject({ ok: false, check: 'pending_writes' });
    expect(verdict({ premiumDesired: 5000, cmsPremium: 5000, driftOurs: 5000, driftMailercloud: 5000, pendingPremium: 50 }).ok).toBe(true);
    expect(verdict({ premiumDesired: 5000, cmsPremium: 5000, driftOurs: 5000, driftMailercloud: 5000, pendingPremium: 51 })).toMatchObject({ check: 'pending_writes' });
  });

  it('Mailercloud vs ours: max(2 %, 25) passes, +1 refuses; both directions', () => {
    expect(deviationLimit(1000, 2)).toBe(25);
    expect(deviationLimit(5000, 2)).toBe(100);
    expect(verdict({ driftMailercloud: 975 }).ok).toBe(true);
    expect(verdict({ driftMailercloud: 1025 }).ok).toBe(true);
    expect(verdict({ driftMailercloud: 974 })).toMatchObject({ ok: false, check: 'mailercloud_deviation' });
    expect(verdict({ driftMailercloud: 1026 })).toMatchObject({ ok: false, check: 'mailercloud_deviation' });
    expect(verdict({ driftOurs: 5000, driftMailercloud: 4900, premiumDesired: 5000, cmsPremium: 5000 }).ok).toBe(true);
    expect(verdict({ driftOurs: 5000, driftMailercloud: 4899, premiumDesired: 5000, cmsPremium: 5000 })).toMatchObject({ check: 'mailercloud_deviation' });
  });

  it('CMS vs ours: the same tolerance, +1 refuses', () => {
    expect(verdict({ cmsPremium: 1025 }).ok).toBe(true);
    expect(verdict({ cmsPremium: 975 }).ok).toBe(true);
    expect(verdict({ cmsPremium: 1026 })).toMatchObject({ ok: false, check: 'cms_deviation' });
    expect(verdict({ cmsPremium: 974 })).toMatchObject({ ok: false, check: 'cms_deviation' });
  });

  it('a missing input fails closed and names itself', () => {
    expect(verdict({ driftMailercloud: null })).toMatchObject({ ok: false, check: 'mailercloud_count_missing' });
    expect(verdict({ driftOurs: null })).toMatchObject({ ok: false, check: 'mailercloud_count_missing' });
    expect(verdict({ cmsPremium: null })).toMatchObject({ ok: false, check: 'cms_count_missing' });
  });

  it('every refusal carries a plain sentence, with counts and codes only', () => {
    const r = verdict({ pendingPremium: 11 });
    if (r.ok) throw new Error('expected a refusal');
    expect(r.plain).toMatch(/11 Premium members/);
    expect(r.plain).not.toMatch(/@/);
  });
});

describe('audienceGuard — FREE', () => {
  const now = new Date('2026-10-30T02:00:00Z');
  const thr = { maxStaleHours: 26, premiumDeviationPct: 2 };
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const base = (over: Partial<GuardSnapshot> = {}): GuardSnapshot => ({
    lastFullOkAt: ago(1 * H),
    lastIncrOkAt: ago(1 * H),
    lastWebhookAt: null,
    breakerOpen: false,
    pendingPremium: 0,
    premiumDesired: 1000,
    premiumApplied: 1000,
    driftOurs: 1000,
    driftMailercloud: 1000,
    cmsPremium: 1000,
    ...over,
  });
  const free = (over: Partial<GuardSnapshot>) => audienceGuard('FREE', base(over), now, thr);

  it('refuses only on an empty Premium tag or 72 h of staleness', () => {
    expect(free({ premiumApplied: 0 })).toMatchObject({ ok: false, check: 'premium_tag_empty' });
    expect(free({ premiumApplied: 1 }).ok).toBe(true);
    const stale = (ms: number) => ({ lastFullOkAt: ago(ms), lastIncrOkAt: ago(ms), lastWebhookAt: null });
    expect(free(stale(72 * H)).ok).toBe(true);
    expect(free(stale(72 * H + MIN))).toMatchObject({ ok: false, check: 'sync_stale' });
    expect(free({ lastFullOkAt: null, lastIncrOkAt: null })).toMatchObject({ ok: false, check: 'sync_stale' });
  });

  it('passes with the breaker open and with every Premium-only check failing', () => {
    expect(free({ breakerOpen: true, pendingPremium: 999, driftMailercloud: null, cmsPremium: null, lastFullOkAt: ago(40 * H), lastIncrOkAt: ago(40 * H) }).ok).toBe(true);
  });
});

/* ---------------------------------------------------------------- */
/* Derived targets (§7.1)                                            */
/* ---------------------------------------------------------------- */

describe('audienceTarget', () => {
  it('flag OFF: unchanged — reads the configured tag ids', () => {
    const c = cfg({ DIGEST_PREMIUM_TAG_IDS: 'p1', DIGEST_FREE_EXCLUDE_TAG_IDS: 'x1' });
    expect(audienceTarget(c, 'PREMIUM', AUD_OFF)).toEqual({
      ok: true,
      target: { listIds: ['list-premium'], segmentIds: [], tagIds: ['p1'], excludeListIds: [], excludeTagIds: [] },
    });
    expect(audienceTarget(c, 'FREE', AUD_OFF)).toEqual({
      ok: true,
      target: { listIds: ['list-free'], segmentIds: [], tagIds: [], excludeListIds: ['list-premium'], excludeTagIds: ['x1'] },
    });
    expect(audienceTarget(cfg({ DIGEST_PREMIUM_LIST_IDS: '' }), 'PREMIUM', AUD_OFF).ok).toBe(false);
  });

  it('flag ON: Premium = the Premium tag; Free excludes the Premium and No-marketing tags and adds the Former tag', () => {
    const c = cfg();
    expect(audienceTarget(c, 'PREMIUM', AUD_ON)).toMatchObject({ ok: true, target: { tagIds: ['tag-premium'] } });
    expect(audienceTarget(c, 'FREE', AUD_ON)).toEqual({
      ok: true,
      target: { listIds: ['list-free'], segmentIds: [], tagIds: ['tag-former'], excludeListIds: ['list-premium'], excludeTagIds: ['tag-premium', 'tag-nomkt'] },
    });
  });

  it('flag ON: config cannot remove the derived excludes, even with no exclude configured or stray tag ids', () => {
    const bare = cfg({ DIGEST_FREE_EXCLUDE_LIST_IDS: '', DIGEST_FREE_EXCLUDE_TAG_IDS: 'stray' });
    const free = audienceTarget(bare, 'FREE', AUD_ON);
    if (!free.ok) throw new Error(free.reason);
    expect(free.target.excludeTagIds).toEqual(['tag-premium', 'tag-nomkt']);
    // Former off by owner choice → no Former tag, excludes unchanged.
    const noFormer = audienceTarget(cfg(), 'FREE', aud({ DIGEST_AUDIENCE_FROM_CMS: 'true', AUDIENCE_FORMER_TO_FREE: 'false' }));
    expect(noFormer).toMatchObject({ ok: true, target: { tagIds: [], excludeTagIds: ['tag-premium', 'tag-nomkt'] } });
  });

  it('flag ON without the tag ids fails closed', () => {
    const none = aud({ DIGEST_AUDIENCE_FROM_CMS: 'true', AUDIENCE_MC_TAG_PREMIUM: '' });
    expect(audienceTarget(cfg(), 'PREMIUM', none).ok).toBe(false);
    expect(audienceTarget(cfg(), 'FREE', none).ok).toBe(false);
  });
});

/* ---------------------------------------------------------------- */
/* The runner                                                        */
/* ---------------------------------------------------------------- */

let n = 0;
const portals: string[] = [];
async function newRun(c: DigestEnv, now = ist(6, 0)) {
  const portal = `${PORTAL_PREFIX}${Date.now()}-${++n}-${Math.floor(Math.random() * 1e6)}`;
  portals.push(portal);
  return ensureRun({ portal, now, cfg: c });
}
function step(runId: string, trigger: DigestTrigger, now: Date, sender: FakeSender, c: DigestEnv, audience: AudienceEnv) {
  return advanceRun(runId, trigger, { sender, now, cfg: c, audience, quiet: QUIET, buildContent: placeholderContent, alerts: false });
}
const sendOf = (runId: string, audience: DigestAudience) => prisma.digestSend.findUniqueOrThrow({ where: { runId_audience: { runId, audience } } });
async function alertsOf(runId: string): Promise<Record<string, Record<string, unknown>>> {
  const r = await prisma.digestRun.findUniqueOrThrow({ where: { id: runId } });
  return r.alerts as Record<string, Record<string, unknown>>;
}

/** The guard's verdict per audience; the database read behind it is replaced. */
let verdicts: Record<DigestAudience, guardModule.GuardResult>;
const OK: guardModule.GuardResult = { ok: true };
const HELD: guardModule.GuardResult = { ok: false, check: 'pending_writes', plain: '40 Premium members are still waiting to be tagged in Mailercloud (limit 10)' };
let guardSpy: jest.SpyInstance;

beforeEach(() => {
  verdicts = { PREMIUM: OK, FREE: OK };
  guardSpy = jest.spyOn(guardModule, 'checkAudienceGuard').mockImplementation(async (audience) => verdicts[audience]);
});
afterEach(() => guardSpy.mockRestore());

describe('digest runner — flag OFF', () => {
  it('never calls the guard; schedules exactly as before', async () => {
    const c = cfg();
    const run = await newRun(c);
    const sender = new FakeSender();
    await step(run.id, 'cron', ist(6, 30), sender, c, AUD_OFF);
    verdicts = { PREMIUM: HELD, FREE: HELD }; // would block, were it consulted
    await step(run.id, 'cron', ist(7, 30), sender, c, AUD_OFF);
    await step(run.id, 'cron', ist(17, 0), sender, c, AUD_OFF);
    expect(sender.count('schedule')).toBe(2);
    expect(guardSpy).not.toHaveBeenCalled();
    expect(Object.keys(await alertsOf(run.id))).not.toContain('audience_unverified');
  });
});

describe('digest runner — flag ON', () => {
  it('a refused PREMIUM stays CREATED, unmarked, due next minute, one alert; FREE is unaffected; clears by itself', async () => {
    const c = cfg();
    const run = await newRun(c);
    const sender = new FakeSender();
    await step(run.id, 'cron', ist(6, 30), sender, c, AUD_ON);
    verdicts = { PREMIUM: HELD, FREE: OK };

    await step(run.id, 'cron', ist(7, 30), sender, c, AUD_ON);
    const held = await sendOf(run.id, 'PREMIUM');
    expect(held.state).toBe('CREATED');
    expect(held.scheduleAttemptedAt).toBeNull();
    expect(held.nextAttemptAt?.getTime()).toBe(ist(7, 31).getTime());
    expect((await sendOf(run.id, 'FREE')).state).toBe('SCHEDULED');
    expect(sender.count('schedule')).toBe(1);

    await step(run.id, 'cron', ist(7, 31), sender, c, AUD_ON);
    await step(run.id, 'cron', ist(7, 32), sender, c, AUD_ON);
    expect((await sendOf(run.id, 'PREMIUM')).scheduleAttemptedAt).toBeNull();
    const alerts = await alertsOf(run.id);
    expect(Object.keys(alerts).filter((k) => k === 'audience_unverified')).toHaveLength(1);
    expect(alerts.audience_unverified).toMatchObject({ audience: 'PREMIUM', check: 'pending_writes' });

    verdicts = { PREMIUM: OK, FREE: OK };
    await step(run.id, 'cron', ist(7, 33), sender, c, AUD_ON);
    expect(sender.count('schedule')).toBe(2);
    expect((await sendOf(run.id, 'PREMIUM')).state).toBe('SCHEDULED');
  });

  it('Send now and Retry meet the same refusal; approval does not override it', async () => {
    const c = cfg({ DIGEST_APPROVAL_REQUIRED: 'true' });
    const run = await newRun(c);
    const sender = new FakeSender();
    await step(run.id, 'cron', ist(6, 30), sender, c, AUD_ON);
    await prisma.digestRun.update({ where: { id: run.id }, data: { approval: 'APPROVED', approvedAt: ist(7, 0) } });
    verdicts = { PREMIUM: HELD, FREE: HELD };
    const a = await step(run.id, 'send_now', ist(9, 0), sender, c, AUD_ON);
    const b = await step(run.id, 'retry', ist(9, 1), sender, c, AUD_ON);
    expect(sender.count('schedule')).toBe(0);
    expect(a.steps.some((s) => s.startsWith('PREMIUM:wait:audience_unverified'))).toBe(true);
    expect(b.steps.some((s) => s.startsWith('FREE:wait:audience_unverified'))).toBe(true);
    expect((await sendOf(run.id, 'PREMIUM')).scheduleAttemptedAt).toBeNull();
  });

  it('still refused at 17:00 → SKIPPED audience_unverified; FREE (verified) was already sent', async () => {
    const c = cfg();
    const run = await newRun(c);
    const sender = new FakeSender();
    await step(run.id, 'cron', ist(6, 30), sender, c, AUD_ON);
    verdicts = { PREMIUM: HELD, FREE: OK };
    await step(run.id, 'cron', ist(7, 30), sender, c, AUD_ON);
    await step(run.id, 'cron', ist(17, 0), sender, c, AUD_ON);
    expect((await sendOf(run.id, 'PREMIUM')).state).toBe('SKIPPED');
    const row = await prisma.digestRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.skipReason).toBe('audience_unverified');
    expect(sender.count('schedule')).toBe(1);
  });

  it('drafts carry the derived tag ids', async () => {
    const c = cfg();
    const run = await newRun(c);
    const sender = new FakeSender();
    await step(run.id, 'cron', ist(6, 30), sender, c, AUD_ON);
    const drafts = sender.draftInputs();
    expect(drafts.find((d) => d.audience === 'PREMIUM')?.target.tagIds).toEqual(['tag-premium']);
    expect(drafts.find((d) => d.audience === 'FREE')?.target.excludeTagIds).toEqual(['tag-premium', 'tag-nomkt']);
  });
});

/* ---------------------------------------------------------------- */
/* Alert copy                                                        */
/* ---------------------------------------------------------------- */

describe('alert copy', () => {
  it('breaker alert: no "held" claim while the guard is off; the held sentence when it is on', () => {
    const c = cfg();
    const off = alertCopy('audience_breaker_open', { reason: 'first_load' }, c, false);
    expect(off.did).not.toMatch(/is held/);
    expect(off.did).toMatch(/not held yet/);
    const on = alertCopy('audience_breaker_open', { reason: 'first_load' }, c, true);
    expect(on.did).toMatch(/Premium digest is held/);
  });

  it('writer-failing alert makes the same distinction; full-incomplete never claims a hold', () => {
    const c = cfg();
    expect(alertCopy('audience_writer_failing', {}, c, false).did).not.toMatch(/is held/);
    expect(alertCopy('audience_writer_failing', {}, c, true).did).toMatch(/is held/);
    expect(alertCopy('audience_full_incomplete', { reason: 'short_load', rows: 1 }, c, true).did).not.toMatch(/held/);
  });

  it('audience_unverified names the check in plain words', () => {
    const copy = alertCopy('audience_unverified', { audience: 'PREMIUM', plain: HELD.ok ? '' : HELD.plain }, cfg(), true);
    expect(copy.what).toMatch(/Premium digest was not sent because 40 Premium members/);
  });
});

/* ---------------------------------------------------------------- */
/* Routes                                                            */
/* ---------------------------------------------------------------- */

describe('Audience card + Resume routes', () => {
  const userIds: string[] = [];
  const syncPortals: string[] = [];
  let admin: User;
  let publisher: User;
  let adminCookie: string;
  let publisherCookie: string;

  async function makeUser(role: UserRole): Promise<User> {
    const email = `audience-guard-${role.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e9)}@team.test`;
    const u = await prisma.user.create({ data: { email, passwordHash: await bcrypt.hash(PASSWORD, 4), role, isActive: true } });
    userIds.push(u.id);
    return u;
  }
  const loginApp = createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 } });
  async function cookieFor(u: User): Promise<string> {
    const res = await request(loginApp).post('/api/auth/login').send({ email: u.email, password: PASSWORD });
    expect(res.status).toBe(200);
    const sc = res.headers['set-cookie'];
    return (Array.isArray(sc) ? sc : [sc as unknown as string]).map((l) => l.split(';')[0]).join('; ');
  }
  const appFor = (portal: string, audience: AudienceEnv = AUD_OFF) =>
    createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 }, digest: { cfg: cfg(), audience, clock: () => new Date('2026-10-30T02:00:00Z'), portal, alerts: false } });
  async function syncPortal(open = false): Promise<string> {
    const portal = `${PORTAL_PREFIX}sync-${Date.now()}-${++n}`;
    syncPortals.push(portal);
    const now = new Date('2026-10-30T01:30:00Z');
    await prisma.audienceSyncState.create({
      data: { portal, lastFullOkAt: now, lastIncrOkAt: now, lastWebhookAt: now, cmsCounts: { active: 40, cancelled: 2 }, drift: { premiumOurs: 41, premiumMailercloud: 42 } },
    });
    if (open) await openBreaker(prisma, portal, 'first_load', { premiumCms: 42, premiumOurs: 41, rows: 900 }, now);
    return portal;
  }

  beforeAll(async () => {
    admin = await makeUser('ADMIN');
    publisher = await makeUser('PUBLISHER');
    adminCookie = await cookieFor(admin);
    publisherCookie = await cookieFor(publisher);
  });

  afterAll(async () => {
    await awaitDigestAlerts();
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL audit_log.allow_purge = 'true'`);
      await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "userId" = ANY(${userIds}::text[])`;
    });
    await prisma.audienceSyncState.deleteMany({ where: { portal: { in: syncPortals } } });
    await prisma.digestRun.deleteMany({ where: { portal: { startsWith: PORTAL_PREFIX } } });
    await prisma.userSession.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  it('needs a session: no cookie and the bearer alone are both refused', async () => {
    const app = appFor(await syncPortal());
    expect((await request(app).get('/api/digest/audience')).status).toBe(401);
    expect((await request(app).get('/api/digest/audience').set('Authorization', AUTH)).status).toBe(401);
  });

  it('sync off → the card is hidden entirely', async () => {
    const res = await request(appFor(await syncPortal(), parseAudienceEnv({}))).get('/api/digest/audience').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: false });
  });

  it('ADMIN gets counts, the sync times, errors and the breaker with its reviewed counts', async () => {
    const portal = await syncPortal(true);
    const res = await request(appFor(portal, AUD_ON)).get('/api/digest/audience').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      enabled: true,
      ok: false,
      guardActive: true,
      writesLive: false,
      counts: { premiumCms: 42, premiumMailercloud: 42 },
      breaker: { open: true, reason: 'first_load', review: { premiumCms: 42, premiumOurs: 41, rows: 900 } },
    });
    expect(res.body.breaker.plain).toMatch(/first complete reader load/);
    expect(res.body.last.fullAt).toBe('2026-10-30T01:30:00.000Z');
    expect(Object.keys(res.body.errors24h).sort()).toEqual(['seqConflict', 'unknownStatus', 'writerFatal', 'writerRetryable']);
  });

  it('PUBLISHER gets one line and nothing else — no digits, no counts', async () => {
    const portal = await syncPortal(true);
    const res = await request(appFor(portal, AUD_ON)).get('/api/digest/audience').set('Cookie', publisherCookie);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['enabled', 'line', 'ok']);
    expect(res.body.line).toBe('Audience sync is paused for review.');
    expect(res.body.line).not.toMatch(/\d/);
  });

  it('neither payload contains an email, a hash or an account id', async () => {
    const portal = await syncPortal(true);
    await prisma.audienceMember.upsert({
      where: { emailHash: `hash-${portal}` },
      create: { emailHash: `hash-${portal}`, email: `reader-${portal}@example.org`, desiredRole: 'PREMIUM' },
      update: {},
    });
    try {
      for (const cookie of [adminCookie, publisherCookie]) {
        const text = JSON.stringify((await request(appFor(portal, AUD_ON)).get('/api/digest/audience').set('Cookie', cookie)).body);
        expect(text).not.toMatch(/@|hash-|reader-|emailHash|accountId|"email"/i);
      }
    } finally {
      await prisma.audienceMember.deleteMany({ where: { emailHash: `hash-${portal}` } });
    }
  });

  it('Resume: PUBLISHER 403, bearer-only 401, ADMIN 200 with ONE audit row, then 409 not_open', async () => {
    const portal = await syncPortal(true);
    const app = appFor(portal, AUD_ON);
    expect((await request(app).post('/api/digest/audience/resume').set('Cookie', publisherCookie)).status).toBe(403);
    expect((await request(app).post('/api/digest/audience/resume').set('Authorization', AUTH)).status).toBe(401);
    expect((await prisma.audienceSyncState.findUniqueOrThrow({ where: { portal } })).breakerOpenAt).not.toBeNull();

    const ok = await request(app).post('/api/digest/audience/resume').set('Cookie', adminCookie);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true });
    const st = await prisma.audienceSyncState.findUniqueOrThrow({ where: { portal } });
    expect(st.breakerOpenAt).toBeNull();
    expect(st.breakerReason).toBeNull();
    const rows = await prisma.auditLog.findMany({ where: { action: 'AUDIENCE_SYNC_RESUMED', userId: admin.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toMatchObject({ portal, reason: 'first_load', review: { premiumCms: 42, rows: 900 } });

    const again = await request(app).post('/api/digest/audience/resume').set('Cookie', adminCookie);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('not_open');
    expect(await prisma.auditLog.count({ where: { action: 'AUDIENCE_SYNC_RESUMED', userId: admin.id } })).toBe(1);
  });

  it('the run detail says why a variant is held (flag on) and nothing when the guard is off', async () => {
    const c = cfg();
    const portal = `${PORTAL_PREFIX}detail-${Date.now()}-${++n}`;
    portals.push(portal);
    const run = await ensureRun({ portal, now: ist(6, 0), cfg: c });
    await step(run.id, 'cron', ist(6, 30), new FakeSender(), c, AUD_ON);
    verdicts = { PREMIUM: HELD, FREE: OK };
    const at = ist(7, 40);
    const mk = (a: AudienceEnv) =>
      createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 }, digest: { cfg: c, audience: a, clock: () => at, portal, alerts: false } });
    const on = await request(mk(AUD_ON)).get(`/api/digest/runs/${run.id}`).set('Cookie', adminCookie);
    const hold = (body: { variants: { audience: string; audienceHold: unknown }[] }, a: string) => body.variants.find((v) => v.audience === a)?.audienceHold;
    expect(hold(on.body, 'PREMIUM')).toMatchObject({ check: 'pending_writes' });
    expect(hold(on.body, 'FREE')).toBeNull();
    const off = await request(mk(AUD_OFF)).get(`/api/digest/runs/${run.id}`).set('Cookie', adminCookie);
    expect(hold(off.body, 'PREMIUM')).toBeNull();
  });
});
