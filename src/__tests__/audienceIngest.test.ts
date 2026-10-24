/**
 * CMS audience sync, task 3 (docs/CMS_AUDIENCE_SYNC_DESIGN.md §3.1, §4, §5, §6.3; push-feed contract
 * v1.2 §6, §7, §10, §11): snapshot parsing, `memberRole`, `applyAccountSnapshot`, `recomputeMembers`,
 * tombstones, erasure both ways, withheld rows, reactivation, the consent lift, the account-keyed
 * suppression, the seq rule (events >, list rows ≥), and no address in any log.
 *
 * Every A.5 fixture runs through `applyAccountSnapshot`. Account ids are prefixed per run and the
 * fake example.com addresses get a per-run tag, so parallel test files never share rows.
 */
import { createHash } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { parseAudienceEnv, parseDigestEnv, type AudienceEnv } from '../lib/env';
import { CMS_EVENT_BODIES, CMS_LIST_PAGE_1 } from './fixtures/cms-feed-v1.3/payloads';
import { parseCmsEvent, parseCmsListRow, type AccountSnapshot } from '../services/audience/snapshot';
import { memberRole } from '../services/audience/rules';
import { applyAccountSnapshot, istDayStart, MAX_LIFTS_PER_DAY, type ApplyOptions, type SnapshotSource } from '../services/audience/ingest';
import { handleMailercloudWebhook } from '../services/digest/webhook';

const logs: string[] = [];
const capture = (...args: unknown[]) => {
  logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a, (_k, v) => (typeof v === 'bigint' ? String(v) : v)))).join(' '));
};
jest.spyOn(console, 'log').mockImplementation(capture);
jest.spyOn(console, 'warn').mockImplementation(capture);
jest.spyOn(console, 'error').mockImplementation(capture);

const RUN = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const P = `t${RUN}-`;
const PORTAL = `test-audience-${RUN}`;
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const hashes = new Set<string>();
const track = (email: string) => {
  hashes.add(sha(email));
  return email;
};

type Key = keyof typeof CMS_EVENT_BODIES;

/** A fixture event with this run's account id / address, optionally overridden. */
function ev(key: Key, over: Record<string, unknown> = {}, id?: string): Record<string, unknown> {
  const o = JSON.parse(CMS_EVENT_BODIES[key]) as Record<string, unknown>;
  o.account_id = id ?? `${P}${o.account_id as string}`;
  if (typeof o.email === 'string') o.email = track((o.email as string).replace('@', `.${RUN}@`));
  const out = { ...o, ...over };
  if (typeof out.email === 'string') track(out.email);
  return out;
}
const email = (local: string) => track(`${local}.${RUN}@example.com`);

const cfg: AudienceEnv = parseAudienceEnv({ AUDIENCE_SYNC_ENABLED: 'true' });

function snapOf(body: Record<string, unknown>): AccountSnapshot {
  const p = parseCmsEvent(body);
  if (!p.ok || !('snapshot' in p)) throw new Error(`fixture did not parse: ${JSON.stringify(p)}`);
  return p.snapshot;
}

function rowSnap(row: Record<string, unknown>): AccountSnapshot {
  const p = parseCmsListRow(row);
  if (!p.ok) throw new Error(`row did not parse: ${p.reason}`);
  return p.snapshot;
}

async function apply(snap: AccountSnapshot, source: SnapshotSource = 'webhook', opts: ApplyOptions = {}) {
  return prisma.$transaction((tx) => applyAccountSnapshot(tx, snap, source, { cfg, portal: PORTAL, ...opts }), { timeout: 20_000 });
}
const applyEv = (body: Record<string, unknown>, opts: ApplyOptions = {}) => apply(snapOf(body), 'webhook', opts);

const account = (id: string) => prisma.cmsAccount.findUnique({ where: { accountId: id } });
const member = (addr: string) => prisma.audienceMember.findUnique({ where: { emailHash: sha(addr) } });

afterAll(async () => {
  const hs = [...hashes];
  await prisma.emailEvent.deleteMany({ where: { OR: [{ emailHash: { in: hs } }, { dedupeKey: { startsWith: `cap-${RUN}` } }, { mcCampaignId: { startsWith: P } }] } });
  await prisma.emailSuppression.deleteMany({ where: { OR: [{ accountId: { startsWith: P } }, { emailHash: { in: hs } }] } });
  await prisma.audienceMember.deleteMany({ where: { emailHash: { in: hs } } });
  await prisma.cmsAccount.deleteMany({ where: { accountId: { startsWith: P } } });
  await prisma.audienceSyncState.deleteMany({ where: { portal: { startsWith: PORTAL } } });
  await prisma.$disconnect();
});

// ─── parsing ────────────────────────────────────────────────────────────────

describe('parseCmsEvent / parseCmsListRow (contract v1.2)', () => {
  it('every A.5 fixture parses byte for byte as a known event', () => {
    for (const [key, body] of Object.entries(CMS_EVENT_BODIES)) {
      const p = parseCmsEvent(JSON.parse(body));
      expect(p.ok).toBe(true);
      expect('snapshot' in p).toBe(true);
      if (p.ok && 'snapshot' in p) expect(`${p.event}_${p.snapshot.accountId}_seq${p.snapshot.seq}`).toBe(key);
    }
  });

  it('withheld rows: email + name null on a live account are tolerated', () => {
    const s = snapOf(JSON.parse(CMS_EVENT_BODIES['account.updated_900003_seq2']));
    expect(s).toMatchObject({ email: null, status: 'free', consentValue: false, deleted: false, erasure: false });
  });

  it('deletions: deleted, deletedAt from occurred_at, erasure carried', () => {
    const d6 = snapOf(JSON.parse(CMS_EVENT_BODIES['account.deleted_900002_seq6']));
    const d7 = snapOf(JSON.parse(CMS_EVENT_BODIES['account.deleted_900002_seq7']));
    expect(d6).toMatchObject({ deleted: true, erasure: false, email: null });
    expect(d6.deletedAt?.toISOString()).toBe('2027-01-10T09:50:00.000Z');
    expect(d7).toMatchObject({ deleted: true, erasure: true });
  });

  it('the A.7 list page rows parse (a withheld row and a tombstone included)', () => {
    const page = JSON.parse(CMS_LIST_PAGE_1) as { data: unknown[] };
    const rows = page.data.map((r) => parseCmsListRow(r));
    expect(rows.every((r) => r.ok)).toBe(true);
    const snaps = rows.map((r) => (r.ok ? r.snapshot : null))!;
    expect(snaps[0]).toMatchObject({ accountId: '900001', status: 'active', email: 'test.reader.new@example.com', reactivated: false });
    expect(snaps[1]).toMatchObject({ accountId: '900003', email: null, consentValue: false });
    expect(snaps[2]).toMatchObject({ accountId: '900002', deleted: true, erasure: false });
    expect(snaps[2]!.deletedAt?.toISOString()).toBe('2027-01-10T09:50:00.000Z');
  });

  it('an unknown event type is reported, not refused', () => {
    const p = parseCmsEvent({ ...JSON.parse(CMS_EVENT_BODIES['account.created_900001_seq1']), event: 'account.merged' });
    expect(p).toEqual({ ok: true, eventId: 'evt_01JB0Z7Q3M4N5P6R7S8T9V0W1X', event: 'account.merged', unknownType: true });
  });

  it('an unknown status parses (kept verbatim; the rules ignore it)', () => {
    expect(snapOf({ ...JSON.parse(CMS_EVENT_BODIES['subscription.started_900001_seq3']), status: 'paused' }).status).toBe('paused');
  });

  it.each([
    ['erasure missing', { erasure: undefined }, 'bad_erasure'],
    ['erasure null', { erasure: null }, 'bad_erasure'],
    ['erasure true on a live account (irreversible → refused)', { erasure: true }, 'bad_erasure'],
    ['email not an address', { email: 'nope' }, 'bad_email'],
    ['seq negative', { seq: -1 }, 'bad_seq'],
    ['seq fractional', { seq: 1.5 }, 'bad_seq'],
    ['seq a string', { seq: '3' }, 'bad_seq'],
    ['account_id a number', { account_id: 900001 }, 'bad_account_id'],
    ['consent value a string', { marketing_consent: { value: 'yes', at: null } }, 'bad_marketing_consent'],
    ['consent at without a zone', { marketing_consent: { value: true, at: '2026-10-22T09:30:00' } }, 'bad_marketing_consent'],
    ['period_end not a date', { period_end: '2027-02-30' }, 'bad_period_end'],
    ['occurred_at missing', { occurred_at: undefined }, 'bad_occurred_at'],
    ['reactivated missing', { reactivated: undefined }, 'bad_reactivated'],
  ])('refuses: %s', (_name, over, reason) => {
    const body = { ...JSON.parse(CMS_EVENT_BODIES['subscription.started_900001_seq3']), ...over } as Record<string, unknown>;
    for (const [k, v] of Object.entries(over)) if (v === undefined) delete body[k];
    const p = parseCmsEvent(body);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).toBe(reason);
  });

  it('a refusal never quotes the value', () => {
    const p = parseCmsEvent({ ...JSON.parse(CMS_EVENT_BODIES['subscription.started_900001_seq3']), email: 'not an address at all' });
    expect(JSON.stringify(p)).not.toContain('not an address');
  });
});

// ─── memberRole ─────────────────────────────────────────────────────────────

describe('memberRole — the single rule', () => {
  const a = (status: string, consentValue: boolean | null = null, deletedAt: Date | null = null) => ({ status, consentValue, deletedAt });
  const on = { formerToFree: true };
  it.each([
    [[a('active')], 'PREMIUM', false],
    [[a('cancelled', false)], 'PREMIUM', true],
    [[a('ended')], 'FORMER', false],
    [[a('ended', true)], 'FORMER', false],
    [[a('ended', false)], 'NONE', true],
    [[a('free')], 'NONE', false],
    [[a('free', false)], 'NONE', true],
    [[a('paused')], 'NONE', false],
    [[a('deleted', null, new Date())], 'NONE', true],
    [[a('active'), a('free', false)], 'PREMIUM', true],
    [[a('ended'), a('active')], 'PREMIUM', false],
    [[a('deleted', null, new Date()), a('free')], 'NONE', false],
    [[a('deleted', null, new Date()), a('active')], 'PREMIUM', false],
  ] as const)('%j → %s (noMarketing %s)', (accounts, role, noMarketing) => {
    expect(memberRole(accounts, on)).toEqual({ role, noMarketing });
  });
  it('AUDIENCE_FORMER_TO_FREE=false: ended is NONE', () => {
    expect(memberRole([a('ended')], { formerToFree: false })).toEqual({ role: 'NONE', noMarketing: false });
  });
  it('no accounts at all: NONE, not excluded', () => {
    expect(memberRole([], on)).toEqual({ role: 'NONE', noMarketing: false });
  });
});

// ─── the A.5 stories through applyAccountSnapshot ───────────────────────────

describe('reader 900001: sign-up → yes → buys a year → changes address', () => {
  const id = `${P}900001`;
  const oldAddr = email('test.reader');
  const newAddr = email('test.reader.new');

  it('seq 1 account.created (free, consent null): mirrored by hash, no member row, no address stored', async () => {
    const r = await applyEv(ev('account.created_900001_seq1'));
    expect(r).toMatchObject({ outcome: 'applied', changed: true, memberChanges: 0 });
    const acc = await account(id);
    expect(acc).toMatchObject({ seq: 1n, status: 'free', consentValue: null, emailHash: sha(oldAddr), lastSource: 'webhook', deletedAt: null, erasedAt: null });
    expect(JSON.stringify(acc, (_k, v) => (typeof v === 'bigint' ? String(v) : v))).not.toContain('@');
    expect(await member(oldAddr)).toBeNull();
  });

  it('seq 2 account.updated (consent yes): still NONE', async () => {
    expect((await applyEv(ev('account.updated_900001_seq2'))).outcome).toBe('applied');
    expect(await account(id)).toMatchObject({ seq: 2n, consentValue: true });
    expect(await member(oldAddr)).toBeNull();
  });

  it('seq 3 subscription.started: PREMIUM, the address stored on the member row only, due for the writer', async () => {
    const r = await applyEv(ev('subscription.started_900001_seq3'));
    expect(r).toMatchObject({ outcome: 'applied', memberChanges: 1, roleChanges: 1 });
    const m = await member(oldAddr);
    expect(m).toMatchObject({ email: oldAddr, desiredRole: 'PREMIUM', noMarketing: false, suppressed: false, appliedTags: [] });
    expect(m!.nextAttemptAt).not.toBeNull();
    expect(await account(id)).toMatchObject({ status: 'active', plan: 'premium_1y' });
    expect((await account(id))!.periodEnd!.toISOString()).toBe('2027-10-21T00:00:00.000Z');
  });

  it('a Mailercloud unsubscribe on the old address is stamped with the account', async () => {
    await handleMailercloudWebhook({ event: 'unsubscribe', email: oldAddr, campaign_id: `${P}camp-1` }, { cfg: parseDigestEnv({}) });
    const row = await prisma.emailSuppression.findUniqueOrThrow({ where: { emailHash: sha(oldAddr) } });
    expect(row.accountId).toBe(id);
    expect((await member(oldAddr))!.suppressed).toBe(true);
  });

  it('seq 4 account.email_changed: Premium follows to the new address, the opt-out follows the account, the old row goes', async () => {
    const r = await applyEv(ev('account.email_changed_900001_seq4'));
    expect(r.outcome).toBe('applied');
    expect(await member(oldAddr)).toBeNull(); // no tags applied yet → nothing left to remove
    expect(await member(newAddr)).toMatchObject({ email: newAddr, desiredRole: 'PREMIUM', suppressed: true });
    expect(await account(id)).toMatchObject({ seq: 4n, emailHash: sha(newAddr) });
  });

  it('the A.7 list row (seq 4 = stored): repaired idempotently, nothing changes', async () => {
    const page = JSON.parse(CMS_LIST_PAGE_1) as { data: Record<string, unknown>[] };
    const row = { ...page.data[0], account_id: id, email: newAddr };
    const before = await member(newAddr);
    const r = await apply(rowSnap(row), 'pull_full');
    expect(r).toMatchObject({ outcome: 'repaired', seqConflict: false, changed: false, memberChanges: 0 });
    expect(await member(newAddr)).toEqual(before);
    expect((await account(id))!.lastSource).toBe('pull_full');
  });

  it('a late event (seq 2) after seq 4 is stale: no change', async () => {
    const r = await applyEv(ev('account.updated_900001_seq2'));
    expect(r).toMatchObject({ outcome: 'stale_seq', changed: false });
    expect(await account(id)).toMatchObject({ seq: 4n, status: 'active' });
  });

  it('a duplicate webhook at the stored seq is stale (events need strictly greater)', async () => {
    expect((await applyEv(ev('account.email_changed_900001_seq4'))).outcome).toBe('stale_seq');
  });
});

describe('reader 900002: monthly, said no → renews → cancels → ends (withheld) → deactivated → erased', () => {
  const id = `${P}900002`;
  const addr = email('monthly.tester');

  it('seq 3 renewed (active, consent false): PREMIUM (a service email) + noMarketing', async () => {
    await applyEv(ev('subscription.renewed_900002_seq3'));
    expect(await member(addr)).toMatchObject({ email: addr, desiredRole: 'PREMIUM', noMarketing: true });
  });

  it('seq 4 cancelled: still PREMIUM (paid to period_end)', async () => {
    const r = await applyEv(ev('subscription.cancelled_900002_seq4'));
    expect(r.roleChanges).toBe(0);
    expect(await member(addr)).toMatchObject({ desiredRole: 'PREMIUM' });
  });

  it('seq 5 ended with the address WITHHELD: Premium removed, kept only as a No-marketing exclusion', async () => {
    const r = await applyEv(ev('subscription.ended_900002_seq5'));
    expect(r).toMatchObject({ outcome: 'applied', roleChanges: 1 });
    expect(await account(id)).toMatchObject({ status: 'ended', consentValue: false, emailHash: sha(addr) });
    expect(await member(addr)).toMatchObject({ desiredRole: 'NONE', noMarketing: true, email: addr });
  });

  it('seq 6 deleted, erasure false: removed from every audience, suppressed by account id, record kept', async () => {
    const r = await applyEv(ev('account.deleted_900002_seq6'));
    expect(r).toMatchObject({ outcome: 'applied', deactivated: true, erased: false });
    const acc = await account(id);
    expect(acc).toMatchObject({ status: 'deleted', erasedAt: null, emailHash: sha(addr) });
    expect(acc!.deletedAt!.toISOString()).toBe('2027-01-10T09:50:00.000Z');
    const sup = await prisma.emailSuppression.findMany({ where: { accountId: id } });
    expect(sup).toHaveLength(1);
    expect(sup[0]).toMatchObject({ reason: 'ACCOUNT_DELETED', email: null, emailHash: null, source: 'cms_feed' });
    expect(await member(addr)).toMatchObject({ desiredRole: 'NONE', noMarketing: true, email: addr });
  });

  it('the tombstone list row at seq 6 re-applies idempotently (still one suppression row)', async () => {
    const page = JSON.parse(CMS_LIST_PAGE_1) as { data: Record<string, unknown>[] };
    const r = await apply(rowSnap({ ...page.data[2], account_id: id }), 'pull_full');
    expect(r).toMatchObject({ outcome: 'repaired', seqConflict: false });
    expect(await prisma.emailSuppression.count({ where: { accountId: id, reason: 'ACCOUNT_DELETED' } })).toBe(1);
  });

  it('a late lower-seq event after the deletion cannot resurrect it', async () => {
    expect((await applyEv(ev('subscription.cancelled_900002_seq4'))).outcome).toBe('stale_seq');
    expect((await account(id))!.status).toBe('deleted');
  });

  it('seq 7 deleted, erasure TRUE: erased here at ingest — addresses nulled (member + suppressions), hash + No-marketing kept, audited', async () => {
    // An opt-out this person had by address must lose the address and keep the hash.
    await prisma.emailSuppression.create({ data: { email: addr, reason: 'UNSUBSCRIBE', source: 'mailercloud_webhook' } });
    const before = await prisma.auditLog.count({ where: { action: 'AUDIENCE_ERASURE' } });
    const r = await applyEv(ev('account.deleted_900002_seq7'));
    expect(r).toMatchObject({ outcome: 'applied', erased: true, addressNulled: true });
    const acc = await account(id);
    expect(acc!.erasedAt).not.toBeNull();
    const rows = await prisma.emailSuppression.findMany({ where: { OR: [{ accountId: id }, { emailHash: sha(addr) }] } });
    expect(rows.length).toBe(2);
    for (const row of rows) expect(row.email).toBeNull();
    expect(rows.find((x) => x.reason === 'UNSUBSCRIBE')!.emailHash).toBe(sha(addr));
    const m = await member(addr);
    // Owner 24 Oct: no erase queue — the address is gone now; the CMS deleted the Mailercloud contact.
    expect(m).toMatchObject({ email: null, desiredRole: 'NONE', noMarketing: true, appliedTags: [], mcState: 'ABSENT', eraseRequestedAt: null, nextAttemptAt: null });
    const audits = await prisma.auditLog.findMany({ where: { action: 'AUDIENCE_ERASURE' }, orderBy: { createdAt: 'desc' }, take: 1 });
    expect(await prisma.auditLog.count({ where: { action: 'AUDIENCE_ERASURE' } })).toBe(before + 1);
    expect(JSON.stringify(audits[0])).not.toContain('@');
    expect(JSON.stringify(audits[0])).not.toContain(id);
  });

  it('an erased account is NEVER reactivated, whatever the seq', async () => {
    const r = await applyEv(ev('account.created_900001_seq1', { seq: 8, reactivated: true, event_id: 'evt_x', email: addr, status: 'active' }, id));
    expect(r.outcome).toBe('erased');
    expect(await account(id)).toMatchObject({ seq: 7n, status: 'deleted' });
    expect((await account(id))!.erasedAt).not.toBeNull();
  });
});

describe('reader 900003: a free reader who says no — the address is withheld from the start', () => {
  it('seq 2 (email null): mirrored with no hash; nothing to hold', async () => {
    const id = `${P}900003`;
    const r = await applyEv(ev('account.updated_900003_seq2'));
    expect(r).toMatchObject({ outcome: 'applied', memberChanges: 0 });
    expect(await account(id)).toMatchObject({ emailHash: null, consentValue: false, status: 'free' });
  });

  it('the same reader, seen with an address earlier (seq 1), keeps it only as an exclusion after withholding', async () => {
    const id = `${P}900003b`;
    const addr = email('free.no');
    await applyEv(ev('account.created_900001_seq1', { email: addr, seq: 1 }, id));
    expect(await member(addr)).toBeNull(); // free + null consent: nothing stored
    await applyEv(ev('account.updated_900003_seq2', {}, id));
    // We never stored this address (free accounts get no member row), so there is nothing to exclude.
    expect(await member(addr)).toBeNull();
    expect(await account(id)).toMatchObject({ emailHash: sha(addr), consentValue: false });
  });
});

// ─── ordering, duplicates, out of order ─────────────────────────────────────

describe('ordering', () => {
  it('out of order (seq 3 before 2): same end state as in order; the late one is stale', async () => {
    const id = `${P}ooo`;
    const addr = email('ooo');
    const s3 = ev('subscription.started_900001_seq3', { email: addr }, id);
    const s2 = ev('account.updated_900001_seq2', { email: addr }, id);
    expect((await applyEv(s3)).outcome).toBe('applied');
    expect((await applyEv(s2)).outcome).toBe('stale_seq');
    expect(await account(id)).toMatchObject({ seq: 3n, status: 'active' });
    expect(await member(addr)).toMatchObject({ desiredRole: 'PREMIUM' });
  });

  it('a gap in seq is harmless (each event is a full snapshot)', async () => {
    const id = `${P}gap`;
    const addr = email('gap');
    await applyEv(ev('account.created_900001_seq1', { email: addr }, id));
    expect((await applyEv(ev('subscription.cancelled_900002_seq4', { email: addr, seq: 9 }, id))).outcome).toBe('applied');
    expect(await member(addr)).toMatchObject({ desiredRole: 'PREMIUM' });
  });

  it('list rows: equal seq re-applies (repair), lower is skipped; equal seq with different content is a seq_conflict', async () => {
    const id = `${P}list`;
    const addr = email('list');
    const row = (over: Record<string, unknown>) => rowSnap({
      account_id: id, seq: 5, email: addr, name: 'X', plan: 'premium_1y', status: 'active', period_start: '2026-10-22', period_end: '2027-10-21',
      marketing_consent: { value: true, at: '2026-10-22T09:30:00+05:30' }, erasure: false, deleted_at: null, updated_at: '2026-11-05T14:03:41+05:30', ...over,
    });
    expect((await apply(row({}), 'pull_full')).outcome).toBe('applied');
    expect((await apply(row({}), 'pull_incr')).outcome).toBe('repaired');
    expect((await apply(row({ seq: 4, status: 'ended' }), 'pull_full')).outcome).toBe('stale_seq');
    expect((await account(id))!.status).toBe('active');
    const c = await apply(row({ status: 'ended' }), 'pull_full');
    expect(c).toMatchObject({ outcome: 'repaired', seqConflict: true, changed: true });
    expect(await member(addr)).toMatchObject({ desiredRole: 'FORMER' }); // the list is the repair
    // An event at that seq is a duplicate, never a repair.
    expect((await applyEv(ev('subscription.started_900001_seq3', { seq: 5, email: addr }, id))).outcome).toBe('stale_seq');
  });

  it('concurrent deliveries of one account serialise on the row lock (no lost update)', async () => {
    const id = `${P}conc`;
    const addr = email('conc');
    await applyEv(ev('account.created_900001_seq1', { email: addr }, id));
    const rs = await Promise.allSettled([
      applyEv(ev('subscription.started_900001_seq3', { email: addr, seq: 3 }, id)),
      applyEv(ev('subscription.ended_900002_seq5', { email: addr, seq: 5, marketing_consent: { value: null, at: null } }, id)),
    ]);
    expect(rs.every((x) => x.status === 'fulfilled')).toBe(true);
    expect(await account(id)).toMatchObject({ seq: 5n, status: 'ended' });
    expect(await member(addr)).toMatchObject({ desiredRole: 'FORMER' });
  });
});

// ─── tombstones + reactivation ──────────────────────────────────────────────

describe('deactivation and reactivation (contract v1.2 §10)', () => {
  it('account.created reactivated:true revives; only ACCOUNT_DELETED is lifted, a real unsubscribe stays', async () => {
    const id = `${P}react`;
    const addr = email('react');
    await applyEv(ev('subscription.started_900001_seq3', { email: addr, seq: 3 }, id));
    await prisma.emailSuppression.create({ data: { email: addr, accountId: id, reason: 'UNSUBSCRIBE', source: 'mailercloud_webhook', lastSeenAt: new Date() } });
    await applyEv(ev('account.deleted_900002_seq6', { seq: 4 }, id));
    expect(await prisma.emailSuppression.count({ where: { accountId: id } })).toBe(2);
    const r = await applyEv(ev('account.created_900001_seq1', { seq: 5, reactivated: true, email: addr, status: 'active', plan: 'premium_1y' }, id));
    expect(r).toMatchObject({ outcome: 'applied', revived: true });
    expect(await account(id)).toMatchObject({ deletedAt: null, status: 'active' });
    const left = await prisma.emailSuppression.findMany({ where: { accountId: id } });
    expect(left.map((x) => x.reason)).toEqual(['UNSUBSCRIBE']);
    expect(await member(addr)).toMatchObject({ desiredRole: 'PREMIUM', suppressed: true, noMarketing: false });
  });

  it('a deleted account sharing an address with a live Premium one does not exclude it', async () => {
    const addr = email('shared-del');
    await applyEv(ev('subscription.started_900001_seq3', { email: addr }, `${P}sh-a`));
    await applyEv(ev('account.created_900001_seq1', { email: addr }, `${P}sh-b`));
    await applyEv(ev('account.deleted_900002_seq6', {}, `${P}sh-b`));
    expect(await member(addr)).toMatchObject({ desiredRole: 'PREMIUM', noMarketing: false, suppressed: false });
  });

  it('an erasure for an address we never held nulls nothing (none stored) but is still final', async () => {
    const id = `${P}erase-free`;
    await applyEv(ev('account.created_900001_seq1', { email: email('erase-free') }, id));
    const r = await applyEv(ev('account.deleted_900002_seq7', { seq: 2 }, id));
    expect(r).toMatchObject({ erased: true, addressNulled: false });
    expect((await account(id))!.erasedAt).not.toBeNull();
    expect(await member(email('erase-free'))).toBeNull();
  });

  it('a deletion first seen on the list (never seen live) is a tombstone straight away', async () => {
    const id = `${P}tomb`;
    const page = JSON.parse(CMS_LIST_PAGE_1) as { data: Record<string, unknown>[] };
    const r = await apply(rowSnap({ ...page.data[2], account_id: id }), 'pull_full');
    expect(r).toMatchObject({ outcome: 'applied', deactivated: true });
    expect(await account(id)).toMatchObject({ status: 'deleted', emailHash: null });
  });
});

describe('the erasure cap trips the breaker', () => {
  it(`more than AUDIENCE_MAX_ERASURES_PER_DAY in one IST day → breaker open (erasure_cap); ingest continues`, async () => {
    const tight = parseAudienceEnv({ AUDIENCE_SYNC_ENABLED: 'true', AUDIENCE_MAX_ERASURES_PER_DAY: '1' });
    const now = new Date('2031-03-03T06:00:00Z'); // a day no other test erases on
    const portal = `${PORTAL}-cap`;
    for (const n of [1, 2]) {
      const id = `${P}cap${n}`;
      await apply(snapOf(ev('account.created_900001_seq1', { email: email(`cap${n}`) }, id)), 'webhook', { cfg: tight, now, portal });
      const r = await apply(snapOf(ev('account.deleted_900002_seq7', { seq: 2 }, id)), 'webhook', { cfg: tight, now, portal });
      expect(r.erased).toBe(true);
      const st = await prisma.audienceSyncState.findUnique({ where: { portal } });
      if (n === 1) expect(st?.breakerOpenAt ?? null).toBeNull();
      else expect(st).toMatchObject({ breakerReason: 'erasure_cap', pendingReview: { erasuresToday: 2 } });
    }
  });

  it('istDayStart is 00:00 IST', () => {
    expect(istDayStart(new Date('2026-10-24T20:00:00Z')).toISOString()).toBe('2026-10-24T18:30:00.000Z');
    expect(istDayStart(new Date('2026-10-24T17:00:00Z')).toISOString()).toBe('2026-10-23T18:30:00.000Z');
  });
});

// ─── unknown status, settings ───────────────────────────────────────────────

describe('unknown status and settings', () => {
  it('an unknown status keeps the previous role and is kept verbatim', async () => {
    const id = `${P}unk`;
    const addr = email('unk');
    await applyEv(ev('subscription.started_900001_seq3', { email: addr }, id));
    const r = await applyEv(ev('subscription.started_900001_seq3', { email: addr, seq: 4, status: 'paused' }, id));
    expect(r).toMatchObject({ outcome: 'applied', unknownStatus: true, roleChanges: 0 });
    expect(await account(id)).toMatchObject({ status: 'active', unknownStatus: 'paused' });
    expect(await member(addr)).toMatchObject({ desiredRole: 'PREMIUM' });
    await applyEv(ev('subscription.started_900001_seq3', { email: addr, seq: 5 }, id));
    expect(await account(id)).toMatchObject({ status: 'active', unknownStatus: null });
  });

  it('an unknown status on a first sighting never grants Premium', async () => {
    const addr = email('unk-first');
    await applyEv(ev('subscription.started_900001_seq3', { email: addr, status: 'vip' }, `${P}unk-first`));
    expect(await member(addr)).toBeNull();
  });

  it('ended with consent null → FORMER; with AUDIENCE_FORMER_TO_FREE=false → nothing', async () => {
    const a1 = email('former-on');
    const a2 = email('former-off');
    const ended = { status: 'ended', marketing_consent: { value: null, at: null } };
    await applyEv(ev('subscription.ended_900002_seq5', { ...ended, email: a1 }, `${P}former-on`));
    await apply(snapOf(ev('subscription.ended_900002_seq5', { ...ended, email: a2 }, `${P}former-off`)), 'webhook', {
      cfg: parseAudienceEnv({ AUDIENCE_SYNC_ENABLED: 'true', AUDIENCE_FORMER_TO_FREE: 'false' }),
    });
    expect(await member(a1)).toMatchObject({ desiredRole: 'FORMER', noMarketing: false });
    expect(await member(a2)).toBeNull();
  });

  it('two accounts sharing an address: Premium wins, an explicit no from the other still excludes Free', async () => {
    const addr = email('shared');
    await applyEv(ev('subscription.started_900001_seq3', { email: addr }, `${P}two-a`));
    await applyEv(ev('account.updated_900001_seq2', { email: addr, marketing_consent: { value: false, at: '2026-10-22T09:30:00+05:30' } }, `${P}two-b`));
    expect(await member(addr)).toMatchObject({ desiredRole: 'PREMIUM', noMarketing: true });
  });
});

// ─── consent lift ───────────────────────────────────────────────────────────

describe('the consent lift (re-subscribe rule)', () => {
  const now = new Date('2030-06-01T06:00:00Z');
  const t = (minutes: number) => new Date(now.getTime() + minutes * 60_000);
  const consent = (at: Date) => ({ marketing_consent: { value: true, at: at.toISOString() } });

  async function setup(tag: string, reason: string, lastSeenAt: Date) {
    const id = `${P}lift-${tag}`;
    const addr = email(`lift-${tag}`);
    await prisma.emailSuppression.create({ data: { email: addr, reason, source: 'mailercloud_webhook', lastSeenAt, firstSeenAt: lastSeenAt } });
    return { id, addr };
  }

  it('an opt-in dated AFTER the unsubscribe lifts it: row deleted, RESUBSCRIBE by hash, audited', async () => {
    const { id, addr } = await setup('ok', 'UNSUBSCRIBE', t(-60));
    const r = await apply(snapOf(ev('account.updated_900001_seq2', { email: addr, ...consent(t(-10)) }, id)), 'webhook', { now });
    expect(r).toMatchObject({ lifted: 1, liftsDeferred: 0 });
    expect(await prisma.emailSuppression.count({ where: { emailHash: sha(addr) } })).toBe(0);
    const evs = await prisma.emailEvent.findMany({ where: { emailHash: sha(addr), type: 'RESUBSCRIBE' } });
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ provider: 'cms', meta: { reason: 'UNSUBSCRIBE' } });
    const audit = await prisma.auditLog.findFirst({ where: { action: 'AUDIENCE_RESUBSCRIBED' }, orderBy: { createdAt: 'desc' } });
    expect(JSON.stringify(audit)).toContain(sha(addr));
    expect(JSON.stringify(audit)).not.toContain('@');
  });

  it('HARD_BOUNCE and SPAM lift the same way', async () => {
    for (const reason of ['HARD_BOUNCE', 'SPAM']) {
      const { id, addr } = await setup(reason.toLowerCase(), reason, t(-60));
      expect((await apply(snapOf(ev('account.updated_900001_seq2', { email: addr, ...consent(t(-1)) }, id)), 'webhook', { now })).lifted).toBe(1);
    }
  });

  it.each([
    ['dated before the opt-out', 'UNSUBSCRIBE', -10, -60],
    ['dated at the opt-out', 'UNSUBSCRIBE', -60, -60],
    ['MANUAL, however late', 'MANUAL', -60, -1],
    ['dated more than 5 min in the future', 'UNSUBSCRIBE', -60, 6],
  ])('no lift: %s', async (tag, reason, seenMin, atMin) => {
    const { id, addr } = await setup(`no-${tag.replace(/\W+/g, '-').toLowerCase()}`, reason, t(seenMin));
    const r = await apply(snapOf(ev('account.updated_900001_seq2', { email: addr, ...consent(t(atMin)) }, id)), 'webhook', { now });
    expect(r.lifted).toBe(0);
    expect(await prisma.emailSuppression.count({ where: { emailHash: sha(addr) } })).toBe(1);
  });

  it('consent null / false never lifts', async () => {
    const { id, addr } = await setup('null', 'UNSUBSCRIBE', t(-60));
    await apply(snapOf(ev('account.updated_900001_seq2', { email: addr, marketing_consent: { value: null, at: null } }, id)), 'webhook', { now });
    await apply(snapOf(ev('account.updated_900001_seq2', { email: addr, seq: 3, marketing_consent: { value: false, at: t(-1).toISOString() } }, id)), 'webhook', { now });
    expect(await prisma.emailSuppression.count({ where: { emailHash: sha(addr) } })).toBe(1);
  });

  it('QA M2: an opt-out keyed by account id on an address the account has LEFT is not lifted by an opt-in at the new one', async () => {
    const id = `${P}lift-acct`;
    const oldA = email('lift-acct-old');
    const newA = email('lift-acct-new');
    await prisma.emailSuppression.create({ data: { email: oldA, accountId: id, reason: 'UNSUBSCRIBE', source: 'mailercloud_webhook', lastSeenAt: t(-60) } });
    const r = await apply(snapOf(ev('account.updated_900001_seq2', { email: newA, ...consent(t(-5)) }, id)), 'webhook', { now });
    expect(r.lifted).toBe(0);
    expect(await prisma.emailSuppression.count({ where: { accountId: id } })).toBe(1);
  });

  it(`at most ${MAX_LIFTS_PER_DAY} a day: the rest are deferred, and a later re-apply (next day) lifts them`, async () => {
    const day = new Date('2032-02-02T06:00:00Z');
    await prisma.emailEvent.createMany({
      data: Array.from({ length: MAX_LIFTS_PER_DAY }, (_, i) => ({ provider: 'cms', type: 'RESUBSCRIBE', dedupeKey: `cap-${RUN}-${i}`, receivedAt: day })),
    });
    const id = `${P}lift-cap`;
    const addr = email('lift-cap');
    await prisma.emailSuppression.create({ data: { email: addr, reason: 'UNSUBSCRIBE', source: 'mailercloud_webhook', lastSeenAt: new Date('2032-01-01T00:00:00Z') } });
    const body = ev('account.updated_900001_seq2', { email: addr, marketing_consent: { value: true, at: '2032-02-01T00:00:00Z' } }, id);
    const r = await apply(snapOf(body), 'webhook', { now: day });
    expect(r).toMatchObject({ lifted: 0, liftsDeferred: 1 });
    expect(await prisma.emailSuppression.count({ where: { emailHash: sha(addr) } })).toBe(1);
    // The nightly list re-applies the row at its seq the next day: the lift goes through.
    const r2 = await apply(snapOf(body), 'pull_full', { now: new Date('2032-02-03T06:00:00Z') });
    expect(r2).toMatchObject({ outcome: 'repaired', lifted: 1 });
  });
});

describe('PII', () => {
  it('no address appears in any log line written during these tests', () => {
    const all = logs.join('\n');
    expect(all).not.toMatch(/@example\.com/);
    expect(all).not.toContain(RUN + '@');
  });

  it('CmsAccount rows hold hashes only', async () => {
    const rows = await prisma.cmsAccount.findMany({ where: { accountId: { startsWith: P } } });
    expect(rows.length).toBeGreaterThan(10);
    expect(JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? String(v) : v))).not.toContain('@');
  });
});
