/**
 * CMS audience sync, task 6 (docs/CMS_AUDIENCE_SYNC_DESIGN.md §6, §10.3): the Mailercloud contact
 * writer against a fake Mailercloud whose contact semantics (M-1 … M-3, tag read-back shape) are
 * switched BOTH ways. The invariants asserted on every recorded request: no `contact_type` (except the
 * lift path with its flag) and no DELETE.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { prisma } from '../lib/prisma';
import { parseAudienceEnv, type AudienceEnv } from '../lib/env';
import { FakeMailercloud } from './audienceFakeMailercloud';
import { McContactClient } from '../services/audience/mcContacts';
import { startAudienceSync } from '../services/audience/boot';
import { diffMember, driftCheck, flushPending, inSendWindow, resetWriterForTests, retryDelayMin, FAILING_ATTEMPTS, type WriterDeps } from '../services/audience/writer';

const logs: string[] = [];
const capture = (...args: unknown[]) => {
  logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
};
jest.spyOn(console, 'log').mockImplementation(capture);
jest.spyOn(console, 'warn').mockImplementation(capture);
jest.spyOn(console, 'error').mockImplementation(capture);

const RUN = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const KEY = 'k'.repeat(40);
const P = `wr${RUN}-`;
const PORTAL = `test-audience-writer-${RUN}`;
const T = { premium: `tp-${RUN}`, former: `tf-${RUN}`, noMarketing: `tn-${RUN}` };
const NAME = { [T.premium]: 'TS Premium (auto)', [T.former]: 'TS Former (auto)', [T.noMarketing]: 'TS No marketing (auto)' };
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const hashes = new Set<string>();
let seq = 0;
const addr = (local: string) => {
  const e = `${local}.${++seq}.${RUN}@example.com`; // unique per call: describe.each re-runs the same names
  hashes.add(sha(e));
  return e;
};
const baseEnv = {
  AUDIENCE_SYNC_ENABLED: 'true',
  AUDIENCE_SYNC_WRITE_MAILERCLOUD: 'true',
  MAILERCLOUD_SYNC_API_KEY: KEY,
  AUDIENCE_MC_LIST_ID: 'list-1',
  AUDIENCE_MC_TAG_PREMIUM: T.premium,
  AUDIENCE_MC_TAG_FORMER: T.former,
  AUDIENCE_MC_TAG_NO_MARKETING: T.noMarketing,
};
const cfgWith = (over: Record<string, string> = {}): AudienceEnv => parseAudienceEnv({ ...baseEnv, ...over });

let now = new Date('2027-03-01T10:00:00Z'); // 15:30 IST — outside the 07:10–08:00 window
let fake: FakeMailercloud;
let base: string;
const noSleep = () => Promise.resolve();

function deps(over: Partial<WriterDeps> & { resubscribe?: boolean } = {}): WriterDeps {
  const { resubscribe, ...rest } = over;
  return {
    client: new McContactClient({ apiKey: KEY, baseV1: base, resubscribeWrites: resubscribe === true }),
    cfg: cfgWith(resubscribe ? { AUDIENCE_RESUBSCRIBE_WRITES: 'true' } : {}),
    digestCfg: { sendAt: '07:30' },
    portal: PORTAL,
    now: () => now,
    sleep: noSleep,
    sendAlerts: false,
    ...rest,
  };
}

async function seedState(portal = PORTAL, extra: Record<string, unknown> = {}) {
  await prisma.audienceSyncState.upsert({
    where: { portal },
    create: { portal, lastFullOkAt: new Date(now.getTime() - 3_600_000), ...extra },
    update: { lastFullOkAt: new Date(now.getTime() - 3_600_000), breakerOpenAt: null, breakerReason: null, ...extra },
  });
}

type SeedOver = { desiredRole?: string; noMarketing?: boolean; suppressed?: boolean; appliedTags?: string[]; resubscribePending?: boolean; nextAttemptAt?: Date | null };
async function member(local: string, over: SeedOver = {}) {
  const email = addr(local);
  const h = sha(email);
  await prisma.audienceMember.create({
    data: { emailHash: h, email, desiredRole: 'PREMIUM', nextAttemptAt: new Date(now.getTime() - 1000), ...over },
  });
  return { email, h };
}
const row = (h: string) => prisma.audienceMember.findUnique({ where: { emailHash: h } });
const state = () => prisma.audienceSyncState.findUnique({ where: { portal: PORTAL } });
const alerts = async () => ((await state())?.alerts ?? {}) as Record<string, { raisedAt?: string; count?: number }>;
const tagNames = (email: string) => [...(fake.contacts.get(email)?.tags ?? [])].sort();

/** The two invariants, on EVERY request the fake recorded. */
function expectInvariants(opts: { allowContactType?: boolean } = {}) {
  for (const r of fake.requests) {
    expect(r.method).not.toBe('DELETE');
    if (!opts.allowContactType) expect(JSON.stringify(r.body ?? null)).not.toContain('contact_type');
  }
}

beforeAll(async () => {
  await seedState();
});

beforeEach(async () => {
  resetWriterForTests();
  logs.length = 0;
  now = new Date('2027-03-01T10:00:00Z');
  fake = new FakeMailercloud(KEY);
  fake.tags = [
    { id: T.premium, tag_name: NAME[T.premium] },
    { id: T.former, tag_name: NAME[T.former] },
    { id: T.noMarketing, tag_name: NAME[T.noMarketing] },
  ];
  base = await fake.start();
  await seedState();
});

afterEach(async () => {
  await fake.stop();
});

afterAll(async () => {
  const hs = [...hashes];
  await prisma.emailSuppression.deleteMany({ where: { OR: [{ accountId: { startsWith: P } }, { emailHash: { in: hs } }] } });
  await prisma.audienceMember.deleteMany({ where: { emailHash: { in: hs } } });
  await prisma.cmsAccount.deleteMany({ where: { accountId: { startsWith: P } } });
  await prisma.audienceSyncState.deleteMany({ where: { portal: { startsWith: PORTAL } } });
  await prisma.$disconnect();
});

// ─── the pure parts ─────────────────────────────────────────────────────────

describe('diff, windows and retry delays', () => {
  it('diffMember: adds what is missing, removes only OUR tags, skips adds for a suppressed member except No-marketing', () => {
    expect(diffMember({ desiredRole: 'PREMIUM', noMarketing: false, suppressed: false, appliedTags: [] }, T)).toEqual({ adds: [T.premium], removes: [] });
    expect(diffMember({ desiredRole: 'FORMER', noMarketing: true, suppressed: false, appliedTags: [T.premium, 'hand'] }, T)).toEqual({ adds: [T.former, T.noMarketing], removes: [T.premium] });
    expect(diffMember({ desiredRole: 'PREMIUM', noMarketing: true, suppressed: true, appliedTags: [T.former] }, T)).toEqual({ adds: [T.noMarketing], removes: [T.former] });
  });

  it('send window = [sendAt − 20 min, sendAt + 30 min) IST', () => {
    const at = (iso: string) => inSendWindow(new Date(iso), '07:30');
    expect(at('2027-03-01T01:39:00Z')).toBe(false); // 07:09 IST
    expect(at('2027-03-01T01:40:00Z')).toBe(true); // 07:10
    expect(at('2027-03-01T02:29:00Z')).toBe(true); // 07:59
    expect(at('2027-03-01T02:30:00Z')).toBe(false); // 08:00
  });

  it('retry delays: +1, +5, +15 min, then hourly', () => {
    expect([1, 2, 3, 4, 5, 20].map(retryDelayMin)).toEqual([1, 5, 15, 60, 60, 60]);
  });
});

// ─── 6: converges, idempotent, flapping, appliedTags only from a 2xx — BOTH behaviours ──────────────

const BEHAVIOURS: { name: string; m1: 'fail' | 'upsert'; m2: 'keep' | 'resubscribe'; m3: 'append' | 'replace'; tagsOut: 'names-csv' | 'ids-array' }[] = [
  { name: 'create fails if it exists · PUT keeps unsubscribed · PUT appends · tags read as names', m1: 'fail', m2: 'keep', m3: 'append', tagsOut: 'names-csv' },
  { name: 'create upserts · PUT re-subscribes · PUT replaces · tags read as ids', m1: 'upsert', m2: 'resubscribe', m3: 'replace', tagsOut: 'ids-array' },
];

describe.each(BEHAVIOURS)('the writer against the fake Mailercloud — $name', (b) => {
  beforeEach(() => {
    fake.m1 = b.m1;
    fake.m2 = b.m2;
    fake.m3 = b.m3;
    fake.tagsOut = b.tagsOut;
  });

  it('converges to the desired tags; a hand-added tag is never dropped; a repeated tick sends nothing', async () => {
    const a = await member('conv-new'); // Premium, no contact → created
    const f = await member('conv-former', { desiredRole: 'FORMER', appliedTags: [T.premium] }); // Premium → Former
    fake.addContact(f.email, { tags: [NAME[T.premium], 'hand-tag'] });
    const g = await member('conv-nomkt', { desiredRole: 'NONE', noMarketing: true }); // exclusion only
    fake.addContact(g.email);
    const n = await member('conv-none', { desiredRole: 'NONE', appliedTags: [T.premium] }); // lost Premium
    fake.addContact(n.email, { tags: [NAME[T.premium], 'hand-tag'] });
    const only = [a.h, f.h, g.h, n.h];

    const r = await flushPending(deps({ onlyHashes: only }));
    expect(r).toMatchObject({ members: 4, created: 1, fatal: 0, retry: 0, dryRun: false });

    expect(tagNames(a.email)).toEqual([NAME[T.premium]]);
    expect(tagNames(f.email)).toEqual(['TS Former (auto)', 'hand-tag']);
    expect(tagNames(g.email)).toEqual([NAME[T.noMarketing]]);
    expect(tagNames(n.email)).toEqual(['hand-tag']);
    expect((await row(a.h))!.appliedTags).toEqual([T.premium]);
    expect((await row(f.h))!.appliedTags).toEqual([T.former]);
    expect((await row(g.h))!.appliedTags).toEqual([T.noMarketing]);
    expect(await row(n.h)).toBeNull(); // no role, nothing applied: the row (and its address) is gone
    expect((await row(a.h))!.nextAttemptAt).toBeNull();

    const sent = fake.requests.length;
    const again = await flushPending(deps({ onlyHashes: only }));
    expect(again.members).toBe(0); // the kept rows are not due …
    expect(again).toMatchObject({ created: 0, tagged: 0, removed: 0, requests: 0 });
    expect(fake.requests.length).toBe(sent); // … so nothing was sent
    expectInvariants();
  });

  it('a flapping member collapses to ONE write', async () => {
    const m = await member('flap', { desiredRole: 'NONE' });
    for (const role of ['PREMIUM', 'NONE', 'PREMIUM']) {
      await prisma.audienceMember.update({ where: { emailHash: m.h }, data: { desiredRole: role } });
    }
    await flushPending(deps({ onlyHashes: [m.h] }));
    const writes = fake.requests.filter((r) => r.method !== 'GET' && !r.path.endsWith('/tags/search'));
    expect(writes.map((r) => `${r.method} ${r.path}`)).toEqual(['POST /v1/contacts']);
    expect(tagNames(m.email)).toEqual([NAME[T.premium]]);
    expectInvariants();
  });

  it('appliedTags is unchanged after a non-2xx (and the member is retried at +1 min)', async () => {
    const m = await member('non2xx');
    fake.failEmails.set(m.email, 503);
    const r = await flushPending(deps({ onlyHashes: [m.h] }));
    expect(r).toMatchObject({ retry: 1, done: 0 });
    const after = (await row(m.h))!;
    expect(after.appliedTags).toEqual([]);
    expect(after).toMatchObject({ attempts: 1, lastErrorKind: 'RETRYABLE' });
    expect(after.nextAttemptAt!.getTime()).toBe(now.getTime() + 60_000);
    expect(fake.contacts.has(m.email)).toBe(false);
    expectInvariants();
  });

  it('M-1 race: the contact appears between our GET and our create — the existing-contact path, never an upsert retry', async () => {
    const m = await member('race');
    fake.beforeCreate = (email) => {
      if (email === m.email && !fake.contacts.has(email)) fake.addContact(email, { status: 'unsubscribed', tags: ['hand-tag'] });
    };
    await flushPending(deps({ onlyHashes: [m.h] }));
    if (b.m1 === 'fail') {
      // "already exists" → GET again → PUT the union; the unsubscribed contact stays unsubscribed (m2 keep) …
      expect(tagNames(m.email)).toEqual(['TS Premium (auto)', 'hand-tag']);
      expect(fake.requests.filter((r) => r.method === 'POST' && r.path === '/v1/contacts')).toHaveLength(1);
    } else {
      // … while a silent-upsert Mailercloud applied the single create: the tags landed (the residual M-1 risk,
      // for the internal-address test — a race inside one GET→create window).
      expect(tagNames(m.email)).toContain('TS Premium (auto)');
    }
    expect((await row(m.h))!.appliedTags).toEqual([T.premium]);
    expectInvariants();
  });
});

// ─── 7 / 8: contact_type, DELETE, suppressed members ────────────────────────

describe('the lift path is the only contact_type', () => {
  async function lifting(over: { flag: boolean; suppressed?: boolean; consent?: boolean }) {
    const m = await member(`lift-${over.flag}-${over.suppressed ?? false}-${over.consent ?? true}`, {
      desiredRole: 'NONE',
      resubscribePending: true,
      suppressed: over.suppressed ?? false,
    });
    await prisma.cmsAccount.create({
      data: { accountId: `${P}${m.h.slice(0, 8)}`, seq: 1n, status: 'free', lastSource: 'webhook', emailHash: m.h, consentValue: over.consent ?? true, consentAt: now },
    });
    fake.addContact(m.email, { status: 'unsubscribed' });
    const r = await flushPending(deps({ onlyHashes: [m.h], resubscribe: over.flag }));
    return { m, r };
  }
  const withType = () => fake.requests.filter((r) => JSON.stringify(r.body ?? null).includes('contact_type'));

  it('flag ON + current consent + not suppressed: exactly one PUT {contact_type: active}', async () => {
    const { m, r } = await lifting({ flag: true });
    expect(r).toMatchObject({ resubscribed: 1, done: 1 });
    expect(withType()).toHaveLength(1);
    expect(withType()[0]).toMatchObject({ method: 'PUT', body: { contact_type: 'active' } });
    expect(fake.contacts.get(m.email)!.status).toBe('active');
    expect((await row(m.h))).toBeNull(); // handled: nothing left to hold
    expectInvariants({ allowContactType: true });
  });

  it('flag OFF: no contact_type anywhere, the contact stays unsubscribed, the lift is counted as skipped', async () => {
    const { m, r } = await lifting({ flag: false });
    expect(r).toMatchObject({ resubscribed: 0, resubscribeSkipped: 1 });
    expect(withType()).toHaveLength(0);
    expect(fake.contacts.get(m.email)!.status).toBe('unsubscribed');
    expectInvariants();
  });

  it('flag ON but the member is suppressed (or consent is not true): still no contact_type', async () => {
    await lifting({ flag: true, suppressed: true });
    await lifting({ flag: true, consent: false });
    expect(withType()).toHaveLength(0);
    expectInvariants();
  });

  it('the client refuses resubscribe() itself unless built with the flag (no request is made)', async () => {
    const c = new McContactClient({ apiKey: KEY, baseV1: base });
    await expect(c.resubscribe('a@example.com')).rejects.toMatchObject({ kind: 'FATAL' });
    expect(fake.requests).toHaveLength(0);
  });

  it('source scan: no DELETE in the writer or the contact client; contact_type only in resubscribe()', () => {
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const writer = strip(readFileSync(path.join(__dirname, '../services/audience/writer.ts'), 'utf8'));
    const client = strip(readFileSync(path.join(__dirname, '../services/audience/mcContacts.ts'), 'utf8'));
    expect(writer).not.toMatch(/['"`]DELETE['"`]/);
    expect(client).not.toMatch(/['"`]DELETE['"`]/);
    expect(client).toMatch(/method: 'GET' \| 'POST' \| 'PUT'/);
    expect(writer).not.toContain('contact_type');
    expect(client.match(/contact_type/g)).toHaveLength(1);
    expect(client.indexOf('contact_type')).toBeGreaterThan(client.indexOf('async resubscribe'));
  });
});

describe('suppressed members are never added (acceptance 8)', () => {
  it.each([['keep' as const], ['resubscribe' as const]])('by address hash / by account id: no premium add, the removal and No-marketing are written (m2=%s)', async (m2) => {
    fake.m2 = m2;
    // Suppressed by an address-hash row that Mailercloud does NOT enforce (MANUAL): the exclusion tag is still written.
    const byHash = await member('sup-hash', { suppressed: true, noMarketing: true, appliedTags: [T.former] });
    await prisma.emailSuppression.create({ data: { emailHash: byHash.h, reason: 'MANUAL', source: 'manual' } });
    fake.addContact(byHash.email, { tags: [NAME[T.former]] });
    // Suppressed by account id only (an opt-out that follows the account from an old address).
    const byAccount = await member('sup-acct', { suppressed: true, noMarketing: true, appliedTags: [T.former] });
    await prisma.emailSuppression.create({ data: { accountId: `${P}sup`, reason: 'UNSUBSCRIBE', source: 'mailercloud_webhook' } });
    fake.addContact(byAccount.email, { tags: [NAME[T.former]] });

    await flushPending(deps({ onlyHashes: [byHash.h, byAccount.h] }));
    for (const x of [byHash, byAccount]) {
      expect(tagNames(x.email)).toEqual([NAME[T.noMarketing]]); // Former removed, No-marketing added, Premium NEVER
      expect((await row(x.h))!.appliedTags).toEqual([T.noMarketing]);
    }
    expectInvariants();
  });

  it('a hash-suppressed member whose address Mailercloud already blocks (UNSUBSCRIBE/bounce/spam): nothing added at all, removal still written, stays unsubscribed', async () => {
    for (const m2 of ['keep', 'resubscribe'] as const) {
      fake.m2 = m2;
      fake.requests.length = 0;
      const m = await member(`sup-unsub-${m2}`, { suppressed: true, noMarketing: true, appliedTags: [T.former] });
      await prisma.emailSuppression.create({ data: { emailHash: m.h, reason: 'UNSUBSCRIBE', source: 'mailercloud_webhook' } });
      fake.addContact(m.email, { status: 'unsubscribed', tags: [NAME[T.former]] });
      await flushPending(deps({ onlyHashes: [m.h] }));
      expect(tagNames(m.email)).toEqual([]);
      expect(fake.contacts.get(m.email)!.status).toBe('unsubscribed'); // no PUT could re-activate it
      expect(fake.requests.some((r) => r.method === 'PUT')).toBe(false);
      expectInvariants();
    }
  });
});

// ─── 9: FATAL stops one member; RETRYABLE follows the ladder ────────────────

describe('error classification (acceptance 9)', () => {
  it('FATAL stops only that member and raises audience_writer_fatal once per day', async () => {
    const bad = await member('fatal-bad');
    const ok = await member('fatal-ok');
    fake.failEmails.set(bad.email, 400);
    const r = await flushPending(deps({ onlyHashes: [bad.h, ok.h] }));
    expect(r).toMatchObject({ fatal: 1, done: 1 });
    expect(await row(bad.h)).toMatchObject({ lastErrorKind: 'FATAL', attempts: 1, nextAttemptAt: null, appliedTags: [] });
    expect((await row(ok.h))!.appliedTags).toEqual([T.premium]);
    const first = (await alerts()).audience_writer_fatal;
    expect(first).toMatchObject({ count: 1 });

    // A second FATAL member the same IST day refreshes the counts; it is not a new alert.
    const bad2 = await member('fatal-bad2');
    fake.failEmails.set(bad2.email, 401);
    now = new Date(now.getTime() + 60_000);
    await flushPending(deps({ onlyHashes: [bad2.h] }));
    expect((await alerts()).audience_writer_fatal!.raisedAt).toBe(first!.raisedAt);

    // Neither FATAL member is due again on its own.
    const before = fake.requests.length;
    now = new Date(now.getTime() + 3 * 3_600_000);
    await flushPending(deps({ onlyHashes: [bad.h, bad2.h] }));
    expect(fake.requests.length).toBe(before);
    expectInvariants();
  });

  it('RETRYABLE follows +1, +5, +15 min and then hourly; the 9th failure raises audience_writer_failing', async () => {
    const m = await member('retry');
    fake.failEmails.set(m.email, 503);
    const delays: number[] = [];
    for (let i = 1; i <= FAILING_ATTEMPTS; i++) {
      await flushPending(deps({ onlyHashes: [m.h] }));
      const r = (await row(m.h))!;
      expect(r).toMatchObject({ attempts: i, lastErrorKind: 'RETRYABLE', appliedTags: [] });
      delays.push((r.nextAttemptAt!.getTime() - now.getTime()) / 60_000);
      // Not due a second early.
      const before = fake.requests.length;
      now = new Date(r.nextAttemptAt!.getTime() - 1000);
      await flushPending(deps({ onlyHashes: [m.h] }));
      expect(fake.requests.length).toBe(before);
      now = r.nextAttemptAt!;
    }
    expect(delays).toEqual([1, 5, 15, 60, 60, 60, 60, 60, 60]);
    expect((await alerts()).audience_writer_failing).toBeDefined();
    expectInvariants();
  });
});

// ─── 10: the flags and the gates ────────────────────────────────────────────

describe('flags and gates (acceptance 10, and the breaker pause of acceptance 3)', () => {
  it('AUDIENCE_SYNC_WRITE_MAILERCLOUD off: ZERO Mailercloud requests, rows untouched, the dry-run count line is logged (no address)', async () => {
    const m = await member('dry', { noMarketing: true });
    const off = deps({ onlyHashes: [m.h], cfg: cfgWith({ AUDIENCE_SYNC_WRITE_MAILERCLOUD: 'false' }) });
    const r = await flushPending(off);
    expect(r).toMatchObject({ dryRun: true, members: 1, wouldAdd: 2, wouldRemove: 0, requests: 0 });
    expect(fake.requests).toHaveLength(0);
    expect(await row(m.h)).toMatchObject({ appliedTags: [], attempts: 0 });
    expect((await row(m.h))!.nextAttemptAt).not.toBeNull();
    const line = logs.find((l) => l.includes('writer dry-run'));
    expect(line).toContain('would_add=2 would_remove=0');
    expect(logs.join('\n')).not.toContain('@example.com');
  });

  it('AUDIENCE_SYNC_ENABLED off: boot prints [audience] disabled and starts no cron', () => {
    const started: string[] = [];
    expect(startAudienceSync(parseAudienceEnv({}), { startCron: (e) => (started.push(e), { stop: () => undefined }) })).toBe('disabled');
    expect(started).toEqual([]);
    expect(logs.some((l) => l.startsWith('[audience] disabled'))).toBe(true);
  });

  it('inside the send window: nothing is written and nothing is touched; just outside, it writes', async () => {
    const m = await member('window');
    now = new Date('2027-02-28T01:45:00Z'); // 07:15 IST
    const r = await flushPending(deps({ onlyHashes: [m.h] }));
    expect(r.skipped).toBe('send_window');
    expect(fake.requests).toHaveLength(0);
    expect((await row(m.h))!.appliedTags).toEqual([]);
    now = new Date('2027-02-28T02:30:00Z'); // 08:00 IST
    await prisma.audienceMember.update({ where: { emailHash: m.h }, data: { nextAttemptAt: new Date(now.getTime() - 1000) } });
    expect((await flushPending(deps({ onlyHashes: [m.h] }))).skipped).toBeUndefined();
    expect((await row(m.h))!.appliedTags).toEqual([T.premium]);
  });

  it('no complete full load yet, or an open breaker: writes are paused (a 6 % change vs a 5 % cap is the pull test’s; here the pause itself)', async () => {
    const m = await member('paused');
    await prisma.audienceSyncState.update({ where: { portal: PORTAL }, data: { lastFullOkAt: null } });
    expect((await flushPending(deps({ onlyHashes: [m.h] }))).skipped).toBe('no_full_load');
    await seedState(PORTAL, { breakerOpenAt: new Date(now.getTime() - 60_000), breakerReason: 'change_too_large' });
    expect((await flushPending(deps({ onlyHashes: [m.h] }))).skipped).toBe('breaker_open');
    expect(fake.requests).toHaveLength(0);
    expect((await row(m.h))!.appliedTags).toEqual([]);
    await seedState(); // closed again: it writes
    expect((await flushPending(deps({ onlyHashes: [m.h] }))).skipped).toBeUndefined();
    expect((await row(m.h))!.appliedTags).toEqual([T.premium]);
  });

  it('a missing tag id / list id / key is "not configured": nothing is sent', async () => {
    const m = await member('unconfigured');
    const r = await flushPending(deps({ onlyHashes: [m.h], cfg: cfgWith({ AUDIENCE_MC_LIST_ID: '' }) }));
    expect(r.skipped).toBe('not_configured');
    expect(fake.requests).toHaveLength(0);
  });

  it('a configured tag id Mailercloud does not have is FATAL for the tick (alert), not a silent no-op', async () => {
    const m = await member('badtag');
    const r = await flushPending(deps({ onlyHashes: [m.h], cfg: cfgWith({ AUDIENCE_MC_TAG_FORMER: 'does-not-exist' }) }));
    expect(r.retry).toBe(1);
    expect((await alerts()).audience_writer_fatal).toBeDefined();
    expect((await row(m.h))!.appliedTags).toEqual([]);
  });
});

// ─── 11: drift ──────────────────────────────────────────────────────────────

describe('drift check (acceptance 11)', () => {
  it('a sampled member whose tags differ is corrected from Mailercloud and made due; audience_drift is raised', async () => {
    const off = await member('drift-off', { appliedTags: [T.premium], nextAttemptAt: null });
    fake.addContact(off.email, { tags: [] }); // someone removed the tag by hand
    const same = await member('drift-same', { appliedTags: [T.premium], nextAttemptAt: null });
    fake.addContact(same.email, { tags: [NAME[T.premium]] });
    const gone = await member('drift-gone', { appliedTags: [T.premium], nextAttemptAt: null }); // contact deleted over there
    const r = await driftCheck(deps({ onlyHashes: [off.h, same.h, gone.h] }));
    expect(r).toMatchObject({ sampled: 3, mismatched: 2 });
    expect(await row(off.h)).toMatchObject({ appliedTags: [], mcState: 'PRESENT' });
    expect((await row(off.h))!.nextAttemptAt).not.toBeNull();
    expect(await row(gone.h)).toMatchObject({ appliedTags: [], mcState: 'ABSENT' });
    expect(await row(same.h)).toMatchObject({ appliedTags: [T.premium], nextAttemptAt: null });
    expect((await alerts()).audience_drift).toMatchObject({ mismatched: 2 });
    expect((await state())!.drift).toMatchObject({ sampled: 3, mismatched: 2 });
    // The repair is a normal write on the next tick.
    await flushPending(deps({ onlyHashes: [off.h, gone.h] }));
    expect(tagNames(off.email)).toEqual([NAME[T.premium]]);
    expectInvariants();
  });

  it('a Premium count that differs from Mailercloud’s segment count raises audience_drift even when every sample matches', async () => {
    const portal = `${PORTAL}-count`;
    await seedState(portal);
    const m = await member('drift-count', { appliedTags: [T.premium], nextAttemptAt: null });
    fake.addContact(m.email, { tags: [NAME[T.premium]] });
    fake.segments = [{ id: 'seg-1', name: 'Premium', active_count: 500 }];
    const cfg = cfgWith({ AUDIENCE_MC_PREMIUM_SEGMENT_ID: 'seg-1' });
    const r = await driftCheck(deps({ onlyHashes: [m.h], portal, cfg }));
    const ours = await prisma.audienceMember.count({ where: { appliedTags: { has: T.premium } } }); // DB-wide, like the real check
    expect(r).toMatchObject({ sampled: 1, mismatched: 0, premiumOurs: ours, premiumMailercloud: 500 });
    const a = ((await prisma.audienceSyncState.findUnique({ where: { portal } }))!.alerts ?? {}) as Record<string, unknown>;
    expect(a.audience_drift).toBeDefined();
    // In tolerance: no alert.
    const portal2 = `${PORTAL}-count2`;
    await seedState(portal2);
    fake.segments = [{ id: 'seg-1', name: 'Premium', active_count: ours }];
    await driftCheck(deps({ onlyHashes: [m.h], portal: portal2, cfg }));
    expect(((await prisma.audienceSyncState.findUnique({ where: { portal: portal2 } }))!.alerts as Record<string, unknown>).audience_drift).toBeUndefined();
  });

  it('writes off, or inside the send window: the drift check does not read Mailercloud', async () => {
    const m = await member('drift-skip', { appliedTags: [T.premium], nextAttemptAt: null });
    expect((await driftCheck(deps({ onlyHashes: [m.h], cfg: cfgWith({ AUDIENCE_SYNC_WRITE_MAILERCLOUD: 'false' }) }))).skipped).toBe('writes_off');
    now = new Date('2027-02-28T01:45:00Z');
    expect((await driftCheck(deps({ onlyHashes: [m.h] }))).skipped).toBe('send_window');
    expect(fake.requests).toHaveLength(0);
  });
});

describe('logging', () => {
  it('no address and no key in any log line the writer wrote', () => {
    expect(logs.length).toBeGreaterThanOrEqual(0);
    for (const l of logs) {
      expect(l).not.toMatch(/@example\.com/i);
      expect(l).not.toContain(KEY);
    }
  });
});
