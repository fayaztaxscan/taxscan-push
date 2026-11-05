import request from 'supertest';
import bcrypt from 'bcrypt';
import type { DigestAudience, User, UserRole } from '@prisma/client';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { parseAudienceEnv, parseDigestEnv, type DigestEnv } from '../lib/env';
import { advanceRun, awaitDigestAlerts, ensureRun, pressSendFree, type DigestTrigger } from '../services/digest/runner';
import { digestActions, type ActionsInput } from '../services/digest/screen';
import { digestRunState } from '../services/digest/runState';
import { digestStatus } from '../services/digest/status';
import { alertCopy, EDITOR_KINDS, sendDigestAlerts, staffPushCopy } from '../services/digest/alerts';
import { digestTick, resetDigestTickLogForTests, type TickDeps } from '../services/digest/scheduler';
import type { SelectItems } from '../services/digest/runner';
import type { EmailSender } from '../lib/email';
import { approvalAudiences, awaitingManualPress, freePressRefusal, isManualOnly, MANUAL_NOT_SENT } from '../services/digest/holds';
import { editSubject, subjectLock, SUBJECT_LOCK_TEXT } from '../services/digest/subjectEdit';
import { placeholderContent } from './digestPlaceholderContent';
import { FakeSender } from './digestFakeSender';

/**
 * DIGEST_FREE_MANUAL (brief 2026-11-05-free-digest-manual-push): with the flag on, Premium keeps its daily routine and the
 * Free version is built, frozen and drafted each morning but goes out ONLY through Send Free. Every provider call goes to
 * the in-memory FakeSender; users are throwaway @team.test addresses. The acceptance numbers match the brief.
 */

jest.spyOn(console, 'log').mockImplementation(() => undefined);
jest.spyOn(console, 'warn').mockImplementation(() => undefined);

const PORTAL_PREFIX = 'test-digest-free-manual-';
const QUIET = { start: '23:00', end: '07:00' };
const IST_OFFSET_MIN = 5 * 60 + 30;
const AUTH = `Bearer ${process.env.ADMIN_TOKEN}`;
const PASSWORD = 'Free-manual-pass-1234';

function ist(h: number, min = 0, day = 23): Date {
  return new Date(Date.UTC(2026, 9, day, h, min) - IST_OFFSET_MIN * 60 * 1000);
}

/** Flag ON, approval ON (the default) unless overridden; complete audiences. */
function cfg(over: NodeJS.ProcessEnv = {}): DigestEnv {
  return parseDigestEnv({
    DIGEST_ENABLED: 'true',
    DIGEST_SEND_LIVE: 'true',
    DIGEST_FREE_MANUAL: 'true',
    DIGEST_FREE_LIST_IDS: 'list-free',
    DIGEST_FREE_EXCLUDE_LIST_IDS: 'list-premium',
    DIGEST_PREMIUM_LIST_IDS: 'list-premium',
    DIGEST_POSTAL_ADDRESS: 'Test address, Kochi',
    ...over,
  });
}

const userIds: string[] = [];
async function makeUser(role: UserRole): Promise<User> {
  const email = `digest-free-manual-${role.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e9)}@team.test`;
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

let publisher: User;
let admin: User;
let publisherCookie: string;
let adminCookie: string;

let n = 0;
const portals: string[] = [];
async function newRun(c: DigestEnv) {
  const portal = `${PORTAL_PREFIX}${Date.now()}-${++n}-${Math.floor(Math.random() * 1e6)}`;
  portals.push(portal);
  return ensureRun({ portal, now: ist(6, 0), cfg: c });
}

function tick(runId: string, now: Date, sender: FakeSender, c: DigestEnv, trigger: DigestTrigger = 'cron') {
  return advanceRun(runId, trigger, { sender, now, cfg: c, quiet: QUIET, buildContent: placeholderContent, alerts: false });
}

/** Built at 06:30 IST with both drafts created, nothing scheduled. */
async function createdRun(c: DigestEnv = cfg()) {
  const run = await newRun(c);
  const sender = new FakeSender();
  await tick(run.id, ist(6, 30), sender, c);
  return { run, sender };
}

function sendOf(runId: string, audience: DigestAudience) {
  return prisma.digestSend.findUniqueOrThrow({ where: { runId_audience: { runId, audience } } });
}

/** Which audiences the provider was asked to schedule, in order. */
function scheduled(sender: FakeSender): DigestAudience[] {
  return sender.calls
    .filter((c) => c.method === 'schedule')
    .map((c) => sender.campaigns.get(c.args[0] as string)?.input.audience as DigestAudience);
}

function approveRun(runId: string, by?: string) {
  return prisma.digestRun.update({ where: { id: runId }, data: { approval: 'APPROVED', approvedAt: new Date(), ...(by ? { approvedByUserId: by } : {}) } });
}

function press(runId: string, now: Date, sender: FakeSender, c: DigestEnv = cfg(), extra: Record<string, unknown> = {}) {
  return pressSendFree(runId, publisher.id, { sender, now, cfg: c, quiet: QUIET, buildContent: placeholderContent, alerts: false, ...extra });
}

function appFor(c: DigestEnv, sender: FakeSender, portal: string, at: Date) {
  return createApp({
    rateLimit: { publicPerMin: 10000, loginPerMin: 10000 },
    digest: { cfg: c, clock: () => at, portal, sender, buildContent: placeholderContent, quiet: QUIET, alerts: false, testSendGapSeconds: 0 },
  });
}

beforeAll(async () => {
  publisher = await makeUser('PUBLISHER');
  admin = await makeUser('ADMIN');
  publisherCookie = await cookieFor(publisher);
  adminCookie = await cookieFor(admin);
});

afterAll(async () => {
  await awaitDigestAlerts();
  const runs = await prisma.digestRun.findMany({ where: { portal: { startsWith: PORTAL_PREFIX } }, select: { id: true, sends: { select: { id: true } } } });
  const ids = [...runs.map((r) => r.id), ...runs.flatMap((r) => r.sends.map((s) => s.id))];
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL audit_log.allow_purge = 'true'`);
    if (ids.length) await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "resourceId" = ANY(${ids}::text[])`;
    await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "userId" = ANY(${userIds}::text[])`;
  });
  await prisma.digestRun.deleteMany({ where: { portal: { startsWith: PORTAL_PREFIX } } });
  await prisma.userSession.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe('the shared rule (holds.ts)', () => {
  it('the flag is off by default and only Free is manual-only', () => {
    expect(parseDigestEnv({}).freeManual).toBe(false);
    expect(isManualOnly({ freeManual: false }, 'FREE')).toBe(false);
    expect(isManualOnly({}, 'FREE')).toBe(false);
    expect(isManualOnly({ freeManual: true }, 'FREE')).toBe(true);
    expect(isManualOnly({ freeManual: true }, 'PREMIUM')).toBe(false);
  });

  it('Approve covers Premium only while the flag is on', () => {
    expect(approvalAudiences({ freeManual: true }, ['FREE', 'PREMIUM'])).toEqual(['PREMIUM']);
    expect(approvalAudiences({ freeManual: false }, ['FREE', 'PREMIUM'])).toEqual(['FREE', 'PREMIUM']);
  });

  it('a manual-only Free waits for its press (approvedAt), nothing else', () => {
    expect(awaitingManualPress({ freeManual: true }, { audience: 'FREE', approvedAt: null })).toBe(true);
    expect(awaitingManualPress({ freeManual: true }, { audience: 'FREE', approvedAt: new Date() })).toBe(false);
    expect(awaitingManualPress({ freeManual: true }, { audience: 'PREMIUM', approvedAt: null })).toBe(false);
    expect(awaitingManualPress({ freeManual: false }, { audience: 'FREE', approvedAt: null })).toBe(false);
  });
});

describe('1. flag off: nothing changes', () => {
  it('both versions follow the routine; Send Free is refused and hidden', async () => {
    const c = cfg({ DIGEST_FREE_MANUAL: 'false', DIGEST_APPROVAL_REQUIRED: 'false' });
    const { run, sender } = await createdRun(c);
    await tick(run.id, ist(7, 30), sender, c);
    expect(scheduled(sender).sort()).toEqual(['FREE', 'PREMIUM']);

    const r = await press(run.id, ist(7, 40), sender, c);
    expect(r).toMatchObject({ ok: false, status: 409, code: 'not_manual' });
  });
});

describe('2–3. the tick never schedules a manual-only Free', () => {
  it('2. flag on, Premium approved: Premium sends; Free stays unscheduled through every tick up to the cut-off', async () => {
    const c = cfg();
    const { run, sender } = await createdRun(c);
    await approveRun(run.id);
    for (const t of [ist(7, 30), ist(8, 30), ist(12, 0), ist(16, 58), ist(16, 59)]) await tick(run.id, t, sender, c);
    expect(scheduled(sender)).toEqual(['PREMIUM']);
    const free = await sendOf(run.id, 'FREE');
    expect(free.state).toBe('CREATED');
    expect(free.scheduleAttemptedAt).toBeNull();
    expect(free.approvedAt).toBeNull();
  });

  it('2b. Send now and Retry now never send an unpressed Free either', async () => {
    const c = cfg({ DIGEST_APPROVAL_REQUIRED: 'false' });
    const { run, sender } = await createdRun(c);
    await tick(run.id, ist(7, 0), sender, c, 'send_now');
    await tick(run.id, ist(7, 1), sender, c, 'retry');
    await tick(run.id, ist(7, 2), sender, c, 'health');
    expect(scheduled(sender)).toEqual(['PREMIUM']);
  });

  it('3. flag on with DIGEST_APPROVAL_REQUIRED=false: Premium goes automatically; Free still waits for the button', async () => {
    const c = cfg({ DIGEST_APPROVAL_REQUIRED: 'false' });
    const { run, sender } = await createdRun(c);
    await tick(run.id, ist(7, 30), sender, c);
    expect(scheduled(sender)).toEqual(['PREMIUM']);
    await tick(run.id, ist(9, 0), sender, c);
    expect(scheduled(sender)).toEqual(['PREMIUM']);
    expect((await sendOf(run.id, 'FREE')).state).toBe('CREATED');
  });

  it('the Free draft is built and created each morning, exactly as today', async () => {
    const { run, sender } = await createdRun(cfg());
    const free = await sendOf(run.id, 'FREE');
    expect(free.mcCampaignId).not.toBeNull();
    expect(free.html).not.toBeNull();
    expect(sender.count('createDraft')).toBe(2);
  });
});

describe('4–5. Send Free', () => {
  it('4. pressed before the send time, after quiet hours: Free is scheduled from the press; Premium is not touched or waited for', async () => {
    const c = cfg(); // approval ON and nobody has approved
    const { run, sender } = await createdRun(c);
    const premiumBefore = await sendOf(run.id, 'PREMIUM');
    const r = await press(run.id, ist(7, 10), sender, c);
    expect(r).toMatchObject({ ok: true, scheduled: true, state: 'SCHEDULED' });
    expect(scheduled(sender)).toEqual(['FREE']);
    const free = await sendOf(run.id, 'FREE');
    expect(free.approvedByUserId).toBe(publisher.id);
    expect(free.approvedAt).not.toBeNull();
    const premiumAfter = await sendOf(run.id, 'PREMIUM');
    expect(premiumAfter.state).toBe('CREATED');
    expect(premiumAfter.sendAfter.getTime()).toBe(premiumBefore.sendAfter.getTime());
    expect(premiumAfter.approvedAt).toBeNull();
  });

  it('5. pressed after Premium was sent: Free goes; Premium is not touched', async () => {
    const c = cfg();
    const { run, sender } = await createdRun(c);
    await approveRun(run.id);
    await tick(run.id, ist(7, 30), sender, c);
    expect(scheduled(sender)).toEqual(['PREMIUM']);
    const premium = await sendOf(run.id, 'PREMIUM');
    expect(premium.state).toBe('SCHEDULED');

    const r = await press(run.id, ist(11, 0), sender, c);
    expect(r).toMatchObject({ ok: true, scheduled: true });
    expect(scheduled(sender)).toEqual(['PREMIUM', 'FREE']);
    const after = await sendOf(run.id, 'PREMIUM');
    expect(after.state).toBe('SCHEDULED');
    expect(after.scheduledAt?.getTime()).toBe(premium.scheduledAt?.getTime());
    expect(sender.count('createDraft')).toBe(2);
  });

  it('10. a Premium skip does not stop Free being pressed', async () => {
    const c = cfg();
    const { run, sender } = await createdRun(c);
    await prisma.digestSend.update({ where: { runId_audience: { runId: run.id, audience: 'PREMIUM' } }, data: { state: 'SKIPPED' } });
    const r = await press(run.id, ist(9, 0), sender, c);
    expect(r).toMatchObject({ ok: true, scheduled: true });
    expect(scheduled(sender)).toEqual(['FREE']);
  });
});

describe('6. two presses give one send', () => {
  it('two concurrent presses: exactly one provider schedule call, the other is refused', async () => {
    const c = cfg();
    const { run, sender } = await createdRun(c);
    sender.delayMs = { schedule: 40 };
    const [a, b] = await Promise.all([press(run.id, ist(9, 0), sender, c), press(run.id, ist(9, 0), sender, c)]);
    const results = [a, b];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const lost = results.find((r) => !r.ok);
    expect(lost).toMatchObject({ ok: false, status: 409, code: 'already_pressed' });
    expect(sender.count('schedule')).toBe(1);
  });

  it('a press after a press, and a press after the send, are refused with their own reason', async () => {
    const c = cfg();
    const { run, sender } = await createdRun(c);
    expect((await press(run.id, ist(9, 0), sender, c)).ok).toBe(true);
    expect(await press(run.id, ist(9, 1), sender, c)).toMatchObject({ ok: false, code: 'already_sent' });
    expect(sender.count('schedule')).toBe(1);
  });
});

describe('7. refused with the reason, nothing sent', () => {
  async function expectRefused(runId: string, sender: FakeSender, r: Awaited<ReturnType<typeof press>>, code: string) {
    expect(r).toMatchObject({ ok: false, status: 409, code });
    if (!r.ok) expect(r.message.length).toBeGreaterThan(10);
    expect(sender.count('schedule')).toBe(0);
    const free = await sendOf(runId, 'FREE');
    expect(free.approvedAt).toBeNull(); // a refusal never leaves a press that fires later
    expect(free.scheduleAttemptedAt).toBeNull();
  }

  it('quiet hours', async () => {
    const c = cfg();
    const { run, sender } = await createdRun(c);
    await expectRefused(run.id, sender, await press(run.id, ist(6, 45), sender, c), 'quiet_hours');
    // …and the tick after quiet hours still does not send it.
    await tick(run.id, ist(7, 35), sender, c);
    expect(scheduled(sender)).not.toContain('FREE');
  });

  it('past the cut-off', async () => {
    const c = cfg();
    const { run, sender } = await createdRun(c);
    await expectRefused(run.id, sender, await press(run.id, ist(17, 5), sender, c), 'past_cutoff');
  });

  it('an editor hold', async () => {
    const c = cfg();
    const { run, sender } = await createdRun(c);
    await prisma.digestRun.update({ where: { id: run.id }, data: { approval: 'HELD' } });
    await expectRefused(run.id, sender, await press(run.id, ist(9, 0), sender, c), 'held_by_editor');
  });

  it('a complaint hold (and Premium’s Approve lifts it for both, as one rule)', async () => {
    const c = cfg();
    const { run, sender } = await createdRun(c);
    await prisma.digestRun.update({
      where: { id: run.id },
      data: { complaintCheck: { checkedAt: ist(6, 15).toISOString(), thresholdPct: 0.3, held: true, previousRunDate: '2026-10-22', sends: [] } },
    });
    await expectRefused(run.id, sender, await press(run.id, ist(9, 0), sender, c), 'complaint_hold');
    await approveRun(run.id);
    expect((await press(run.id, ist(9, 1), sender, c)).ok).toBe(true);
  });

  it('the sanity hold', async () => {
    const c = cfg();
    const { run, sender } = await createdRun(c);
    await prisma.digestRun.update({ where: { id: run.id }, data: { candidateCount: c.sanityMaxCandidates + 1, approval: 'PENDING' } });
    await expectRefused(run.id, sender, await press(run.id, ist(9, 0), sender, c), 'sanity_hold');
  });

  it('no draft yet', async () => {
    const c = cfg();
    const run = await newRun(c);
    const sender = new FakeSender();
    sender.fail('createDraft', 'RETRYABLE', 2);
    await tick(run.id, ist(6, 30), sender, c);
    await expectRefused(run.id, sender, await press(run.id, ist(9, 0), sender, c), 'no_draft');
  });

  it('DIGEST_SEND_LIVE off', async () => {
    const c = cfg({ DIGEST_SEND_LIVE: 'false' });
    const { run, sender } = await createdRun(c);
    await expectRefused(run.id, sender, await press(run.id, ist(9, 0), sender, c), 'preview_only');
  });

  it('an invalid Free target (no reader list)', async () => {
    const c = cfg();
    const { run, sender } = await createdRun(c);
    const broken = cfg({ DIGEST_FREE_LIST_IDS: '' });
    await expectRefused(run.id, sender, await press(run.id, ist(9, 0), sender, broken), 'config_invalid');
  });

  it('a refused audience guard (fail closed)', async () => {
    const c = cfg();
    const { run, sender } = await createdRun(c);
    // The CMS audience on, with its tags set but no sync ever run: the guard cannot verify the lists, so it refuses.
    const guardOn = parseAudienceEnv({
      AUDIENCE_SYNC_ENABLED: 'true',
      DIGEST_AUDIENCE_FROM_CMS: 'true',
      AUDIENCE_MC_TAG_PREMIUM: 'tag-premium',
      AUDIENCE_MC_TAG_FORMER: 'tag-former',
      AUDIENCE_MC_TAG_NO_MARKETING: 'tag-nomkt',
    });
    const r = await press(run.id, ist(9, 0), sender, c, { audience: guardOn });
    await expectRefused(run.id, sender, r, 'audience_unverified');
  });

  it('every refusal has plain words', () => {
    for (const code of [
      'not_manual', 'not_built', 'no_draft', 'content_pending', 'preview_only', 'held_by_editor', 'sanity_hold', 'complaint_hold',
      'quiet_hours', 'past_cutoff', 'config_invalid', 'audience_unverified', 'already_pressed', 'already_sent', 'skipped', 'failed_final',
    ]) {
      expect(freePressRefusal(code).length).toBeGreaterThan(15);
      expect(freePressRefusal(code)).not.toMatch(/\b[a-z]+_[a-z_]+\b/); // no raw lower-case code in the sentence (env names like DIGEST_SEND_LIVE are fine)
    }
  });
});

describe('8–9. unpressed at the cut-off', () => {
  it('8. Free is SKIPPED as manual_not_sent: no alert, no banner, no run skip reason; Premium is untouched', async () => {
    const c = cfg();
    const { run, sender } = await createdRun(c);
    await approveRun(run.id);
    await tick(run.id, ist(7, 30), sender, c);
    sender.setStatus({ state: 'SENT', targeted: 100, reached: 100 });
    await tick(run.id, ist(17, 0), sender, c);

    const free = await sendOf(run.id, 'FREE');
    expect(free.state).toBe('SKIPPED');
    expect(free.lastError).toBe(MANUAL_NOT_SENT);
    expect((await sendOf(run.id, 'PREMIUM')).state).toBe('SENT');
    const row = await prisma.digestRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.skipReason).toBeNull();
    expect(Object.keys((row.alerts ?? {}) as Record<string, unknown>)).not.toContain('skipped');

    const audit = await prisma.auditLog.findMany({ where: { resourceType: 'DigestSend', resourceId: free.id, action: 'DIGEST_SKIPPED' } });
    expect(audit).toHaveLength(1);
    expect((audit[0].metadata as { reason: string }).reason).toBe(MANUAL_NOT_SENT);

    const status = await digestStatus({ cfg: c, portal: run.portal, now: ist(17, 1) });
    expect(status.attention).toBeNull();
    expect(status.today?.state).toBe('sent');
  });

  it('8b. Premium’s own skip still alerts exactly as today', async () => {
    const c = cfg(); // approval ON, nobody approves
    const { run, sender } = await createdRun(c);
    await tick(run.id, ist(17, 0), sender, c);
    const row = await prisma.digestRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.skipReason).toBe('not_approved');
    expect(Object.keys((row.alerts ?? {}) as Record<string, unknown>)).toContain('skipped');
    expect((await sendOf(run.id, 'PREMIUM')).state).toBe('SKIPPED');
    expect((await sendOf(run.id, 'FREE')).lastError).toBe(MANUAL_NOT_SENT);
  });

  it('9. an unsent Free ends SKIPPED, the state tomorrow’s roll-forward reads (builder.ts rollsForward)', async () => {
    const c = cfg({ DIGEST_APPROVAL_REQUIRED: 'false' });
    const { run, sender } = await createdRun(c);
    await tick(run.id, ist(7, 30), sender, c);
    await tick(run.id, ist(17, 0), sender, c);
    expect((await sendOf(run.id, 'FREE')).state).toBe('SKIPPED');
  });

  it('a Free pressed in time is never skipped, and its press survives to the cut-off', async () => {
    const c = cfg();
    const { run, sender } = await createdRun(c);
    await press(run.id, ist(9, 0), sender, c);
    sender.setStatus({ state: 'SENT', targeted: 50, reached: 50 });
    await tick(run.id, ist(17, 0), sender, c);
    expect((await sendOf(run.id, 'FREE')).state).toBe('SENT');
  });
});

describe('11. the route: roles, confirm, audit', () => {
  it('signed out → 401; the ADMIN_TOKEN bearer is refused; no confirm → 400', async () => {
    const c = cfg();
    const { run, sender } = await createdRun(c);
    const app = appFor(c, sender, run.portal, ist(9, 0));
    expect((await request(app).post(`/api/digest/runs/${run.id}/send-free`).send({ confirm: true })).status).toBe(401);
    const bearer = await request(app).post(`/api/digest/runs/${run.id}/send-free`).set('Authorization', AUTH).send({ confirm: true });
    expect([401, 403]).toContain(bearer.status);
    const noConfirm = await request(app).post(`/api/digest/runs/${run.id}/send-free`).set('Cookie', publisherCookie).send({});
    expect(noConfirm.status).toBe(400);
    expect(sender.count('schedule')).toBe(0);
  });

  it('PUBLISHER and ADMIN may press; one audit row per real send, with no address and no headline', async () => {
    const c = cfg();
    const first = await createdRun(c);
    const app = appFor(c, first.sender, first.run.portal, ist(9, 0));
    const ok = await request(app).post(`/api/digest/runs/${first.run.id}/send-free`).set('Cookie', publisherCookie).send({ confirm: true });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, scheduled: true });

    const again = await request(app).post(`/api/digest/runs/${first.run.id}/send-free`).set('Cookie', publisherCookie).send({ confirm: true });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('already_sent');

    const rows = await prisma.auditLog.findMany({ where: { resourceType: 'DigestRun', resourceId: first.run.id, action: 'DIGEST_FREE_PRESSED' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(publisher.id);
    const meta = rows[0].metadata as Record<string, unknown>;
    expect(Object.keys(meta).sort()).toEqual(['audience', 'scheduled', 'state']);
    const blob = JSON.stringify(rows[0]);
    expect(blob).not.toContain(publisher.email);
    const titles = (await prisma.digestItem.findMany({ where: { runId: first.run.id }, select: { title: true } })).map((t) => t.title);
    for (const t of titles) expect(blob).not.toContain(t);

    const second = await createdRun(c);
    const app2 = appFor(c, second.sender, second.run.portal, ist(9, 0));
    const asAdmin = await request(app2).post(`/api/digest/runs/${second.run.id}/send-free`).set('Cookie', adminCookie).send({ confirm: true });
    expect(asAdmin.status).toBe(200);
    expect(second.sender.count('schedule')).toBe(1);
  });

  it('two concurrent HTTP presses: one 200, one 409, one schedule call', async () => {
    const c = cfg();
    const { run, sender } = await createdRun(c);
    sender.delayMs = { schedule: 40 };
    const app = appFor(c, sender, run.portal, ist(9, 0));
    const go = () => request(app).post(`/api/digest/runs/${run.id}/send-free`).set('Cookie', publisherCookie).send({ confirm: true });
    const res = await Promise.all([go(), go()]);
    expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(sender.count('schedule')).toBe(1);
    const rows = await prisma.auditLog.findMany({ where: { resourceType: 'DigestRun', resourceId: run.id, action: 'DIGEST_FREE_PRESSED' } });
    expect(rows).toHaveLength(1);
  });

  it('a refused press writes no audit row and answers 409 with the reason', async () => {
    const c = cfg();
    const { run, sender } = await createdRun(c);
    const app = appFor(c, sender, run.portal, ist(6, 45)); // quiet hours
    const res = await request(app).post(`/api/digest/runs/${run.id}/send-free`).set('Cookie', publisherCookie).send({ confirm: true });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('quiet_hours');
    expect(res.body.message).toMatch(/quiet hours/);
    expect(await prisma.auditLog.count({ where: { resourceId: run.id, action: 'DIGEST_FREE_PRESSED' } })).toBe(0);
  });

  it('Approve ignores a manual-only Free even when the request names it', async () => {
    const c = cfg();
    const { run, sender } = await createdRun(c);
    await prisma.digestSend.update({ where: { runId_audience: { runId: run.id, audience: 'FREE' } }, data: { ownApprovalRequired: true } });
    const app = appFor(c, sender, run.portal, ist(9, 0));
    const res = await request(app).post(`/api/digest/runs/${run.id}/approve`).set('Cookie', publisherCookie).send({ audiences: ['FREE', 'PREMIUM'] });
    expect(res.status).toBe(200);
    expect(res.body.variants).toEqual([]);
    const free = await sendOf(run.id, 'FREE');
    expect(free.approvedAt).toBeNull();
    await tick(run.id, ist(9, 5), sender, c);
    expect(scheduled(sender)).toEqual(['PREMIUM']);
  });
});

describe('12. a restart between the press and the schedule', () => {
  it('the press is durable: the next tick sends once, never twice', async () => {
    const c = cfg();
    const { run, sender } = await createdRun(c);
    // The press was stamped, then the process died before schedule().
    await prisma.digestSend.update({
      where: { runId_audience: { runId: run.id, audience: 'FREE' } },
      data: { approvedAt: ist(9, 0), approvedByUserId: publisher.id, sendAfter: ist(9, 0) },
    });
    await tick(run.id, ist(9, 1), sender, c);
    await tick(run.id, ist(9, 2), sender, c);
    expect(scheduled(sender)).toEqual(['FREE']);
    expect((await sendOf(run.id, 'FREE')).state).toBe('SCHEDULED');
  });

  it('a reply lost after schedule(): the retry asks the provider first and never calls schedule() again', async () => {
    const c = cfg();
    const { run, sender } = await createdRun(c);
    sender.fail('schedule', 'AMBIGUOUS', 1, { applied: true });
    const r = await press(run.id, ist(9, 0), sender, c);
    expect(r.ok).toBe(true);
    expect(sender.count('schedule')).toBe(1);
    await tick(run.id, ist(9, 20), sender, c);
    await tick(run.id, ist(9, 40), sender, c);
    expect(sender.count('schedule')).toBe(1);
    expect((await sendOf(run.id, 'FREE')).state).toBe('SCHEDULED');
  });
});

describe('the screen (digestActions)', () => {
  const base = (over: Partial<ActionsInput> = {}, free: Partial<ActionsInput['sends'][number]> = {}): ActionsInput => ({
    cfg: { enabled: true, sendLive: true, approvalRequired: true, sanityMaxCandidates: 150, cutoff: '17:00', freeManual: true },
    now: ist(10, 0),
    quiet: QUIET,
    providerReady: true,
    viewerCanTest: false,
    run: { runDate: new Date(Date.UTC(2026, 9, 23)), build: 'BUILT', approval: 'PENDING', candidateCount: 20 },
    sends: [
      { audience: 'FREE', state: 'CREATED', lastError: null, nextAttemptAt: null, mcCampaignId: 'c-free', hasHtml: true, ownApprovalRequired: false, approvedAt: null, adoptedDraftAt: null, ...free },
      { audience: 'PREMIUM', state: 'CREATED', lastError: null, nextAttemptAt: null, mcCampaignId: 'c-prem', hasHtml: true, ownApprovalRequired: false, approvedAt: null, adoptedDraftAt: null },
    ],
    ...over,
  });

  it('hidden with the flag off', () => {
    const i = base();
    i.cfg = { ...i.cfg, freeManual: false };
    expect(digestActions(i).sendFree.show).toBe(false);
  });

  it('on when nothing blocks it, even though the run is not approved', () => {
    expect(digestActions(base()).sendFree).toEqual({ show: true, enabled: true, reason: null });
  });

  it('stays on offer after Premium was sent (open is false by then), until the cut-off', () => {
    const i = base();
    i.sends = i.sends.map((s) => (s.audience === 'PREMIUM' ? { ...s, state: 'SENT' as const } : s));
    expect(digestActions(i).sendNow.show).toBe(false);
    expect(digestActions(i).sendFree).toEqual({ show: true, enabled: true, reason: null });
  });

  it('stays on offer after a Premium skip', () => {
    const i = base();
    i.sends = i.sends.map((s) => (s.audience === 'PREMIUM' ? { ...s, state: 'SKIPPED' as const } : s));
    expect(digestActions(i).sendFree.enabled).toBe(true);
  });

  it('shows why it cannot be pressed, in the shared words', () => {
    const quiet = digestActions(base({ now: ist(6, 45) })).sendFree;
    expect(quiet).toMatchObject({ show: true, enabled: false });
    expect(quiet.reason).toBe(freePressRefusal('quiet_hours', { quiet: QUIET }));
    expect(digestActions(base({ run: { ...base().run, approval: 'HELD' } })).sendFree.reason).toBe(freePressRefusal('held_by_editor'));
    expect(digestActions(base({}, { mcCampaignId: null })).sendFree.reason).toBe(freePressRefusal('no_draft'));
    expect(digestActions(base({ now: ist(17, 5) })).sendFree.reason).toBe(freePressRefusal('past_cutoff', { cutoff: '17:00' }));
    expect(digestActions(base({}, { approvedAt: new Date() })).sendFree.reason).toBe(freePressRefusal('already_pressed'));
    expect(digestActions(base({}, { state: 'SENT' })).sendFree.reason).toBe(freePressRefusal('already_sent'));
    const off = base();
    off.cfg = { ...off.cfg, sendLive: false };
    expect(digestActions(off).sendFree.reason).toBe(freePressRefusal('preview_only'));
  });

  it('hidden once Free has been skipped', () => {
    expect(digestActions(base({}, { state: 'SKIPPED' })).sendFree.show).toBe(false);
  });

  it('Approve is not offered for a manual-only Free that has "its own approval" pending', () => {
    const i = base({ run: { ...base().run, approval: 'APPROVED' } }, { ownApprovalRequired: true });
    expect(digestActions(i).approve.show).toBe(false);
  });
});

describe('run state and wording', () => {
  const s = (audience: DigestAudience, state: 'CREATED' | 'SENT' | 'SKIPPED' | 'PENDING', lastError: string | null = null, approvedAt: Date | null = null) => ({ audience, state, lastError, approvedAt });

  it('Premium sent + Free waiting for its press reads "sent", not "created"', () => {
    expect(digestRunState({ build: 'BUILT' }, [s('PREMIUM', 'SENT'), s('FREE', 'CREATED')], { freeManual: true })).toBe('sent');
    expect(digestRunState({ build: 'BUILT' }, [s('PREMIUM', 'SENT'), s('FREE', 'CREATED')])).toBe('created'); // flag off: as before
  });

  it('Premium sent + Free unsent at the cut-off reads "sent", not "partly sent"', () => {
    expect(digestRunState({ build: 'BUILT' }, [s('PREMIUM', 'SENT'), s('FREE', 'SKIPPED', MANUAL_NOT_SENT)])).toBe('sent');
    expect(digestRunState({ build: 'BUILT' }, [s('PREMIUM', 'SENT'), s('FREE', 'SKIPPED')])).toBe('partially_sent'); // any other skip still does
  });

  it('only waiting / unsent rows: "created" while waiting, "skipped" after the day', () => {
    expect(digestRunState({ build: 'BUILT' }, [s('FREE', 'CREATED')], { freeManual: true })).toBe('created');
    expect(digestRunState({ build: 'BUILT' }, [s('PREMIUM', 'SKIPPED'), s('FREE', 'SKIPPED', MANUAL_NOT_SENT)])).toBe('skipped');
    expect(digestRunState({ build: 'BUILT' }, [s('FREE', 'SKIPPED', MANUAL_NOT_SENT)])).toBe('skipped');
  });

  it('a pressed Free counts as an ordinary version again', () => {
    expect(digestRunState({ build: 'BUILT' }, [s('PREMIUM', 'SENT'), s('FREE', 'CREATED', null, new Date())], { freeManual: true })).toBe('created');
  });

  it('the ready / not-approved alerts and staff pushes speak only about Premium while the flag is on', () => {
    const on = cfg();
    const off = cfg({ DIGEST_FREE_MANUAL: 'false' });
    expect(alertCopy('ready_for_approval', { audiences: ['PREMIUM'] }, on).what).toMatch(/^Premium version is built/);
    expect(alertCopy('not_approved_yet', {}, on).short).toMatch(/Premium/);
    expect(alertCopy('not_approved_yet', {}, off).short).not.toMatch(/Premium/);
    expect(staffPushCopy('ready_for_approval', {}, on)?.title).toMatch(/Premium/);
    expect(staffPushCopy('not_approved_yet', {}, on)?.title).toMatch(/Premium/);
    expect(staffPushCopy('ready_for_approval', {}, off)?.title).not.toMatch(/Premium/);
    expect(alertCopy('skipped', { reason: MANUAL_NOT_SENT }, on).what).toMatch(/Send Free/);
  });
});

describe('alerts at the build and at T+60', () => {
  it('the ready note names Premium only, and not_approved_yet never fires for an unpressed Free alone', async () => {
    const c = cfg();
    const run = await newRun(c);
    const sender = new FakeSender();
    await advanceRun(run.id, 'cron', { sender, now: ist(6, 30), cfg: c, quiet: QUIET, buildContent: placeholderContent, alerts: false });
    const row = await prisma.digestRun.findUniqueOrThrow({ where: { id: run.id } });
    const marker = ((row.alerts ?? {}) as Record<string, { audiences?: string[] }>).ready_for_approval;
    expect(marker?.audiences).toEqual(['PREMIUM']);
  });
});

describe('the tick: reminders and cut-off emails speak only about Premium', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const selectItems: SelectItems = async (_run, now) => ({
    windowStart: new Date(now.getTime() - DAY),
    windowEnd: now,
    candidateCount: 20,
    outcome: 'ok',
    perAudience: { FREE: [], PREMIUM: [] },
    mainCounts: { FREE: 8, PREMIUM: 8 },
    rows: [],
    reads: { used: false, source: 'off', note: null },
    droppedDead: 0,
  });

  function day(c: DigestEnv) {
    const portal = `${PORTAL_PREFIX}tick-${Date.now()}-${++n}-${Math.floor(Math.random() * 1e6)}`;
    portals.push(portal);
    const sender = new FakeSender({ withLookup: true });
    const mails: { to: string; subject: string }[] = [];
    let now = ist(0, 0);
    const run = async (h: number, min = 0, extra: Partial<TickDeps> = {}) => {
      now = ist(h, min);
      const emailSender: EmailSender = async (m) => {
        mails.push({ to: m.to, subject: m.subject });
        return { ok: true };
      };
      return digestTick({
        sender,
        cfg: c,
        quiet: QUIET,
        now,
        portals: [portal],
        buildContent: placeholderContent,
        selectItems,
        awaitAlerts: true,
        log: () => undefined,
        alerts: (runId) =>
          sendDigestAlerts(runId, {
            cfg: c,
            now,
            emailSender,
            isConfigured: () => true,
            recipients: async (kind) => (kind && EDITOR_KINDS.has(kind) ? ['editor@team.test'] : ['admin@team.test']),
          }),
        ...extra,
      });
    };
    const runRow = () => prisma.digestRun.findFirstOrThrow({ where: { portal } });
    return { portal, sender, mails, run, runRow };
  }
  const like = (mails: { subject: string }[], re: RegExp) => mails.filter((m) => re.test(m.subject));

  beforeEach(() => resetDigestTickLogForTests());

  it('ready note and the 08:30 reminder name Premium; an unpressed Free is never nagged about', async () => {
    const d = day(cfg());
    await d.run(6, 15);
    await d.run(6, 30);
    expect(like(d.mails, /ready for approval/i)).toHaveLength(1);
    await d.run(8, 30);
    const nag = like(d.mails, /still waiting for approval/);
    expect(nag).toHaveLength(1);
    expect(nag[0].subject).toMatch(/Premium/);
  });

  it('Premium approved and sent, Free unpressed: no reminder at 08:30 and no "skipped" email at 17:00', async () => {
    const d = day(cfg());
    await d.run(6, 15);
    await d.run(6, 30);
    await approveRun((await d.runRow()).id);
    await d.run(7, 30);
    d.sender.setStatus({ state: 'SENT', targeted: 10, reached: 10 });
    await d.run(8, 30);
    await d.run(12, 0);
    await d.run(17, 0);
    expect(like(d.mails, /still waiting/)).toHaveLength(0);
    expect(like(d.mails, /was skipped/)).toHaveLength(0);
    const run = await d.runRow();
    expect((await sendOf(run.id, 'FREE')).state).toBe('SKIPPED');
    expect((await sendOf(run.id, 'FREE')).lastError).toBe(MANUAL_NOT_SENT);
    expect((await sendOf(run.id, 'PREMIUM')).state).toBe('SENT');
  });

  it('the same day with the flag off still nags and skips as before', async () => {
    const d = day(cfg({ DIGEST_FREE_MANUAL: 'false' }));
    await d.run(6, 15);
    await d.run(6, 30);
    await d.run(8, 30);
    expect(like(d.mails, /still waiting for approval/)).toHaveLength(1);
    expect(like(d.mails, /still waiting for approval/)[0].subject).not.toMatch(/Premium/);
    await d.run(17, 0);
    expect(like(d.mails, /was skipped/)).toHaveLength(1);
  });
});

describe('Follow-up 1: Free’s subject stays editable until Send Free is pressed', () => {
  const NEW = 'A better subject line for Free readers';
  const edit = (runId: string, audience: DigestAudience, sender: FakeSender, c: DigestEnv, now = ist(9, 0), raw: unknown = NEW) =>
    editSubject({ runId, audience, raw, now, cfg: c, sender });
  const providerSubject = (sender: FakeSender, id: string | null) => (id ? sender.campaigns.get(id)?.input.subject : undefined);

  it('1. flag on, Premium approved, Free unpressed: Free’s subject can be edited and the draft is updated', async () => {
    const c = cfg();
    const { run, sender } = await createdRun(c);
    await approveRun(run.id);
    const r = await edit(run.id, 'FREE', sender, c);
    expect(r.status).toBe(200);
    const free = await sendOf(run.id, 'FREE');
    expect(free.subject).toBe(NEW);
    expect(providerSubject(sender, free.mcCampaignId)).toBe(NEW);
    expect(sender.count('updateSubject')).toBe(1);
  });

  it('2. flag on, Free pressed: refused with the existing "approved" reason', async () => {
    const c = cfg();
    const { run, sender } = await createdRun(c);
    expect((await press(run.id, ist(9, 0), sender, c)).ok).toBe(true);
    const r = await edit(run.id, 'FREE', sender, c, ist(9, 5));
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: 'approved', message: SUBJECT_LOCK_TEXT.approved });
    expect(sender.count('updateSubject')).toBe(0);
  });

  it('3. flag on: Premium’s subject after Approve is still locked', async () => {
    const c = cfg();
    const { run, sender } = await createdRun(c);
    await approveRun(run.id);
    const r = await edit(run.id, 'PREMIUM', sender, c);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: 'approved' });
    expect(sender.count('updateSubject')).toBe(0);
  });

  it('4. flag on: the other locks still refuse Free (past the cut-off, scheduled, not today, not built)', async () => {
    const c = cfg();
    const { run, sender } = await createdRun(c);
    const past = await edit(run.id, 'FREE', sender, c, ist(17, 5));
    expect(past.body).toMatchObject({ error: 'past_cutoff' });
    const otherDay = await edit(run.id, 'FREE', sender, c, ist(9, 0, 24));
    expect(otherDay.body).toMatchObject({ error: 'not_today' });
    await prisma.digestSend.update({ where: { runId_audience: { runId: run.id, audience: 'FREE' } }, data: { scheduleAttemptedAt: ist(8, 0) } });
    const sched = await edit(run.id, 'FREE', sender, c);
    expect(sched.body).toMatchObject({ error: 'scheduled' });
    // pure rule, same file: an unbuilt run
    const free = { audience: 'FREE', state: 'CREATED' as const, scheduleAttemptedAt: null, createAttemptedAt: null, approvedAt: null };
    expect(subjectLock({ runDate: new Date(Date.UTC(2026, 9, 23)), build: 'BUILDING', approval: 'PENDING' }, free, ist(9, 0), c)).toBe('not_built');
    expect(sender.count('updateSubject')).toBe(0);
  });

  it('5. flag off: both versions lock on Approve exactly as before', () => {
    const off = cfg({ DIGEST_FREE_MANUAL: 'false' });
    const run = { runDate: new Date(Date.UTC(2026, 9, 23)), build: 'BUILT' as const, approval: 'APPROVED' as const };
    for (const audience of ['FREE', 'PREMIUM']) {
      const send = { audience, state: 'CREATED' as const, scheduleAttemptedAt: null, createAttemptedAt: null, approvedAt: null };
      expect(subjectLock(run, send, ist(9, 0), off)).toBe('approved');
    }
    // the same inputs with the flag on: Premium locked, Free open
    const on = cfg();
    const free = { audience: 'FREE', state: 'CREATED' as const, scheduleAttemptedAt: null, createAttemptedAt: null, approvedAt: null };
    expect(subjectLock(run, free, ist(9, 0), on)).toBeNull();
    expect(subjectLock(run, { ...free, audience: 'PREMIUM' }, ist(9, 0), on)).toBe('approved');
    expect(subjectLock(run, { ...free, approvedAt: ist(9, 1) }, ist(9, 2), on)).toBe('approved');
  });

  it('6. a press landing between the lock check and the write cannot be overtaken by the edit', async () => {
    const c = cfg();
    const { run, sender } = await createdRun(c);
    const before = (await sendOf(run.id, 'FREE')).subject;
    const real = prisma.digestSend.updateMany.bind(prisma.digestSend);
    let stamped = false;
    const spy = jest.spyOn(prisma.digestSend, 'updateMany').mockImplementation(((args: Parameters<typeof real>[0]) => {
      if (!stamped) {
        stamped = true;
        // The press stamps `approvedAt` after the edit's lock check but before its conditional update.
        return real({ where: { runId: run.id, audience: 'FREE' }, data: { approvedAt: ist(9, 0), approvedByUserId: publisher.id } }).then(() => real(args));
      }
      return real(args);
    }) as never);
    try {
      const r = await edit(run.id, 'FREE', sender, c);
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ error: 'changed' });
    } finally {
      spy.mockRestore();
    }
    expect((await sendOf(run.id, 'FREE')).subject).toBe(before);
    expect(sender.count('updateSubject')).toBe(0);
  });

  it('the screen shows the same rule: Free editable after Approve, locked after the press; Premium locked', async () => {
    const c = cfg();
    const { run, sender } = await createdRun(c);
    await approveRun(run.id);
    const app = appFor(c, sender, run.portal, ist(9, 0));
    const detail = async () => (await request(app).get(`/api/digest/runs/${run.id}`).set('Cookie', publisherCookie)).body;
    let d = await detail();
    const by = (a: string) => d.variants.find((v: { audience: string }) => v.audience === a).subjectEdit;
    expect(by('FREE')).toEqual({ editable: true, reason: null });
    expect(by('PREMIUM')).toMatchObject({ editable: false, reason: SUBJECT_LOCK_TEXT.approved });
    await press(run.id, ist(9, 0), sender, c);
    d = await detail();
    expect(by('FREE')).toMatchObject({ editable: false, reason: SUBJECT_LOCK_TEXT.approved });
  });
});
