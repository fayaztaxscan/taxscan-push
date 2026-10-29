/**
 * CMS audience sync — prep before task 3 (QA findings on tasks 1–2; docs/CMS_AUDIENCE_SYNC_DESIGN.md
 * §4, §6.2, §6.3, §8, §10.1):
 *  1. a backup restore of a hash-only `EmailSuppression` row (null email) never crashes;
 *  2. every suppression write carries `emailHash` (DB trigger + the webhook), one row per person,
 *     and every reader matches on email OR hash OR accountId;
 *  3. the Mailercloud webhook writes suppressions ONLY for newly inserted events;
 *  4. config: problems shown while off, short secrets masked, canonical IPs, port refusal.
 * Fake addresses on reserved TLDs only.
 */
import { createHash, randomBytes } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { parseDigestEnv, parseAudienceEnv, isCmsIpAllowed } from '../lib/env';
import { canonicalIp } from '../lib/clientIp';
import { handleMailercloudWebhook } from '../services/digest/webhook';
import { findSuppressions, isSuppressed, restoreSuppressionRow, suppressionWhere } from '../services/suppression';
import { startAudienceSync } from '../services/audience/boot';
import { redactText } from '../lib/redact';

const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const LOCAL = `prep.${RUN}`;
const CAMP = `prep-camp-${RUN}`;
const ACCT = `prep-acct-${RUN}`;
const addr = (tag: string) => `${LOCAL}.${tag}@example.invalid`;
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
let n = 0;
const camp = () => `${CAMP}-${++n}`;

const cfg = parseDigestEnv({
  DIGEST_ENABLED: 'true',
  DIGEST_WEBHOOKS_ENABLED: 'true',
  MAILERCLOUD_WEBHOOK_TOKEN: randomBytes(32).toString('hex'),
});
const send = (body: unknown, now = new Date()) => handleMailercloudWebhook(body, { cfg, now });

afterAll(async () => {
  await prisma.emailEvent.deleteMany({ where: { mcCampaignId: { startsWith: CAMP } } });
  await prisma.emailSuppression.deleteMany({
    where: { OR: [{ email: { startsWith: LOCAL } }, { accountId: { startsWith: ACCT } }, { source: `prep-${RUN}` }] },
  });
  await prisma.audienceMember.deleteMany({ where: { emailHash: { in: ['m1', 'm2', 'm3'].map((t) => sha(addr(t))) } } });
  await prisma.cmsAccount.deleteMany({ where: { accountId: { startsWith: ACCT } } });
  await prisma.$disconnect();
});

describe('EmailSuppression.emailHash — the trigger', () => {
  it('a plain insert with only an address gets the hash; nulling the address keeps it', async () => {
    const a = addr('trigger');
    const row = await prisma.emailSuppression.create({ data: { email: a, reason: 'MANUAL', source: `prep-${RUN}` } });
    expect(row.emailHash).toBe(sha(a));
    const nulled = await prisma.emailSuppression.update({ where: { id: row.id }, data: { email: null } });
    expect(nulled.email).toBeNull();
    expect(nulled.emailHash).toBe(sha(a));
  });

  it('a wrong hash written next to an address is corrected', async () => {
    const a = addr('wronghash');
    const row = await prisma.emailSuppression.create({ data: { email: a, emailHash: 'f'.repeat(64), reason: 'MANUAL', source: `prep-${RUN}` } });
    expect(row.emailHash).toBe(sha(a));
  });
});

describe('the Mailercloud webhook and emailHash', () => {
  it('writes emailHash on a new suppression', async () => {
    const a = addr('newrow');
    await send({ event: 'unsubscribe', email: a, campaign_id: camp() });
    const row = await prisma.emailSuppression.findUniqueOrThrow({ where: { email: a } });
    expect(row.emailHash).toBe(sha(a));
  });

  it('the same person never becomes two rows: an existing hash-only row is escalated, its address stays null', async () => {
    const a = addr('hashonly');
    await prisma.emailSuppression.create({
      data: { email: null, emailHash: sha(a), accountId: `${ACCT}-ho`, reason: 'UNSUBSCRIBE', source: `prep-${RUN}` },
    });
    await send({ event: 'spam', email: a, campaign_id: camp() });
    const rows = await prisma.emailSuppression.findMany({ where: { emailHash: sha(a) } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: null, reason: 'SPAM', accountId: `${ACCT}-ho` });
    expect(await prisma.emailSuppression.count({ where: { email: a } })).toBe(0);
  });

  it('a replayed old opt-out cannot re-create a lifted suppression (design §6.3)', async () => {
    const a = addr('lifted');
    const ev = { event: 'unsubscribe', email: a, campaign_id: camp() };
    await send(ev, new Date(Date.now() - 60_000));
    expect(await prisma.emailSuppression.count({ where: { email: a } })).toBe(1);
    await prisma.emailSuppression.deleteMany({ where: { email: a } }); // the consent lift
    const r = await send(ev);
    expect(r).toMatchObject({ stored: 0, duplicates: 1 });
    expect(await prisma.emailSuppression.count({ where: { emailHash: sha(a) } })).toBe(0);
  });

  it('a NEW opt-out after a lift does suppress again', async () => {
    const a = addr('relift');
    await send({ event: 'unsubscribe', email: a, campaign_id: camp() });
    await prisma.emailSuppression.deleteMany({ where: { email: a } });
    await send({ event: 'unsubscribe', email: a, campaign_id: camp() });
    expect(await prisma.emailSuppression.count({ where: { email: a } })).toBe(1);
  });

  it('stamps the one live CMS account onto the row and marks the audience member suppressed', async () => {
    const a = addr('m1');
    await prisma.cmsAccount.create({ data: { accountId: `${ACCT}-m1`, seq: 1n, status: 'active', emailHash: sha(a), lastSource: 'webhook' } });
    await prisma.audienceMember.create({ data: { emailHash: sha(a), email: a, desiredRole: 'PREMIUM' } });
    await send({ event: 'unsubscribe', email: a, campaign_id: camp() });
    const row = await prisma.emailSuppression.findUniqueOrThrow({ where: { email: a } });
    expect(row.accountId).toBe(`${ACCT}-m1`);
    const m = await prisma.audienceMember.findUniqueOrThrow({ where: { emailHash: sha(a) } });
    expect(m.suppressed).toBe(true);
    expect(m.nextAttemptAt).not.toBeNull();
  });

  it('does not stamp an account when two live accounts share the address', async () => {
    const a = addr('m2');
    await prisma.cmsAccount.createMany({
      data: [
        { accountId: `${ACCT}-m2a`, seq: 1n, status: 'active', emailHash: sha(a), lastSource: 'webhook' },
        { accountId: `${ACCT}-m2b`, seq: 1n, status: 'free', emailHash: sha(a), lastSource: 'webhook' },
      ],
    });
    await send({ event: 'unsubscribe', email: a, campaign_id: camp() });
    expect((await prisma.emailSuppression.findUniqueOrThrow({ where: { email: a } })).accountId).toBeNull();
  });
});

describe('readers match on email OR emailHash OR accountId', () => {
  it('findSuppressions / isSuppressed', async () => {
    const a = addr('reader');
    const row = await prisma.emailSuppression.create({ data: { email: a, reason: 'UNSUBSCRIBE', source: `prep-${RUN}`, accountId: `${ACCT}-r` } });
    const erased = await prisma.emailSuppression.create({ data: { email: null, emailHash: sha(addr('reader-erased')), reason: 'SPAM', source: `prep-${RUN}` } });
    expect((await findSuppressions(prisma, { email: a.toUpperCase() })).map((r) => r.id)).toEqual([row.id]);
    expect((await findSuppressions(prisma, { emailHash: sha(a) })).map((r) => r.id)).toEqual([row.id]);
    expect((await findSuppressions(prisma, { accountIds: [`${ACCT}-r`] })).map((r) => r.id)).toEqual([row.id]);
    // An erased row (no address) still matches the address by its hash.
    expect(await isSuppressed(prisma, { email: addr('reader-erased') })).toBe(true);
    expect((await findSuppressions(prisma, { emailHash: erased.emailHash })).map((r) => r.id)).toEqual([erased.id]);
    expect(await isSuppressed(prisma, { email: addr('nobody') })).toBe(false);
  });

  it('an empty key matches nothing (never every row)', async () => {
    expect(suppressionWhere({})).toBeNull();
    expect(suppressionWhere({ accountIds: ['', ''] })).toBeNull();
    expect(await isSuppressed(prisma, {})).toBe(false);
    expect(await findSuppressions(prisma, { email: 'not-an-address' })).toEqual([]);
  });
});

describe('restoreSuppressionRow — null email (QA finding 1)', () => {
  const base = (over: Record<string, unknown>) => ({
    reason: 'UNSUBSCRIBE',
    source: `prep-${RUN}`,
    firstSeenAt: new Date('2026-10-01T00:00:00Z'),
    lastSeenAt: new Date('2026-10-02T00:00:00Z'),
    accountId: null,
    ...over,
  });

  it('a hash-only backup row restores into an empty slot, then merges by hash on a re-run', async () => {
    const h = sha(addr('restore-hashonly'));
    const data = base({ id: `prep-r1-${RUN}`, email: null, emailHash: h, accountId: `${ACCT}-r1` });
    expect(await restoreSuppressionRow(prisma, data)).toBe('created');
    expect(await restoreSuppressionRow(prisma, { ...data, id: `prep-r1b-${RUN}`, reason: 'SPAM' })).toBe('merged');
    const rows = await prisma.emailSuppression.findMany({ where: { emailHash: h } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: null, reason: 'SPAM', accountId: `${ACCT}-r1` });
  });

  it('a v2 backup row (address, no hash) onto a live ERASED row: matched by the computed hash, the address is not brought back', async () => {
    const a = addr('restore-erased');
    await prisma.emailSuppression.create({ data: { email: null, emailHash: sha(a), reason: 'HARD_BOUNCE', source: `prep-${RUN}` } });
    expect(await restoreSuppressionRow(prisma, base({ id: `prep-r2-${RUN}`, email: a }))).toBe('merged');
    const rows = await prisma.emailSuppression.findMany({ where: { emailHash: sha(a) } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: null, reason: 'HARD_BOUNCE' });
  });

  it('a v2 backup row (address, no hash) into an empty slot is created with its hash', async () => {
    const a = addr('restore-v2');
    expect(await restoreSuppressionRow(prisma, base({ id: `prep-r3-${RUN}`, email: a }))).toBe('created');
    expect((await prisma.emailSuppression.findUniqueOrThrow({ where: { email: a } })).emailHash).toBe(sha(a));
  });

  it('no address and no hash: falls back to the id, never crashes', async () => {
    const id = `prep-r4-${RUN}`;
    const data = base({ id, email: null, emailHash: null, accountId: `${ACCT}-r4` });
    expect(await restoreSuppressionRow(prisma, data)).toBe('created');
    expect(await restoreSuppressionRow(prisma, { ...data, reason: 'MANUAL' })).toBe('merged');
    expect(await prisma.emailSuppression.findUniqueOrThrow({ where: { id } })).toMatchObject({ reason: 'MANUAL', accountId: `${ACCT}-r4` });
  });

  it('merging never weakens and fills a missing accountId only', async () => {
    const a = addr('restore-merge');
    await prisma.emailSuppression.create({ data: { email: a, reason: 'SPAM', source: `prep-${RUN}`, lastSeenAt: new Date('2026-10-20T00:00:00Z') } });
    await restoreSuppressionRow(prisma, base({ id: `prep-r5-${RUN}`, email: a, accountId: `${ACCT}-r5` }));
    const row = await prisma.emailSuppression.findUniqueOrThrow({ where: { email: a } });
    expect(row).toMatchObject({ reason: 'SPAM', accountId: `${ACCT}-r5` });
    expect(row.lastSeenAt.toISOString()).toBe('2026-10-20T00:00:00.000Z');
  });
});

describe('config (QA finding 4)', () => {
  it('problems are printed while the sync is OFF, by variable name only', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const short = 'shortsecret-123';
    try {
      expect(startAudienceSync(parseAudienceEnv({ CMS_FEED_PULL_SECRET: short, CMS_FEED_ALLOWED_IPS: '10.0.0.0/8' }))).toBe('disabled');
      const out = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(out).toMatch(/\[audience\] config problems \(sync is off\): .*CMS_FEED_PULL_SECRET.*CMS_FEED_ALLOWED_IPS/);
      expect(out).not.toContain(short);
      expect(out).not.toContain('10.0.0.0');
      warn.mockClear();
      startAudienceSync(parseAudienceEnv({}));
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });

  it('a too-short secret still in the environment is masked by logSecrets()', () => {
    const short = 'short-but-secret-value';
    const prev = process.env.CMS_FEED_INBOUND_SECRET;
    process.env.CMS_FEED_INBOUND_SECRET = short;
    try {
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
        const { logSecrets } = require('../lib/httpErrors') as typeof import('../lib/httpErrors');
        expect(logSecrets()).toContain(short);
        expect(redactText(`boom ${short} boom`, logSecrets())).toBe('boom [secret] boom');
      });
    } finally {
      if (prev === undefined) delete process.env.CMS_FEED_INBOUND_SECRET;
      else process.env.CMS_FEED_INBOUND_SECRET = prev;
    }
  });

  it('canonicalIp: IPv6 compression/case, IPv4-mapped forms, refusals', () => {
    expect(canonicalIp('2001:DB8:0:0::1')).toBe('2001:db8::1');
    expect(canonicalIp(' ::ffff:203.0.113.7 ')).toBe('203.0.113.7');
    expect(canonicalIp('::FFFF:CB00:7107')).toBe('203.0.113.7');
    expect(canonicalIp('203.0.113.7')).toBe('203.0.113.7');
    for (const bad of ['10.0.0.0/8', 'fe80::1%en0', '[2001:db8::1]', '203.0.113.7:443', 'cms.example', '', '01.2.3.4', undefined, null]) {
      expect(canonicalIp(bad as string)).toBeNull();
    }
  });

  it('allow-list entries are compared in canonical form, still fail-closed', () => {
    const ips = parseAudienceEnv({ CMS_FEED_ALLOWED_IPS: '2001:0DB8:0000::0001, ::ffff:198.51.100.4' }).cms.allowedIps;
    expect(ips).toEqual(['2001:db8::1', '198.51.100.4']);
    expect(isCmsIpAllowed('2001:db8::1', ips)).toBe(true);
    expect(isCmsIpAllowed('2001:DB8:0:0:0:0:0:1', ips)).toBe(true);
    expect(isCmsIpAllowed('198.51.100.4', ips)).toBe(true);
    expect(isCmsIpAllowed('::ffff:c633:6404', ips)).toBe(true);
    expect(isCmsIpAllowed('2001:db8::2', ips)).toBe(false);
    expect(isCmsIpAllowed('fe80::1%en0', ['fe80::1'])).toBe(false);
    expect(isCmsIpAllowed('198.51.100.4', [])).toBe(false);
    // A hand-built list in a non-canonical form still matches (both sides are canonicalised).
    expect(isCmsIpAllowed('2001:db8::1', ['2001:DB8::0:1'])).toBe(true);
  });

  it('CMS_FEED_BASE_URL: a non-default port is refused unless explicitly allowed', () => {
    const bad = parseAudienceEnv({ CMS_FEED_BASE_URL: 'https://api.taxscan.in:8443' });
    expect(bad.cms.baseUrl).toBe('');
    expect(bad.problems.join(';')).toMatch(/CMS_FEED_BASE_URL has a non-default port/);
    expect(bad.problems.join(';')).not.toContain('8443');
    const ok = parseAudienceEnv({ CMS_FEED_BASE_URL: 'https://api.taxscan.in:8443', CMS_FEED_ALLOW_CUSTOM_PORT: 'true' });
    expect(ok.cms.baseUrl).toBe('https://api.taxscan.in:8443');
    expect(ok.problems).toEqual([]);
    expect(parseAudienceEnv({ CMS_FEED_BASE_URL: 'https://api.taxscan.in:443' }).cms.baseUrl).toBe('https://api.taxscan.in');
    expect(parseAudienceEnv({ CMS_FEED_BASE_URL: 'https://api.taxscan.in:8443', CMS_FEED_ALLOW_CUSTOM_PORT: 'yes' }).cms.baseUrl).toBe('');
  });
});
