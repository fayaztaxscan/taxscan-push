/**
 * CMS audience sync — QA follow-ups on 381fb25 (docs/CMS_AUDIENCE_SYNC_DESIGN.md, owner rulings 24 Oct;
 * push-feed contract v1.3):
 *  - M1 erasure: our records are erased at INGEST (no erase queue, no Mailercloud delete); the hash and
 *    the No-marketing exclusion stay; an address another live account still holds is left alone;
 *  - M2 consent lift: only suppressions on the account's CURRENT address are lifted, never by an
 *    account-id match alone;
 *  - L3 the EmailSuppression trigger normalises exactly like the app before hashing;
 *  - L5 `erasure: true` only on `account.deleted` or a tombstone list row.
 */
import { createHash } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { parseAudienceEnv, type AudienceEnv } from '../lib/env';
import { CMS_EVENT_BODIES } from './fixtures/cms-feed-v1.3/payloads';
import { parseCmsEvent, parseCmsListRow, type AccountSnapshot } from '../services/audience/snapshot';
import { applyAccountSnapshot, type SnapshotSource } from '../services/audience/ingest';
import { emailHash, normaliseEmail } from '../services/digest/webhook';

const logs: string[] = [];
const capture = (...args: unknown[]) => {
  logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a, (_k, v) => (typeof v === 'bigint' ? String(v) : v)))).join(' '));
};
jest.spyOn(console, 'log').mockImplementation(capture);
jest.spyOn(console, 'warn').mockImplementation(capture);
jest.spyOn(console, 'error').mockImplementation(capture);

const RUN = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const P = `qf${RUN}-`;
const PORTAL = `test-audience-qf-${RUN}`;
const SRC = `qf-${RUN}`;
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const hashes = new Set<string>();
const email = (local: string) => {
  const e = `${local}.${RUN}@example.com`;
  hashes.add(sha(e));
  return e;
};
const cfg: AudienceEnv = parseAudienceEnv({ AUDIENCE_SYNC_ENABLED: 'true' });

type Key = keyof typeof CMS_EVENT_BODIES;
function ev(key: Key, id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const o = JSON.parse(CMS_EVENT_BODIES[key]) as Record<string, unknown>;
  return { ...o, account_id: id, ...over };
}
function snapOf(body: Record<string, unknown>): AccountSnapshot {
  const p = parseCmsEvent(body);
  if (!p.ok || !('snapshot' in p)) throw new Error(`did not parse: ${JSON.stringify(p)}`);
  return p.snapshot;
}
async function apply(snap: AccountSnapshot, source: SnapshotSource = 'webhook', now?: Date) {
  return prisma.$transaction((tx) => applyAccountSnapshot(tx, snap, source, { cfg, portal: PORTAL, ...(now ? { now } : {}) }), { timeout: 20_000 });
}
const member = (addr: string) => prisma.audienceMember.findUnique({ where: { emailHash: sha(addr) } });

afterAll(async () => {
  const hs = [...hashes];
  await prisma.emailEvent.deleteMany({ where: { emailHash: { in: hs } } });
  await prisma.emailSuppression.deleteMany({ where: { OR: [{ accountId: { startsWith: P } }, { emailHash: { in: hs } }, { source: SRC }] } });
  await prisma.audienceMember.deleteMany({ where: { emailHash: { in: hs } } });
  await prisma.cmsAccount.deleteMany({ where: { accountId: { startsWith: P } } });
  await prisma.audienceSyncState.deleteMany({ where: { portal: { startsWith: PORTAL } } });
  await prisma.$disconnect();
});

// ─── M1: erasure ────────────────────────────────────────────────────────────

describe('M1 — erasure erases OUR records at ingest (owner 24 Oct; contract v1.3)', () => {
  it('the v1.3 fixture (900003 seq 3: erasure true, email null) parses as an erasure', () => {
    const s = snapOf(JSON.parse(CMS_EVENT_BODIES['account.deleted_900003_seq3']));
    expect(s).toMatchObject({ accountId: '900003', seq: 3n, email: null, deleted: true, erasure: true, status: 'deleted' });
  });

  it('900003 (v1.3): sign-up, says no (withheld), asks for erasure → erased; its opt-out loses the address, keeps the hash', async () => {
    const id = `${P}900003`;
    const addr = email('reader3');
    // seq 1 (not shown in the contract): the sign-up, with an address. A plain free reader: no member row.
    await apply(snapOf(ev('account.created_900001_seq1', id, { email: addr })));
    // seq 2: "no" → withheld. Still no address held (we never stored one).
    await apply(snapOf(ev('account.updated_900003_seq2', id)));
    expect(await member(addr)).toBeNull();
    await prisma.emailSuppression.create({ data: { email: addr, reason: 'UNSUBSCRIBE', source: SRC, lastSeenAt: new Date('2026-01-01') } });

    const r = await apply(snapOf(ev('account.deleted_900003_seq3', id)));
    expect(r).toMatchObject({ outcome: 'applied', erased: true, addressNulled: false });
    expect(await member(addr)).toBeNull();
    const sup = await prisma.emailSuppression.findMany({ where: { emailHash: sha(addr) } });
    expect(sup).toHaveLength(1);
    expect(sup[0]).toMatchObject({ email: null, emailHash: sha(addr), reason: 'UNSUBSCRIBE' });
    // The account keeps its hash, so the opt-out still matches by hash.
    expect(await prisma.cmsAccount.findUnique({ where: { accountId: id } })).toMatchObject({ emailHash: sha(addr), status: 'deleted' });
  });

  it('an ex-Premium reader held as a No-marketing exclusion is erased: address nulled, hash + exclusion kept', async () => {
    const id = `${P}900002`;
    const addr = email('reader2');
    await apply(snapOf(ev('subscription.renewed_900002_seq3', id, { email: addr })));
    await apply(snapOf(ev('subscription.ended_900002_seq5', id)));
    expect(await member(addr)).toMatchObject({ email: addr, noMarketing: true, desiredRole: 'NONE' });
    const r = await apply(snapOf(ev('account.deleted_900002_seq7', id)));
    expect(r).toMatchObject({ erased: true, addressNulled: true });
    expect(await member(addr)).toMatchObject({ email: null, noMarketing: true, desiredRole: 'NONE', appliedTags: [], nextAttemptAt: null });
  });

  it('an erased Premium member: tags marked gone (the CMS deleted the contact), nothing queued for the writer', async () => {
    const id = `${P}prem-erase`;
    const addr = email('prem-erase');
    await apply(snapOf(ev('subscription.started_900001_seq3', id, { email: addr, seq: 1 })));
    await prisma.audienceMember.update({ where: { emailHash: sha(addr) }, data: { appliedTags: ['tagP'], mcState: 'PRESENT', nextAttemptAt: null } });
    const r = await apply(snapOf(ev('account.deleted_900002_seq7', id, { seq: 2 })));
    expect(r).toMatchObject({ erased: true, addressNulled: true, premiumRemovals: 1 });
    const m = await member(addr);
    expect(m).toMatchObject({ email: null, desiredRole: 'NONE', noMarketing: true, appliedTags: [], mcState: 'ABSENT', nextAttemptAt: null });
    // Re-applying the erased tombstone (the nightly list) changes nothing and brings nothing back.
    const listRow = {
      account_id: id, seq: 2, email: null, name: null, plan: null, status: 'deleted', period_start: null, period_end: null,
      marketing_consent: { value: null, at: null }, erasure: true, deleted_at: '2027-01-15T11:05:00+05:30', updated_at: '2027-01-15T11:06:00+05:30',
    };
    const lr = parseCmsListRow(listRow);
    if (!lr.ok) throw new Error(lr.reason);
    expect((await apply(lr.snapshot, 'pull_full')).outcome).toBe('repaired');
    expect(await member(addr)).toMatchObject({ email: null, appliedTags: [] });
  });

  it('SHARED address: A erased while B (same address) is Premium → B untouched (address, role, tags, schedule), B’s opt-out keeps its address', async () => {
    const a = `${P}share-a`;
    const b = `${P}share-b`;
    const addr = email('shared');
    await prisma.emailSuppression.create({ data: { email: addr, reason: 'UNSUBSCRIBE', source: SRC } });
    await apply(snapOf(ev('account.created_900001_seq1', a, { email: addr })));
    await apply(snapOf(ev('subscription.started_900001_seq3', b, { email: addr, seq: 1 })));
    await prisma.audienceMember.update({ where: { emailHash: sha(addr) }, data: { appliedTags: ['tagP'], mcState: 'PRESENT', nextAttemptAt: null } });
    const before = await member(addr);

    const r = await apply(snapOf(ev('account.deleted_900002_seq7', a, { seq: 2 })));
    expect(r).toMatchObject({ erased: true, addressNulled: false, roleChanges: 0, premiumRemovals: 0 });
    const after = await member(addr);
    expect(after).toMatchObject({ email: addr, desiredRole: 'PREMIUM', noMarketing: false, suppressed: true, appliedTags: ['tagP'], mcState: 'PRESENT', nextAttemptAt: null });
    expect(after!.updatedAt.getTime()).toBe(before!.updatedAt.getTime());
    expect((await prisma.emailSuppression.findFirst({ where: { emailHash: sha(addr) } }))!.email).toBe(addr);
    // A's own account is erased all the same.
    expect((await prisma.cmsAccount.findUnique({ where: { accountId: a } }))!.erasedAt).not.toBeNull();
  });

  it('no erase queue is ever written (the column stays, unused)', async () => {
    expect(await prisma.audienceMember.count({ where: { emailHash: { in: [...hashes] }, eraseRequestedAt: { not: null } } })).toBe(0);
  });
});

// ─── M2: lift only on the current address ───────────────────────────────────

describe('M2 — the consent lift applies only to the account’s CURRENT address', () => {
  it('SPAM on old@, the account moves to new@ with consent true → old@ SPAM stays; new@ stays suppressed by it', async () => {
    const id = `${P}m2`;
    const oldA = email('m2-old');
    const newA = email('m2-new');
    const t0 = new Date('2026-10-01T00:00:00Z');
    await apply(snapOf(ev('subscription.started_900001_seq3', id, { email: oldA, seq: 1, marketing_consent: { value: null, at: null } })));
    await prisma.emailSuppression.create({ data: { email: oldA, accountId: id, reason: 'SPAM', source: SRC, firstSeenAt: t0, lastSeenAt: t0 } });
    const r = await apply(
      snapOf(ev('account.email_changed_900001_seq4', id, { email: newA, seq: 2, marketing_consent: { value: true, at: '2026-10-20T00:00:00+05:30' } })),
    );
    expect(r.lifted).toBe(0);
    expect(await prisma.emailSuppression.count({ where: { emailHash: sha(oldA), reason: 'SPAM' } })).toBe(1);
    // The opt-out still follows the account: no add-writes for new@.
    expect(await member(newA)).toMatchObject({ desiredRole: 'PREMIUM', suppressed: true });
  });

  it('a HARD_BOUNCE carrying only the account id (hash-only row of another address) is never lifted', async () => {
    const id = `${P}m2b`;
    const cur = email('m2b-cur');
    const gone = email('m2b-gone');
    const t0 = new Date('2026-10-01T00:00:00Z');
    await prisma.emailSuppression.create({ data: { email: null, emailHash: sha(gone), accountId: id, reason: 'HARD_BOUNCE', source: SRC, firstSeenAt: t0, lastSeenAt: t0 } });
    const r = await apply(snapOf(ev('account.updated_900001_seq2', id, { email: cur, seq: 1 })));
    expect(r.lifted).toBe(0);
    expect(await prisma.emailSuppression.count({ where: { accountId: id, reason: 'HARD_BOUNCE' } })).toBe(1);
  });

  it('an UNSUBSCRIBE on the current address, older than the opt-in, IS lifted', async () => {
    const id = `${P}m2c`;
    const cur = email('m2c-cur');
    const t0 = new Date('2026-10-01T00:00:00Z');
    await prisma.emailSuppression.create({ data: { email: cur, reason: 'UNSUBSCRIBE', source: SRC, firstSeenAt: t0, lastSeenAt: t0 } });
    const r = await apply(snapOf(ev('account.updated_900001_seq2', id, { email: cur, seq: 1 })), 'webhook', new Date('2026-10-22T10:00:00Z'));
    expect(r.lifted).toBe(1);
    expect(await prisma.emailSuppression.count({ where: { emailHash: sha(cur) } })).toBe(0);
  });
});

// ─── L3: the trigger normalises like the app ─────────────────────────────────

describe('L3 — the EmailSuppression trigger normalises exactly like the app', () => {
  const insert = (raw: string) =>
    prisma.$queryRaw<{ email: string; emailHash: string }[]>`
      INSERT INTO "EmailSuppression" (id, email, reason, source, "firstSeenAt", "lastSeenAt")
      VALUES (${`qf-${RUN}-${Math.random()}`}, ${raw}, 'MANUAL', ${SRC}, now(), now())
      RETURNING email, "emailHash"`;

  it.each([
    ['  Mixed.Case@Example.COM  ', 'spaces + capitals'],
    [' ﻿Tabbed@Example.com \t', 'Unicode whitespace JS trim() removes'],
  ])('%j (%s) is stored and hashed as normaliseEmail → emailHash', async (local) => {
    const raw = local.replace('@', `.${RUN}@`);
    const n = normaliseEmail(raw)!;
    hashes.add(emailHash(n));
    const [row] = await insert(raw);
    expect(row.email).toBe(n);
    expect(row.emailHash).toBe(emailHash(n));
  });

  it('an already-normalised non-ASCII address (what the app stores) passes through with the app’s hash', async () => {
    const n = normaliseEmail(`İçerik.ẞtraße.${RUN}@example.com`)!;
    hashes.add(emailHash(n));
    const [row] = await insert(n);
    expect(row.email).toBe(n);
    expect(row.emailHash).toBe(emailHash(n));
  });

  it('a NON-normalised non-ASCII address is refused (Postgres lower() would disagree with JS)', async () => {
    await expect(insert(`İSTANBUL.${RUN}@example.com`)).rejects.toThrow();
    await expect(insert(`Ünïcode.${RUN}@example.com`)).rejects.toThrow();
    // Residual (documented in the migration): a capital the database LOCALE does not know as one
    // (e.g. U+1E9E under macOS's libc) passes through verbatim. The app never writes one.
  });

  it('control characters are refused, as normaliseEmail refuses them', async () => {
    await expect(insert(`a\u0007b.${RUN}@example.com`)).rejects.toThrow();
  });

  it('an update that nulls the address keeps the normalised hash', async () => {
    const raw = `Keep.Hash.${RUN}@Example.com`;
    const n = normaliseEmail(raw)!;
    hashes.add(emailHash(n));
    const [row] = await insert(raw);
    await prisma.$executeRaw`UPDATE "EmailSuppression" SET email = NULL WHERE "emailHash" = ${row.emailHash}`;
    const after = await prisma.emailSuppression.findUnique({ where: { emailHash: emailHash(n) } });
    expect(after).toMatchObject({ email: null, emailHash: emailHash(n) });
  });
});

// ─── L5: erasure only on a deletion ─────────────────────────────────────────

describe('L5 — erasure:true only on account.deleted (or a tombstone list row)', () => {
  it('an account.updated carrying status "deleted" + erasure true is refused', () => {
    const p = parseCmsEvent(ev('account.deleted_900002_seq7', '1', { event: 'account.updated' }));
    expect(p).toMatchObject({ ok: false, reason: 'bad_erasure' });
  });

  it('every other event type with erasure true is refused', () => {
    for (const t of ['account.created', 'account.email_changed', 'subscription.ended']) {
      expect([t, parseCmsEvent(ev('account.deleted_900002_seq7', '1', { event: t })).ok]).toEqual([t, false]);
    }
  });

  const row = (over: Record<string, unknown>) => ({
    account_id: '1', seq: 1, email: null, name: null, plan: null, status: 'deleted', period_start: null, period_end: null,
    marketing_consent: { value: null, at: null }, erasure: true, deleted_at: '2027-01-15T11:05:00+05:30', updated_at: '2027-01-15T11:06:00+05:30', ...over,
  });

  it('a list row: erasure true with deleted_at → ok; with deleted_at null → refused', () => {
    expect(parseCmsListRow(row({})).ok).toBe(true);
    expect(parseCmsListRow(row({ deleted_at: null }))).toMatchObject({ ok: false, reason: 'bad_erasure' });
  });

  it('account.deleted with erasure true still parses (both fixtures)', () => {
    expect(parseCmsEvent(JSON.parse(CMS_EVENT_BODIES['account.deleted_900002_seq7'])).ok).toBe(true);
    expect(parseCmsEvent(JSON.parse(CMS_EVENT_BODIES['account.deleted_900003_seq3'])).ok).toBe(true);
  });
});

describe('logging', () => {
  it('no address appears in any log line', () => {
    for (const line of logs) expect(line).not.toMatch(/@example\.com/i);
  });
});
