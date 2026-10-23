import request from 'supertest';
import bcrypt from 'bcrypt';
import type { User, UserRole } from '@prisma/client';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { parseDigestEnv, type DigestEnv } from '../lib/env';
import { advanceRun, awaitDigestAlerts, ensureRun } from '../services/digest/runner';
import { digestActions, itemReadBasis, readsLine, type ActionsInput } from '../services/digest/screen';
import { PREVIEW_CSP } from '../routes/digest';
import { digestStatus } from '../services/digest/status';
import { MockSenderInProductionError, mockSendersEnabled } from '../lib/mockSenderGuard';
import { placeholderContent } from './digestPlaceholderContent';
import { FakeSender } from './digestFakeSender';

/**
 * Email digest task 7 (docs/EMAIL_DIGEST_DESIGN.md §6, §7, §9): the Digests
 * screen's routes. Every provider call goes to the in-memory FakeSender; users
 * and recipients are throwaway @team.test / example addresses.
 */

jest.spyOn(console, 'log').mockImplementation(() => undefined);
jest.spyOn(console, 'warn').mockImplementation(() => undefined);

const PORTAL_PREFIX = 'test-digest-screen-';
const QUIET = { start: '23:00', end: '07:00' };
const IST_OFFSET_MIN = 5 * 60 + 30;
const AUTH = `Bearer ${process.env.ADMIN_TOKEN}`;
const READER = 'reader.person@example.org';
const PASSWORD = 'Screen-test-pass-1234';

function ist(h: number, min = 0, day = 23): Date {
  return new Date(Date.UTC(2026, 9, day, h, min) - IST_OFFSET_MIN * 60 * 1000);
}

const userIds: string[] = [];
const portals: string[] = [];
let tester: User; // PUBLISHER, listed in DIGEST_TEST_RECIPIENTS
let outsider: User; // ADMIN, not listed

function cfg(over: NodeJS.ProcessEnv = {}): DigestEnv {
  return parseDigestEnv({
    DIGEST_ENABLED: 'true',
    DIGEST_SEND_LIVE: 'true',
    DIGEST_APPROVAL_REQUIRED: 'false',
    DIGEST_FREE_LIST_IDS: 'list-free',
    DIGEST_FREE_EXCLUDE_LIST_IDS: 'list-premium',
    DIGEST_PREMIUM_LIST_IDS: 'list-premium',
    DIGEST_POSTAL_ADDRESS: 'Test address, Kochi',
    DIGEST_TEST_RECIPIENTS: `someone.else@team.test, ${tester.email.toUpperCase()}`,
    ...over,
  });
}

async function makeUser(role: UserRole): Promise<User> {
  const email = `digest-screen-${role.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e9)}@team.test`;
  const u = await prisma.user.create({
    data: { email, passwordHash: await bcrypt.hash(PASSWORD, 4), role, isActive: true },
  });
  userIds.push(u.id);
  return u;
}

const loginApp = createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 } });
async function cookieFor(u: User): Promise<string> {
  const res = await request(loginApp).post('/api/auth/login').send({ email: u.email, password: PASSWORD });
  expect(res.status).toBe(200);
  const sc = res.headers['set-cookie'];
  const arr = Array.isArray(sc) ? sc : [sc as unknown as string];
  return arr.map((l) => l.split(';')[0]).join('; ');
}

let n = 0;
/** A run built at 06:30 IST with drafts created (state `created`). */
async function createdRun(c: DigestEnv, sender: FakeSender) {
  const portal = `${PORTAL_PREFIX}${Date.now()}-${++n}`;
  portals.push(portal);
  const run = await ensureRun({ portal, now: ist(6, 0), cfg: c });
  await advanceRun(run.id, 'cron', { sender, now: ist(6, 30), cfg: c, quiet: QUIET, buildContent: placeholderContent, alerts: false });
  return run;
}

function appFor(c: DigestEnv, sender: FakeSender, portal: string, at: Date) {
  return createApp({
    rateLimit: { publicPerMin: 10000, loginPerMin: 10000 },
    digest: { cfg: c, clock: () => at, portal, sender, buildContent: placeholderContent, quiet: QUIET, alerts: false, testSendGapSeconds: 0 },
  });
}

async function auditRows(runId: string, action: string) {
  return prisma.auditLog.findMany({ where: { resourceType: 'DigestRun', resourceId: runId, action: action as never } });
}

let testerCookie: string;
let outsiderCookie: string;

beforeAll(async () => {
  tester = await makeUser('PUBLISHER');
  outsider = await makeUser('ADMIN');
  testerCookie = await cookieFor(tester);
  outsiderCookie = await cookieFor(outsider);
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

describe('auth', () => {
  it('401 without a session on every screen route', async () => {
    const c = cfg();
    const sender = new FakeSender();
    const run = await createdRun(c, sender);
    const app = appFor(c, sender, run.portal, ist(7, 0));
    const gets = ['/api/digest/runs', `/api/digest/runs/${run.id}`, `/api/digest/runs/${run.id}/preview/free`];
    for (const p of gets) expect((await request(app).get(p)).status).toBe(401);
    const posts = ['approve', 'hold', 'send-now', 'retry', 'test-send/free'];
    for (const p of posts) expect((await request(app).post(`/api/digest/runs/${run.id}/${p}`).send({ confirm: true })).status).toBe(401);
    expect(sender.count('schedule')).toBe(0);
    expect(sender.count('testSend')).toBe(0);
  });

  it('approve / hold / test send need a person: the bearer is refused', async () => {
    const c = cfg({ DIGEST_APPROVAL_REQUIRED: 'true' });
    const sender = new FakeSender();
    const run = await createdRun(c, sender);
    const app = appFor(c, sender, run.portal, ist(7, 0));
    for (const p of ['approve', 'hold', 'test-send/free']) {
      expect((await request(app).post(`/api/digest/runs/${run.id}/${p}`).set('Authorization', AUTH)).status).toBe(401);
    }
  });
});

describe('approve and hold', () => {
  it('a PUBLISHER approves, then holds; each writes an audit row with the userId', async () => {
    const c = cfg({ DIGEST_APPROVAL_REQUIRED: 'true' });
    const sender = new FakeSender();
    const run = await createdRun(c, sender);
    const app = appFor(c, sender, run.portal, ist(7, 0));

    const a = await request(app).post(`/api/digest/runs/${run.id}/approve`).set('Cookie', testerCookie);
    expect(a.status).toBe(200);
    let row = await prisma.digestRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(row).toMatchObject({ approval: 'APPROVED', approvedByUserId: tester.id });
    expect(await auditRows(run.id, 'DIGEST_APPROVED')).toEqual([expect.objectContaining({ userId: tester.id })]);

    // Approving again is refused (not waiting for approval any more).
    expect((await request(app).post(`/api/digest/runs/${run.id}/approve`).set('Cookie', testerCookie)).status).toBe(409);

    const h = await request(app).post(`/api/digest/runs/${run.id}/hold`).set('Cookie', outsiderCookie);
    expect(h.status).toBe(200);
    row = await prisma.digestRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.approval).toBe('HELD');
    expect(await auditRows(run.id, 'DIGEST_HELD')).toEqual([expect.objectContaining({ userId: outsider.id })]);
    expect(sender.count('schedule')).toBe(0);
  });

  it('hold is refused once a variant is handed to Mailercloud', async () => {
    const c = cfg();
    const sender = new FakeSender();
    const run = await createdRun(c, sender);
    await advanceRun(run.id, 'cron', { sender, now: ist(7, 30), cfg: c, quiet: QUIET, buildContent: placeholderContent, alerts: false });
    const app = appFor(c, sender, run.portal, ist(7, 35));
    const h = await request(app).post(`/api/digest/runs/${run.id}/hold`).set('Cookie', testerCookie);
    expect(h.status).toBe(409);
    expect(await auditRows(run.id, 'DIGEST_HELD')).toHaveLength(0);
  });
});

describe('an adopted Mailercloud draft (owner decision A, 2026-10-23)', () => {
  it('auto mode: Approve is offered for that variant alone, the approval stamps only it, and only then is it scheduled', async () => {
    const c = cfg(); // DIGEST_APPROVAL_REQUIRED=false in this file
    const sender = new FakeSender();
    const run = await createdRun(c, sender);
    // As adoptExisting leaves it: Mailercloud already had today's FREE draft.
    await prisma.digestSend.updateMany({
      where: { runId: run.id, audience: 'FREE' },
      data: { adoptedDraftAt: ist(6, 30), ownApprovalRequired: true, approvedAt: null, scheduleAttemptedAt: ist(6, 30) },
    });
    const app = appFor(c, sender, run.portal, ist(7, 35));
    const before = await request(app).get(`/api/digest/runs/${run.id}`).set('Cookie', testerCookie);
    expect(before.body.actions.approve.show).toBe(true);
    const free = before.body.variants.find((v: { audience: string }) => v.audience === 'FREE');
    expect(free).toMatchObject({ adoptedDraft: true, approval: 'waiting' });
    expect(before.body.variants.find((v: { audience: string }) => v.audience === 'PREMIUM').approval).toBe('not_needed');

    await advanceRun(run.id, 'cron', { sender, now: ist(7, 30), cfg: c, quiet: QUIET, buildContent: placeholderContent, alerts: false });
    expect(sender.calls.filter((x) => x.method === 'schedule')).toHaveLength(1); // PREMIUM only
    const banner = (await digestStatus({ portal: run.portal, now: ist(7, 31), cfg: c })).attention;
    expect(banner).toMatchObject({ code: 'adopted_draft' });
    expect(banner?.headline).toMatch(/already had today's Free digest campaign, which this system did not create/);

    const res = await request(app).post(`/api/digest/runs/${run.id}/approve`).set('Cookie', testerCookie).send({ audiences: ['FREE'] });
    expect(res.status).toBe(200);
    expect(res.body.variants).toEqual(['FREE']);
    expect((await prisma.digestRun.findUniqueOrThrow({ where: { id: run.id } })).approval).toBe('NOT_REQUIRED');
    await advanceRun(run.id, 'cron', { sender, now: ist(7, 36), cfg: c, quiet: QUIET, buildContent: placeholderContent, alerts: false });
    expect(sender.calls.filter((x) => x.method === 'schedule')).toHaveLength(2);
  });

  it('digestActions: the adopted draft blocks Send now with its own reason', () => {
    const i: ActionsInput = {
      cfg: { enabled: true, sendLive: true, approvalRequired: false, sanityMaxCandidates: 150, cutoff: '17:00' },
      now: ist(7, 10),
      quiet: QUIET,
      providerReady: true,
      viewerCanTest: true,
      run: { runDate: new Date(Date.UTC(2026, 9, 23)), build: 'BUILT', approval: 'NOT_REQUIRED', candidateCount: 30 },
      sends: [
        { audience: 'FREE', state: 'CREATED', lastError: null, nextAttemptAt: null, mcCampaignId: 'mc-1', hasHtml: true, ownApprovalRequired: true, approvedAt: null, adoptedDraftAt: ist(6, 30) },
        { audience: 'PREMIUM', state: 'CREATED', lastError: null, nextAttemptAt: null, mcCampaignId: 'mc-2', hasHtml: true },
      ],
    };
    const a = digestActions(i);
    expect(a.approve.show).toBe(true);
    expect(a.sendNow.reason).toMatch(/Approve the Free digest first: Mailercloud already had its draft/);
  });

  it('a complaint hold makes an auto-mode run an approval run on the screen too', () => {
    const i: ActionsInput = {
      cfg: { enabled: true, sendLive: true, approvalRequired: false, sanityMaxCandidates: 150, cutoff: '17:00' },
      now: ist(7, 10),
      quiet: QUIET,
      providerReady: true,
      viewerCanTest: true,
      run: { runDate: new Date(Date.UTC(2026, 9, 23)), build: 'BUILT', approval: 'PENDING', candidateCount: 30, complaintCheck: { held: true, sends: [] } },
      sends: [{ audience: 'FREE', state: 'CREATED', lastError: null, nextAttemptAt: null, mcCampaignId: 'mc-1', hasHtml: true }],
    };
    const a = digestActions(i);
    expect(a.approve.show).toBe(true);
    expect(a.sendNow.reason).toBe('Approve it first.');
  });
});

describe('send now and retry', () => {
  it('send now is refused while DIGEST_SEND_LIVE is off; nothing is scheduled', async () => {
    const c = cfg({ DIGEST_SEND_LIVE: 'false' });
    const sender = new FakeSender();
    const run = await createdRun(c, sender);
    const app = appFor(c, sender, run.portal, ist(7, 10));
    const res = await request(app).post(`/api/digest/runs/${run.id}/send-now`).set('Cookie', testerCookie).send({ confirm: true });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('send_live_off');
    expect(res.body.message).toMatch(/DIGEST_SEND_LIVE/);
    expect(sender.count('schedule')).toBe(0);
  });

  it('retry now works in preview mode (owner, 2026-10-23): a failed variant gets its draft, nothing is scheduled', async () => {
    const c = cfg({ DIGEST_SEND_LIVE: 'false' });
    const sender = new FakeSender();
    sender.fail('createDraft', 'FATAL', 1, { http: 401 });
    const portal = `${PORTAL_PREFIX}${Date.now()}-${++n}`;
    portals.push(portal);
    const run = await ensureRun({ portal, now: ist(6, 0), cfg: c });
    await advanceRun(run.id, 'cron', { sender, now: ist(6, 30), cfg: c, quiet: QUIET, buildContent: placeholderContent, alerts: false });
    const failed = await prisma.digestSend.findMany({ where: { runId: run.id, state: 'FAILED' } });
    expect(failed).toHaveLength(1);

    const res = await request(appFor(c, sender, portal, ist(7, 40))).post(`/api/digest/runs/${run.id}/retry`).set('Cookie', testerCookie).send({});
    expect(res.status).toBe(200);
    expect(res.body.result.steps).toContain(`${failed[0].audience}:create:ok`);
    expect(res.body.result.steps).toContain(`${failed[0].audience}:wait:preview_only`);
    expect(sender.count('createDraft')).toBe(3);
    expect(sender.count('schedule')).toBe(0);
    expect((await prisma.digestSend.findUniqueOrThrow({ where: { id: failed[0].id } })).state).toBe('CREATED');
    const audit = await auditRows(run.id, 'DIGEST_RETRY');
    expect(audit.at(-1)?.metadata).toMatchObject({ previewOnly: true });
  });

  it('send now needs confirm: true', async () => {
    const c = cfg();
    const sender = new FakeSender();
    const run = await createdRun(c, sender);
    const res = await request(appFor(c, sender, run.portal, ist(7, 10)))
      .post(`/api/digest/runs/${run.id}/send-now`)
      .set('Cookie', testerCookie)
      .send({});
    expect(res.status).toBe(400);
    expect(sender.count('schedule')).toBe(0);
  });

  it('a PUBLISHER sends now: advanceRun schedules both variants once, audited', async () => {
    const c = cfg();
    const sender = new FakeSender();
    const run = await createdRun(c, sender);
    const app = appFor(c, sender, run.portal, ist(7, 10));
    const res = await request(app).post(`/api/digest/runs/${run.id}/send-now`).set('Cookie', testerCookie).send({ confirm: true });
    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ outcome: 'advanced', state: 'scheduled' });
    expect(sender.count('schedule')).toBe(2);
    expect(await auditRows(run.id, 'DIGEST_SEND_NOW')).toEqual([
      expect.objectContaining({ userId: tester.id, metadata: expect.objectContaining({ outcome: 'advanced', via: 'session' }) }),
    ]);

    // Second press: the runner refuses (already scheduled); still audited, nothing more scheduled.
    const again = await request(app).post(`/api/digest/runs/${run.id}/send-now`).set('Cookie', testerCookie).send({ confirm: true });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('refused');
    expect(sender.count('schedule')).toBe(2);
    expect(await auditRows(run.id, 'DIGEST_SEND_NOW')).toHaveLength(2);
  });

  it('the runner gates still apply: Send now in quiet hours schedules nothing', async () => {
    const c = cfg();
    const sender = new FakeSender();
    const run = await createdRun(c, sender);
    const res = await request(appFor(c, sender, run.portal, ist(6, 45)))
      .post(`/api/digest/runs/${run.id}/send-now`)
      .set('Cookie', testerCookie)
      .send({ confirm: true });
    expect(res.status).toBe(200);
    expect(sender.count('schedule')).toBe(0);
  });

  it('retry after a FATAL create resumes the same frozen html; preview is unchanged', async () => {
    const c = cfg();
    const sender = new FakeSender().fail('createDraft', 'FATAL', 2, { http: 401 });
    const run = await createdRun(c, sender);
    const app = appFor(c, sender, run.portal, ist(7, 40));
    const before = await request(app).get(`/api/digest/runs/${run.id}/preview/FREE`).set('Cookie', testerCookie);
    expect(before.status).toBe(200);
    const stored = await prisma.digestSend.findFirstOrThrow({ where: { runId: run.id, audience: 'FREE' } });
    expect(before.text).toBe(stored.html);

    const detail = await request(app).get(`/api/digest/runs/${run.id}`).set('Cookie', testerCookie);
    expect(detail.body.state).toBe('failed');
    expect(detail.body.actions.retry).toEqual({ show: true, enabled: true, reason: null });

    const res = await request(app).post(`/api/digest/runs/${run.id}/retry`).set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(sender.count('schedule')).toBe(2);
    expect(await auditRows(run.id, 'DIGEST_RETRY')).toEqual([
      expect.objectContaining({ userId: null, metadata: expect.objectContaining({ via: 'bearer' }) }),
    ]);
    const after = await request(app).get(`/api/digest/runs/${run.id}/preview/free`).set('Cookie', testerCookie);
    expect(after.text).toBe(before.text);
  });
});

describe('the cut-off on a late press', () => {
  it('Send now after 17:00: 409 cutoff_passed, nothing scheduled', async () => {
    const c = cfg();
    const sender = new FakeSender();
    const run = await createdRun(c, sender);
    const res = await request(appFor(c, sender, run.portal, ist(17, 5)))
      .post(`/api/digest/runs/${run.id}/send-now`)
      .set('Cookie', testerCookie)
      .send({ confirm: true });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('cutoff_passed');
    expect(res.body.message).toMatch(/Not sent — past the 17:00 IST cut-off/);
    expect(sender.count('schedule')).toBe(0);
  });

  it('the runner gets a LIVE clock: time crossing 17:00 mid-request stops the second variant', async () => {
    const c = cfg();
    const sender = new FakeSender();
    const run = await createdRun(c, sender);
    // No clock injected into the router: it must read the real (here: faked) time.
    const app = createApp({
      rateLimit: { publicPerMin: 10000, loginPerMin: 10000 },
      digest: { cfg: c, portal: run.portal, sender, buildContent: placeholderContent, quiet: QUIET, alerts: false },
    });
    const schedule = sender.schedule.bind(sender);
    sender.schedule = async (id: string, when: 'now') => {
      await schedule(id, when);
      jest.setSystemTime(new Date(ist(17, 0).getTime() + 5_000)); // a slow first schedule crosses the cut-off
    };
    jest.useFakeTimers({
      doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
    });
    try {
      jest.setSystemTime(new Date(ist(16, 59).getTime() + 50_000)); // 16:59:50 IST
      const res = await request(app).post(`/api/digest/runs/${run.id}/send-now`).set('Authorization', AUTH).send({ confirm: true });
      expect(sender.count('schedule')).toBe(1); // Free went; Premium was refused on the fresh clock
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('cutoff_passed');
      expect(res.body.message).toMatch(/Only the Free digest went out/);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('test send', () => {
  it('refuses a user whose address is not in DIGEST_TEST_RECIPIENTS (403), sends nothing', async () => {
    const c = cfg();
    const sender = new FakeSender();
    const run = await createdRun(c, sender);
    const res = await request(appFor(c, sender, run.portal, ist(7, 0)))
      .post(`/api/digest/runs/${run.id}/test-send/free`)
      .set('Cookie', outsiderCookie);
    expect(res.status).toBe(403);
    expect(sender.count('testSend')).toBe(0);
    expect(await auditRows(run.id, 'DIGEST_TEST_SENT')).toHaveLength(0);
  });

  it("a listed user gets it at their own address only; nothing is scheduled; audited without the address", async () => {
    const c = cfg();
    const sender = new FakeSender();
    const spy = jest.spyOn(sender, 'testSend');
    const run = await createdRun(c, sender);
    const draft = await prisma.digestSend.findFirstOrThrow({ where: { runId: run.id, audience: 'PREMIUM' } });
    const res = await request(appFor(c, sender, run.portal, ist(7, 0)))
      .post(`/api/digest/runs/${run.id}/test-send/premium`)
      .set('Cookie', testerCookie)
      .send({ to: [READER] }); // ignored: the route never takes a recipient from the body
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith(draft.mcCampaignId, [tester.email.toLowerCase()]);
    expect(sender.count('schedule')).toBe(0);
    expect(sender.count('createDraft')).toBe(2); // only the build's two drafts
    const rows = await auditRows(run.id, 'DIGEST_TEST_SENT');
    expect(rows).toEqual([expect.objectContaining({ userId: tester.id, metadata: { audience: 'PREMIUM' } })]);
    const after = await prisma.digestSend.findMany({ where: { runId: run.id } });
    expect(after.every((s) => s.state === 'CREATED' && s.scheduleAttemptedAt === null)).toBe(true);
  });
});

describe('detail, preview and history payloads', () => {
  it('preview: frozen html under a strict CSP and SAMEORIGIN framing', async () => {
    const c = cfg();
    const sender = new FakeSender();
    const run = await createdRun(c, sender);
    const res = await request(appFor(c, sender, run.portal, ist(7, 0))).get(`/api/digest/runs/${run.id}/preview/premium`).set('Cookie', testerCookie);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.headers['content-security-policy']).toBe(PREVIEW_CSP);
    // Literal checks on the header itself, not just "equals our constant".
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toMatch(/(^|;\s*)sandbox(\s*;|$)/);
    expect(PREVIEW_CSP).toContain("default-src 'none'");
    expect(PREVIEW_CSP).toContain('img-src https: data:');
    expect(PREVIEW_CSP).toContain("style-src 'unsafe-inline'");
    expect(PREVIEW_CSP).not.toMatch(/script-src/);
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.text).toContain('Premium variant');
    expect((await request(appFor(c, sender, run.portal, ist(7, 0))).get(`/api/digest/runs/${run.id}/preview/other`).set('Cookie', testerCookie)).status).toBe(400);
  });

  it('detail: variants, items with read basis, actions, timeline; no html, no reader address', async () => {
    const c = cfg({ DIGEST_APPROVAL_REQUIRED: 'true' });
    const sender = new FakeSender();
    const run = await createdRun(c, sender);
    await prisma.digestRun.update({ where: { id: run.id }, data: { readsUsed: true, readsSource: 'ga' } });
    await prisma.digestItem.createMany({
      data: [
        { runId: run.id, rank: 1, section: 'MAIN', articleKey: 'k1', title: 'Sample SC ruling', url: 'https://www.taxscan.in/a-1', authority: 'Supreme Court', category: 'GST', capturedAt: ist(4, 0), readRate: 82.4 },
        { runId: run.id, rank: 2, section: 'MAIN', articleKey: 'k2', title: 'Sample fresh HC ruling', url: 'https://www.taxscan.in/a-2', authority: 'High Court', category: 'GST', capturedAt: ist(6, 0), readRate: null },
        { runId: run.id, rank: 3, section: 'ICYMI', audience: 'PREMIUM', articleKey: 'k3', title: 'Sample carried over', url: 'https://www.taxscan.in/a-3', authority: null, category: 'GST', capturedAt: ist(4, 0, 22), readRate: null },
      ],
    });
    await prisma.digestSend.updateMany({ where: { runId: run.id, audience: 'FREE' }, data: { lastError: `bounced for ${READER}` } });
    const app = appFor(c, sender, run.portal, ist(7, 0));
    await request(app).post(`/api/digest/runs/${run.id}/approve`).set('Cookie', testerCookie);
    const res = await request(app).get(`/api/digest/runs/${run.id}`).set('Cookie', testerCookie);
    expect(res.status).toBe(200);
    const b = res.body;
    expect(b).toMatchObject({ runId: run.id, runDate: '2026-10-23', isToday: true, state: 'created', approval: 'APPROVED', approvedBy: tester.email });
    expect(b.readsLine).toMatch(/Ranked by reads/);
    expect(b.variants).toHaveLength(2);
    expect(b.variants[0]).toMatchObject({ audience: 'FREE', hasPreview: true });
    expect(b.variants[0].subject).toContain('Free');
    expect(b.items.FREE.map((i: { readBasis: string }) => i.readBasis)).toEqual(['reads', 'new']);
    expect(b.items.PREMIUM.map((i: { readBasis: string }) => i.readBasis)).toEqual(['reads', 'new', 'none']);
    expect(b.items.FREE[0]).toMatchObject({ tier: 1, section: 'MAIN', readRate: 82.4 });
    expect(b.actions.testSend.FREE).toEqual({ show: true, enabled: true, reason: null });
    expect(b.actions.sendNow).toEqual({ show: true, enabled: true, reason: null });
    expect(b.timeline.map((t: { text: string }) => t.text)).toEqual(expect.arrayContaining(['Approved']));
    const raw = JSON.stringify(b);
    expect(raw).not.toContain(READER);
    expect(raw).not.toContain('<html');
    expect(b.variants[0]).not.toHaveProperty('html');

    // The outsider is not a test recipient: the button explains why.
    const o = await request(app).get(`/api/digest/runs/${run.id}`).set('Cookie', outsiderCookie);
    expect(o.body.actions.testSend.FREE).toMatchObject({ show: true, enabled: false });
    expect(o.body.actions.testSend.FREE.reason).toMatch(/DIGEST_TEST_RECIPIENTS/);
  });

  it('history: per-variant state and items; unsubscribes/complaints null (never a fake 0)', async () => {
    const c = cfg();
    const sender = new FakeSender();
    const run = await createdRun(c, sender);
    const res = await request(appFor(c, sender, run.portal, ist(9, 0))).get('/api/digest/runs?days=14').set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(1);
    expect(res.body.runs[0]).toMatchObject({ runId: run.id, runDate: '2026-10-23', state: 'created', items: { FREE: 0, PREMIUM: 0 } });
    expect(res.body.runs[0].variants[0]).toMatchObject({ audience: 'FREE', state: 'CREATED', delivered: null, unsubscribes: null, complaints: null });
    expect(res.body.runs[0].variants[0].mcCampaignId).toBeTruthy();
  });

  it('status carries the build time for the "no run yet" line', async () => {
    const c = cfg();
    const res = await request(appFor(c, new FakeSender(), `${PORTAL_PREFIX}empty-${Date.now()}`, ist(5, 0)))
      .get('/api/digest/status')
      .set('Authorization', AUTH);
    expect(res.body.today).toBeNull();
    expect(res.body.config.buildAt).toBe('06:30');
  });
});

describe('digestActions (which buttons the screen offers)', () => {
  const base = (): ActionsInput => ({
    cfg: { enabled: true, sendLive: true, approvalRequired: true, sanityMaxCandidates: 150, cutoff: '17:00' },
    now: ist(7, 10),
    quiet: QUIET,
    providerReady: true,
    viewerCanTest: true,
    run: { runDate: new Date(Date.UTC(2026, 9, 23)), build: 'BUILT', approval: 'PENDING', candidateCount: 30 },
    sends: (['FREE', 'PREMIUM'] as const).map((audience) => ({
      audience,
      state: 'CREATED' as const,
      lastError: null,
      nextAttemptAt: null,
      mcCampaignId: `mc-${audience}`,
      hasHtml: true,
    })),
  });

  type SendIn = ActionsInput['sends'][number];
  const patch = (i: ActionsInput, idx: number, p: Partial<SendIn>): ActionsInput => ({
    ...i,
    sends: i.sends.map((s, k) => (k === idx ? { ...s, ...p } : s)),
  });

  it('awaiting approval: Approve + Hold shown, Send now disabled "Approve it first", no Retry', () => {
    const a = digestActions(base());
    expect(a.approve.show).toBe(true);
    expect(a.hold.show).toBe(true);
    expect(a.sendNow).toEqual({ show: true, enabled: false, reason: 'Approve it first.' });
    expect(a.retry.show).toBe(false);
    expect(a.testSend.FREE.enabled).toBe(true);
  });

  it('approved: no Approve; Send now enabled', () => {
    const i = base();
    i.run.approval = 'APPROVED';
    const a = digestActions(i);
    expect(a.approve.show).toBe(false);
    expect(a.sendNow.enabled).toBe(true);
  });

  it('preview mode: Send now disabled naming DIGEST_SEND_LIVE; Retry now enabled on a failed variant (drafts only)', () => {
    const i = base();
    i.run.approval = 'APPROVED';
    i.cfg.sendLive = false;
    expect(digestActions(i).sendNow.reason).toMatch(/DIGEST_SEND_LIVE/);
    const failed = patch(i, 0, { state: 'FAILED', lastError: 'create: 401' });
    expect(digestActions(failed).retry).toEqual({ show: true, enabled: true, reason: null });
  });

  it('quiet hours: Send now disabled', () => {
    const i = base();
    i.run.approval = 'APPROVED';
    i.now = ist(6, 40);
    expect(digestActions(i).sendNow.reason).toMatch(/quiet hours/);
  });

  it('scheduled: no Approve, Hold, Send now or Retry', () => {
    const i = base();
    i.sends = i.sends.map((s) => ({ ...s, state: 'SCHEDULED' as const }));
    const a = digestActions(i);
    expect([a.approve.show, a.hold.show, a.sendNow.show, a.retry.show]).toEqual([false, false, false, false]);
  });

  it('past the cut-off: nothing to press except test send', () => {
    const i = base();
    i.now = ist(17, 0);
    const a = digestActions(i);
    expect([a.approve.show, a.hold.show, a.sendNow.show, a.retry.show]).toEqual([false, false, false, false]);
  });

  it('FAILED variant before the cut-off: Retry shown; provider-FAILED (terminal) is not', () => {
    const i = base();
    expect(digestActions(patch(i, 0, { state: 'FAILED', lastError: 'create: 401' })).retry.show).toBe(true);
    const terminal = patch(patch(i, 0, { state: 'FAILED', lastError: 'provider_failed: nobody reached' }), 1, { state: 'SENT' });
    expect(digestActions(terminal).retry.show).toBe(false);
  });

  it('build failed: Retry shown', () => {
    const i = base();
    i.run.build = 'BUILD_FAILED';
    i.sends = [];
    expect(digestActions(i).retry.show).toBe(true);
  });

  it('digest off: nothing shown', () => {
    const i = base();
    i.cfg.enabled = false;
    const a = digestActions(i);
    expect([a.approve.show, a.hold.show, a.sendNow.show, a.retry.show, a.testSend.FREE.show]).toEqual([false, false, false, false, false]);
  });

  it('test send without a draft id, or not a test recipient: disabled with a reason', () => {
    const i = patch(base(), 0, { mcCampaignId: null });
    expect(digestActions(i).testSend.FREE.reason).toMatch(/draft/);
    i.viewerCanTest = false;
    expect(digestActions(i).testSend.PREMIUM.reason).toMatch(/DIGEST_TEST_RECIPIENTS/);
  });
});

describe('E2E_MOCK_SENDER production guard', () => {
  it('refused with NODE_ENV=production; allowed elsewhere; off by default', () => {
    expect(() => mockSendersEnabled({ E2E_MOCK_SENDER: 'true', NODE_ENV: 'production' })).toThrow(MockSenderInProductionError);
    expect(mockSendersEnabled({ E2E_MOCK_SENDER: 'true', NODE_ENV: 'development' })).toBe(true);
    expect(mockSendersEnabled({ NODE_ENV: 'production' })).toBe(false);
    expect(mockSendersEnabled({})).toBe(false);
  });
});

describe('read basis and reads line', () => {
  it.each([
    [{ section: 'MAIN', readRate: 12.5 }, true, 'reads'],
    [{ section: 'MAIN', readRate: null }, true, 'new'],
    [{ section: 'ICYMI', readRate: null }, true, 'none'],
    [{ section: 'MAIN', readRate: null }, false, 'none'],
    [{ section: 'MAIN', readRate: null }, null, 'none'],
  ])('%j readsUsed=%s → %s', (item, used, want) => {
    expect(itemReadBasis(item, used)).toBe(want);
  });

  it('reads line', () => {
    expect(readsLine(true, 'ga', null)).toBe('Ranked by reads (Google Analytics).');
    expect(readsLine(false, 'ga', 'GA data stale')).toBe('Ranked newest-first — GA data stale.');
    expect(readsLine(null, null, null)).toBeNull();
  });
});
