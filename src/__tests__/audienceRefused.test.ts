import request from 'supertest';
import bcrypt from 'bcrypt';
import { createHash } from 'node:crypto';
import type { User, UserRole } from '@prisma/client';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { parseAudienceEnv, parseDigestEnv, type AudienceEnv } from '../lib/env';
import { FakeMailercloud } from './audienceFakeMailercloud';
import { McContactClient } from '../services/audience/mcContacts';
import { audienceCard } from '../services/audience/adminView';
import { openBreaker } from '../services/audience/breaker';
import { flushPending, resetWriterForTests, retryRefused, type WriterDeps } from '../services/audience/writer';

/**
 * Brief 2026-11-06-audience-refused-contacts: refused counts on the Audience card, the ADMIN "Retry refused" route
 * and the writer picking retried members up again. Members are isolated by hash (`onlyHashes`) where the global
 * retry could otherwise touch another test file's rows; card counts are compared before/after.
 */

jest.spyOn(console, 'log').mockImplementation(() => undefined);
jest.spyOn(console, 'warn').mockImplementation(() => undefined);
jest.spyOn(console, 'error').mockImplementation(() => undefined);

const RUN = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const KEY = 'k'.repeat(40);
const PASSWORD = 'Refused-test-pass-1234';
const PORTAL = `test-audience-refused-${RUN}`;
const T = { premium: `rp-${RUN}`, former: `rf-${RUN}`, noMarketing: `rn-${RUN}` };
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const CFG: AudienceEnv = parseAudienceEnv({
  AUDIENCE_SYNC_ENABLED: 'true',
  AUDIENCE_SYNC_WRITE_MAILERCLOUD: 'true',
  MAILERCLOUD_SYNC_API_KEY: KEY,
  AUDIENCE_MC_LIST_ID: 'list-1',
  AUDIENCE_MC_TAG_PREMIUM: T.premium,
  AUDIENCE_MC_TAG_FORMER: T.former,
  AUDIENCE_MC_TAG_NO_MARKETING: T.noMarketing,
});

const hashes = new Set<string>();
let seq = 0;
async function member(role: string, over: Record<string, unknown> = {}) {
  const email = `ref.${++seq}.${RUN}@example.com`;
  const h = sha(email);
  hashes.add(h);
  await prisma.audienceMember.create({ data: { emailHash: h, email, desiredRole: role, nextAttemptAt: null, ...over } });
  return { email, h };
}
const row = (h: string) => prisma.audienceMember.findUniqueOrThrow({ where: { emailHash: h } });
const refused = (role = 'PREMIUM') => ({ lastErrorKind: 'FATAL', attempts: 1, desiredRole: role });

let admin: User;
let publisher: User;
let adminCookie: string;
let publisherCookie: string;
const userIds: string[] = [];
let now = new Date('2027-03-01T10:00:00Z'); // 15:30 IST, outside the 07:10–08:00 window

async function makeUser(role: UserRole): Promise<User> {
  const email = `audience-refused-${role.toLowerCase()}-${RUN}@team.test`;
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
const app = () =>
  createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 }, digest: { cfg: parseDigestEnv({}), audience: CFG, clock: () => now, portal: PORTAL, alerts: false } });

beforeAll(async () => {
  admin = await makeUser('ADMIN');
  publisher = await makeUser('PUBLISHER');
  adminCookie = await cookieFor(admin);
  publisherCookie = await cookieFor(publisher);
});

afterAll(async () => {
  await prisma.audienceMember.deleteMany({ where: { emailHash: { in: [...hashes] } } });
  await prisma.audienceSyncState.deleteMany({ where: { portal: PORTAL } });
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL audit_log.allow_purge = 'true'`);
    await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "userId" = ANY(${userIds}::text[])`;
  });
  await prisma.userSession.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe('card refused counts (acceptance 4)', () => {
  it('counts FATAL by role; RETRYABLE and erased rows are not counted; no address in the payload', async () => {
    const before = (await audienceCard(PORTAL, 'ADMIN', now, CFG)) as { refused: { premium: number; former: number } };
    await member('PREMIUM', refused('PREMIUM'));
    await member('PREMIUM', refused('PREMIUM'));
    await member('FORMER', refused('FORMER'));
    await member('PREMIUM', { lastErrorKind: 'RETRYABLE', attempts: 2, nextAttemptAt: now });
    const after = (await audienceCard(PORTAL, 'ADMIN', now, CFG)) as { refused: { premium: number; former: number } };
    expect(after.refused.premium - before.refused.premium).toBe(2);
    expect(after.refused.former - before.refused.former).toBe(1);
    expect(JSON.stringify(after)).not.toMatch(/@|emailHash/);
    const pub = await audienceCard(PORTAL, 'PUBLISHER', now, CFG);
    expect(Object.keys(pub).sort()).toEqual(['enabled', 'line', 'ok']);
  });
});

describe('retryRefused (acceptance 5, 6, 8)', () => {
  it('makes only FATAL rows with an address due; RETRYABLE, done and erased rows are untouched', async () => {
    const fatal = await member('PREMIUM', refused());
    const retryable = await member('PREMIUM', { lastErrorKind: 'RETRYABLE', attempts: 4, nextAttemptAt: new Date(now.getTime() + 3_600_000) });
    const done = await member('FORMER', { lastErrorKind: null, attempts: 0 });
    const erasedHash = sha(`erased-${RUN}`);
    hashes.add(erasedHash);
    await prisma.audienceMember.create({ data: { emailHash: erasedHash, email: null, desiredRole: 'PREMIUM', ...{ lastErrorKind: 'FATAL', attempts: 1 } } });
    const retryableBefore = await row(retryable.h);

    const r = await retryRefused(admin.id, now, [fatal.h, retryable.h, done.h, erasedHash]);
    expect(r).toEqual({ premium: 1, former: 0, other: 0, total: 1 });

    const f = await row(fatal.h);
    expect(f.nextAttemptAt?.toISOString()).toBe(now.toISOString());
    expect(f.attempts).toBe(0);
    expect(f.lastErrorKind).toBeNull();
    expect(await row(retryable.h)).toEqual(retryableBefore);
    expect((await row(done.h)).nextAttemptAt).toBeNull();
    const erased = await row(erasedHash);
    expect(erased.lastErrorKind).toBe('FATAL');
    expect(erased.nextAttemptAt).toBeNull();
    expect(erased.attempts).toBe(1);
  });
});

describe('POST /api/digest/audience/retry-refused (acceptance 7, 8)', () => {
  it('PUBLISHER 403, signed out 401, bearer alone 401', async () => {
    expect((await request(app()).post('/api/digest/audience/retry-refused').set('Cookie', publisherCookie)).status).toBe(403);
    expect((await request(app()).post('/api/digest/audience/retry-refused')).status).toBe(401);
    expect((await request(app()).post('/api/digest/audience/retry-refused').set('Authorization', `Bearer ${process.env.ADMIN_TOKEN}`)).status).toBe(401);
  });

  it('ADMIN: returns the count and writes ONE audit row with counts and no address', async () => {
    const m = await member('PREMIUM', refused());
    const before = await prisma.auditLog.count({ where: { action: 'AUDIENCE_REFUSED_RETRIED', userId: admin.id } });
    const res = await request(app()).post('/api/digest/audience/retry-refused').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.count).toBeGreaterThanOrEqual(1);
    expect((await row(m.h)).lastErrorKind).toBeNull();
    const rows = await prisma.auditLog.findMany({ where: { action: 'AUDIENCE_REFUSED_RETRIED', userId: admin.id } });
    expect(rows).toHaveLength(before + 1);
    const meta = rows[rows.length - 1].metadata as Record<string, unknown>;
    expect(meta.total).toBe(res.body.count);
    expect(JSON.stringify(meta)).not.toMatch(/@|emailHash/);
  });

  it('writes nothing and audits nothing when sync is off', async () => {
    const off = createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 }, digest: { cfg: parseDigestEnv({}), audience: parseAudienceEnv({}), clock: () => now, portal: PORTAL, alerts: false } });
    const before = await prisma.auditLog.count({ where: { action: 'AUDIENCE_REFUSED_RETRIED', userId: admin.id } });
    expect((await request(off).post('/api/digest/audience/retry-refused').set('Cookie', adminCookie)).status).toBe(409);
    expect(await prisma.auditLog.count({ where: { action: 'AUDIENCE_REFUSED_RETRIED', userId: admin.id } })).toBe(before);
  });
});

describe('a retried member and the writer gates (acceptance 9, 10)', () => {
  let fake: FakeMailercloud;
  let base: string;
  const deps = (hs: string[], over: Partial<WriterDeps> = {}): WriterDeps => ({
    client: new McContactClient({ apiKey: KEY, baseV1: base }),
    cfg: CFG,
    digestCfg: { sendAt: '07:30' },
    portal: PORTAL,
    now: () => now,
    sleep: () => Promise.resolve(),
    sendAlerts: false,
    onlyHashes: hs,
    ...over,
  });
  const seedState = (extra: Record<string, unknown> = {}) =>
    prisma.audienceSyncState.upsert({
      where: { portal: PORTAL },
      create: { portal: PORTAL, lastFullOkAt: new Date(now.getTime() - 3_600_000), ...extra },
      update: { lastFullOkAt: new Date(now.getTime() - 3_600_000), breakerOpenAt: null, breakerReason: null, ...extra },
    });

  beforeEach(async () => {
    resetWriterForTests();
    now = new Date('2027-03-01T10:00:00Z');
    fake = new FakeMailercloud(KEY);
    fake.tags = [
      { id: T.premium, tag_name: 'TS Premium (auto)' },
      { id: T.former, tag_name: 'TS Former (auto)' },
      { id: T.noMarketing, tag_name: 'TS No marketing (auto)' },
    ];
    base = await fake.start();
    await seedState();
  });
  afterEach(async () => {
    await fake.stop();
  });

  it('is written by the next tick when the gates are open', async () => {
    const m = await member('PREMIUM', refused());
    await retryRefused(admin.id, now, [m.h]);
    const r = await flushPending(deps([m.h]));
    expect(r.done).toBe(1);
    expect(fake.contacts.get(m.email)?.tags.has('TS Premium (auto)')).toBe(true);
    expect((await row(m.h)).appliedTags).toContain(T.premium);
  });

  it('waits inside the send window and while the breaker is open', async () => {
    const m = await member('PREMIUM', refused());
    await retryRefused(admin.id, now, [m.h]);
    now = new Date('2027-03-01T01:50:00Z'); // 07:20 IST
    expect((await flushPending(deps([m.h]))).skipped).toBe('send_window');
    now = new Date('2027-03-01T10:00:00Z');
    await openBreaker(prisma, PORTAL, 'first_load', {}, now);
    expect((await flushPending(deps([m.h]))).skipped).toBe('breaker_open');
    expect(fake.requests).toHaveLength(0);
    expect((await row(m.h)).nextAttemptAt).not.toBeNull();
  });

  it('refused again after a retry returns to FATAL and counts on the card again', async () => {
    const m = await member('PREMIUM', refused());
    const base0 = (await audienceCard(PORTAL, 'ADMIN', now, CFG)) as { refused: { premium: number } };
    await retryRefused(admin.id, now, [m.h]);
    const mid = (await audienceCard(PORTAL, 'ADMIN', now, CFG)) as { refused: { premium: number } };
    expect(mid.refused.premium).toBe(base0.refused.premium - 1);
    fake.failCreate = () => ({ status: 400, body: { error: { message: 'Invalid email domain' } } });
    const r = await flushPending(deps([m.h]));
    expect(r.fatal).toBe(1);
    const again = await row(m.h);
    expect(again.lastErrorKind).toBe('FATAL');
    expect(again.nextAttemptAt).toBeNull();
    const end = (await audienceCard(PORTAL, 'ADMIN', now, CFG)) as { refused: { premium: number } };
    expect(end.refused.premium).toBe(base0.refused.premium);
  });
});
