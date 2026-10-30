import bcrypt from 'bcrypt';
import request from 'supertest';
import type { DigestApproval, DigestBuild, DigestSendState, User, UserRole } from '@prisma/client';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { parseDigestEnv, type DigestEnv } from '../lib/env';
import { digestRunDetail } from '../services/digest/screen';
import { checkSubject, subjectLock } from '../services/digest/subjectEdit';
import { MailercloudSender } from '../services/digest/mailercloud';
import { FakeSender } from './digestFakeSender';

/** Brief 2026-10-30-digest-subject-edit: editors change a version's subject before approval. */

jest.spyOn(console, 'log').mockImplementation(() => undefined);
jest.spyOn(console, 'warn').mockImplementation(() => undefined);
jest.spyOn(console, 'error').mockImplementation(() => undefined);

const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const PORTAL_PREFIX = 'test-digest-subj-';
const PASSWORD = 'digest-subj-test-pw-1';
const AUTH = `Bearer ${process.env.ADMIN_TOKEN}`;
// 22 Oct 2026, 07:00 IST (after the 06:30 build, before the 17:00 cut-off).
const NOW = new Date(Date.UTC(2026, 9, 22, 7, 0) - (5 * 60 + 30) * 60_000);
const RUN_DATE = new Date(Date.UTC(2026, 9, 22));
const OLD = 'Lead headline of the day, as the build made it';

function cfg(): DigestEnv {
  return parseDigestEnv({
    DIGEST_ENABLED: 'true',
    DIGEST_FREE_LIST_IDS: 'list-free',
    DIGEST_PREMIUM_LIST_IDS: 'list-premium',
    DIGEST_POSTAL_ADDRESS: 'Taxscan Media, Kochi, Kerala 682001, India',
    MAILERCLOUD_API_KEY: 'secret-key-for-test',
  });
}

let n = 0;
const userIds: string[] = [];
let admin: User;
let publisher: User;
let adminCookie: string;
let publisherCookie: string;
const loginApp = createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 } });

async function makeUser(role: UserRole): Promise<User> {
  const u = await prisma.user.create({
    data: { email: `digest-subj-${role.toLowerCase()}-${RUN}-${++n}@team.test`, passwordHash: await bcrypt.hash(PASSWORD, 4), role, isActive: true },
  });
  userIds.push(u.id);
  return u;
}
async function cookieFor(u: User): Promise<string> {
  const res = await request(loginApp).post('/api/auth/login').send({ email: u.email, password: PASSWORD });
  const sc = res.headers['set-cookie'];
  return (Array.isArray(sc) ? sc : [sc as unknown as string]).map((l) => l.split(';')[0]).join('; ');
}

beforeAll(async () => {
  admin = await makeUser('ADMIN');
  publisher = await makeUser('PUBLISHER');
  adminCookie = await cookieFor(admin);
  publisherCookie = await cookieFor(publisher);
});

afterAll(async () => {
  const runs = await prisma.digestRun.findMany({ where: { portal: { startsWith: PORTAL_PREFIX } }, select: { id: true } });
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL audit_log.allow_purge = 'true'`);
    const ids = runs.map((r) => r.id);
    if (ids.length) await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "resourceId" = ANY(${ids}::text[])`;
    await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "userId" = ANY(${userIds}::text[])`;
  });
  await prisma.digestRun.deleteMany({ where: { portal: { startsWith: PORTAL_PREFIX } } });
  await prisma.userSession.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

type Fixture = { portal: string; runId: string; sender: FakeSender; app: ReturnType<typeof createApp>; campaignId: string | null };

/** A built run with one FREE version. `state` PENDING = no draft yet; CREATED = a draft exists in the fake. */
async function fixture(o: { state?: DigestSendState; build?: DigestBuild; approval?: DigestApproval; scheduleAttempted?: boolean; runDate?: Date; now?: Date } = {}): Promise<Fixture> {
  const portal = `${PORTAL_PREFIX}${RUN}-${++n}`;
  const sender = new FakeSender();
  const state = o.state ?? 'CREATED';
  const run = await prisma.digestRun.create({
    data: { portal, runDate: o.runDate ?? RUN_DATE, windowStart: new Date(NOW.getTime() - 86_400_000), builtAt: NOW, build: o.build ?? 'BUILT', approval: o.approval ?? 'PENDING' },
  });
  let campaignId: string | null = null;
  const name = `TS-DIGEST-2026-10-22-FREE-${portal}`;
  if (state !== 'PENDING') {
    const d = await sender.createDraft({ name, audience: 'FREE', subject: OLD, preheader: 'p', html: '<p>x</p>', text: null, target: { listIds: [], segmentIds: [], tagIds: [], excludeListIds: [], excludeTagIds: [] } });
    campaignId = d.campaignId;
  }
  await prisma.digestSend.create({
    data: {
      runId: run.id,
      audience: 'FREE',
      state,
      subject: OLD,
      preheader: 'p',
      html: '<html><title>x</title></html>',
      htmlBytes: 30,
      mcCampaignName: name,
      mcCampaignId: campaignId,
      sendAfter: NOW,
      scheduleAttemptedAt: o.scheduleAttempted ? NOW : null,
    },
  });
  sender.calls.length = 0;
  const app = createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 }, digest: { cfg: cfg(), portal, clock: () => o.now ?? NOW, sender, alerts: false } });
  return { portal, runId: run.id, sender, app, campaignId };
}
const put = (f: Fixture, subject: unknown, cookie = adminCookie, from?: string) => request(f.app).post(`/api/digest/runs/${f.runId}/subject/free`).set('Cookie', cookie).send({ subject, ...(from === undefined ? {} : { from }) });
const rowOf = (f: Fixture) => prisma.digestSend.findFirstOrThrow({ where: { runId: f.runId } });
const auditRows = (f: Fixture) => prisma.auditLog.findMany({ where: { resourceId: f.runId, action: 'DIGEST_SUBJECT_EDITED' } });

describe('1. a version with no draft yet', () => {
  it('stores the subject; the later createDraft receives it (nothing is sent to the provider now)', async () => {
    const f = await fixture({ state: 'PENDING' });
    const r = await put(f, '  A better subject  ');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, subject: 'A better subject' });
    expect((await rowOf(f)).subject).toBe('A better subject');
    expect(f.sender.count('updateSubject')).toBe(0);
    // The build's later createDraft reads DigestSend.subject (runner.ts); here: the stored value is what it is handed.
    const d = await f.sender.createDraft({ name: 'x', audience: 'FREE', subject: (await rowOf(f)).subject, preheader: '', html: '', text: null, target: { listIds: [], segmentIds: [], tagIds: [], excludeListIds: [], excludeTagIds: [] } });
    expect(f.sender.draftInputs().at(-1)?.subject).toBe('A better subject');
    expect(d.campaignId).toBeTruthy();
  });
});

describe('2. a version with a draft', () => {
  it('row updated, exactly one updateSubject(id, subject), and the screen payload shows it', async () => {
    const f = await fixture();
    const r = await put(f, 'New subject for the draft', publisherCookie);
    expect(r.status).toBe(200);
    expect(f.sender.calls.filter((c) => c.method === 'updateSubject')).toEqual([{ method: 'updateSubject', args: [f.campaignId, 'New subject for the draft'] }]);
    expect(f.sender.campaigns.get(f.campaignId as string)?.input.subject).toBe('New subject for the draft');
    const detail = await digestRunDetail(f.runId, { cfg: cfg(), now: NOW, providerReady: true, viewerCanTest: false });
    expect(detail?.variants[0].subject).toBe('New subject for the draft');
    expect(detail?.variants[0].subjectEdit).toEqual({ editable: true, reason: null });
    expect((await auditRows(f)).length).toBe(1);
  });
});

describe('3. provider failure', () => {
  it.each(['RETRYABLE', 'FATAL'] as const)('%s: the row goes back to the old subject, 502 with a plain reason, no audit row', async (kind) => {
    const f = await fixture();
    f.sender.fail('updateSubject', kind, 1, { http: kind === 'FATAL' ? 400 : 503 });
    const r = await put(f, 'Will not stick');
    expect(r.status).toBe(502);
    expect(r.body.error).toBe('provider_error');
    expect(r.body.message).toMatch(/^Mailercloud did not accept the new subject: /);
    expect(JSON.stringify(r.body)).not.toContain('secret-key-for-test');
    expect(JSON.stringify(r.body)).not.toContain('@example.com'); // the fake's address is masked
    expect((await rowOf(f)).subject).toBe(OLD);
    expect((await auditRows(f)).length).toBe(0);
  });
});

describe('4. locked cases → 409 with a code', () => {
  it('approved run', async () => {
    const f = await fixture({ approval: 'APPROVED' });
    const r = await put(f, 'x subject');
    expect([r.status, r.body.error]).toEqual([409, 'approved']);
    expect(f.sender.count('updateSubject')).toBe(0);
  });
  it('a schedule was attempted', async () => {
    const f = await fixture({ scheduleAttempted: true });
    expect((await put(f, 'x subject')).body.error).toBe('scheduled');
  });
  it('a version already sent', async () => {
    const f = await fixture({ state: 'SENT' });
    expect((await put(f, 'x subject')).body.error).toBe('scheduled');
  });
  it('past the 17:00 cut-off', async () => {
    const late = new Date(Date.UTC(2026, 9, 22, 17, 1) - (5 * 60 + 30) * 60_000);
    const f = await fixture({ now: late });
    expect((await put(f, 'x subject')).body.error).toBe('past_cutoff');
  });
  it('not today’s run', async () => {
    const f = await fixture({ runDate: new Date(Date.UTC(2026, 9, 21)) });
    expect((await put(f, 'x subject')).body.error).toBe('not_today');
  });
  it('build not BUILT', async () => {
    const f = await fixture({ build: 'BUILDING' });
    expect((await put(f, 'x subject')).body.error).toBe('not_built');
  });
  it('a held run is still editable (only approval locks)', async () => {
    const f = await fixture({ approval: 'HELD' });
    expect((await put(f, 'x subject')).status).toBe(200);
  });
  it('the lock rule is the same one the screen shows', () => {
    const run = { runDate: RUN_DATE, build: 'BUILT' as const, approval: 'APPROVED' as const };
    const send = { state: 'CREATED' as const, scheduleAttemptedAt: null, createAttemptedAt: null, approvedAt: null };
    expect(subjectLock(run, send, NOW, { cutoff: '17:00' })).toBe('approved');
    expect(subjectLock({ ...run, approval: 'PENDING' }, send, NOW, { cutoff: '17:00' })).toBeNull();
  });
});

describe('5. validation', () => {
  it('empty, 151 chars, newline → 400; nothing changes', async () => {
    const f = await fixture();
    for (const bad of ['', '   ', 'x'.repeat(151), 'two\nlines', 'tab\there', undefined, 42]) {
      const r = await put(f, bad);
      expect([bad, r.status, r.body.error]).toEqual([bad, 400, 'invalid_subject']);
    }
    expect((await rowOf(f)).subject).toBe(OLD);
    expect(f.sender.count('updateSubject')).toBe(0);
  });
  it('150 chars is fine', async () => {
    const f = await fixture();
    expect((await put(f, 'y'.repeat(150))).status).toBe(200);
  });
  it('{{x}} is defused exactly as the automatic subject is', async () => {
    const f = await fixture();
    const r = await put(f, 'Ruling on {{unsubscribe_link}} today');
    expect(r.status).toBe(200);
    expect(r.body.subject).toBe('Ruling on { {unsubscribe_link} } today');
    expect((await rowOf(f)).subject).toBe('Ruling on { {unsubscribe_link} } today');
    expect(checkSubject('a {{b}} c')).toEqual({ ok: true, subject: 'a { {b} } c' });
  });
  it('the same subject → 200 no-op: no provider call, no audit', async () => {
    const f = await fixture();
    const r = await put(f, `  ${OLD}  `);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, subject: OLD, unchanged: true });
    expect(f.sender.count('updateSubject')).toBe(0);
    expect((await auditRows(f)).length).toBe(0);
  });
  it('a bad version in the URL → 400', async () => {
    const f = await fixture();
    expect((await request(f.app).post(`/api/digest/runs/${f.runId}/subject/gold`).set('Cookie', adminCookie).send({ subject: 'x' })).status).toBe(400);
  });
});

describe('6. concurrency', () => {
  it('two saves from the same old subject: one 200, one 409 changed, one provider call', async () => {
    const f = await fixture();
    f.sender.delays('updateSubject', [150]);
    const [a, b] = await Promise.all([put(f, 'Editor one subject', adminCookie, OLD), put(f, 'Editor two subject', publisherCookie, OLD)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.error).toBe('changed');
    expect(f.sender.count('updateSubject')).toBe(1);
    const winner = a.status === 200 ? 'Editor one subject' : 'Editor two subject';
    expect((await rowOf(f)).subject).toBe(winner);
  });
});

describe('6b. an editor working from a stale subject', () => {
  it('`from` no longer matches → 409 changed, nothing written', async () => {
    const f = await fixture();
    const r = await put(f, 'My version', adminCookie, 'What someone replaced meanwhile');
    expect([r.status, r.body.error]).toEqual([409, 'changed']);
    expect((await rowOf(f)).subject).toBe(OLD);
    expect(f.sender.count('updateSubject')).toBe(0);
  });
});

describe('7. roles', () => {
  it('ADMIN and PUBLISHER 200; bearer-only 401/403; signed out 401', async () => {
    const f = await fixture({ state: 'PENDING' });
    expect((await put(f, 'By the admin', adminCookie)).status).toBe(200);
    expect((await put(f, 'By the publisher', publisherCookie)).status).toBe(200);
    const bearer = await request(f.app).post(`/api/digest/runs/${f.runId}/subject/free`).set('Authorization', AUTH).send({ subject: 'By bearer' });
    expect([401, 403]).toContain(bearer.status);
    const none = await request(f.app).post(`/api/digest/runs/${f.runId}/subject/free`).send({ subject: 'By nobody' });
    expect(none.status).toBe(401);
    expect((await rowOf(f)).subject).toBe('By the publisher');
  });
});

describe('8. audit', () => {
  it('DIGEST_SUBJECT_EDITED on success only, with lengths and no text', async () => {
    const f = await fixture();
    await put(f, 'a'.repeat(200)); // invalid
    expect((await auditRows(f)).length).toBe(0);
    await put(f, 'Short and new');
    const rows = await auditRows(f);
    expect(rows.length).toBe(1);
    expect(rows[0].userId).toBe(admin.id);
    expect(rows[0].metadata).toEqual({ audience: 'FREE', oldLength: OLD.length, newLength: 'Short and new'.length, draftUpdated: true });
    expect(JSON.stringify(rows[0].metadata)).not.toContain('Short and new');
  });
});

describe('Mailercloud client: PUT /campaign/{id} with { subject } only', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });
  const client = () => new MailercloudSender({ apiKey: 'secret-key-for-test', senderName: 'T', senderEmail: 'a@hello.taxscan.in', replyEmail: 'b@hello.taxscan.in', baseV1: 'https://cloudapi.test/v1', sleep: async () => undefined });
  it('sends only the subject, with the key in Authorization', async () => {
    const f = jest.fn(async () => new Response('{"message":"ok"}', { status: 200 }));
    global.fetch = f as unknown as typeof fetch;
    await client().updateSubject('cmp/1', 'The new one');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://cloudapi.test/v1/campaign/cmp%2F1');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ subject: 'The new one' });
    expect((init.headers as Record<string, string>).Authorization).toBe('secret-key-for-test');
  });
  it('classifies like the other calls and never echoes the subject or the key', async () => {
    const reply = (status: number, body: unknown) => {
      global.fetch = jest.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    };
    reply(503, { message: 'down' });
    await expect(client().updateSubject('c', 'Secret headline text')).rejects.toMatchObject({ kind: 'RETRYABLE', http: 503 });
    reply(400, { message: 'subject invalid' });
    const err = await client().updateSubject('c', 'Secret headline text').catch((e: Error) => e);
    expect(err).toMatchObject({ kind: 'FATAL', http: 400 });
    expect(String((err as Error).message)).not.toContain('Secret headline text');
    expect(String((err as Error).message)).not.toContain('secret-key-for-test');
    reply(401, { message: 'bad key' });
    await expect(client().updateSubject('c', 'x')).rejects.toMatchObject({ kind: 'FATAL', http: 401 });
  });
  it('is refused by a read-only client (a write never leaves the process)', async () => {
    const f = jest.fn();
    global.fetch = f as unknown as typeof fetch;
    const ro = new MailercloudSender({ apiKey: 'k', senderName: 'T', senderEmail: 'a@hello.taxscan.in', replyEmail: 'b@hello.taxscan.in', readOnly: true });
    await expect(ro.updateSubject('c', 'x')).rejects.toMatchObject({ kind: 'FATAL', notSent: true });
    expect(f).not.toHaveBeenCalled();
  });
});
