import { randomBytes } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { parseAudienceEnv, parseNoticesEnv } from '../lib/env';
import { emailHash } from '../services/digest/webhook';
import { audienceCard } from '../services/audience/adminView';
import {
  NONCE_TTL_MS,
  NOTICES_MAX_FULL_AGE_MS,
  claimNonce,
  digestNoticeList,
  noticeCounts,
  noticesBootLine,
  noticesEtag,
  noticesNotReady,
} from '../services/audience/notices';

/**
 * Brief 2026-11-09-digest-notice-list, acceptance 1, 2 and the list's building blocks: `digestNoticeList` (the single definition),
 * its ETag and counts, the freshness rule behind the door's 503, the single-use nonce store, the env section and the Audience card's
 * `notices` field. Every account lives on a unique `test-notices-*` portal with run-unique addresses, so parallel test files never
 * share rows. No Mailercloud or CMS call. No address ever appears in a result.
 */
const logs: string[] = [];
jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
jest.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
jest.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));

const RUN = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const P = `nt${RUN}-`;
const PORTAL = `test-notices-${RUN}`;
const NOW = new Date('2027-03-01T10:00:00Z');
const hashes = new Set<string>();

type Seed = {
  status?: string;
  deletedAt?: Date | null;
  erasedAt?: Date | null;
  outOfScopeAt?: Date | null;
  withheld?: boolean; // no address on file (emailHash null)
  role?: string | null; // AudienceMember.desiredRole; null = no member row
  noMarketing?: boolean;
  fatal?: boolean;
  /** Suppression rows: by address hash, by account id only, or both (two rows). */
  byHash?: string;
  byAccount?: string;
  portal?: string;
  /** Share an address with another seed (same hash, a different account). */
  shareWith?: { email: string };
};

/** One CMS account (and, unless `role` is null, its audience member and suppressions). Returns the account id and the address. */
async function seed(key: string, o: Seed = {}): Promise<{ accountId: string; email: string }> {
  const email = o.shareWith?.email ?? `${key}.${RUN}@example.org`;
  const h = emailHash(email);
  hashes.add(h);
  const accountId = `${P}${key}`;
  await prisma.cmsAccount.create({
    data: {
      accountId,
      portal: o.portal ?? PORTAL,
      seq: 1n,
      status: o.status ?? 'active',
      plan: 'premium_1y',
      emailHash: o.withheld ? null : h,
      deletedAt: o.deletedAt ?? null,
      erasedAt: o.erasedAt ?? null,
      outOfScopeAt: o.outOfScopeAt ?? null,
      lastSource: 'pull_full',
    },
  });
  if (o.role !== null && !o.shareWith) {
    await prisma.audienceMember.create({
      data: { emailHash: h, email, desiredRole: o.role ?? 'PREMIUM', noMarketing: o.noMarketing ?? false, lastErrorKind: o.fatal ? 'FATAL' : null },
    });
  }
  if (o.byHash) await prisma.emailSuppression.upsert({ where: { emailHash: h }, create: { email, emailHash: h, reason: o.byHash, source: 'mailercloud_webhook' }, update: {} });
  if (o.byAccount) await prisma.emailSuppression.create({ data: { accountId, reason: o.byAccount, source: 'cms_feed' } });
  return { accountId, email };
}

const list = () => digestNoticeList(PORTAL, NOW);
const asMap = (items: { accountId: string; reason: string }[]) => Object.fromEntries(items.map((i) => [i.accountId, i.reason]));

async function wipe() {
  const accs = await prisma.cmsAccount.findMany({ where: { accountId: { startsWith: P } }, select: { accountId: true } });
  const hs = [...hashes];
  await prisma.emailSuppression.deleteMany({ where: { OR: [{ accountId: { startsWith: P } }, { emailHash: { in: hs } }] } });
  await prisma.audienceMember.deleteMany({ where: { emailHash: { in: hs } } });
  await prisma.cmsAccount.deleteMany({ where: { accountId: { in: accs.map((a) => a.accountId) } } });
  await prisma.audienceSyncState.deleteMany({ where: { portal: { startsWith: PORTAL } } });
  await prisma.digestSetting.deleteMany({ where: { key: { startsWith: `cms-notices:nonce:nt${RUN}` } } });
}
beforeEach(wipe);
afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
});

/* ================================================================== */
/* 1. The list's rules                                                  */
/* ================================================================== */

describe('1. digestNoticeList: who is on the list, and why', () => {
  it('FATAL → bad_address; HARD_BOUNCE → bad_address; UNSUBSCRIBE → unsubscribed; FATAL + UNSUBSCRIBE → bad_address', async () => {
    const fatal = await seed('fatal', { fatal: true });
    const bounce = await seed('bounce', { byHash: 'HARD_BOUNCE' });
    const unsub = await seed('unsub', { byHash: 'UNSUBSCRIBE' });
    const both = await seed('both', { fatal: true, byHash: 'UNSUBSCRIBE' });
    expect(asMap(await list())).toEqual({
      [fatal.accountId]: 'bad_address',
      [bounce.accountId]: 'bad_address',
      [unsub.accountId]: 'unsubscribed',
      [both.accountId]: 'bad_address',
    });
  });

  it('SPAM, MANUAL and ACCOUNT_DELETED suppressions, consent = false and a non-PREMIUM member are never listed', async () => {
    const spam = await seed('spam', { byHash: 'SPAM' });
    const manual = await seed('manual', { byHash: 'MANUAL' });
    const deletedRow = await seed('delrow', { fatal: true, byAccount: 'ACCOUNT_DELETED' });
    const spamWins = await seed('spamwins', { byHash: 'HARD_BOUNCE', byAccount: 'SPAM' }); // one account, two rows: any excluded reason wins
    const noMkt = await seed('nomkt', { fatal: true, noMarketing: true });
    const former = await seed('former', { fatal: true, role: 'FORMER' });
    const noMember = await seed('nomember', { role: null, byHash: 'HARD_BOUNCE' });
    const ok = await seed('ok', { byHash: 'UNSUBSCRIBE' });
    const got = asMap(await list());
    expect(got).toEqual({ [ok.accountId]: 'unsubscribed' });
    for (const x of [spam, manual, deletedRow, spamWins, noMkt, former, noMember]) expect(got).not.toHaveProperty(x.accountId);
  });

  it('only an `active` account that is live and has an address: free / ended / cancelled / deleted / erased / out of scope / withheld are absent', async () => {
    const live = await seed('live', { fatal: true });
    const absent = [
      await seed('cancelled', { status: 'cancelled', fatal: true }),
      await seed('free', { status: 'free', fatal: true }),
      await seed('ended', { status: 'ended', fatal: true }),
      await seed('deletedst', { status: 'deleted', fatal: true }),
      await seed('deletedat', { deletedAt: NOW, fatal: true }),
      await seed('erased', { erasedAt: NOW, fatal: true }),
      await seed('outscope', { outOfScopeAt: NOW, fatal: true }),
      await seed('withheld', { withheld: true, fatal: true }),
    ];
    const got = asMap(await list());
    expect(Object.keys(got)).toEqual([live.accountId]);
    for (const x of absent) expect(got).not.toHaveProperty(x.accountId);
  });

  it('an active account nobody has a problem with is not listed (no suppression, not FATAL)', async () => {
    await seed('fine');
    expect(await list()).toEqual([]);
  });

  it('a suppression that follows the account by ACCOUNT ID only is counted (an opt-out from an address the account has left)', async () => {
    const bounce = await seed('acc-bounce', { byAccount: 'HARD_BOUNCE' });
    const unsub = await seed('acc-unsub', { byAccount: 'UNSUBSCRIBE' });
    expect(asMap(await list())).toEqual({ [bounce.accountId]: 'bad_address', [unsub.accountId]: 'unsubscribed' });
  });

  it('a row held by BOTH the address and the account counts once; the stronger reason wins', async () => {
    const a = await seed('dup', { byHash: 'UNSUBSCRIBE', byAccount: 'HARD_BOUNCE' });
    const got = await list();
    expect(got).toEqual([{ accountId: a.accountId, reason: 'bad_address' }]);
  });
});

describe('2. accounts and addresses', () => {
  it('two accounts that share one address both appear; each account appears once', async () => {
    const first = await seed('shared-a', { fatal: true });
    const second = await seed('shared-b', { shareWith: { email: first.email } });
    const got = await list();
    expect(got.map((i) => i.accountId).sort()).toEqual([first.accountId, second.accountId].sort());
    expect(new Set(got.map((i) => i.reason))).toEqual(new Set(['bad_address']));
    expect(got).toHaveLength(2);
  });

  it('is sorted by account id, so the same list always has the same ETag; a change gives a new one', async () => {
    const c = await seed('zz-c', { byHash: 'UNSUBSCRIBE' });
    const a = await seed('aa-a', { fatal: true });
    const b = await seed('mm-b', { byHash: 'HARD_BOUNCE' });
    const one = await list();
    expect(one.map((i) => i.accountId)).toEqual([a.accountId, b.accountId, c.accountId]);
    expect(noticesEtag(await list())).toBe(noticesEtag(one));
    expect(noticesEtag(one)).toMatch(/^[0-9a-f]{64}$/);
    await prisma.emailSuppression.update({ where: { emailHash: emailHash(c.email) }, data: { reason: 'HARD_BOUNCE' } }); // one reason changes
    expect(noticesEtag(await list())).not.toBe(noticesEtag(one));
    expect(noticesEtag([])).toBe(noticesEtag([]));
    expect(noticesEtag([])).not.toBe(noticesEtag(one));
  });

  it('reads only its own portal', async () => {
    const mine = await seed('mine', { fatal: true });
    await seed('theirs', { fatal: true, portal: `${PORTAL}-other` });
    expect((await list()).map((i) => i.accountId)).toEqual([mine.accountId]);
    expect(await digestNoticeList(`${PORTAL}-nobody`, NOW)).toEqual([]);
    await prisma.cmsAccount.deleteMany({ where: { portal: `${PORTAL}-other` } });
  });

  it('never carries an address, a hash or anything but an account id and a reason', async () => {
    const a = await seed('shape', { fatal: true, byHash: 'UNSUBSCRIBE' });
    const got = await list();
    expect(got).toEqual([{ accountId: a.accountId, reason: 'bad_address' }]);
    const blob = JSON.stringify(got);
    expect(blob).not.toContain('@');
    expect(blob).not.toContain(emailHash(a.email));
    expect(noticeCounts(got)).toEqual({ badAddress: 1, unsubscribed: 0 });
  });

  it('noticeCounts: bad_address and unsubscribed, by reason', () => {
    expect(noticeCounts([])).toEqual({ badAddress: 0, unsubscribed: 0 });
    expect(
      noticeCounts([
        { accountId: '1', reason: 'bad_address' },
        { accountId: '2', reason: 'unsubscribed' },
        { accountId: '3', reason: 'unsubscribed' },
      ]),
    ).toEqual({ badAddress: 1, unsubscribed: 2 });
  });
});

/* ================================================================== */
/* Freshness: when the door may vouch for the list                      */
/* ================================================================== */

describe('noticesNotReady: a complete full load within 48 h, and the breaker closed', () => {
  const state = (over: Record<string, unknown>) => prisma.audienceSyncState.upsert({ where: { portal: PORTAL }, create: { portal: PORTAL, ...over }, update: over });

  it('no state row, or no complete full load ever → no_full_load', async () => {
    expect(await noticesNotReady(PORTAL, NOW)).toBe('no_full_load');
    await state({ lastFullOkAt: null });
    expect(await noticesNotReady(PORTAL, NOW)).toBe('no_full_load');
  });

  it('a load 47 h old is fresh; 49 h old is not; the boundary is 48 h', async () => {
    await state({ lastFullOkAt: new Date(NOW.getTime() - 47 * 3_600_000) });
    expect(await noticesNotReady(PORTAL, NOW)).toBeNull();
    await state({ lastFullOkAt: new Date(NOW.getTime() - NOTICES_MAX_FULL_AGE_MS) });
    expect(await noticesNotReady(PORTAL, NOW)).toBeNull();
    await state({ lastFullOkAt: new Date(NOW.getTime() - NOTICES_MAX_FULL_AGE_MS - 1000) });
    expect(await noticesNotReady(PORTAL, NOW)).toBe('no_full_load');
  });

  it('an open breaker → breaker_open, even with a fresh load', async () => {
    await state({ lastFullOkAt: new Date(NOW.getTime() - 3_600_000), breakerOpenAt: new Date(NOW.getTime() - 60_000), breakerReason: 'truncated_load' });
    expect(await noticesNotReady(PORTAL, NOW)).toBe('breaker_open');
    await state({ breakerOpenAt: null, breakerReason: null });
    expect(await noticesNotReady(PORTAL, NOW)).toBeNull();
  });
});

/* ================================================================== */
/* The nonce store                                                      */
/* ================================================================== */

describe('claimNonce: single use for 10 minutes', () => {
  const nonce = () => `nt${RUN}${randomBytes(8).toString('hex')}`.slice(0, 32).padEnd(32, '0');

  it('the first claim wins, a repeat inside 10 minutes loses, a different nonce is independent', async () => {
    const n = nonce();
    expect(await claimNonce(n, NOW)).toBe(true);
    expect(await claimNonce(n, NOW)).toBe(false);
    expect(await claimNonce(n, new Date(NOW.getTime() + NONCE_TTL_MS - 1000))).toBe(false);
    expect(await claimNonce(nonce(), NOW)).toBe(true);
  });

  it('after 10 minutes the nonce is free again (the row is swept)', async () => {
    const n = nonce();
    expect(await claimNonce(n, NOW)).toBe(true);
    expect(await claimNonce(n, new Date(NOW.getTime() + NONCE_TTL_MS + 1000))).toBe(true);
  });

  it('five concurrent claims of one nonce: exactly one wins', async () => {
    const n = nonce();
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => claimNonce(n, NOW)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

/* ================================================================== */
/* Env + boot line                                                      */
/* ================================================================== */

describe('the door N environment', () => {
  const SECRET = 'n'.repeat(48);

  it('off by default; on only with DIGEST_NOTICES_ENABLED=true; a secret under 32 characters counts as unset (named, never echoed)', () => {
    expect(parseNoticesEnv({})).toEqual({ enabled: false, secret: '', secretPrevious: '', problems: [] });
    expect(parseNoticesEnv({ DIGEST_NOTICES_ENABLED: 'yes' }).enabled).toBe(false);
    const on = parseNoticesEnv({ DIGEST_NOTICES_ENABLED: 'true', CMS_FEED_NOTICES_SECRET: SECRET, CMS_FEED_NOTICES_SECRET_PREVIOUS: 'p'.repeat(40) });
    expect(on).toMatchObject({ enabled: true, secret: SECRET, secretPrevious: 'p'.repeat(40), problems: [] });
    const short = parseNoticesEnv({ CMS_FEED_NOTICES_SECRET: 'tooshort' });
    expect(short.secret).toBe('');
    expect(short.problems).toEqual(['CMS_FEED_NOTICES_SECRET is shorter than 32 characters (treated as unset)']);
    expect(JSON.stringify(short)).not.toContain('tooshort');
  });

  it('one secret per door: the same value as any other CMS door\'s secret is a named problem', () => {
    for (const other of ['CMS_FEED_PULL_SECRET', 'CMS_FEED_INBOUND_SECRET', 'CMS_FEED_INBOUND_SECRET_PREVIOUS', 'CMS_FEED_VIEWS_SECRET']) {
      const r = parseNoticesEnv({ CMS_FEED_NOTICES_SECRET: SECRET, [other]: SECRET });
      expect(r.problems).toEqual(['CMS_FEED_NOTICES_SECRET must differ from the other door secrets (one secret per door)']);
    }
    expect(parseNoticesEnv({ CMS_FEED_NOTICES_SECRET: SECRET, CMS_FEED_PULL_SECRET: 'q'.repeat(48) }).problems).toEqual([]);
  });

  it('the boot line says on / off and any fault by name, never a value', () => {
    expect(noticesBootLine({ enabled: false, secret: '', problems: [] }, [])).toBe('[audience] digest notices off (set DIGEST_NOTICES_ENABLED=true to answer the CMS)');
    expect(noticesBootLine({ enabled: true, secret: SECRET, problems: [] }, ['148.113.0.114'])).toBe('[audience] digest notices on');
    const line = noticesBootLine({ enabled: true, secret: '', problems: [] }, []);
    expect(line).toContain('CMS_FEED_NOTICES_SECRET is unset');
    expect(line).toContain('CMS_FEED_ALLOWED_IPS is empty');
    expect(noticesBootLine({ enabled: true, secret: SECRET, problems: [] }, ['148.113.0.114'])).not.toContain(SECRET);
  });
});

/* ================================================================== */
/* The Audience card                                                    */
/* ================================================================== */

describe('the Audience card carries the notice counts (ADMIN only)', () => {
  const cfg = parseAudienceEnv({ AUDIENCE_SYNC_ENABLED: 'true' });

  it('ADMIN: notices { enabled, ready, badAddress, unsubscribed, asOf }; PUBLISHER: no such field', async () => {
    await seed('card-bad', { fatal: true });
    await seed('card-unsub', { byHash: 'UNSUBSCRIBE' });
    await seed('card-unsub2', { byHash: 'UNSUBSCRIBE' });
    const admin = (await audienceCard(PORTAL, 'ADMIN', NOW, cfg)) as { notices?: Record<string, unknown> };
    expect(admin.notices).toEqual({ enabled: false, ready: false, badAddress: 1, unsubscribed: 2, asOf: NOW.toISOString() });
    await prisma.audienceSyncState.upsert({ where: { portal: PORTAL }, create: { portal: PORTAL, lastFullOkAt: new Date(NOW.getTime() - 3_600_000) }, update: { lastFullOkAt: new Date(NOW.getTime() - 3_600_000) } });
    const ready = (await audienceCard(PORTAL, 'ADMIN', NOW, cfg)) as { notices?: { ready: boolean } };
    expect(ready.notices?.ready).toBe(true);
    const pub = (await audienceCard(PORTAL, 'PUBLISHER', NOW, cfg)) as Record<string, unknown>;
    expect(Object.keys(pub)).not.toContain('notices');
    expect(JSON.stringify(admin)).not.toContain('@');
  });
});
