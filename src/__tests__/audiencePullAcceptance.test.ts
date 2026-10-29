/**
 * CMS audience sync, task 5 — the acceptance items audiencePull.test.ts does not pin
 * (brief 2026-10-29-audience-pull-writer, tests 1, 2, 3, 5): a feed that never ends, absences counting
 * toward the change cap, the cap as a percentage (6 % opens, 4 % writes), 429 retried, the 30 s timeout.
 */
import { createHash } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { parseAudienceEnv, type AudienceEnv } from '../lib/env';
import { FakeCms, type ListRow } from './audienceFakeCms';
import { CmsListClient, CMS_TIMEOUT_MS } from '../services/audience/cmsClient';
import { runPull, type PullDeps } from '../services/audience/pull';
import { resumeBreaker, changeLimit } from '../services/audience/breaker';

jest.spyOn(console, 'log').mockImplementation(() => undefined);
jest.spyOn(console, 'warn').mockImplementation(() => undefined);
jest.spyOn(console, 'error').mockImplementation(() => undefined);

const RUN = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const P = `pa${RUN}-`;
const PORTAL = `test-audience-accept-${RUN}`;
const SECRET = 'p'.repeat(40) + RUN.slice(0, 8);
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const hashes = new Set<string>();
const addr = (local: string) => {
  const e = `${local}.${RUN}@example.com`;
  hashes.add(sha(e));
  return e;
};
const cfg: AudienceEnv = parseAudienceEnv({ AUDIENCE_SYNC_ENABLED: 'true' });

let fake: FakeCms;
let base: string;
const client = (over: Partial<ConstructorParameters<typeof CmsListClient>[0]> = {}) =>
  new CmsListClient({ baseUrl: base, secret: SECRET, allowedHosts: ['127.0.0.1'], allowLoopbackHttpForTests: true, sleep: () => Promise.resolve(), ...over });
let clock = Date.parse('2027-02-11T00:00:00Z');
const tick = (min = 1) => new Date((clock += min * 60_000));
const deps = (portal: string, over: Partial<PullDeps> = {}): PullDeps => ({ client: client(), cfg, portal, pageLimit: 50, sendAlerts: false, now: () => tick(), ...over });
const account = (id: string) => prisma.cmsAccount.findUnique({ where: { accountId: id } });

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
const premium = (id: string, seq = 1) =>
  row(id, { seq, email: addr(id), name: 'X', plan: 'premium_1y', status: 'active', period_start: '2026-10-22', period_end: '2027-10-21', updated_at: tick().toISOString() });

beforeAll(async () => {
  fake = new FakeCms([SECRET]);
  base = await fake.start();
});

beforeEach(() => fake.resetFaults());

afterAll(async () => {
  await fake.stop();
  const hs = [...hashes];
  await prisma.emailSuppression.deleteMany({ where: { OR: [{ accountId: { startsWith: P } }, { emailHash: { in: hs } }] } });
  await prisma.audienceMember.deleteMany({ where: { OR: [{ emailHash: { in: hs } }, { mcState: `seed-${RUN}` }] } });
  await prisma.cmsAccount.deleteMany({ where: { accountId: { startsWith: P } } });
  await prisma.audienceSyncState.deleteMany({ where: { portal: { startsWith: PORTAL } } });
  await prisma.$disconnect();
});

describe('acceptance 1 — a feed that never ends is an incomplete load', () => {
  it('the last page still has next_cursor: rows applied, NO absence, truncated_load + audience_full_incomplete', async () => {
    const portal = `${PORTAL}-endless`;
    const live = [row('e1'), row('e2'), row('e3')];
    fake.setRows(live);
    await runPull('full', deps(portal));
    await resumeBreaker(portal, null, tick());
    expect((await account(`${P}e3`))!.outOfScopeAt).toBeNull();

    fake.setRows([row('e1', { seq: 2 }), row('e2', { seq: 2 })]); // e3 would be absent from a complete load
    fake.lastPageKeepsCursor = true;
    const r = await runPull('full', deps(portal));
    expect(r).toMatchObject({ complete: false, incompleteReason: 'cursor_loop', absent: 0, breakerOpened: 'truncated_load' });
    expect((await account(`${P}e1`))!.seq).toBe(2n); // the rows it read are applied
    expect((await account(`${P}e3`))!.outOfScopeAt).toBeNull();
    const st = await prisma.audienceSyncState.findUnique({ where: { portal } });
    expect(st!.lastFullRowCount).toBe(3); // a load that is not complete never replaces the baseline
    expect((st!.alerts as Record<string, { reason?: string }>).audience_full_incomplete).toMatchObject({ reason: 'cursor_loop' });
  });
});

describe('acceptance 2 — absences count toward the change cap', () => {
  it('a COMPLETE load (≥ 90 % of the last) that drops 101 Premium accounts: they go out of scope AND the cap opens the breaker', async () => {
    const portal = `${PORTAL}-absent`;
    const ids = Array.from({ length: 1100 }, (_, i) => `ab${i}`);
    fake.setRows(ids.map((id) => premium(id)));
    const first = await runPull('full', deps(portal, { pageLimit: 500 }));
    expect(first).toMatchObject({ complete: true, rows: 1100 });
    await resumeBreaker(portal, null, tick()); // the first_load review

    // 999 / 1100 = 90.8 % — complete; 101 absent. Their roles go to NONE: 101 > max(5 % of mailed, 100).
    fake.setRows(ids.slice(101).map((id) => premium(id)));
    const r = await runPull('full', deps(portal, { pageLimit: 500 }));
    expect(r).toMatchObject({ complete: true, rows: 999, absent: 101, roleChanges: 101 });
    expect(r.breakerOpened).not.toBeNull();
    expect((await account(`${P}ab0`))!.outOfScopeAt).not.toBeNull();
    expect((await account(`${P}ab500`))!.outOfScopeAt).toBeNull();
    // Role NONE with nothing applied in Mailercloud: the row is gone (it exists only while it holds something).
    expect(await prisma.audienceMember.findUnique({ where: { emailHash: sha(addr('ab0')) } })).toBeNull();
    expect(await prisma.audienceMember.findUnique({ where: { emailHash: sha(addr('ab500')) } })).toMatchObject({ desiredRole: 'PREMIUM' });
    expect((await prisma.audienceSyncState.findUnique({ where: { portal } }))!.breakerOpenAt).not.toBeNull();
  }, 120_000);
});

describe('acceptance 3 — the change cap as a percentage', () => {
  it('limit = max(5 % of mailed members, 100): 3,000 mailed → 150; a 6 % change (180) opens it, a 4 % change (120) is written', async () => {
    const portal = `${PORTAL}-pct`;
    expect(changeLimit(3000, cfg)).toBe(150);
    // 3,000 mailed members already in the table (Premium, nothing due) — the base the cap is a % of.
    // Seeded with this run's marker and cleaned afterwards; the build DB holds nothing else.
    const seeded = await prisma.audienceMember.count({ where: { desiredRole: { not: 'NONE' } } });
    const need = Math.max(0, 3000 - seeded);
    await prisma.$executeRaw`
      INSERT INTO "AudienceMember" ("emailHash","desiredRole","mcState","updatedAt")
      SELECT md5(${RUN} || g::text) || md5(g::text || ${RUN}), 'PREMIUM', ${`seed-${RUN}`}, now()
        FROM generate_series(1, ${need}::int) g`;
    fake.setRows([row('pc0')]);
    await runPull('full', deps(portal));
    await resumeBreaker(portal, null, tick());

    const mailed = await prisma.audienceMember.count({ where: { desiredRole: { not: 'NONE' } } });
    const cap = changeLimit(mailed, cfg);
    expect(cap).toBeGreaterThanOrEqual(150);
    const four = Math.floor((mailed * 4) / 100);
    const six = Math.ceil((mailed * 6) / 100);
    expect(four).toBeLessThanOrEqual(cap);
    expect(six).toBeGreaterThan(cap);

    fake.asOf = tick().toISOString();
    fake.setRows(Array.from({ length: four }, (_, i) => premium(`pf${i}`)));
    const ok = await runPull('incremental', deps(portal, { pageLimit: 500 }));
    expect(ok).toMatchObject({ roleChanges: four, breakerOpened: null });
    expect((await prisma.audienceSyncState.findUnique({ where: { portal } }))!.breakerOpenAt).toBeNull();

    fake.setRows(Array.from({ length: six }, (_, i) => premium(`pg${i}`)));
    const big = await runPull('incremental', deps(portal, { pageLimit: 500 }));
    expect(big).toMatchObject({ roleChanges: six, breakerOpened: 'change_too_large' });
    expect((await prisma.audienceSyncState.findUnique({ where: { portal } }))!.breakerOpenAt).not.toBeNull();
  });
});

describe('acceptance 5 — the pull client', () => {
  it('429 is retried (re-signed each time) and then succeeds', async () => {
    fake.setRows([row('t1')]);
    fake.failPage.set(0, { status: 429, times: 2 });
    const before = fake.requests.length;
    const page = await client().fetchPage({ limit: 5 });
    expect(page.rows).toHaveLength(1);
    expect(fake.requests.length - before).toBe(3);
  });

  it('times out after 30 s (the constant) and a hung CMS is RETRYABLE, not FATAL', async () => {
    expect(CMS_TIMEOUT_MS).toBe(30_000);
    fake.setRows([row('t2')]);
    fake.delayMs = 400;
    await expect(client({ timeoutMs: 50, maxRetries: 0 }).fetchPage({ limit: 5 })).rejects.toMatchObject({ kind: 'RETRYABLE', message: expect.stringContaining('no reply within 50 ms') });
  });
});
