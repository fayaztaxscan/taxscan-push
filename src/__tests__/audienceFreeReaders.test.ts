import { createHash } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { parseAudienceEnv, parseDigestEnv, type AudienceEnv } from '../lib/env';
import { FakeCms, type ListRow } from './audienceFakeCms';
import { FakeMailercloud } from './audienceFakeMailercloud';
import { CmsListClient } from '../services/audience/cmsClient';
import { McContactClient } from '../services/audience/mcContacts';
import { memberRole, type RuleAccount } from '../services/audience/rules';
import { applyAccountSnapshot, countsAsRoleChange } from '../services/audience/ingest';
import { parseCmsListRow } from '../services/audience/snapshot';
import { runPull, type PullDeps } from '../services/audience/pull';
import { resumeBreaker } from '../services/audience/breaker';
import { audienceGuard, loadGuardSnapshot } from '../services/audience/guard';
import { audienceCard } from '../services/audience/adminView';
import { freeConfigProblems, startAudienceSync } from '../services/audience/boot';
import { desiredTags, diffMember, flushPending, resetWriterForTests, type WriterDeps } from '../services/audience/writer';
import { audienceTarget } from '../services/digest/runner';

/**
 * Brief 2026-11-08-free-cms-readers: the FREE role (CMS `free` accounts), their addresses on the first full load
 * after the switch, daily admission into Mailercloud, the breaker / guard staying Premium-only, the FREE line on
 * the Audience card, and the pause between CMS pages. Acceptance tests 1–13, in order.
 */

const logs: string[] = [];
const capture = (...args: unknown[]) => logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
jest.spyOn(console, 'log').mockImplementation(capture);
jest.spyOn(console, 'warn').mockImplementation(capture);
jest.spyOn(console, 'error').mockImplementation(capture);

const RUN = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const P = `fr${RUN}-`;
const PORTAL = `test-audience-free-${RUN}`;
const SECRET = 'f'.repeat(40) + RUN.slice(0, 8);
const KEY = 'k'.repeat(40);
const T = { premium: `fp-${RUN}`, former: `ff-${RUN}`, free: `fx-${RUN}`, noMarketing: `fn-${RUN}` };
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const hashes = new Set<string>();
const addr = (local: string) => {
  const e = `${local}.${RUN}@example.com`;
  hashes.add(sha(e));
  return e;
};

const ON = {
  AUDIENCE_SYNC_ENABLED: 'true',
  AUDIENCE_SYNC_WRITE_MAILERCLOUD: 'true',
  MAILERCLOUD_SYNC_API_KEY: KEY,
  AUDIENCE_MC_LIST_ID: 'list-1',
  AUDIENCE_MC_TAG_PREMIUM: T.premium,
  AUDIENCE_MC_TAG_FORMER: T.former,
  AUDIENCE_MC_TAG_NO_MARKETING: T.noMarketing,
  AUDIENCE_PULL_PAGE_PAUSE_MS: '0',
};
const cfgWith = (over: Record<string, string> = {}): AudienceEnv => parseAudienceEnv({ ...ON, ...over });
const FREE_ON = (cap: number, over: Record<string, string> = {}) =>
  cfgWith({ AUDIENCE_FREE_READERS: 'true', AUDIENCE_MC_TAG_FREE: T.free, AUDIENCE_FREE_ADMIT_PER_DAY: String(cap), ...over });

afterAll(async () => {
  const hs = [...hashes];
  await prisma.emailSuppression.deleteMany({ where: { OR: [{ accountId: { startsWith: P } }, { emailHash: { in: hs } }] } });
  await prisma.audienceMember.deleteMany({ where: { emailHash: { in: hs } } });
  await prisma.cmsAccount.deleteMany({ where: { accountId: { startsWith: P } } });
  await prisma.audienceSyncState.deleteMany({ where: { portal: { startsWith: PORTAL } } });
  await prisma.$disconnect();
});

// ─── 1, 2: the rule ──────────────────────────────────────────────────────────

const acct = (status: string, consentValue: boolean | null = null, over: Partial<RuleAccount> = {}): RuleAccount => ({
  status,
  consentValue,
  deletedAt: null,
  ...over,
});

describe('rule (acceptance 1, 2)', () => {
  it('1. flag off: a free account is NONE, whatever its consent (today’s rule)', () => {
    for (const opts of [{ formerToFree: true }, { formerToFree: true, freeReaders: false }]) {
      expect(memberRole([acct('free')], opts)).toEqual({ role: 'NONE', noMarketing: false });
      expect(memberRole([acct('free', true)], opts)).toEqual({ role: 'NONE', noMarketing: false });
      expect(memberRole([acct('free', false)], opts)).toEqual({ role: 'NONE', noMarketing: true });
      expect(memberRole([acct('ended')], opts).role).toBe('FORMER');
      expect(memberRole([acct('active')], opts).role).toBe('PREMIUM');
    }
  });

  it('2. flag on: free → FREE (null and true consent), false → NONE + noMarketing, PREMIUM > FORMER > FREE, deleted / out of scope → NONE', () => {
    const on = { formerToFree: true, freeReaders: true };
    expect(memberRole([acct('free', null)], on)).toEqual({ role: 'FREE', noMarketing: false });
    expect(memberRole([acct('free', true)], on)).toEqual({ role: 'FREE', noMarketing: false });
    expect(memberRole([acct('free', false)], on)).toEqual({ role: 'NONE', noMarketing: true });
    expect(memberRole([acct('free'), acct('ended')], on).role).toBe('FORMER');
    expect(memberRole([acct('free'), acct('active')], on).role).toBe('PREMIUM');
    expect(memberRole([acct('free', null, { deletedAt: new Date() })], on).role).toBe('NONE');
    expect(memberRole([acct('free', null, { outOfScopeAt: new Date() })], on).role).toBe('NONE');
  });

  it('NONE ⇄ FREE does not count toward the change cap; moves touching PREMIUM / FORMER still do', () => {
    expect(countsAsRoleChange('NONE', 'FREE')).toBe(false);
    expect(countsAsRoleChange('FREE', 'NONE')).toBe(false);
    expect(countsAsRoleChange('FREE', 'PREMIUM')).toBe(true); // a Premium change still counts
    expect(countsAsRoleChange('PREMIUM', 'FREE')).toBe(true);
    expect(countsAsRoleChange('FORMER', 'FREE')).toBe(true);
    expect(countsAsRoleChange('NONE', 'PREMIUM')).toBe(true);
    expect(countsAsRoleChange('PREMIUM', 'FORMER')).toBe(true);
  });

  it('the Free tag: wanted only for an unsuppressed FREE member, never an unset id', () => {
    const tags = { premium: 'p', former: 'f', free: 'x', noMarketing: 'n' };
    expect(desiredTags({ desiredRole: 'FREE', noMarketing: false }, tags)).toEqual(['x']);
    expect(desiredTags({ desiredRole: 'FREE', noMarketing: false, suppressed: true }, tags)).toEqual([]);
    expect(desiredTags({ desiredRole: 'FREE', noMarketing: false }, { ...tags, free: '' })).toEqual([]);
    // FORMER → FREE swaps the tags the way PREMIUM ⇄ FORMER does.
    expect(diffMember({ desiredRole: 'FREE', noMarketing: false, suppressed: false, appliedTags: ['f'] }, tags)).toEqual({ adds: ['x'], removes: ['f'] });
  });
});

// ─── 3, 8, 13: pulls ─────────────────────────────────────────────────────────

describe('pulls (acceptance 3, 8, 13)', () => {
  let fake: FakeCms;
  let base: string;
  let clock = Date.parse('2027-06-01T00:00:00Z');
  const tick = () => new Date((clock += 60_000));
  const client = () => new CmsListClient({ baseUrl: base, secret: SECRET, allowedHosts: ['127.0.0.1'], allowLoopbackHttpForTests: true, sleep: () => Promise.resolve() });
  const portalN = (n: string) => `${PORTAL}-${n}`;
  const deps = (portal: string, cfg: AudienceEnv, over: Partial<PullDeps> = {}): PullDeps => ({
    client: client(),
    cfg,
    portal,
    pageLimit: 500,
    sendAlerts: false,
    now: tick,
    ...over,
  });
  function row(id: string, over: Record<string, unknown> = {}): ListRow {
    return {
      account_id: `${P}${id}`,
      seq: 1,
      email: addr(id),
      name: 'X',
      plan: null,
      status: 'free',
      period_start: null,
      period_end: null,
      marketing_consent: { value: null, at: null },
      erasure: false,
      deleted_at: null,
      updated_at: '2027-05-30T00:00:00.000Z',
      ...over,
    };
  }

  beforeAll(async () => {
    fake = new FakeCms([SECRET]);
    base = await fake.start();
  });
  afterAll(() => fake.stop());

  it('3. flag on: a full load over stored free accounts at EQUAL seq creates FREE members with the address (no Mailercloud call: the pull has no Mailercloud client)', async () => {
    const portal = portalN('a3');
    const rows = [row('p3-a'), row('p3-b'), row('p3-c', { marketing_consent: { value: false, at: '2027-05-01T00:00:00Z' } })];
    fake.setRows(rows);
    const off = await runPull('full', deps(portal, cfgWith()));
    expect(off.complete).toBe(true);
    expect(await prisma.audienceMember.count({ where: { emailHash: { in: [sha(rows[0].email as string), sha(rows[1].email as string)] } } })).toBe(0);

    const on = await runPull('full', deps(portal, FREE_ON(0)));
    expect(on.complete).toBe(true);
    expect(on.applied + on.repaired).toBeGreaterThanOrEqual(2); // not skipped as "unchanged"
    for (const r of rows.slice(0, 2)) {
      const m = await prisma.audienceMember.findUnique({ where: { emailHash: sha(r.email as string) } });
      expect(m).toMatchObject({ desiredRole: 'FREE', email: r.email, admittedAt: null, appliedTags: [] });
    }
    // Consent false: NONE + the No-marketing exclusion (as today), never FREE.
    expect(await prisma.audienceMember.findUnique({ where: { emailHash: sha(rows[2].email as string) } })).toMatchObject({ desiredRole: 'NONE', noMarketing: true });

    // A second identical load skips them again (the exception fires only while no member row exists).
    const again = await runPull('full', deps(portal, FREE_ON(0)));
    expect(again.unchanged).toBe(3);
  });

  it('8. switching the flag on with 1,000 new FREE members opens no breaker; a Premium run above the limit still opens change_too_large', async () => {
    const portal = portalN('a8');
    const rows = Array.from({ length: 1000 }, (_, i) => row(`b8-${i}`));
    fake.setRows(rows);
    const first = await runPull('full', deps(portal, cfgWith()));
    expect(first.complete).toBe(true);
    expect(first.breakerOpened).toBe('first_load');
    expect(await resumeBreaker(portal, null)).toBe(true);

    const on = await runPull('full', deps(portal, FREE_ON(0)));
    expect(on.complete).toBe(true);
    expect(on.roleChanges).toBe(0);
    expect(on.breakerOpened).toBeNull();
    expect((await prisma.audienceSyncState.findUnique({ where: { portal } }))?.breakerOpenAt).toBeNull();
    expect(await prisma.audienceMember.count({ where: { emailHash: { in: rows.map((r) => sha(r.email as string)) }, desiredRole: 'FREE' } })).toBe(1000);

    // 101 of them turn Premium in one run: above max(5 %, 100) of mailed members → change_too_large.
    const premium = rows.map((r, i) =>
      i < 101 ? { ...r, seq: 2, status: 'active', plan: 'premium_1y', period_start: '2027-05-01', period_end: '2028-04-30', updated_at: '2027-05-31T00:00:00.000Z' } : r,
    );
    fake.setRows(premium);
    const p = await runPull('full', deps(portal, FREE_ON(0)));
    expect(p.roleChanges).toBe(101);
    expect(p.breakerOpened).toBe('change_too_large');
  }, 180_000);

  it('13. page pause: a 3-page full pull waits exactly twice for 2000 ms; a 1-page pull never; 0 = no wait; the incremental pull waits too', async () => {
    const portal = portalN('a13');
    const rows = Array.from({ length: 5 }, (_, i) => row(`c13-${i}`));
    fake.setRows(rows);
    const waits: number[] = [];
    const pause = (ms: number) => {
      waits.push(ms);
      return Promise.resolve();
    };
    const withPause = parseAudienceEnv({ ...ON, AUDIENCE_PULL_PAGE_PAUSE_MS: undefined as unknown as string });
    expect(withPause.pullPagePauseMs).toBe(2000);
    const r3 = await runPull('full', deps(portal, withPause, { pageLimit: 2, pause }));
    expect(r3.pages).toBe(3);
    expect(waits).toEqual([2000, 2000]);

    waits.length = 0;
    const r1 = await runPull('full', deps(portal, withPause, { pageLimit: 10, pause }));
    expect(r1.pages).toBe(1);
    expect(waits).toEqual([]);

    const zero = cfgWith({ AUDIENCE_PULL_PAGE_PAUSE_MS: '0' });
    expect(zero.pullPagePauseMs).toBe(0);
    await runPull('full', deps(portal, zero, { pageLimit: 2, pause }));
    expect(waits).toEqual([]);

    // Incremental: rows updated after the last full load's as_of, 3 pages.
    fake.setRows(rows.map((r) => ({ ...r, seq: 5, updated_at: '2027-01-11T02:30:00+05:30' })));
    const inc = await runPull('incremental', deps(portal, withPause, { pageLimit: 2, pause }));
    expect(inc.pages).toBe(3);
    expect(waits).toEqual([2000, 2000]);
  }, 60_000);
});

// ─── 4–7, 11: the writer ─────────────────────────────────────────────────────

describe('writer admission (acceptance 4, 5, 6, 7, 11)', () => {
  let fake: FakeMailercloud;
  let base: string;
  let now = new Date('2027-07-01T10:00:00Z'); // 15:30 IST, outside the send window
  const WPORTAL = `${PORTAL}-w`;
  const deps = (cfg: AudienceEnv, hs: string[], over: Partial<WriterDeps> = {}): WriterDeps => ({
    client: new McContactClient({ apiKey: KEY, baseV1: base }),
    cfg,
    digestCfg: { sendAt: '07:30' },
    portal: WPORTAL,
    now: () => now,
    sleep: () => Promise.resolve(),
    sendAlerts: false,
    onlyHashes: hs,
    ...over,
  });
  let seq = 0;
  async function member(role: string, over: Record<string, unknown> = {}) {
    const email = addr(`w${++seq}`);
    const h = sha(email);
    await prisma.audienceMember.create({ data: { emailHash: h, email, desiredRole: role, nextAttemptAt: now, ...over } });
    return { email, h };
  }
  const row = (h: string) => prisma.audienceMember.findUniqueOrThrow({ where: { emailHash: h } });
  const touched = (emails: string[]) => fake.requests.filter((r) => emails.some((e) => r.path.includes(encodeURIComponent(e)) || r.path.includes(e) || JSON.stringify(r.body).includes(e)));

  beforeEach(async () => {
    resetWriterForTests();
    fake = new FakeMailercloud(KEY);
    fake.tags = [
      { id: T.premium, tag_name: 'TS Premium (auto)' },
      { id: T.former, tag_name: 'TS Former (auto)' },
      { id: T.free, tag_name: 'TS Free reader (auto)' },
      { id: T.noMarketing, tag_name: 'TS No marketing (auto)' },
    ];
    base = await fake.start();
    await prisma.audienceSyncState.upsert({
      where: { portal: WPORTAL },
      create: { portal: WPORTAL, lastFullOkAt: new Date(now.getTime() - 3_600_000) },
      update: { lastFullOkAt: new Date(now.getTime() - 3_600_000), breakerOpenAt: null, breakerReason: null },
    });
  });
  afterEach(() => fake.stop());

  it('4. cap 3, 5 waiting: day 1 admits exactly 3 — the ones already in Mailercloud first; day 2 admits the other 2', async () => {
    now = new Date('2027-07-01T10:00:00Z');
    const ms = [];
    for (let i = 0; i < 5; i++) ms.push(await member('FREE'));
    // The two Mailercloud already holds are the two LAST in hash order, so hash order alone would not pick them.
    const byHash = [...ms].sort((a, b) => (a.h < b.h ? -1 : 1));
    const present = byHash.slice(3);
    for (const p of present) fake.addContact(p.email, { list: 'SwZafy' });
    const hs = ms.map((m) => m.h);

    const d1 = await flushPending(deps(FREE_ON(3), hs));
    expect(d1.admitted).toBe(3);
    expect(d1.looked).toBe(5);
    const admitted1 = (await Promise.all(hs.map(row))).filter((m) => m.admittedAt !== null);
    expect(admitted1).toHaveLength(3);
    for (const p of present) expect((await row(p.h)).admittedAt).not.toBeNull();
    for (const m of admitted1) expect(m.appliedTags).toEqual([T.free]);
    expect(fake.contacts.get(present[0].email)!.tags.has('TS Free reader (auto)')).toBe(true);
    // The absent one admitted was CREATED in our list with the Free tag.
    const createdAbsent = admitted1.find((m) => !present.some((p) => p.h === m.emailHash))!;
    expect(fake.contacts.get(createdAbsent.email!)!.lists.has('list-1')).toBe(true);

    // Same day: no room left.
    const d1b = await flushPending(deps(FREE_ON(3), hs));
    expect(d1b.admitted).toBe(0);

    now = new Date('2027-07-02T10:00:00Z');
    const d2 = await flushPending(deps(FREE_ON(3), hs));
    expect(d2.admitted).toBe(2);
    expect((await Promise.all(hs.map(row))).every((m) => m.admittedAt !== null && m.appliedTags.includes(T.free))).toBe(true);
  });

  it('5. cap 0: no FREE member admitted and no Mailercloud call for any of them; PREMIUM and FORMER writes still run', async () => {
    now = new Date('2027-07-05T10:00:00Z');
    const free = [await member('FREE'), await member('FREE')];
    const prem = await member('PREMIUM');
    const former = await member('FORMER');
    const r = await flushPending(deps(FREE_ON(0), [...free, prem, former].map((m) => m.h)));
    expect(r.admitted).toBe(0);
    expect(r.looked).toBe(0);
    expect(touched(free.map((f) => f.email))).toHaveLength(0);
    for (const f of free) expect(await row(f.h)).toMatchObject({ admittedAt: null, mcState: 'UNKNOWN', appliedTags: [] });
    expect((await row(prem.h)).appliedTags).toEqual([T.premium]);
    expect((await row(former.h)).appliedTags).toEqual([T.former]);
  });

  it('PREMIUM and FORMER go first: a batch full of them leaves no budget for admissions', async () => {
    now = new Date('2027-07-06T10:00:00Z');
    const prem = [await member('PREMIUM'), await member('PREMIUM')];
    const free = await member('FREE');
    const r = await flushPending(deps(FREE_ON(10), [...prem, free].map((m) => m.h), { batch: 2 }));
    expect(r.members).toBe(2);
    expect(r.admitted).toBe(0);
    expect(touched([free.email])).toHaveLength(0);
  });

  it('6. a waiting FREE member that turns PREMIUM is written at once, without the cap, and never gets the Free tag', async () => {
    now = new Date('2027-07-08T10:00:00Z');
    // Through the real ingest: a free account becomes active.
    const email = addr('w6');
    const h = sha(email);
    const snap = (status: string, s: number) => {
      const p = parseCmsListRow({
        account_id: `${P}w6`,
        seq: s,
        email,
        name: 'X',
        plan: status === 'active' ? 'premium_1y' : null,
        status,
        period_start: status === 'active' ? '2027-07-01' : null,
        period_end: status === 'active' ? '2028-06-30' : null,
        marketing_consent: { value: null, at: null },
        erasure: false,
        deleted_at: null,
        updated_at: now.toISOString(),
      });
      if (!p.ok) throw new Error(p.reason);
      return p.snapshot;
    };
    const cfg = FREE_ON(0);
    await prisma.$transaction((tx) => applyAccountSnapshot(tx, snap('free', 1), 'pull_full', { now, cfg, portal: WPORTAL }));
    expect(await row(h)).toMatchObject({ desiredRole: 'FREE', admittedAt: null });
    await prisma.$transaction((tx) => applyAccountSnapshot(tx, snap('active', 2), 'webhook', { now, cfg, portal: WPORTAL }));
    expect((await row(h)).desiredRole).toBe('PREMIUM');

    const r = await flushPending(deps(cfg, [h]));
    expect(r.admitted).toBe(0);
    const m = await row(h);
    expect(m.appliedTags).toEqual([T.premium]);
    expect(m.admittedAt).toBeNull();
    expect([...fake.contacts.get(email)!.tags]).toEqual(['TS Premium (auto)']);
  });

  it('7. FREE → NONE, FREE → unsubscribed and FREE → deleted remove the Free tag at once, with the cap at 0', async () => {
    now = new Date('2027-07-10T10:00:00Z');
    const admitted = { admittedAt: new Date('2027-07-01T10:00:00Z'), appliedTags: [T.free], mcState: 'PRESENT', nextAttemptAt: null };
    const toNone = await member('FREE', admitted);
    const toUnsub = await member('FREE', admitted);
    const toDeleted = await member('FREE', admitted);
    for (const m of [toNone, toUnsub, toDeleted]) fake.addContact(m.email, { tags: ['TS Free reader (auto)'], list: 'list-1' });
    // What recomputeMembers writes for each: role NONE; suppressed; deleted = NONE + No-marketing.
    await prisma.audienceMember.update({ where: { emailHash: toNone.h }, data: { desiredRole: 'NONE', nextAttemptAt: now } });
    await prisma.audienceMember.update({ where: { emailHash: toUnsub.h }, data: { suppressed: true, nextAttemptAt: now } });
    await prisma.audienceMember.update({ where: { emailHash: toDeleted.h }, data: { desiredRole: 'NONE', noMarketing: true, suppressed: true, nextAttemptAt: now } });

    const r = await flushPending(deps(FREE_ON(0), [toNone, toUnsub, toDeleted].map((m) => m.h)));
    expect(r.admitted).toBe(0);
    for (const m of [toNone, toUnsub, toDeleted]) expect(fake.contacts.get(m.email)!.tags.has('TS Free reader (auto)')).toBe(false);
    expect(await prisma.audienceMember.findUnique({ where: { emailHash: toNone.h } })).toBeNull(); // nothing left to hold
    expect((await row(toUnsub.h)).appliedTags).toEqual([]);
    expect((await row(toDeleted.h)).appliedTags).toEqual([T.noMarketing]);
  });

  it('11. flag on + AUDIENCE_MC_TAG_FREE unset: a config problem at boot, FREE writes skipped, Premium still written', async () => {
    now = new Date('2027-07-12T10:00:00Z');
    const cfg = cfgWith({ AUDIENCE_FREE_READERS: 'true', AUDIENCE_FREE_ADMIT_PER_DAY: '10' });
    expect(cfg.problems).toEqual([]); // not a sync-stopping problem
    expect(freeConfigProblems(cfg)).toEqual([expect.stringContaining('AUDIENCE_MC_TAG_FREE')]);
    expect(freeConfigProblems(FREE_ON(10))).toEqual([]);
    expect(freeConfigProblems(cfgWith())).toEqual([]);
    logs.length = 0;
    startAudienceSync(cfg, { startCron: () => ({ stop: () => undefined }) });
    expect(logs.some((l) => l.includes('config problem') && l.includes('AUDIENCE_MC_TAG_FREE'))).toBe(true);
    expect(logs.join('\n')).not.toMatch(/@/);

    const free = await member('FREE');
    const prem = await member('PREMIUM');
    const r = await flushPending(deps(cfg, [free.h, prem.h]));
    expect(r.admitted).toBe(0);
    expect(touched([free.email])).toHaveLength(0);
    expect((await row(prem.h)).appliedTags).toEqual([T.premium]);
  });

  it('a suppressed waiting member is never admitted', async () => {
    now = new Date('2027-07-14T10:00:00Z');
    const m = await member('FREE', { suppressed: true });
    const r = await flushPending(deps(FREE_ON(5), [m.h]));
    expect(r.admitted).toBe(0);
    expect(touched([m.email])).toHaveLength(0);
  });

  it('no address in any writer log line', () => {
    expect(logs.join('\n')).not.toMatch(/@example\.com/);
  });
});

// ─── 9, 10, 12 ───────────────────────────────────────────────────────────────

describe('guard, target, card (acceptance 9, 10, 12)', () => {
  const now = new Date('2027-08-01T10:00:00Z');

  it('9. 1,000 FREE members waiting leave pending_writes unchanged', async () => {
    const cfg = FREE_ON(0);
    const before = await loadGuardSnapshot(PORTAL, cfg);
    const rows = Array.from({ length: 1000 }, (_, i) => {
      const email = addr(`g9-${i}`);
      return { emailHash: sha(email), email, desiredRole: 'FREE', nextAttemptAt: now };
    });
    await prisma.audienceMember.createMany({ data: rows });
    const after = await loadGuardSnapshot(PORTAL, cfg);
    expect(after.pendingPremium).toBe(before.pendingPremium);
    expect(after.premiumDesired).toBe(before.premiumDesired);
    const r = audienceGuard('PREMIUM', { ...after, pendingPremium: 0, premiumDesired: 0 }, now, cfg.thresholds);
    if (!r.ok) expect(r.check).not.toBe('pending_writes');
    await prisma.audienceMember.deleteMany({ where: { emailHash: { in: rows.map((r) => r.emailHash) } } });
  });

  it('10. Free with two segment ids targets both, and still refuses an id shared with Premium', () => {
    const aud = parseAudienceEnv({});
    const two = parseDigestEnv({ DIGEST_FREE_SEGMENT_IDS: 'segA,segB', DIGEST_FREE_MANUAL: 'true', DIGEST_PREMIUM_SEGMENT_IDS: 'segP' });
    const t = audienceTarget(two, 'FREE', aud);
    expect(t).toEqual({ ok: true, target: { listIds: [], segmentIds: ['segA', 'segB'], tagIds: [], excludeListIds: [], excludeTagIds: [] } });
    const shared = parseDigestEnv({ DIGEST_FREE_SEGMENT_IDS: 'segA,segP', DIGEST_FREE_MANUAL: 'true', DIGEST_PREMIUM_SEGMENT_IDS: 'segP' });
    const s = audienceTarget(shared, 'FREE', aud);
    expect(s.ok).toBe(false);
  });

  it('12. Audience card: the FREE line with the flag on (counts only), absent with it off', async () => {
    const cfg = FREE_ON(7);
    const email = addr('card-1');
    await prisma.audienceMember.create({ data: { emailHash: sha(email), email, desiredRole: 'FREE', nextAttemptAt: now } });
    const card = (await audienceCard(PORTAL, 'ADMIN', now, cfg)) as Record<string, unknown> & { free?: Record<string, unknown> };
    expect(card.free).toEqual({
      eligible: expect.any(Number),
      admitted: expect.any(Number),
      tagged: expect.any(Number),
      refused: expect.any(Number),
      waiting: expect.any(Number),
      admittedToday: expect.any(Number),
      cap: 7,
      tagConfigured: true,
    });
    expect(card.free!.waiting as number).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(card)).not.toMatch(/@|emailHash/);
    const off = (await audienceCard(PORTAL, 'ADMIN', now, cfgWith())) as Record<string, unknown>;
    expect(off).not.toHaveProperty('free');
    const pub = await audienceCard(PORTAL, 'PUBLISHER', now, cfg);
    expect(Object.keys(pub).sort()).toEqual(['enabled', 'line', 'ok']);
  });
});
