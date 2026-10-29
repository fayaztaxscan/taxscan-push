/**
 * CMS audience sync, task 5 (docs/CMS_AUDIENCE_SYNC_DESIGN.md §5.2–§5.4, §8.2, §11.5): the signed
 * door-L client against a fake CMS that verifies OUR requests with `verifyPushGet`; full and
 * incremental loads; acceptance; the absence rule; the equal-seq skip (and its two exceptions);
 * chunk / row retries; the breaker (first load, scope change, change cap, 24 h Premium removals,
 * truncated load); sync state; daily alerts; the cron wrapper. No address in any log line.
 */
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { parseAudienceEnv, type AudienceEnv } from '../lib/env';
import { CMS_LIST_PAGE_1 } from './fixtures/cms-feed-v1.3/payloads';
import { FakeCms, type ListRow } from './audienceFakeCms';
import { CmsListClient, CmsPullError, LIST_PATH, parsePage } from '../services/audience/cmsClient';
import { runPull, isRetryableTxError, INCREMENTAL_OVERLAP_MS, type PullDeps } from '../services/audience/pull';
import { resumeBreaker, recordSyncActivity, todaysCounters, istDayKey, changeLimit, removalLimit } from '../services/audience/breaker';
import { raiseAudienceAlert, sendAudienceAlerts } from '../services/audience/alerts';
import { cronPull, startAudienceSync, DRIFT_CRON, FULL_CRON, INCREMENTAL_CRON, WRITER_CRON } from '../services/audience/boot';
import * as ingest from '../services/audience/ingest';

const logs: string[] = [];
const capture = (...args: unknown[]) => {
  logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a, (_k, v) => (typeof v === 'bigint' ? String(v) : v)))).join(' '));
};
jest.spyOn(console, 'log').mockImplementation(capture);
jest.spyOn(console, 'warn').mockImplementation(capture);
jest.spyOn(console, 'error').mockImplementation(capture);

const RUN = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const P = `pl${RUN}-`;
const PORTAL = `test-audience-pull-${RUN}`;
const SECRET = 'p'.repeat(40) + RUN.slice(0, 8);
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const hashes = new Set<string>();
const addr = (local: string) => {
  const e = `${local}.${RUN}@example.com`;
  hashes.add(sha(e));
  return e;
};

const cfg: AudienceEnv = parseAudienceEnv({ AUDIENCE_SYNC_ENABLED: 'true' });
const noSleep = () => Promise.resolve();

let fake: FakeCms;
let base: string;
const client = (over: Partial<ConstructorParameters<typeof CmsListClient>[0]> = {}) =>
  new CmsListClient({ baseUrl: base, secret: SECRET, allowedHosts: ['127.0.0.1'], allowLoopbackHttpForTests: true, sleep: noSleep, ...over });
const deps = (over: Partial<PullDeps> = {}): PullDeps => ({ client: client(), cfg, portal: PORTAL, pageLimit: 5, sendAlerts: false, ...over });
const state = () => prisma.audienceSyncState.findUnique({ where: { portal: PORTAL } });
const account = (id: string) => prisma.cmsAccount.findUnique({ where: { accountId: id } });
const member = (a: string) => prisma.audienceMember.findUnique({ where: { emailHash: sha(a) } });

let clock = Date.parse('2027-01-11T00:00:00Z');
const tick = (min = 1) => new Date((clock += min * 60_000));
function row(id: string, over: Record<string, unknown> = {}): ListRow {
  return {
    account_id: `${P}${id}`,
    seq: 1,
    email: null,
    name: null,
    plan: null,
    status: 'free',
    period_start: null,
    period_end: null,
    marketing_consent: { value: null, at: null },
    erasure: false,
    deleted_at: null,
    updated_at: tick(0).toISOString(),
    ...over,
  };
}
const premium = (id: string, seq = 1, over: Record<string, unknown> = {}) =>
  row(id, { seq, email: addr(id), name: 'X', plan: 'premium_1y', status: 'active', period_start: '2026-10-22', period_end: '2027-10-21', ...over });

beforeAll(async () => {
  fake = new FakeCms([SECRET]);
  base = await fake.start();
});

afterAll(async () => {
  await fake.stop();
  const hs = [...hashes];
  await prisma.emailEvent.deleteMany({ where: { emailHash: { in: hs } } });
  await prisma.emailSuppression.deleteMany({ where: { OR: [{ accountId: { startsWith: P } }, { emailHash: { in: hs } }] } });
  await prisma.audienceMember.deleteMany({ where: { emailHash: { in: hs } } });
  await prisma.cmsAccount.deleteMany({ where: { accountId: { startsWith: P } } });
  await prisma.audienceSyncState.deleteMany({ where: { portal: { startsWith: PORTAL } } });
  await prisma.$disconnect();
});

// ─── the client ─────────────────────────────────────────────────────────────

describe('door-L client (signed GET, contract v1.3 §1–§3)', () => {
  beforeEach(() => fake.resetFaults());

  it('every request verifies at the fake CMS (verifyPushGet), with a fresh nonce, path = new URL().pathname', async () => {
    fake.setRows([row('c1'), row('c2'), row('c3')]);
    const before = fake.requests.length;
    const page = await client().fetchPage({ limit: 2, updatedSince: new Date('2027-01-11T02:05:00+05:30') });
    expect(page.rows).toHaveLength(2); // every row is updated after it; limit 2
    const r = fake.requests.slice(before);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ ok: true, path: LIST_PATH });
    expect(r[0].params).toMatchObject({ limit: '2', updated_since: '2027-01-10T20:35:00.000Z' });
    expect(r[0].rawQuery).toContain('updated_since=2027-01-10T20%3A35%3A00.000Z');
  });

  it('a base URL with a path prefix signs the prefixed path (what new URL() sends)', async () => {
    const f2 = new FakeCms([SECRET], '/cms-prefix');
    const b2 = await f2.start();
    try {
      f2.setRows([row('pfx')]);
      const page = await client({ baseUrl: b2 }).fetchPage({ limit: 5 });
      expect(page.rows).toHaveLength(1);
      expect(f2.requests[0]).toMatchObject({ ok: true, path: `/cms-prefix${LIST_PATH}` });
    } finally {
      await f2.stop();
    }
  });

  it('wrong secret → 401 at the fake → FATAL, not retried', async () => {
    const before = fake.requests.length;
    await expect(client({ secret: 'q'.repeat(40) }).fetchPage({})).rejects.toMatchObject({ kind: 'FATAL', http: 401 });
    expect(fake.requests.length - before).toBe(1);
  });

  it('503 twice then 200: retried, each attempt re-signed with a NEW nonce (all verified)', async () => {
    fake.setRows([row('r1')]);
    fake.failPage.set(0, { status: 503, times: 2 });
    const before = fake.requests.length;
    const page = await client().fetchPage({ limit: 5 });
    expect(page.rows).toHaveLength(1);
    const r = fake.requests.slice(before);
    expect(r.map((x) => x.ok)).toEqual([true, true, true]);
    expect(new Set(r.map((x) => x.params!.nonce)).size).toBe(3);
  });

  it('503 forever: gives up after 3 retries (4 attempts) as RETRYABLE', async () => {
    fake.failPage.set(0, { status: 503, times: Infinity });
    const before = fake.requests.length;
    await expect(client().fetchPage({ limit: 5 })).rejects.toMatchObject({ kind: 'RETRYABLE', http: 503 });
    expect(fake.requests.length - before).toBe(4);
  });

  it('a redirect is refused (redirect: "error"), never followed', async () => {
    fake.redirectTo = '/elsewhere';
    await expect(client({ maxRetries: 0 }).fetchPage({})).rejects.toBeInstanceOf(CmsPullError);
    expect(fake.requests.some((r) => r.path === '/elsewhere')).toBe(false);
  });

  it('https only: plain http is refused without the test-only loopback switch; a host off the list is refused', async () => {
    await expect(client({ allowLoopbackHttpForTests: false }).fetchPage({})).rejects.toMatchObject({ kind: 'FATAL', message: 'cms list: only https is allowed' });
    await expect(client({ allowedHosts: ['api.taxscan.in'] }).fetchPage({})).rejects.toMatchObject({ kind: 'FATAL' });
    expect(() => new CmsListClient({ baseUrl: 'https://evil.example', secret: SECRET, allowedHosts: ['api.taxscan.in'] }).listUrl()).toThrow(/CMS_FEED_ALLOWED_HOSTS/);
    expect(() => new CmsListClient({ baseUrl: 'https://api.taxscan.in', secret: '', allowedHosts: ['api.taxscan.in'] }).listUrl()).toThrow(/PULL_SECRET/);
  });

  it('parsePage is strict: data array, meta.next_cursor string|null, meta.as_of instant, optional counts', () => {
    expect(parsePage(CMS_LIST_PAGE_1, 3)).toMatchObject({ nextCursor: 'MjAyNy0wMS0xMFQwOTo1MTo0NC4xMjNaLDkwMDAwMg', counts: null });
    expect(parsePage(CMS_LIST_PAGE_1, 3).asOf.toISOString()).toBe('2027-01-10T20:35:00.000Z');
    expect(() => parsePage(CMS_LIST_PAGE_1, 2)).toThrow(/more rows than the limit/);
    expect(() => parsePage('{"data":[],"meta":{"next_cursor":null}}')).toThrow(/as_of/);
    expect(() => parsePage('{"data":[],"meta":{"next_cursor":"","as_of":"2027-01-11T02:05:00Z"}}')).toThrow(/next_cursor/);
    expect(() => parsePage('{"meta":{}}')).toThrow(/data array/);
    expect(() => parsePage('not json')).toThrow(/not JSON/);
    expect(parsePage('{"data":[],"meta":{"next_cursor":null,"as_of":"2027-01-11T02:05:00Z","counts":{"active":5,"ended":2}}}').counts).toEqual({ active: 5, ended: 2 });
    expect(() => parsePage('{"data":[],"meta":{"next_cursor":null,"as_of":"2027-01-11T02:05:00Z","counts":{"active":-1}}}')).toThrow(/counts/);
  });

  it('an error message never carries the secret', async () => {
    try {
      await client({ secret: SECRET, maxRetries: 0, baseUrl: 'http://127.0.0.1:1' }).fetchPage({});
    } catch (e) {
      expect(String((e as Error).message)).not.toContain(SECRET);
    }
  });
});

// ─── full + incremental loads ───────────────────────────────────────────────

describe('full load → incremental → absence → acceptance (one evolving CMS)', () => {
  const page1 = JSON.parse(CMS_LIST_PAGE_1) as { data: ListRow[] };
  // The three A.7 fixture rows with this run's ids/addresses, plus readers of our own.
  const fixtureRows = (): ListRow[] =>
    page1.data.map((r) => ({
      ...r,
      account_id: `${P}${r.account_id}`,
      email: typeof r.email === 'string' ? addr(`fx-${r.account_id}`) : null,
    }));
  let rows: ListRow[];

  beforeAll(() => {
    fake.resetFaults();
    rows = [
      ...fixtureRows(),
      premium('p1'),
      premium('p2'),
      row('f1', { email: addr('f1') }),
      row('f2', { email: addr('f2') }),
      ...Array.from({ length: 13 }, (_, i) => row(`fill${i}`)),
    ];
    fake.setRows(rows);
    fake.counts = { active: 3, cancelled: 0, free: 3, ended: 0 };
  });

  it('incremental before any complete full load is skipped (no watermark to page from)', async () => {
    const r = await runPull('incremental', deps({ now: () => tick() }));
    expect(r.skipped).toBe('no_full_load');
  });

  it('the FIRST full load: complete over 4 pages, rows applied, watermarks + counts stored, breaker first_load, audited', async () => {
    const r = await runPull('full', deps({ now: () => tick() }));
    expect(r).toMatchObject({ complete: true, pages: 4, rows: 20, applied: 20, invalid: 0, rowErrors: 0, breakerOpened: 'first_load' });
    const st = await state();
    expect(st!.lastFullAsOf!.toISOString()).toBe('2027-01-10T20:35:00.000Z'); // the FIRST page's as_of
    expect(st).toMatchObject({ lastFullRowCount: 20, cmsCounts: { active: 3, cancelled: 0, free: 3, ended: 0 }, breakerReason: 'first_load' });
    expect(st!.lastFullOkAt).not.toBeNull();
    expect(await member(addr('p1'))).toMatchObject({ desiredRole: 'PREMIUM' });
    expect(await account(`${P}900002`)).toMatchObject({ status: 'deleted' });
    const audit = await prisma.auditLog.findFirst({ where: { action: 'AUDIENCE_FULL_LOAD', metadata: { path: ['portal'], equals: PORTAL } }, orderBy: { createdAt: 'desc' } });
    expect(audit!.metadata).toMatchObject({ complete: true, rows: 20, applied: 20 });
    expect(JSON.stringify(audit)).not.toContain('@');
  });

  it('every request of that load verified at the fake CMS; cursors were passed back unchanged', () => {
    const recent = fake.requests.slice(-4);
    expect(recent.every((x) => x.ok)).toBe(true);
    expect(recent[0].params!.cursor).toBeUndefined();
    expect(recent.slice(1).every((x) => typeof x.params!.cursor === 'string')).toBe(true);
    expect(recent.every((x) => x.params!.updated_since === undefined)).toBe(true);
  });

  it('the same list again: every row is skipped (equal seq, same content) — no transaction, nothing changed', async () => {
    const spy = jest.spyOn(ingest, 'applyAccountSnapshot');
    const r = await runPull('full', deps({ now: () => tick() }));
    expect(r).toMatchObject({ complete: true, rows: 20, unchanged: 20, applied: 0, repaired: 0 });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('ADMIN Resume clears first_load (audited with the counts)', async () => {
    expect(await resumeBreaker(PORTAL, null, tick())).toBe(true);
    expect((await state())!.breakerOpenAt).toBeNull();
    expect(await resumeBreaker(PORTAL, null, tick())).toBe(false);
  });

  it('incremental: updated_since = max(watermarks) − 10 min, applies newer rows, stores lastIncrAsOf from the first page', async () => {
    const st0 = await state();
    const t = tick(5);
    rows = rows.map((x) => (x.account_id === `${P}f1` ? { ...x, seq: 2, status: 'active', plan: 'premium_1y', updated_at: t.toISOString() } : x));
    fake.setRows(rows);
    fake.asOf = '2027-01-11T03:05:00+05:30';
    const before = fake.requests.length;
    const r = await runPull('incremental', deps({ now: () => tick() }));
    expect(r).toMatchObject({ complete: true, applied: 1 });
    const since = fake.requests[before].params!.updated_since;
    expect(Date.parse(since)).toBe(st0!.lastFullAsOf!.getTime() - INCREMENTAL_OVERLAP_MS);
    const st = await state();
    expect(st!.lastIncrAsOf!.toISOString()).toBe('2027-01-10T21:35:00.000Z');
    expect(await member(addr('f1'))).toMatchObject({ desiredRole: 'PREMIUM' });
  });

  it('the next incremental pages from the LATER watermark (lastIncrAsOf)', async () => {
    const before = fake.requests.length;
    await runPull('incremental', deps({ now: () => tick() }));
    expect(Date.parse(fake.requests[before].params!.updated_since)).toBe(Date.parse('2027-01-10T21:35:00.000Z') - INCREMENTAL_OVERLAP_MS);
  });

  it('ABSENCE: a complete load that no longer lists a live account → out of scope at its seq; tags go, no suppression, no exclusion', async () => {
    await prisma.audienceMember.update({ where: { emailHash: sha(addr('p2')) }, data: { appliedTags: ['tagP'], nextAttemptAt: null } });
    fake.setRows(rows.filter((x) => x.account_id !== `${P}p2`));
    const r = await runPull('full', deps({ now: () => tick() }));
    expect(r).toMatchObject({ complete: true, absent: 1, premiumRemovals: 1 });
    const acc = await account(`${P}p2`);
    expect(acc!.outOfScopeAt).not.toBeNull();
    expect(acc).toMatchObject({ seq: 1n, deletedAt: null, status: 'active' });
    expect(await prisma.emailSuppression.count({ where: { accountId: `${P}p2` } })).toBe(0);
    // Role NONE, NOT No-marketing; kept only until the writer removes the tag.
    expect(await member(addr('p2'))).toMatchObject({ desiredRole: 'NONE', noMarketing: false, appliedTags: ['tagP'] });
    expect((await member(addr('p2')))!.nextAttemptAt).not.toBeNull();
  });

  it('…and when the list names it again at the SAME seq, it is back in scope (not a seq conflict)', async () => {
    fake.setRows(rows);
    const r = await runPull('full', deps({ now: () => tick() }));
    expect(r).toMatchObject({ complete: true, repaired: 1, seqConflict: 0, absent: 0 });
    expect((await account(`${P}p2`))!.outOfScopeAt).toBeNull();
    expect(await member(addr('p2'))).toMatchObject({ desiredRole: 'PREMIUM' });
  });

  it('TRUNCATED (a page answers 500 every time): rows read are applied, NO absence, breaker truncated_load + alert marker', async () => {
    const missing = `${P}f2`; // would be absent if absence ran
    fake.setRows(rows.filter((x) => x.account_id !== missing));
    fake.failPage.set(2, { status: 500, times: Infinity });
    const r = await runPull('full', deps({ now: () => tick(), client: client({ maxRetries: 1 }) }));
    expect(r).toMatchObject({ complete: false, incompleteReason: 'page_failed_500', absent: 0, breakerOpened: 'truncated_load' });
    expect((await account(missing))!.outOfScopeAt).toBeNull();
    const st = await state();
    expect(st).toMatchObject({ breakerReason: 'truncated_load', lastFullRowCount: 20 });
    expect((st!.alerts as Record<string, { reason?: string }>).audience_full_incomplete).toMatchObject({ reason: 'page_failed_500' });
  });

  it('TRUNCATED (the feed ends early: last page with no cursor, < 90 % of the previous load): short_load, NO absence', async () => {
    fake.resetFaults();
    fake.setRows(rows);
    fake.stopAfterPage = 1; // 2 pages × 5 rows = 10 of 20 rows
    const r = await runPull('full', deps({ now: () => tick() }));
    expect(r).toMatchObject({ complete: false, incompleteReason: 'short_load', rows: 10, absent: 0 });
    expect((await state())!.lastFullRowCount).toBe(20);
  });

  it('the next COMPLETE, clean load closes truncated_load by itself', async () => {
    fake.resetFaults();
    const r = await runPull('full', deps({ now: () => tick() }));
    expect(r).toMatchObject({ complete: true, breakerClosed: true });
    expect((await state())!.breakerOpenAt).toBeNull();
  });

  it('an invalid row makes the load incomplete (and it is never half-read)', async () => {
    fake.setRows([...rows, row('bad', { erasure: true })]); // erasure on a live row: refused
    const r = await runPull('full', deps({ now: () => tick() }));
    expect(r).toMatchObject({ complete: false, incompleteReason: 'invalid_rows', invalid: 1, absent: 0 });
    expect(await account(`${P}bad`)).toBeNull();
    await resumeBreaker(PORTAL, null, tick());
    fake.setRows(rows);
  });

  it('SCOPE CHANGE (allowlist → all): a complete load > 2× the previous and > 100 rows larger → breaker scope_change', async () => {
    const many = Array.from({ length: 120 }, (_, i) => row(`s${i}`));
    fake.setRows([...rows, ...many]);
    const r = await runPull('full', deps({ now: () => tick(), pageLimit: 50 }));
    expect(r).toMatchObject({ complete: true, rows: 140, breakerOpened: 'scope_change' });
    expect((await state())!.pendingReview).toMatchObject({ reason: 'scope_change', rows: 140, previousRows: 20 });
    await resumeBreaker(PORTAL, null, tick());
  });
});

// ─── the equal-seq exceptions ───────────────────────────────────────────────

describe('equal-seq rows that are NOT skipped', () => {
  const portal = `${PORTAL}-eq`;
  it('a pending consent lift re-applies (the lift’s retry path) and lifts', async () => {
    const id = `${P}lift`;
    const a = addr('lift');
    const r1 = row('lift', { email: a, marketing_consent: { value: true, at: '2027-01-01T00:00:00Z' } });
    fake.resetFaults();
    fake.setRows([r1]);
    await runPull('full', deps({ portal, now: () => tick() }));
    await prisma.emailSuppression.create({ data: { email: a, reason: 'UNSUBSCRIBE', source: 'mailercloud_webhook', lastSeenAt: new Date('2026-12-01T00:00:00Z') } });
    const r = await runPull('full', deps({ portal, now: () => tick() }));
    expect(r).toMatchObject({ repaired: 1, unchanged: 0 });
    expect(await prisma.emailSuppression.count({ where: { emailHash: sha(a) } })).toBe(0);
    expect((await account(id))!.seq).toBe(1n);
  });

  it('a member whose address was stripped (restore) is refilled by the equal-seq row', async () => {
    const a = addr('refill');
    fake.setRows([premium('refill')]);
    await runPull('full', deps({ portal, now: () => tick() }));
    await prisma.audienceMember.update({ where: { emailHash: sha(a) }, data: { email: null } });
    const r = await runPull('full', deps({ portal, now: () => tick() }));
    expect(r).toMatchObject({ repaired: 1 });
    expect((await member(a))!.email).toBe(a);
  });

  it('a lower-seq row is skipped as stale; a live row for an erased account is skipped as erased', async () => {
    const a = addr('stale');
    fake.setRows([premium('stale', 3)]);
    await runPull('full', deps({ portal, now: () => tick() }));
    fake.setRows([premium('stale', 2)]);
    expect(await runPull('full', deps({ portal, now: () => tick() }))).toMatchObject({ stale: 1, applied: 0 });
    fake.setRows([row('stale', { seq: 4, status: 'deleted', erasure: true, deleted_at: '2027-01-12T00:00:00Z' })]);
    await runPull('full', deps({ portal, now: () => tick() }));
    fake.setRows([premium('stale', 9)]);
    expect(await runPull('full', deps({ portal, now: () => tick() }))).toMatchObject({ erased: 1, applied: 0 });
    expect((await member(a))?.email ?? null).toBeNull();
  });
});

// ─── retries ────────────────────────────────────────────────────────────────

describe('chunk / row retries', () => {
  const portal = `${PORTAL}-retry`;
  it('isRetryableTxError: P2002, P2034, P2028, 40P01 / 40001 → yes; anything else → no', () => {
    const known = (code: string, meta?: Record<string, unknown>) => new Prisma.PrismaClientKnownRequestError('x', { code, clientVersion: '6', meta });
    expect(isRetryableTxError(known('P2002'))).toBe(true);
    expect(isRetryableTxError(known('P2034'))).toBe(true);
    expect(isRetryableTxError(known('P2028'))).toBe(true);
    expect(isRetryableTxError(known('P2010', { code: '40P01' }))).toBe(true);
    expect(isRetryableTxError(new Error('ERROR: deadlock detected'))).toBe(true);
    expect(isRetryableTxError(known('P2003'))).toBe(false);
    expect(isRetryableTxError(new Error('boom'))).toBe(false);
  });

  it('a P2002 race on one row: the chunk is retried and every row lands; a row that keeps failing is counted, the page goes on', async () => {
    fake.resetFaults();
    fake.setRows([row('r1'), row('r2'), row('r3'), row('r4')]);
    const real = ingest.applyAccountSnapshot;
    let raced = false;
    const spy = jest.spyOn(ingest, 'applyAccountSnapshot').mockImplementation(async (tx, snap, source, opts) => {
      if (snap.accountId === `${P}r2` && !raced) {
        raced = true;
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: '6' });
      }
      if (snap.accountId === `${P}r4`) throw new Error('permanent failure');
      return real(tx, snap, source, opts);
    });
    try {
      const r = await runPull('full', deps({ portal, now: () => tick(), pageLimit: 10 }));
      expect(raced).toBe(true);
      expect(r).toMatchObject({ applied: 3, rowErrors: 1, complete: false, incompleteReason: 'row_errors', absent: 0 });
      expect(await account(`${P}r2`)).not.toBeNull();
      expect(await account(`${P}r4`)).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});

// ─── breaker: change cap + 24 h removals ────────────────────────────────────

describe('breaker thresholds', () => {
  it('limits: change max(5 %, 100); removals max(3 %, 50)', () => {
    expect(changeLimit(1000, cfg)).toBe(100);
    expect(changeLimit(10_000, cfg)).toBe(500);
    expect(removalLimit(1000)).toBe(50);
    expect(removalLimit(3000)).toBe(90);
  });

  it('one incremental run changing > 100 roles opens change_too_large; ≤ 100 does not', async () => {
    const portal = `${PORTAL}-cap`;
    // A completed (and reviewed) full load first.
    fake.resetFaults();
    fake.setRows([row('cap0')]);
    await runPull('full', deps({ portal, now: () => tick() }));
    await resumeBreaker(portal, null, tick());
    const t = tick();
    fake.asOf = t.toISOString();
    fake.setRows(Array.from({ length: 90 }, (_, i) => premium(`ca${i}`, 1, { updated_at: tick().toISOString() })));
    const ok = await runPull('incremental', deps({ portal, now: () => tick(), pageLimit: 100 }));
    expect(ok).toMatchObject({ roleChanges: 90, breakerOpened: null });
    fake.setRows(Array.from({ length: 101 }, (_, i) => premium(`cb${i}`, 1, { updated_at: tick().toISOString() })));
    const big = await runPull('incremental', deps({ portal, now: () => tick(), pageLimit: 200 }));
    expect(big).toMatchObject({ roleChanges: 101, breakerOpened: 'change_too_large' });
    await resumeBreaker(portal, null, tick());

    // 24 h Premium removals: 60 of those members end → > max(3 %, 50).
    fake.setRows(Array.from({ length: 60 }, (_, i) => premium(`cb${i}`, 2, { status: 'ended', updated_at: tick().toISOString() })));
    const rem = await runPull('incremental', deps({ portal, now: () => tick(), pageLimit: 100 }));
    expect(rem.premiumRemovals).toBe(60);
    expect(rem.breakerOpened).toBe('premium_removals');
    expect((await prisma.audienceSyncState.findUnique({ where: { portal } }))!.pendingReview).toMatchObject({ reason: 'premium_removals', removals24h: 60 });
    await resumeBreaker(portal, null, tick());
  });
});

// ─── counters + alerts ──────────────────────────────────────────────────────

describe('daily counters and alerts', () => {
  it('seq conflict + unknown status are counted per IST day and raise one marker each per day', async () => {
    const portal = `${PORTAL}-alerts`;
    fake.resetFaults();
    fake.setRows([row('sc', { email: addr('sc') }), row('us')]);
    await runPull('full', deps({ portal, now: () => tick() }));
    fake.setRows([row('sc', { email: addr('sc'), plan: 'changed_same_seq' }), row('us', { seq: 2, status: 'paused_new' })]);
    const r = await runPull('full', deps({ portal, now: () => tick() }));
    expect(r).toMatchObject({ seqConflict: 1, unknownStatus: 1 });
    const st = await prisma.audienceSyncState.findUnique({ where: { portal } });
    const alerts = st!.alerts as Record<string, { count?: number; day?: string }>;
    expect(alerts.seq_conflict).toMatchObject({ count: 1, day: istDayKey(new Date(clock)) });
    expect(alerts.unknown_status).toMatchObject({ count: 1 });

    // Emailed once per kind per day, through the digest alert copy.
    const sent: { to: string; subject: string; text: string }[] = [];
    const sender = async (m: { to: string; subject: string; html: string; text: string }) => {
      sent.push(m);
      return { ok: true as const };
    };
    const d = { emailSender: sender as never, isConfigured: () => true, recipients: async () => ['admin@test.invalid'], now: new Date(clock) };
    expect((await sendAudienceAlerts(portal, d)).sort()).toEqual(['audience_breaker_open', 'seq_conflict', 'unknown_status']);
    expect(await sendAudienceAlerts(portal, d)).toEqual([]);
    expect(await raiseAudienceAlert(portal, 'seq_conflict', { count: 2 }, new Date(clock))).toBe(false); // same day
    expect(await sendAudienceAlerts(portal, d)).toEqual([]);
    expect(sent.find((m) => m.subject.includes('conflicting'))!.text).toContain('1 reader account(s)');
    for (const m of sent) expect(m.text).not.toMatch(/@example\.com/);
    // A new IST day → a fresh marker → a fresh email.
    expect(await raiseAudienceAlert(portal, 'seq_conflict', { count: 1 }, new Date(clock + 86_400_000))).toBe(true);
  });

  it('recordSyncActivity resets the daily counts at the IST day change and keeps removals 24 h', async () => {
    const portal = `${PORTAL}-ctr`;
    const t0 = new Date('2027-02-01T10:00:00Z');
    await prisma.$transaction((tx) => recordSyncActivity(tx, portal, { seqConflict: 2, premiumRemovals: 5 }, t0));
    expect(await todaysCounters(prisma, portal, t0)).toEqual({ seqConflict: 2, unknownStatus: 0, removals24h: 5 });
    const t1 = new Date('2027-02-02T09:00:00Z'); // next IST day, < 24 h later
    await prisma.$transaction((tx) => recordSyncActivity(tx, portal, { unknownStatus: 1 }, t1));
    expect(await todaysCounters(prisma, portal, t1)).toEqual({ seqConflict: 0, unknownStatus: 1, removals24h: 5 });
    expect((await todaysCounters(prisma, portal, new Date('2027-02-02T10:00:01Z'))).removals24h).toBe(0);
  });
});

// ─── cron + boot ────────────────────────────────────────────────────────────

describe('cron wrapper and boot', () => {
  it('a full load that meets a running pull waits and tries again (never silently skipped)', async () => {
    fake.resetFaults();
    fake.setRows([row('cron')]);
    const portal = `${PORTAL}-cron`;
    let waits = 0;
    const slow = runPull('full', deps({ portal, now: () => tick() }));
    const retried = cronPull('full', deps({ portal, now: () => tick() }), 0, async () => {
      waits += 1;
      await slow;
    });
    await Promise.all([slow, retried]);
    expect(waits).toBe(1);
    expect((await prisma.audienceSyncState.findUnique({ where: { portal } }))!.lastFullOkAt).not.toBeNull();
  });

  it('enabled with the pull secret: starts the incremental (hourly :10, not 04:10) and full (04:30) crons in IST', () => {
    const started: [string, string][] = [];
    const c = parseAudienceEnv({ AUDIENCE_SYNC_ENABLED: 'true', CMS_FEED_INBOUND_SECRET: 'i'.repeat(40), CMS_FEED_PULL_SECRET: 'p'.repeat(40) });
    expect(startAudienceSync(c, { startCron: (e, _f, tz) => (started.push([e, tz]), { stop: () => undefined }) })).toBe('enabled');
    expect(started).toEqual([
      [INCREMENTAL_CRON, 'Asia/Kolkata'],
      [FULL_CRON, 'Asia/Kolkata'],
      [WRITER_CRON, 'Asia/Kolkata'],
      [DRIFT_CRON, 'Asia/Kolkata'],
    ]);
    expect(INCREMENTAL_CRON).toBe('10 0-3,5-23 * * *');
    expect(FULL_CRON).toBe('30 4 * * *');
  });

  it('no pull secret: no pull crons, but the writer + drift crons still start (the webhook still ingests)', () => {
    const started: string[] = [];
    const c = parseAudienceEnv({ AUDIENCE_SYNC_ENABLED: 'true', CMS_FEED_INBOUND_SECRET: 'i'.repeat(40) });
    startAudienceSync(c, { startCron: (e) => (started.push(e), { stop: () => undefined }) });
    expect(started).toEqual([WRITER_CRON, DRIFT_CRON]);
  });
});

describe('logging', () => {
  it('no address, secret or account id in any log line', () => {
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) {
      expect(line).not.toMatch(/@example\.com/i);
      expect(line).not.toContain(SECRET);
      expect(line).not.toContain(P);
    }
  });
});
