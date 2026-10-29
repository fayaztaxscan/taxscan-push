/**
 * CMS audience sync, task 1 (docs/CMS_AUDIENCE_SYNC_DESIGN.md §4, §5, §10.1, §11.1):
 * env parsing (defaults OFF, secret minimums, https-only base URL, empty IP list = reject,
 * two webhook secrets), the `[audience] disabled …` boot marker, the redactor, and the schema.
 */
import { parseAudienceEnv, isCmsIpAllowed, AUDIENCE_SECRET_MIN_LENGTH } from '../lib/env';
import { startAudienceSync } from '../services/audience/boot';
import { prisma } from '../lib/prisma';

const S1 = 'a'.repeat(64);
const S2 = 'b'.repeat(64);
const S3 = 'c'.repeat(64);

describe('parseAudienceEnv — defaults', () => {
  const cfg = parseAudienceEnv({});

  it('every behaviour flag defaults OFF', () => {
    expect(cfg.enabled).toBe(false);
    expect(cfg.writeMailercloud).toBe(false);
    expect(cfg.digestFromCms).toBe(false);
    expect(cfg.resubscribeWrites).toBe(false);
    // AUDIENCE_ERASE_IN_MAILERCLOUD was removed (owner 24 Oct: the CMS erases in Mailercloud).
    expect('eraseInMailercloud' in cfg).toBe(false);
    expect(cfg.erasePathRemovedButSet).toBe(false);
    expect(parseAudienceEnv({ AUDIENCE_ERASE_IN_MAILERCLOUD: 'true' }).erasePathRemovedButSet).toBe(true);
  });

  it('owner settings: Former → Free on (Q1), consent rule exclude_false (Q2)', () => {
    expect(cfg.formerToFree).toBe(true);
    expect(cfg.consentRule).toBe('exclude_false');
  });

  it('thresholds default to the design numbers (Q7)', () => {
    expect(cfg.thresholds).toEqual({
      maxStaleHours: 26,
      premiumDeviationPct: 2,
      maxChangePct: 5,
      maxErasuresPerDay: 20,
      writeRps: 5,
    });
  });

  it('door L host is the contract one (api.taxscan.in), https', () => {
    expect(cfg.cms.allowedHosts).toEqual(['api.taxscan.in']);
    expect(cfg.cms.baseUrl).toBe('https://api.taxscan.in');
  });

  it('no secrets, no IPs, no problems', () => {
    expect(cfg.cms.inboundSecret).toBe('');
    expect(cfg.cms.inboundSecretPrevious).toBe('');
    expect(cfg.cms.pullSecret).toBe('');
    expect(cfg.mailercloud.syncApiKey).toBe('');
    expect(cfg.cms.allowedIps).toEqual([]);
    expect(cfg.problems).toEqual([]);
  });

  it('only the literal "true" switches a flag on', () => {
    const c = parseAudienceEnv({ AUDIENCE_SYNC_ENABLED: 'TRUE', AUDIENCE_SYNC_WRITE_MAILERCLOUD: '1', AUDIENCE_RESUBSCRIBE_WRITES: 'yes' });
    expect(c.enabled).toBe(false);
    expect(c.writeMailercloud).toBe(false);
    expect(c.resubscribeWrites).toBe(false);
  });
});

describe('parseAudienceEnv — secrets', () => {
  it('accepts 32+ character secrets, two webhook secrets for rotation', () => {
    const c = parseAudienceEnv({ CMS_FEED_INBOUND_SECRET: S1, CMS_FEED_INBOUND_SECRET_PREVIOUS: S2, CMS_FEED_PULL_SECRET: S3 });
    expect(c.cms.inboundSecret).toBe(S1);
    expect(c.cms.inboundSecretPrevious).toBe(S2);
    expect(c.cms.pullSecret).toBe(S3);
    expect(c.problems).toEqual([]);
  });

  it.each(['CMS_FEED_INBOUND_SECRET', 'CMS_FEED_INBOUND_SECRET_PREVIOUS', 'CMS_FEED_PULL_SECRET', 'MAILERCLOUD_SYNC_API_KEY'])(
    '%s shorter than 32 → treated as unset, problem names the variable only',
    (name) => {
      const short = 'x'.repeat(AUDIENCE_SECRET_MIN_LENGTH - 1);
      const c = parseAudienceEnv({ [name]: short });
      const all = JSON.stringify(c);
      expect(all).not.toContain(short);
      expect(c.problems).toHaveLength(1);
      expect(c.problems[0]).toContain(name);
    },
  );

  it('the boundary is the literal 32 (pinned without the constant): 31 → unset, 32 → kept', () => {
    // QA: the test above derives its short value from AUDIENCE_SECRET_MIN_LENGTH, so lowering the
    // constant moved the test with it (a mutation to 31 survived). Pin the number itself.
    expect(AUDIENCE_SECRET_MIN_LENGTH).toBe(32);
    const c31 = parseAudienceEnv({ CMS_FEED_INBOUND_SECRET: 'k'.repeat(31) });
    expect(c31.cms.inboundSecret).toBe('');
    expect(c31.problems.join()).toMatch(/CMS_FEED_INBOUND_SECRET/);
    // Surrounding whitespace does not count toward the length.
    expect(parseAudienceEnv({ CMS_FEED_INBOUND_SECRET: ` ${'k'.repeat(31)}\n` }).cms.inboundSecret).toBe('');
    expect(parseAudienceEnv({ CMS_FEED_INBOUND_SECRET: 'k'.repeat(32) }).cms.inboundSecret).toHaveLength(32);
  });

  it('exactly 32 characters is accepted', () => {
    const c = parseAudienceEnv({ CMS_FEED_INBOUND_SECRET: 'k'.repeat(32) });
    expect(c.cms.inboundSecret).toHaveLength(32);
    expect(c.problems).toEqual([]);
  });

  it('the list secret must differ from the webhook secrets (one secret per door)', () => {
    expect(parseAudienceEnv({ CMS_FEED_INBOUND_SECRET: S1, CMS_FEED_PULL_SECRET: S1 }).problems.join()).toMatch(/one secret per door/);
    expect(parseAudienceEnv({ CMS_FEED_INBOUND_SECRET_PREVIOUS: S1, CMS_FEED_PULL_SECRET: S1 }).problems.join()).toMatch(/one secret per door/);
  });
});

describe('parseAudienceEnv — CMS base URL', () => {
  it.each([
    ['http://api.taxscan.in', /must be https/],
    ['ftp://api.taxscan.in', /must be https/],
    ['not a url', /not a valid URL/],
    ['https://evil.example.com', /not in CMS_FEED_ALLOWED_HOSTS/],
    ['https://user:pw@api.taxscan.in', /credentials/],
    ['https://api.taxscan.in/?x=1', /query/],
  ])('%s → refused (baseUrl empty)', (url, why) => {
    const c = parseAudienceEnv({ CMS_FEED_BASE_URL: url });
    expect(c.cms.baseUrl).toBe('');
    expect(c.problems.join()).toMatch(why);
    expect(c.problems.join()).not.toContain('pw@');
  });

  it('a trailing slash is trimmed; an allowed host passes', () => {
    const c = parseAudienceEnv({ CMS_FEED_BASE_URL: 'https://API.taxscan.in/', CMS_FEED_ALLOWED_HOSTS: 'api.taxscan.in' });
    expect(c.cms.baseUrl).toBe('https://api.taxscan.in');
    expect(c.problems).toEqual([]);
  });

  it('a custom host must be on the custom allow-list', () => {
    const c = parseAudienceEnv({ CMS_FEED_BASE_URL: 'https://cms.example.org', CMS_FEED_ALLOWED_HOSTS: 'cms.example.org' });
    expect(c.cms.baseUrl).toBe('https://cms.example.org');
  });
});

describe('parseAudienceEnv — IP fence', () => {
  it('parses IPv4 and IPv6 literals, drops and reports invalid entries', () => {
    const c = parseAudienceEnv({ CMS_FEED_ALLOWED_IPS: '203.0.113.7, 2001:DB8::1 , 10.0.0.0/8, nope' });
    expect(c.cms.allowedIps).toEqual(['203.0.113.7', '2001:db8::1']);
    expect(c.problems.join()).toMatch(/2 invalid entries/);
  });

  it('an EMPTY allow-list rejects everything (never allow-all)', () => {
    expect(isCmsIpAllowed('203.0.113.7', [])).toBe(false);
    expect(isCmsIpAllowed('127.0.0.1', parseAudienceEnv({}).cms.allowedIps)).toBe(false);
    expect(isCmsIpAllowed('203.0.113.7', parseAudienceEnv({ CMS_FEED_ALLOWED_IPS: ' , ' }).cms.allowedIps)).toBe(false);
  });

  it('a listed IP passes (incl. the IPv4-mapped IPv6 form); others and a missing IP fail', () => {
    const ips = ['203.0.113.7', '2001:db8::1'];
    expect(isCmsIpAllowed('203.0.113.7', ips)).toBe(true);
    expect(isCmsIpAllowed('::ffff:203.0.113.7', ips)).toBe(true);
    expect(isCmsIpAllowed('2001:DB8::1', ips)).toBe(true);
    expect(isCmsIpAllowed('203.0.113.8', ips)).toBe(false);
    expect(isCmsIpAllowed('::ffff:203.0.113.8', ips)).toBe(false);
    expect(isCmsIpAllowed(undefined, ips)).toBe(false);
    expect(isCmsIpAllowed('', ips)).toBe(false);
  });
});

describe('parseAudienceEnv — other validation', () => {
  it('an unknown consent rule is a problem', () => {
    expect(parseAudienceEnv({ AUDIENCE_CONSENT_RULE: 'include_all' }).problems.join()).toMatch(/AUDIENCE_CONSENT_RULE/);
  });

  it('DIGEST_AUDIENCE_FROM_CMS with explicit digest tag ids → "set one, not both"', () => {
    const c = parseAudienceEnv({ DIGEST_AUDIENCE_FROM_CMS: 'true', DIGEST_PREMIUM_TAG_IDS: 't1' });
    expect(c.problems.join()).toMatch(/set one, not both/);
    expect(parseAudienceEnv({ DIGEST_PREMIUM_TAG_IDS: 't1' }).problems).toEqual([]);
  });

  it('out-of-range thresholds fall back to the defaults', () => {
    const c = parseAudienceEnv({ AUDIENCE_MAX_CHANGE_PCT: '150', AUDIENCE_PREMIUM_DEVIATION_PCT: '-1', AUDIENCE_WRITE_RPS: 'fast' });
    expect(c.thresholds.maxChangePct).toBe(5);
    expect(c.thresholds.premiumDeviationPct).toBe(2);
    expect(c.thresholds.writeRps).toBe(5);
  });
});

describe('startAudienceSync — boot marker', () => {
  let log: jest.SpyInstance;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  beforeEach(() => {
    log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('flag off → the exact disabled line', () => {
    expect(startAudienceSync(parseAudienceEnv({}))).toBe('disabled');
    expect(log).toHaveBeenCalledWith('[audience] disabled (set AUDIENCE_SYNC_ENABLED=true to start)');
  });

  it('flag on without the webhook secret → config_invalid, variable names only', () => {
    const short = 'z'.repeat(20);
    expect(startAudienceSync(parseAudienceEnv({ AUDIENCE_SYNC_ENABLED: 'true', CMS_FEED_PULL_SECRET: short }))).toBe('config_invalid');
    const line = String(error.mock.calls[0][0]);
    expect(line).toMatch(/^\[audience\] config_invalid/);
    expect(line).toContain('CMS_FEED_INBOUND_SECRET is unset');
    expect(line).not.toContain(short);
  });

  it('flag on, valid, empty IP list → warns that every webhook is rejected', () => {
    expect(startAudienceSync(parseAudienceEnv({ AUDIENCE_SYNC_ENABLED: 'true', CMS_FEED_INBOUND_SECRET: S1 }))).toBe('enabled');
    expect(String(warn.mock.calls[0][0])).toMatch(/CMS_FEED_ALLOWED_IPS is empty/);
    expect(JSON.stringify([log.mock.calls, warn.mock.calls])).not.toContain(S1);
  });
});

describe('redactor knows the audience secrets', () => {
  it('safeErrorLog masks every audience secret', () => {
    const vals = {
      CMS_FEED_INBOUND_SECRET: 'inbound-' + 'q'.repeat(40),
      CMS_FEED_INBOUND_SECRET_PREVIOUS: 'previous-' + 'r'.repeat(40),
      CMS_FEED_PULL_SECRET: 'pull-' + 's'.repeat(40),
      MAILERCLOUD_SYNC_API_KEY: 'mcsync-' + 't'.repeat(40),
    };
    const saved = { ...process.env };
    Object.assign(process.env, vals);
    try {
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { safeErrorLog } = require('../lib/httpErrors') as typeof import('../lib/httpErrors');
        const out = JSON.stringify(safeErrorLog(new Error(`boom ${Object.values(vals).join(' ')}`), { stack: true }));
        for (const v of Object.values(vals)) expect(out).not.toContain(v);
        expect(out).toContain('[secret]');
      });
    } finally {
      process.env = saved;
    }
  });
});

describe('schema (migration 20261024100000_cms_audience_sync)', () => {
  afterAll(() => prisma.$disconnect());

  it('the four new tables exist and are empty-able; EmailSuppression takes a hash-only row', async () => {
    await expect(prisma.cmsAccount.count()).resolves.toEqual(expect.any(Number));
    await expect(prisma.audienceMember.count()).resolves.toEqual(expect.any(Number));
    await expect(prisma.cmsEventReceipt.count()).resolves.toEqual(expect.any(Number));
    await expect(prisma.audienceSyncState.count()).resolves.toEqual(expect.any(Number));
    const hash = 'test-audience-task1-' + Date.now();
    const row = await prisma.emailSuppression.create({
      data: { email: null, emailHash: hash, accountId: '900002', reason: 'UNSUBSCRIBE', source: 'manual' },
    });
    try {
      expect(row.email).toBeNull();
      expect(row.emailHash).toBe(hash);
    } finally {
      await prisma.emailSuppression.delete({ where: { id: row.id } });
    }
  });
});
