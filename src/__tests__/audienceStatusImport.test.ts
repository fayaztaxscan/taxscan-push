import bcrypt from 'bcrypt';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import type { User, UserRole } from '@prisma/client';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { parseAudienceEnv, parseDigestEnv, type AudienceEnv } from '../lib/env';
import { emailHash } from '../services/digest/webhook';
import { classifyStatus, IMPORT_MAX_BYTES, ImportRejected, importMailercloudStatuses, parseCsv, parseStatusFile } from '../services/audience/statusImport';
import { digestNoticeList } from '../services/audience/notices';
import { applyAccountSnapshot } from '../services/audience/ingest';
import type { AccountSnapshot } from '../services/audience/snapshot';
import { flushPending, resetWriterForTests, type WriterDeps } from '../services/audience/writer';
import { McContactClient } from '../services/audience/mcContacts';
import { FakeMailercloud } from './audienceFakeMailercloud';

/**
 * Brief 2026-11-09-digest-notice-list, acceptance 7 and 8: the one-time import of Mailercloud's status export. The CSV reading and
 * status words, what is written (counts, escalation, only CMS-held addresses, a re-import changes nothing), that no address reaches a log,
 * the reply or the audit entry, what a new suppression does in the audience writer (proved against a fake Mailercloud: no call at all),
 * the ADMIN route and its 400s, and the end-to-end opt-in lift. Run-unique addresses on a unique portal; no Mailercloud or CMS call.
 */
const logs: string[] = [];
jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')));
jest.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
jest.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));

const RUN = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const P = `si${RUN}-`;
const PORTAL = `test-status-import-${RUN}`;
const NOW = new Date('2027-03-01T10:00:00Z');
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const hashes = new Set<string>();
const emails: string[] = [];
let seq = 0;
const addr = (local: string): string => {
  const e = `${local}.${++seq}.${RUN}@example.org`;
  emails.push(e);
  hashes.add(sha(e));
  return e;
};

type Held = { email: string; accountId: string; hash: string };
/** A CMS account holding an address (active, with its PREMIUM member); optionally an existing suppression row. */
async function held(local: string, o: { existing?: { reason: string; source?: string }; suppressed?: boolean; fatal?: boolean; tags?: string[]; status?: string } = {}): Promise<Held> {
  const email = addr(local);
  const hash = emailHash(email);
  const accountId = `${P}${local}-${seq}`;
  await prisma.cmsAccount.create({ data: { accountId, portal: PORTAL, seq: 1n, status: o.status ?? 'active', plan: 'premium_1y', emailHash: hash, lastSource: 'pull_full' } });
  await prisma.audienceMember.create({
    data: { emailHash: hash, email, desiredRole: 'PREMIUM', suppressed: o.suppressed ?? false, lastErrorKind: o.fatal ? 'FATAL' : null, appliedTags: o.tags ?? [], mcState: o.tags?.length ? 'PRESENT' : 'UNKNOWN', syncedAt: o.tags?.length ? new Date(NOW.getTime() - 86_400_000) : null },
  });
  if (o.existing) {
    await prisma.emailSuppression.create({
      data: { email, emailHash: hash, reason: o.existing.reason, source: o.existing.source ?? 'mailercloud_webhook', firstSeenAt: new Date('2026-12-01T00:00:00Z'), lastSeenAt: new Date('2026-12-01T00:00:00Z') },
    });
  }
  return { email, accountId, hash };
}

const csv = (rows: [string, string][], header = 'Email,Status'): Buffer => Buffer.from([header, ...rows.map(([e, s]) => `${e},${s}`)].join('\n'), 'utf8');
const rowOf = (hash: string) => prisma.emailSuppression.findUnique({ where: { emailHash: hash } });
const member = (hash: string) => prisma.audienceMember.findUnique({ where: { emailHash: hash } });

const userIds: string[] = [];
async function wipe() {
  const hs = [...hashes];
  await prisma.emailSuppression.deleteMany({ where: { OR: [{ emailHash: { in: hs } }, { accountId: { startsWith: P } }] } });
  await prisma.emailEvent.deleteMany({ where: { emailHash: { in: hs } } });
  await prisma.audienceMember.deleteMany({ where: { emailHash: { in: hs } } });
  await prisma.cmsAccount.deleteMany({ where: { accountId: { startsWith: P } } });
  await prisma.audienceSyncState.deleteMany({ where: { portal: PORTAL } });
}
beforeEach(async () => {
  logs.length = 0;
  await wipe();
});
afterAll(async () => {
  await wipe();
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL audit_log.allow_purge = 'true'`);
    await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "userId" = ANY(${userIds}::text[])`;
    // the service tests import with no user (the route always has one): those rows are ours alone
    await tx.$executeRaw`DELETE FROM "AuditLog" WHERE action = 'AUDIENCE_STATUSES_IMPORTED' AND "userId" IS NULL`;
  });
  await prisma.userSession.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

/* ================================================================== */
/* The CSV and the words                                                */
/* ================================================================== */

describe('reading the file', () => {
  it('parseCsv: quoted fields (commas, doubled quotes, line breaks), CRLF / LF / CR, a BOM, blank lines, no trailing newline', () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\r\n\r\nlast,row')).toEqual([['a', 'b'], ['x, y', 'say "hi"'], ['last', 'row']]);
    expect(parseCsv('a,b\n"multi\nline",2\n')).toEqual([['a', 'b'], ['multi\nline', '2']]);
    expect(parseCsv('a,b\rc,d')).toEqual([['a', 'b'], ['c', 'd']]);
    expect(parseCsv('a;b\n1;2')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseCsv('a\tb\n1\t2')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseCsv('')).toEqual([]);
  });

  it('classifyStatus: Unsubscribed → UNSUBSCRIBE; Hard bounce / Bounced → HARD_BOUNCE; Spam / Complained → SPAM; everything else is ignored', () => {
    for (const s of ['Unsubscribed', 'unsubscribed', ' UNSUBSCRIBE ']) expect(classifyStatus(s)).toBe('UNSUBSCRIBE');
    for (const s of ['Hard bounce', 'Hard bounced', 'hard_bounce', 'HARD-BOUNCED', 'Bounced', 'bounce']) expect(classifyStatus(s)).toBe('HARD_BOUNCE');
    for (const s of ['Spam', 'Complained', 'spam complaint', 'COMPLAINT']) expect(classifyStatus(s)).toBe('SPAM');
    for (const s of ['Active', 'Subscribed', 'Soft bounce', 'Inactive', 'Invalid', 'Blocked', '', 'unsubscribed-ish']) expect(classifyStatus(s)).toBeNull();
  });

  it('header names: the accepted spellings; a BOM; a semicolon file', () => {
    for (const header of ['Email,Status', 'email address,contact status', 'E-mail,Subscription Status', 'Contact Email;State', '﻿EMAIL,STATUS']) {
      const sep = header.includes(';') ? ';' : ',';
      const r = parseStatusFile(Buffer.from(`${header}\nreader@example.org${sep}Unsubscribed`, 'utf8'));
      expect([header, r.byHash.size]).toEqual([header, 1]);
    }
  });

  it('a file without an email column, without a status column, empty, binary or over 5 MB is refused with its own code', () => {
    const code = (b: Buffer): string | null => {
      try {
        parseStatusFile(b);
        return null;
      } catch (e) {
        return e instanceof ImportRejected ? e.code : 'other';
      }
    };
    expect(code(Buffer.from('Name,Status\nx,Unsubscribed'))).toBe('no_email_column');
    expect(code(Buffer.from('Email,Name\nx@example.org,x'))).toBe('no_status_column');
    expect(code(Buffer.alloc(0))).toBe('empty');
    expect(code(Buffer.from('\n\n\n'))).toBe('empty');
    expect(code(Buffer.from([0x45, 0x6d, 0x61, 0x00, 0x69, 0x6c]))).toBe('not_csv');
    expect(code(Buffer.alloc(IMPORT_MAX_BYTES + 1, 'a'))).toBe('too_big');
  });

  it('counts rows, unreadable addresses and other statuses; the strongest status wins for an address listed twice', () => {
    const a = addr('twice');
    const r = parseStatusFile(csv([[a, 'Unsubscribed'], [a.toUpperCase(), 'Spam'], ['not-an-email', 'Unsubscribed'], ['', 'Hard bounce'], [addr('act'), 'Active'], [addr('soft'), 'Soft bounce']]));
    expect([r.read, r.invalid, r.ignored, r.byHash.size]).toEqual([6, 2, 2, 1]);
    expect([...r.byHash.values()][0].reason).toBe('SPAM');
  });
});

/* ================================================================== */
/* The import                                                           */
/* ================================================================== */

describe('7. importMailercloudStatuses', () => {
  const ctx = { userId: null as string | null, now: NOW };

  it('counts, what is written, and what is left alone', async () => {
    const unsub = await held('unsub');
    const bounce = await held('bounce');
    const spam = await held('spam');
    const active = await held('active');
    const dup = await held('dup');
    const stranger1 = addr('stranger1');
    const stranger2 = addr('stranger2');
    const file = csv([
      [unsub.email, 'Unsubscribed'],
      [bounce.email, 'Hard bounce'],
      [spam.email, 'Spam'],
      [active.email, 'Active'],
      [dup.email, 'Unsubscribed'],
      [dup.email, 'Complained'],
      [stranger1, 'Unsubscribed'],
      [stranger2, 'Bounced'],
      ['broken address', 'Unsubscribed'],
    ]);
    const c = await importMailercloudStatuses(file, ctx);
    expect(c).toEqual({ read: 9, invalid: 1, ignored: 1, notInCms: 2, matched: { UNSUBSCRIBE: 1, HARD_BOUNCE: 1, SPAM: 2 }, created: 4, upgraded: 0, unchanged: 0 });

    for (const [h, reason] of [[unsub.hash, 'UNSUBSCRIBE'], [bounce.hash, 'HARD_BOUNCE'], [spam.hash, 'SPAM'], [dup.hash, 'SPAM']] as const) {
      const row = await rowOf(h);
      expect(row).toMatchObject({ reason, source: 'mailercloud_export', firstSeenAt: NOW, lastSeenAt: NOW });
    }
    // only addresses a CMS account holds are written; an Active status writes nothing
    expect(await rowOf(emailHash(stranger1))).toBeNull();
    expect(await rowOf(emailHash(stranger2))).toBeNull();
    expect(await rowOf(active.hash)).toBeNull();
    // exactly like a Mailercloud webhook opt-out: the account id is stamped, the member is suppressed and due for the writer
    expect((await rowOf(unsub.hash))?.accountId).toBe(unsub.accountId);
    expect(await member(unsub.hash)).toMatchObject({ suppressed: true, nextAttemptAt: NOW, desiredRole: 'PREMIUM' });
    expect(await member(active.hash)).toMatchObject({ suppressed: false });
  });

  it('the existing escalation rule holds: never downgraded, MANUAL untouched, escalated only upward', async () => {
    const spamHeld = await held('e-spam', { existing: { reason: 'SPAM' } });
    const manual = await held('e-manual', { existing: { reason: 'MANUAL', source: 'manual' } });
    const unsubToBounce = await held('e-up', { existing: { reason: 'UNSUBSCRIBE' } });
    const bounceHeld = await held('e-bounce', { existing: { reason: 'HARD_BOUNCE' } });
    const sameReason = await held('e-same', { existing: { reason: 'UNSUBSCRIBE' } });
    const before = await Promise.all([spamHeld, manual, bounceHeld, sameReason].map((h) => rowOf(h.hash)));
    const c = await importMailercloudStatuses(
      csv([
        [spamHeld.email, 'Unsubscribed'], // weaker than SPAM
        [manual.email, 'Spam'], // MANUAL is a person's decision: never rewritten
        [unsubToBounce.email, 'Hard bounce'], // stronger: upgraded
        [bounceHeld.email, 'Unsubscribed'], // weaker than HARD_BOUNCE
        [sameReason.email, 'Unsubscribed'], // the same: nothing to write
      ]),
      ctx,
    );
    expect(c).toMatchObject({ created: 0, upgraded: 1, unchanged: 4 });
    const after = await Promise.all([spamHeld, manual, bounceHeld, sameReason].map((h) => rowOf(h.hash)));
    expect(after).toEqual(before); // every field, including source and lastSeenAt
    expect(await rowOf(unsubToBounce.hash)).toMatchObject({ reason: 'HARD_BOUNCE', source: 'mailercloud_export', lastSeenAt: NOW });
    // only the escalated one was handed to the writer
    expect((await member(unsubToBounce.hash))?.suppressed).toBe(true);
    expect((await member(manual.hash))?.suppressed).toBe(false);
  });

  it('a re-import of the same file changes nothing: no row, no field, no member', async () => {
    const a = await held('r-a');
    const b = await held('r-b', { existing: { reason: 'UNSUBSCRIBE' } });
    const file = csv([[a.email, 'Unsubscribed'], [b.email, 'Hard bounce'], [addr('r-x'), 'Spam']]);
    const first = await importMailercloudStatuses(file, ctx);
    expect(first).toMatchObject({ created: 1, upgraded: 1, unchanged: 0 });
    const snap = async () => ({
      rows: await prisma.emailSuppression.findMany({ where: { emailHash: { in: [a.hash, b.hash] } }, orderBy: { emailHash: 'asc' } }),
      members: await prisma.audienceMember.findMany({ where: { emailHash: { in: [a.hash, b.hash] } }, orderBy: { emailHash: 'asc' } }),
    });
    const before = await snap();
    const second = await importMailercloudStatuses(file, { ...ctx, now: new Date(NOW.getTime() + 3_600_000) });
    expect(second).toMatchObject({ created: 0, upgraded: 0, unchanged: 2 });
    expect(await snap()).toEqual(before);
  });

  it('an address that is erased from the table keeps its hash only: a re-import never brings the address back', async () => {
    const a = await held('erased');
    await prisma.emailSuppression.create({ data: { email: null, emailHash: a.hash, reason: 'UNSUBSCRIBE', source: 'mailercloud_webhook' } });
    await importMailercloudStatuses(csv([[a.email, 'Hard bounce']]), ctx);
    expect(await rowOf(a.hash)).toMatchObject({ email: null, reason: 'HARD_BOUNCE' });
  });

  it('NO ADDRESS (and no hash) in a log line, the reply or the audit entry', async () => {
    const a = await held('scan-a');
    const b = await held('scan-b');
    const user = await prisma.user.create({ data: { email: `scan-${RUN}@team.test`, passwordHash: 'x', role: 'ADMIN', isActive: true } });
    userIds.push(user.id);
    const c = await importMailercloudStatuses(csv([[a.email, 'Unsubscribed'], [b.email, 'Hard bounce'], [addr('scan-x'), 'Spam']]), { userId: user.id, now: NOW });
    const entry = await prisma.auditLog.findFirstOrThrow({ where: { action: 'AUDIENCE_STATUSES_IMPORTED', userId: user.id } });
    expect(entry.metadata).toMatchObject({ read: 3, notInCms: 1, matched: { UNSUBSCRIBE: 1, HARD_BOUNCE: 1, SPAM: 0 }, created: 2 });
    const blob = JSON.stringify([c, entry.metadata, entry.resourceType, entry.resourceId, logs]);
    for (const e of emails) {
      expect(blob).not.toContain(e);
      expect(blob).not.toContain(emailHash(e));
    }
    expect(blob).not.toContain('@');
    expect(logs.join('\n')).toMatch(/\[audience\] statuses imported read=3 matched=2 created=2 upgraded=0 unchanged=0 ignored=0 invalid=0 notInCms=1/);
  });
});

/* ================================================================== */
/* What a new suppression does downstream                               */
/* ================================================================== */

describe('7. what an imported suppression changes in the audience writer', () => {
  const KEY = 'k'.repeat(40);
  const T = { premium: `tp-${RUN}`, former: `tf-${RUN}`, noMarketing: `tn-${RUN}` };
  const cfg = (): AudienceEnv =>
    parseAudienceEnv({
      AUDIENCE_SYNC_ENABLED: 'true',
      AUDIENCE_SYNC_WRITE_MAILERCLOUD: 'true',
      MAILERCLOUD_SYNC_API_KEY: KEY,
      AUDIENCE_MC_LIST_ID: 'list-1',
      AUDIENCE_MC_TAG_PREMIUM: T.premium,
      AUDIENCE_MC_TAG_FORMER: T.former,
      AUDIENCE_MC_TAG_NO_MARKETING: T.noMarketing,
    });
  let fake: FakeMailercloud;
  let base: string;
  beforeEach(async () => {
    resetWriterForTests();
    fake = new FakeMailercloud(KEY);
    fake.tags = [
      { id: T.premium, tag_name: 'TS Premium (auto)' },
      { id: T.former, tag_name: 'TS Former (auto)' },
      { id: T.noMarketing, tag_name: 'TS No marketing (auto)' },
    ];
    base = await fake.start();
    await prisma.audienceSyncState.upsert({ where: { portal: PORTAL }, create: { portal: PORTAL, lastFullOkAt: new Date(NOW.getTime() - 3_600_000) }, update: { lastFullOkAt: new Date(NOW.getTime() - 3_600_000) } });
  });
  afterEach(async () => {
    await fake.stop();
  });
  const tick = (only: string[]) => {
    const deps: WriterDeps = {
      client: new McContactClient({ apiKey: KEY, baseV1: base, resubscribeWrites: false }),
      cfg: cfg(),
      digestCfg: { sendAt: '07:30' },
      portal: PORTAL,
      now: () => NOW,
      sleep: () => Promise.resolve(),
      sendAlerts: false,
      onlyHashes: only,
    };
    return flushPending(deps);
  };

  it('a paid reader Mailercloud already excludes: the writer makes NO Mailercloud call, keeps the Premium tag and the role; only the bookkeeping moves', async () => {
    const tagged = await held('w-tagged', { tags: [T.premium] });
    fake.addContact(tagged.email, { status: 'unsubscribed', tags: ['TS Premium (auto)'] });
    const refused = await held('w-refused', { fatal: true });
    const untagged = await held('w-untagged'); // Premium, never written yet: its tag would have been added
    await importMailercloudStatuses(csv([[tagged.email, 'Unsubscribed'], [refused.email, 'Hard bounce'], [untagged.email, 'Unsubscribed']]), { userId: null, now: NOW });
    const report = await tick([tagged.hash, refused.hash, untagged.hash]);
    expect(report.skipped).toBeUndefined();
    // Mailercloud was asked nothing about any contact and nothing was written: the ONLY request is the writer's read-only tag-name search
    // (made at the start of any tick with a due member; a POST in Mailercloud's API, but it only reads tag names)
    expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual(['POST /v1/tags/search']);
    // the tagged reader keeps its tag and role; it is suppressed (adds stop) and no longer due
    expect(await member(tagged.hash)).toMatchObject({ desiredRole: 'PREMIUM', appliedTags: [T.premium], suppressed: true, nextAttemptAt: null, lastErrorKind: null });
    // the refused (FATAL) reader is no longer "refused" in the writer's bookkeeping: its FATAL flag is cleared because there is nothing left to write
    expect(await member(refused.hash)).toMatchObject({ desiredRole: 'PREMIUM', appliedTags: [], suppressed: true, nextAttemptAt: null, lastErrorKind: null });
    // a suppressed reader never gets the Premium tag added (it is unsubscribed in Mailercloud anyway)
    expect(await member(untagged.hash)).toMatchObject({ appliedTags: [], suppressed: true, lastErrorKind: null });
    // and every one of them is on the notice list, from the suppression row (the FATAL flag is gone)
    const got = Object.fromEntries((await digestNoticeList(PORTAL, NOW)).map((i) => [i.accountId, i.reason]));
    expect(got).toEqual({ [tagged.accountId]: 'unsubscribed', [refused.accountId]: 'bad_address', [untagged.accountId]: 'unsubscribed' });
  });

  it('a refused reader the file does NOT list as bounced stays refused: nothing is written, nothing changes', async () => {
    const refused = await held('w-stay', { fatal: true });
    await importMailercloudStatuses(csv([[refused.email, 'Active']]), { userId: null, now: NOW });
    expect(await rowOf(refused.hash)).toBeNull();
    expect(await member(refused.hash)).toMatchObject({ lastErrorKind: 'FATAL', suppressed: false });
    expect((await digestNoticeList(PORTAL, NOW)).map((i) => i.reason)).toEqual(['bad_address']);
  });

  it('the digest send never reads EmailSuppression: only the webhook, the writer, ingest and the pull do', () => {
    const root = path.join(__dirname, '..');
    const offenders: string[] = [];
    const scan = (dir: string): void => {
      for (const n of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, n.name);
        if (n.isDirectory()) scan(p);
        else if (p.endsWith('.ts') && !p.endsWith('digest/webhook.ts')) {
          if (/emailSuppression|findSuppressions|isSuppressed|afterSuppressionWrite/.test(readFileSync(p, 'utf8'))) offenders.push(path.relative(root, p));
        }
      }
    };
    scan(path.join(root, 'services', 'digest'));
    for (const f of readdirSync(path.join(root, 'routes')).filter((n) => /^digest.*\.ts$/.test(n))) {
      if (/emailSuppression|findSuppressions|isSuppressed/.test(readFileSync(path.join(root, 'routes', f), 'utf8'))) offenders.push(`routes/${f}`);
    }
    expect(offenders).toEqual([]);
  });
});

/* ================================================================== */
/* The ADMIN route                                                      */
/* ================================================================== */

describe('7. POST /api/digest/audience/import-statuses', () => {
  const PASSWORD = 'ImportPw1Aa';
  const app = createApp({
    rateLimit: { publicPerMin: 100_000, loginPerMin: 100_000 },
    digest: { cfg: parseDigestEnv({}), audience: parseAudienceEnv({ AUDIENCE_SYNC_ENABLED: 'true' }), clock: () => NOW, portal: PORTAL, alerts: false },
  });
  const login = createApp({ rateLimit: { publicPerMin: 100_000, loginPerMin: 100_000 } });
  let admin: User;
  let publisher: User;
  let adminCookie = '';
  let publisherCookie = '';
  async function makeUser(role: UserRole): Promise<User> {
    const u = await prisma.user.create({ data: { email: `import-${role.toLowerCase()}-${RUN}-${++seq}@team.test`, passwordHash: await bcrypt.hash(PASSWORD, 4), role, isActive: true } });
    userIds.push(u.id);
    return u;
  }
  async function cookie(u: User): Promise<string> {
    const res = await request(login).post('/api/auth/login').send({ email: u.email, password: PASSWORD });
    expect(res.status).toBe(200);
    const sc = res.headers['set-cookie'];
    return (Array.isArray(sc) ? sc : [sc as unknown as string]).map((l) => l.split(';')[0]).join('; ');
  }
  beforeAll(async () => {
    admin = await makeUser('ADMIN');
    publisher = await makeUser('PUBLISHER');
    adminCookie = await cookie(admin);
    publisherCookie = await cookie(publisher);
  });
  const upload = (body: Buffer, who: 'admin' | 'publisher' | 'none' | 'bearer' = 'admin', type = 'text/csv') => {
    let req = request(app).post('/api/digest/audience/import-statuses').set('Content-Type', type);
    if (who === 'admin') req = req.set('Cookie', adminCookie);
    if (who === 'publisher') req = req.set('Cookie', publisherCookie);
    if (who === 'bearer') req = req.set('Authorization', `Bearer ${process.env.ADMIN_TOKEN}`);
    return req.send(body);
  };

  it('ADMIN only: no session 401, a bearer 401, a PUBLISHER 403', async () => {
    const f = csv([[addr('role'), 'Unsubscribed']]);
    expect((await upload(f, 'none')).status).toBe(401);
    expect((await upload(f, 'bearer')).status).toBe(401);
    expect((await upload(f, 'publisher')).status).toBe(403);
  });

  it('an ADMIN gets counts, whatever DIGEST_NOTICES_ENABLED says; the same file again adds nothing; any content type is read as the file', async () => {
    const a = await held('route-a');
    const b = await held('route-b');
    const file = csv([[a.email, 'Unsubscribed'], [b.email, 'Hard bounce'], [addr('route-x'), 'Unsubscribed'], [addr('route-y'), 'Active']]);
    const first = await upload(file);
    expect([first.status, first.body]).toEqual([200, { ok: true, counts: { read: 4, invalid: 0, ignored: 1, notInCms: 1, matched: { UNSUBSCRIBE: 1, HARD_BOUNCE: 1, SPAM: 0 }, created: 2, upgraded: 0, unchanged: 0 } }]);
    const again = await upload(file, 'admin', 'application/vnd.ms-excel');
    expect(again.body.counts).toMatchObject({ created: 0, upgraded: 0, unchanged: 2 });
    const entry = await prisma.auditLog.findFirstOrThrow({ where: { action: 'AUDIENCE_STATUSES_IMPORTED', userId: admin.id }, orderBy: { createdAt: 'asc' } });
    expect(entry.metadata).toMatchObject({ read: 4, created: 2 });
    expect(JSON.stringify([first.body, again.body, entry.metadata])).not.toContain('@');
  });

  it('a bad file is a plain 400 in words: empty, no email column, no status column, binary, over 5 MB', async () => {
    const cases: [string, Buffer, string][] = [
      ['empty', Buffer.alloc(0), 'empty'],
      ['no email column', Buffer.from('Name,Status\nx,Unsubscribed'), 'no_email_column'],
      ['no status column', Buffer.from('Email,Name\nx@example.org,x'), 'no_status_column'],
      ['binary', Buffer.from([0x45, 0x00, 0x6d]), 'not_csv'],
      ['over 5 MB', Buffer.alloc(IMPORT_MAX_BYTES + 1024, 'a'), 'too_big'],
    ];
    for (const [label, body, code] of cases) {
      const r = await upload(body);
      expect([label, r.status, r.body.error]).toEqual([label, 400, code]);
      expect(typeof r.body.message).toBe('string');
      expect(r.body.message.length).toBeGreaterThan(10);
    }
  });
});

/* ================================================================== */
/* 8. A CMS opt-in lifts an imported unsubscribe                        */
/* ================================================================== */

describe('8. the existing consent lift, end to end, on an imported unsubscribe', () => {
  const cfg = parseAudienceEnv({ AUDIENCE_SYNC_ENABLED: 'true' });
  const snap = (accountId: string, email: string, over: Partial<AccountSnapshot>): AccountSnapshot => ({
    accountId,
    seq: 1n,
    email,
    status: 'active',
    plan: 'premium_1y',
    periodEnd: new Date('2027-12-31'),
    consentValue: null,
    consentAt: null,
    erasure: false,
    reactivated: false,
    deleted: false,
    deletedAt: null,
    ...over,
  });
  const apply = (s: AccountSnapshot, now: Date) => prisma.$transaction((tx) => applyAccountSnapshot(tx, s, 'webhook', { cfg, portal: PORTAL, now }), { timeout: 20_000 });
  const ids = () => ({ id: `${P}lift-${++seq}`, email: addr('lift') });

  it('an opt-in dated AFTER the import deletes the suppression and the account leaves the list on the next build; one dated BEFORE does not', async () => {
    const later = ids();
    const earlier = ids();
    for (const x of [later, earlier]) await apply(snap(x.id, x.email, {}), NOW);
    const c = await importMailercloudStatuses(csv([[later.email, 'Unsubscribed'], [earlier.email, 'Unsubscribed']]), { userId: null, now: NOW });
    expect(c.created).toBe(2);
    expect(Object.fromEntries((await digestNoticeList(PORTAL, NOW)).map((i) => [i.accountId, i.reason]))).toEqual({ [later.id]: 'unsubscribed', [earlier.id]: 'unsubscribed' });

    const afterImport = new Date(NOW.getTime() + 3_600_000);
    // the opt-in tap, dated an hour after the import
    await apply(snap(later.id, later.email, { seq: 2n, consentValue: true, consentAt: afterImport }), afterImport);
    // a consent that was already true BEFORE the import (the reader opted in at the CMS long ago; Mailercloud still has them unsubscribed)
    await apply(snap(earlier.id, earlier.email, { seq: 2n, consentValue: true, consentAt: new Date(NOW.getTime() - 86_400_000) }), afterImport);

    expect(await rowOf(emailHash(later.email))).toBeNull();
    expect(await rowOf(emailHash(earlier.email))).toMatchObject({ reason: 'UNSUBSCRIBE' });
    expect((await digestNoticeList(PORTAL, afterImport)).map((i) => i.accountId)).toEqual([earlier.id]);
    // the lift is recorded the way every lift is
    expect(await prisma.emailEvent.count({ where: { type: 'RESUBSCRIBE', emailHash: emailHash(later.email) } })).toBe(1);
  });

  it('an imported unsubscribe on an account whose consent is false never reaches the list (consent = false is never notified)', async () => {
    const x = ids();
    await apply(snap(x.id, x.email, { consentValue: false, consentAt: NOW }), NOW);
    await importMailercloudStatuses(csv([[x.email, 'Unsubscribed']]), { userId: null, now: NOW });
    expect((await digestNoticeList(PORTAL, NOW)).map((i) => i.accountId)).not.toContain(x.id);
  });
});
