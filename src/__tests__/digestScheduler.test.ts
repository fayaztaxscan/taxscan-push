import { prisma } from '../lib/prisma';
import { parseDigestEnv, type DigestEnv } from '../lib/env';
import { startDigestScheduler, validateDigestSchedule } from '../services/digest/scheduler';

/**
 * Email digest task 1 (docs/EMAIL_DIGEST_DESIGN.md §13): flags, the boot log
 * paths, the quiet-hours refusal and the one-run-per-day constraint. The
 * scheduler is a skeleton — nothing here can send or call a provider.
 */

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
const QUIET = { start: '23:00', end: '07:00' };

/** Defaults plus overrides, built through the real parser. */
function digestCfg(over: NodeJS.ProcessEnv = {}): DigestEnv {
  return parseDigestEnv(over);
}

describe('parseDigestEnv defaults', () => {
  it('every flag is off except approval, and the times are the owner-approved IST ones', () => {
    const d = parseDigestEnv({});
    expect(d.enabled).toBe(false);
    expect(d.sendLive).toBe(false);
    expect(d.webhooksEnabled).toBe(false);
    expect(d.approvalRequired).toBe(true);
    expect(d.sendAt).toBe('07:30');
    expect(d.buildLeadMinutes).toBe(60);
    expect(d.cutoff).toBe('17:00');
    expect([d.maxItems, d.minItems, d.rollforwardItems]).toEqual([15, 5, 3]);
    expect(d.sanityMaxCandidates).toBe(150);
    expect([d.maxHtmlKb, d.htmlWarnKb]).toEqual([90, 80]);
    expect([d.htmlRetentionDays, d.emailEventRetentionDays]).toEqual([30, 90]);
    expect(d.mailercloud.apiKey).toBe('');
    expect(d.audiences.free.excludeListIds).toEqual([]);
  });

  it('only the literal "true" turns a flag on, and only "false" turns approval off', () => {
    const d = parseDigestEnv({
      DIGEST_ENABLED: '1',
      DIGEST_SEND_LIVE: 'yes',
      DIGEST_WEBHOOKS_ENABLED: 'TRUE',
      DIGEST_APPROVAL_REQUIRED: 'no',
    });
    expect([d.enabled, d.sendLive, d.webhooksEnabled]).toEqual([false, false, false]);
    expect(d.approvalRequired).toBe(true);
    expect(parseDigestEnv({ DIGEST_APPROVAL_REQUIRED: 'false' }).approvalRequired).toBe(false);
  });

  it('splits id lists and falls back on invalid numbers', () => {
    const d = parseDigestEnv({
      DIGEST_FREE_EXCLUDE_LIST_IDS: ' a1, ,b2 ',
      DIGEST_MAX_ITEMS: 'lots',
      DIGEST_MIN_ITEMS: '-4',
    });
    expect(d.audiences.free.excludeListIds).toEqual(['a1', 'b2']);
    expect(d.maxItems).toBe(15);
    expect(d.minItems).toBe(5);
  });
});

describe('validateDigestSchedule', () => {
  it('accepts the defaults and derives the 06:30 build', () => {
    const r = validateDigestSchedule(digestCfg(), QUIET);
    expect(r).toEqual({ ok: true, schedule: { buildAt: '06:30', sendAt: '07:30', cutoff: '17:00' } });
  });

  it('refuses a send time inside quiet hours (06:59) and allows the first minute after (07:00)', () => {
    const blocked = validateDigestSchedule(digestCfg({ DIGEST_SEND_AT: '06:59' }), QUIET);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toMatch(/quiet hours/);
    expect(validateDigestSchedule(digestCfg({ DIGEST_SEND_AT: '07:00' }), QUIET).ok).toBe(true);
    // Late evening is quiet too (wrap-around window).
    expect(validateDigestSchedule(digestCfg({ DIGEST_SEND_AT: '23:00' }), QUIET).ok).toBe(false);
  });

  it('refuses a send time at or after the cut-off, a malformed time, and a build before midnight', () => {
    expect(validateDigestSchedule(digestCfg({ DIGEST_SEND_AT: '17:00' }), QUIET).ok).toBe(false);
    expect(validateDigestSchedule(digestCfg({ DIGEST_SEND_AT: '16:59' }), QUIET).ok).toBe(true);
    expect(validateDigestSchedule(digestCfg({ DIGEST_SEND_AT: '7.30' }), QUIET).ok).toBe(false);
    expect(validateDigestSchedule(digestCfg({ DIGEST_CUTOFF: '25:00' }), QUIET).ok).toBe(false);
    expect(validateDigestSchedule(digestCfg({ DIGEST_BUILD_LEAD_MINUTES: '500' }), QUIET).ok).toBe(false);
  });
});

describe('startDigestScheduler boot paths', () => {
  let log: jest.SpyInstance;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  const allOutput = () =>
    [...log.mock.calls, ...warn.mock.calls, ...error.mock.calls].map((c) => c.join(' ')).join('\n');

  beforeEach(() => {
    log = jest.spyOn(console, 'log').mockImplementation(() => {});
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    error = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('flags off → logs the disabled marker', () => {
    expect(startDigestScheduler(digestCfg())).toBe('disabled');
    expect(log).toHaveBeenCalledWith('[digest] disabled (set DIGEST_ENABLED=true to start)');
  });

  it('enabled without MAILERCLOUD_API_KEY → "not configured", no throw', () => {
    expect(() => startDigestScheduler(digestCfg({ DIGEST_ENABLED: 'true' }))).not.toThrow();
    expect(startDigestScheduler(digestCfg({ DIGEST_ENABLED: 'true' }))).toBe('not_configured');
    expect(warn.mock.calls[0][0]).toMatch(/\[digest\] not configured/);
  });

  it('enabled + configured → starts the 1-minute IST tick and logs the schedule, never the key', () => {
    const key = `mc-secret-${uniq()}`;
    const started: { expression: string; timezone: string }[] = [];
    const state = startDigestScheduler(
      digestCfg({ DIGEST_ENABLED: 'true', MAILERCLOUD_API_KEY: key, DIGEST_TEST_RECIPIENTS: 'qa@example.com' }),
      undefined,
      // Never a real cron in a test: record what would be scheduled.
      { startCron: (expression, _fn, timezone) => (started.push({ expression, timezone }), { stop: () => undefined }) },
    );
    expect(state).toBe('ready');
    expect(started).toEqual([{ expression: '* * * * *', timezone: 'Asia/Kolkata' }]);
    const line = log.mock.calls[0][0] as string;
    expect(line).toMatch(/build=06:30 send=07:30 cutoff=17:00 IST/);
    expect(line).toMatch(/approval=required sendLive=off webhooks=off/);
    expect(allOutput()).not.toContain(key);
    expect(allOutput()).not.toContain('@');
  });

  it('a malformed QUIET_HOURS_* value disables the digest instead of crashing boot', () => {
    let state: string | undefined;
    expect(() => {
      state = startDigestScheduler(digestCfg({ DIGEST_ENABLED: 'true' }), { start: '11pm', end: '07:00' });
    }).not.toThrow();
    expect(state).toBe('config_invalid');
  });

  it('a send time inside quiet hours is refused at boot and the scheduler is not started', () => {
    const started: string[] = [];
    const state = startDigestScheduler(
      digestCfg({ DIGEST_ENABLED: 'true', MAILERCLOUD_API_KEY: 'k', DIGEST_SEND_AT: '06:00' }),
      undefined,
      { startCron: (e) => (started.push(e), { stop: () => undefined }) },
    );
    expect(started).toEqual([]);
    expect(state).toBe('config_invalid');
    expect(error.mock.calls[0][0]).toMatch(/\[digest\] config_invalid .*quiet hours/);
    expect(log).not.toHaveBeenCalled();
  });
});

describe('DigestRun one-per-day constraint', () => {
  const portal = `test-digest-${uniq()}`;

  afterAll(async () => {
    await prisma.digestRun.deleteMany({ where: { portal } });
    await prisma.$disconnect();
  });

  it('rejects a second run for the same (portal, runDate) and allows the next day', async () => {
    const runDate = new Date('2026-10-23T00:00:00Z');
    await prisma.digestRun.create({ data: { portal, runDate, windowStart: new Date() } });
    await expect(
      prisma.digestRun.create({ data: { portal, runDate, windowStart: new Date() } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await expect(
      prisma.digestRun.create({ data: { portal, runDate: new Date('2026-10-24T00:00:00Z'), windowStart: new Date() } }),
    ).resolves.toBeTruthy();
    expect(await prisma.digestRun.count({ where: { portal } })).toBe(2);
  });

  it('allows one send per audience per run, cascading with the run', async () => {
    const run = await prisma.digestRun.create({
      data: { portal, runDate: new Date('2026-10-25T00:00:00Z'), windowStart: new Date() },
    });
    const send = (audience: 'FREE' | 'PREMIUM', name: string) =>
      prisma.digestSend.create({
        data: { runId: run.id, audience, subject: 's', preheader: 'p', htmlBytes: 0, mcCampaignName: name, sendAfter: new Date() },
      });
    await send('FREE', `TS-DIGEST-${uniq()}-FREE`);
    await send('PREMIUM', `TS-DIGEST-${uniq()}-PREMIUM`);
    await expect(send('FREE', `TS-DIGEST-${uniq()}-FREE2`)).rejects.toMatchObject({ code: 'P2002' });
    await prisma.digestRun.delete({ where: { id: run.id } });
    expect(await prisma.digestSend.count({ where: { runId: run.id } })).toBe(0);
  });
});
