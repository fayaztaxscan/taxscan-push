import { randomBytes } from 'node:crypto';
import type { DigestAudience } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { parseDigestEnv, type DigestEnv } from '../lib/env';
import type { EmailSender } from '../lib/email';
import * as runner from '../services/digest/runner';
import { digestProviderCampaignName, type SelectItems } from '../services/digest/runner';
import { createDigestTicker, digestDayPlan, digestTick, resetDigestTickLogForTests, type TickDeps } from '../services/digest/scheduler';
import { EDITOR_KINDS, digestAlertRecipients, sendDigestAlerts } from '../services/digest/alerts';
import { digestStatus } from '../services/digest/status';
import { healthDueSince } from '../services/digest/health';
import { SenderError } from '../services/digest/sender';
import { placeholderContent } from './digestPlaceholderContent';
import { FakeSender } from './digestFakeSender';

/**
 * Email digest task 13: the scheduler tick end to end, with the FakeSender and a
 * fake clock (every tick is given its instant). Rows live under unique
 * `test-digest-tick-*` portals and are removed afterwards. No real Mailercloud,
 * no real email: alert emails go to an injected recording sender.
 */

jest.spyOn(console, 'log').mockImplementation(() => undefined);
jest.spyOn(console, 'warn').mockImplementation(() => undefined);

const PORTAL_PREFIX = 'test-digest-tick-';
const QUIET = { start: '23:00', end: '07:00' };
const IST_OFFSET_MIN = 5 * 60 + 30;
const DAY = 24 * 60 * 60 * 1000;
const ADMIN = 'tick-admin@team.test';
const PUBLISHER = 'tick-publisher@team.test';

/** UTC instant of an IST wall-clock time on 23 Oct 2026 (or `day`). */
function ist(h: number, min = 0, day = 23): Date {
  return new Date(Date.UTC(2026, 9, day, h, min) - IST_OFFSET_MIN * 60 * 1000);
}

/** Live mode, approval REQUIRED (the default), complete audiences. */
function cfg(over: NodeJS.ProcessEnv = {}): DigestEnv {
  return parseDigestEnv({
    DIGEST_ENABLED: 'true',
    DIGEST_SEND_LIVE: 'true',
    DIGEST_FREE_LIST_IDS: 'list-free',
    DIGEST_FREE_EXCLUDE_LIST_IDS: 'list-premium',
    DIGEST_PREMIUM_LIST_IDS: 'list-premium',
    DIGEST_POSTAL_ADDRESS: 'Test address, Kochi',
    ...over,
  });
}

/** The builder, stubbed: a normal day (placeholder content needs no items). */
const selectItems: SelectItems = async (_run, now) => ({
  windowStart: new Date(now.getTime() - DAY),
  windowEnd: now,
  candidateCount: 20,
  outcome: 'ok',
  perAudience: { FREE: [], PREMIUM: [] },
  mainCounts: { FREE: 8, PREMIUM: 8 },
  rows: [],
  reads: { used: false, source: 'off', note: null },
  droppedDead: 0,
});

type Day = {
  portal: string;
  sender: FakeSender;
  c: DigestEnv;
  quiet: { start: string; end: string };
  lines: string[];
  mails: { to: string; subject: string }[];
  now: Date;
};

let n = 0;
function newDay(c: DigestEnv = cfg(), opts: { quiet?: { start: string; end: string }; sender?: FakeSender } = {}): Day {
  return {
    portal: `${PORTAL_PREFIX}${Date.now()}-${++n}-${randomBytes(3).toString('hex')}`,
    sender: opts.sender ?? new FakeSender({ withLookup: true }),
    c,
    quiet: opts.quiet ?? QUIET,
    lines: [],
    mails: [],
    now: ist(0, 0),
  };
}

function deps(d: Day, extra: Partial<TickDeps> = {}): TickDeps {
  const emailSender: EmailSender = async (m) => {
    d.mails.push({ to: m.to, subject: m.subject });
    return { ok: true };
  };
  return {
    sender: d.sender,
    cfg: d.c,
    quiet: d.quiet,
    now: d.now,
    portals: [d.portal],
    buildContent: placeholderContent,
    selectItems,
    awaitAlerts: true,
    log: (l) => d.lines.push(l),
    alerts: (runId) =>
      sendDigestAlerts(runId, {
        cfg: d.c,
        now: d.now,
        emailSender,
        isConfigured: () => true,
        recipients: async (kind) => (kind && EDITOR_KINDS.has(kind) ? [ADMIN, PUBLISHER] : [ADMIN]),
      }),
    ...extra,
  };
}

async function tick(d: Day, h: number, min = 0, extra: Partial<TickDeps> = {}) {
  d.now = ist(h, min);
  return digestTick(deps(d, extra));
}

async function runOf(d: Day) {
  return prisma.digestRun.findUnique({ where: { portal_runDate: { portal: d.portal, runDate: new Date(Date.UTC(2026, 9, 23)) } } });
}
async function sendOf(d: Day, audience: DigestAudience = 'FREE') {
  const run = await runOf(d);
  return prisma.digestSend.findUniqueOrThrow({ where: { runId_audience: { runId: run!.id, audience } } });
}
async function alertsOf(d: Day): Promise<Record<string, Record<string, unknown>>> {
  return ((await runOf(d))?.alerts ?? {}) as Record<string, Record<string, unknown>>;
}
const mailsLike = (d: Day, re: RegExp) => d.mails.filter((m) => re.test(m.subject));

afterAll(async () => {
  const runs = await prisma.digestRun.findMany({ where: { portal: { startsWith: PORTAL_PREFIX } }, select: { sends: { select: { id: true } } } });
  const sendIds = runs.flatMap((r) => r.sends.map((s) => s.id));
  await prisma.emailEvent.deleteMany({ where: { OR: [{ sendId: { in: sendIds } }, { dedupeKey: { startsWith: PORTAL_PREFIX } }] } });
  await prisma.digestRun.deleteMany({ where: { portal: { startsWith: PORTAL_PREFIX } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: 'tick-role-' } } });
  await prisma.$disconnect();
});

beforeEach(() => resetDigestTickLogForTests());

/* ------------------------------------------------------------------ */

describe('the day plan comes from §5 and the env', () => {
  it('defaults: run + health 06:15, build 06:30, health 07:15, send 07:30, "not approved" 08:30, cut-off 17:00', () => {
    const p = digestDayPlan(new Date(Date.UTC(2026, 9, 23)), cfg());
    expect(p.openAt).toEqual(ist(6, 15));
    expect(p.healthAt).toEqual([ist(6, 15), ist(7, 15)]);
    expect(p.buildAt).toEqual(ist(6, 30));
    expect(p.sendAt).toEqual(ist(7, 30));
    expect(p.notApprovedEmailAt).toEqual(ist(8, 30));
    expect(p.cutoffAt).toEqual(ist(17, 0));
  });

  it('follows DIGEST_SEND_AT / DIGEST_BUILD_LEAD_MINUTES (health stays at T−75 and T−15)', () => {
    const p = digestDayPlan(new Date(Date.UTC(2026, 9, 23)), cfg({ DIGEST_SEND_AT: '08:00', DIGEST_BUILD_LEAD_MINUTES: '30' }));
    expect(p.buildAt).toEqual(ist(7, 30));
    expect(p.healthAt).toEqual([ist(6, 45), ist(7, 45)]);
    expect(p.openAt).toEqual(ist(6, 45));
  });
});

describe('end to end: approval mode, approved → sent', () => {
  it('run 06:15 → build + drafts 06:30 → approval → schedule 07:30 → verify → SENT; each email once; one log line per change', async () => {
    const d = newDay();
    await tick(d, 6, 0);
    expect(await runOf(d)).toBeNull(); // before T−75 nothing exists

    const r615 = await tick(d, 6, 15);
    expect(r615.portals[0].did).toEqual(expect.arrayContaining(['run:created', 'health:ok']));
    expect(d.sender.count('health')).toBe(1);
    expect(await prisma.digestSend.count({ where: { runId: (await runOf(d))!.id } })).toBe(0); // no build before 06:30

    await tick(d, 6, 20);
    expect(d.sender.count('health')).toBe(1);

    await tick(d, 6, 30);
    expect(d.sender.count('createDraft')).toBe(2);
    expect((await sendOf(d)).state).toBe('CREATED');
    // "Ready for approval" to editors (admin + publisher), once.
    expect(mailsLike(d, /ready for approval/)).toHaveLength(2);
    expect(mailsLike(d, /ready for approval/).map((m) => m.to).sort()).toEqual([ADMIN, PUBLISHER].sort());

    const linesBefore = d.lines.length;
    for (let m = 31; m <= 45; m++) await tick(d, 6, m); // idle minutes
    expect(d.lines.length).toBe(linesBefore); // never a line per idle tick
    expect(d.sender.count('createDraft')).toBe(2);

    await tick(d, 7, 15);
    expect(d.sender.count('health')).toBe(2);

    await tick(d, 7, 30); // not approved yet: waits
    expect(d.sender.count('schedule')).toBe(0);
    const banner = await digestStatus({ portal: d.portal, now: ist(7, 30), cfg: d.c });
    expect(banner.attention?.code).toBe('awaiting_approval');

    const run = (await runOf(d))!;
    await prisma.digestRun.update({ where: { id: run.id }, data: { approval: 'APPROVED', approvedAt: ist(7, 34) } });
    const r735 = await tick(d, 7, 35);
    expect(d.sender.count('schedule')).toBe(2);
    expect(r735.portals[0].did).toEqual(expect.arrayContaining(['FREE:schedule:ok', 'PREMIUM:schedule:ok']));

    for (const c of d.sender.campaigns.values()) c.state = 'SENT';
    await tick(d, 7, 40); // before the +10 min poll: no status call needed
    const statusAt740 = d.sender.count('status');
    await tick(d, 7, 45);
    expect(d.sender.count('status')).toBeGreaterThan(statusAt740);
    expect((await sendOf(d)).state).toBe('SENT');
    expect((await sendOf(d, 'PREMIUM')).state).toBe('SENT');

    // Nothing more for the rest of the day, and no "not approved yet" email.
    for (const [h, m] of [[8, 30], [12, 0], [17, 0], [17, 1]] as const) await tick(d, h, m);
    expect(d.sender.count('schedule')).toBe(2);
    expect(d.sender.count('createDraft')).toBe(2);
    expect(mailsLike(d, /still waiting/)).toHaveLength(0);
    expect(mailsLike(d, /ready for approval/)).toHaveLength(2);
    // One compact line per change, carrying the date and states, no address.
    expect(d.lines.some((l) => /2026-10-23 run=\S+ sent build=BUILT approval=APPROVED .*FREE=SENT PREMIUM=SENT/.test(l))).toBe(true);
    expect(d.lines.join('\n')).not.toContain('@');
  });
});

describe('end to end: not approved', () => {
  it('"not approved yet" to editors once at 08:30 (not 08:29), then SKIPPED not_approved at 17:00; nothing scheduled', async () => {
    const d = newDay();
    await tick(d, 6, 15);
    await tick(d, 6, 30);
    await tick(d, 7, 30);
    await tick(d, 8, 29);
    expect(mailsLike(d, /still waiting for approval/)).toHaveLength(0);
    await tick(d, 8, 30);
    expect(mailsLike(d, /still waiting for approval/).map((m) => m.to).sort()).toEqual([ADMIN, PUBLISHER].sort());
    await tick(d, 8, 31);
    await tick(d, 12, 0);
    expect(mailsLike(d, /still waiting for approval/)).toHaveLength(2);

    await tick(d, 16, 59);
    expect((await sendOf(d)).state).toBe('CREATED');
    await tick(d, 17, 0);
    expect((await sendOf(d)).state).toBe('SKIPPED');
    expect((await runOf(d))!.skipReason).toBe('not_approved');
    expect(d.sender.count('schedule')).toBe(0);
    expect(mailsLike(d, /was skipped/)).toEqual([expect.objectContaining({ to: ADMIN })]);
    await tick(d, 17, 30);
    expect(mailsLike(d, /was skipped/)).toHaveLength(1);
  });

  it('a HELD run gets no "not approved yet" nag (an editor decided)', async () => {
    const d = newDay();
    await tick(d, 6, 15);
    await tick(d, 6, 30);
    await prisma.digestRun.update({ where: { id: (await runOf(d))!.id }, data: { approval: 'HELD' } });
    await tick(d, 8, 30);
    expect(mailsLike(d, /still waiting/)).toHaveLength(0);
  });

  it('preview mode: no "not approved yet" email; "ready" says review, not approve', async () => {
    const d = newDay(cfg({ DIGEST_SEND_LIVE: 'false' }));
    await tick(d, 6, 15);
    await tick(d, 6, 30);
    await tick(d, 8, 30);
    expect(mailsLike(d, /ready to review/)).toHaveLength(2);
    expect(mailsLike(d, /ready for approval|still waiting/)).toHaveLength(0);
  });

  it('auto mode (approval off): no "ready for approval" email at all; sends at 07:30', async () => {
    const d = newDay(cfg({ DIGEST_APPROVAL_REQUIRED: 'false' }));
    await tick(d, 6, 15);
    await tick(d, 6, 30);
    await tick(d, 7, 29);
    expect(d.sender.count('schedule')).toBe(0);
    await tick(d, 7, 30);
    expect(d.sender.count('schedule')).toBe(2);
    expect(mailsLike(d, /ready/)).toHaveLength(0);
  });

  it('a day first seen after the cut-off is not created (nothing could be sent)', async () => {
    const d = newDay();
    await tick(d, 17, 5);
    expect(await runOf(d)).toBeNull();
  });
});

describe('quiet hours, both directions (fresh clock)', () => {
  const auto = () => cfg({ DIGEST_APPROVAL_REQUIRED: 'false' });

  it('a send time inside the night window waits; the first open minute sends', async () => {
    const d = newDay(auto(), { quiet: { start: '23:00', end: '07:40' } });
    await tick(d, 6, 15);
    await tick(d, 6, 30);
    const r = await tick(d, 7, 30);
    expect(r.portals[0].did).toContain('FREE:wait:quiet_hours');
    await tick(d, 7, 39);
    expect(d.sender.count('schedule')).toBe(0);
    await tick(d, 7, 40);
    expect(d.sender.count('schedule')).toBe(2);
  });

  it('the live clock is re-read before schedule(): a tick that starts open but whose clock reads quiet does not send', async () => {
    const d = newDay(auto(), { quiet: { start: '07:35', end: '08:00' } });
    await tick(d, 6, 15);
    await tick(d, 6, 30);
    await tick(d, 7, 34, { clock: () => ist(7, 36) });
    expect(d.sender.count('schedule')).toBe(0);
    expect((await sendOf(d)).scheduleAttemptedAt).toBeNull(); // provably never called
    await tick(d, 8, 0);
    expect(d.sender.count('schedule')).toBe(2);
  });
});

describe('overlap and robustness', () => {
  it('single-flight: a tick that starts while the previous one runs is skipped', async () => {
    const d = newDay();
    d.sender.delayMs.createDraft = 200;
    const ticker = createDigestTicker({ ...deps(d), now: () => ist(6, 30) });
    const [a, b] = await Promise.all([ticker.tick(), ticker.tick()]);
    expect([a.skipped, b.skipped].filter(Boolean)).toEqual(['in_flight']);
    expect(d.sender.count('createDraft')).toBe(2);
  });

  it('the production ticker hands the runner a LIVE clock for the pre-schedule re-check (not the tick instant)', async () => {
    const d = newDay();
    const timers = ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] as const;
    jest.useFakeTimers({ doNotFake: [...timers], now: ist(7, 34) }); // only Date is faked
    const seen: runner.AdvanceDeps[] = [];
    const spy = jest.spyOn(runner, 'advanceRun').mockImplementation(async (runId, _t, dep) => {
      seen.push(dep);
      return { runId, outcome: 'advanced', steps: [], state: null };
    });
    try {
      const noClockDeps: Omit<TickDeps, 'now'> = { ...deps(d) };
      delete (noClockDeps as Partial<TickDeps>).now;
      await createDigestTicker(noClockDeps).tick(); // production shape: no `now`, no `clock`
      expect(seen.length).toBeGreaterThan(0);
      const dep = seen[seen.length - 1];
      expect(dep.now).toEqual(ist(7, 34));
      jest.setSystemTime(ist(7, 36));
      expect(dep.clock?.()).toEqual(ist(7, 36)); // reads the wall clock at the moment it is asked
    } finally {
      spy.mockRestore();
      jest.useRealTimers();
    }
  });

  it('two replicas ticking at the same minute: one run, one health call, one draft per audience', async () => {
    const d = newDay();
    d.sender.delayMs.createDraft = 150;
    d.sender.delayMs.health = 100;
    const one = createDigestTicker({ ...deps(d), now: () => ist(6, 30) });
    const two = createDigestTicker({ ...deps(d), now: () => ist(6, 30) });
    await Promise.all([one.tick(), two.tick()]);
    expect(await prisma.digestRun.count({ where: { portal: d.portal } })).toBe(1);
    expect(d.sender.count('health')).toBe(1);
    expect(d.sender.count('createDraft')).toBe(2);
    expect(d.sender.campaigns.size).toBe(2);
    expect((await sendOf(d)).state).toBe('CREATED');
    expect((await sendOf(d, 'PREMIUM')).state).toBe('CREATED');
  });

  it('restart mid-create: a live claim blocks, a stale one is taken over; the provider is asked, nothing is created twice', async () => {
    const d = newDay(cfg({ DIGEST_APPROVAL_REQUIRED: 'false' }));
    d.sender.fail('findCampaignByName', 'RETRYABLE', 2);
    await tick(d, 6, 15);
    await tick(d, 6, 30); // built; both lookups failed → PENDING, marker set
    const run = (await runOf(d))!;
    // The 06:31 retry claimed both variants and the process died: FREE's create had reached Mailercloud.
    await prisma.digestSend.updateMany({ where: { runId: run.id }, data: { stepClaimedAt: ist(6, 31), createAttemptedAt: ist(6, 31) } });
    const freeId = 'fake-made-before-the-crash';
    d.sender.campaigns.set(freeId, { id: freeId, name: digestProviderCampaignName(d.portal, run.runDate, 'FREE'), state: 'DRAFT', input: {} as never });

    resetDigestTickLogForTests(); // the restart
    const r635 = await tick(d, 6, 35);
    expect(r635.portals[0].did).toEqual(expect.arrayContaining(['FREE:create:claimed_elsewhere', 'PREMIUM:create:claimed_elsewhere']));
    expect(d.sender.count('createDraft')).toBe(0);

    await tick(d, 6, 42); // claims are now > 10 min old: taken over
    expect(d.sender.count('createDraft')).toBe(1);
    expect(d.sender.draftInputs()[0].audience).toBe('PREMIUM');
    const free = await sendOf(d);
    expect(free.mcCampaignId).toBe(freeId);
    // Decision A narrowed (owner, 2026-10-23): our own create marker was there, so the
    // found draft is our lost create — adopted and carried on, no extra approval.
    expect(free.adoptedDraftAt).toBeNull();
    expect(free.ownApprovalRequired).toBe(false);
    expect(d.sender.campaigns.size).toBe(2);

    await tick(d, 7, 30);
    expect(d.sender.calls.filter((c) => c.method === 'schedule').map((c) => c.args[0]).sort()).toEqual(
      [freeId, (await sendOf(d, 'PREMIUM')).mcCampaignId].sort(),
    );
  });

  it('restart mid-schedule: the provider decides — accepted is not scheduled again, a draft is scheduled once', async () => {
    const d = newDay(cfg({ DIGEST_APPROVAL_REQUIRED: 'false' }));
    await tick(d, 6, 15);
    await tick(d, 6, 30);
    const run = (await runOf(d))!;
    // 07:30: both claimed with the marker set, FREE's schedule reached Mailercloud, then the process died.
    await prisma.digestSend.updateMany({ where: { runId: run.id }, data: { stepClaimedAt: ist(7, 30), scheduleAttemptedAt: ist(7, 30) } });
    const free = await sendOf(d);
    d.sender.campaigns.get(free.mcCampaignId!)!.state = 'SCHEDULED';

    resetDigestTickLogForTests();
    await tick(d, 7, 35);
    expect(d.sender.count('schedule')).toBe(0);
    await tick(d, 7, 41);
    const premium = await sendOf(d, 'PREMIUM');
    expect(d.sender.calls.filter((c) => c.method === 'schedule').map((c) => c.args[0])).toEqual([premium.mcCampaignId]);
    expect((await sendOf(d)).state).toBe('SCHEDULED');
    expect(premium.state).toBe('SCHEDULED');
  });

  it('an earlier day left open (the app was down at 17:00) is swept on the next tick', async () => {
    const d = newDay(cfg({ DIGEST_APPROVAL_REQUIRED: 'false' }));
    d.now = ist(6, 30, 22);
    await digestTick({ ...deps(d), now: ist(6, 15, 22) });
    await digestTick({ ...deps(d), now: ist(6, 30, 22) });
    // Down from 07:00 on the 22nd until 06:00 on the 23rd: yesterday's drafts were never swept.
    await tick(d, 6, 0);
    const y = await prisma.digestRun.findUniqueOrThrow({
      where: { portal_runDate: { portal: d.portal, runDate: new Date(Date.UTC(2026, 9, 22)) } },
      include: { sends: true },
    });
    expect(y.sends.map((s) => s.state)).toEqual(['SKIPPED', 'SKIPPED']);
    expect(d.sender.count('schedule')).toBe(0); // never sent late on a later day
  });
});

describe('health checks', () => {
  it('FATAL at 06:15 → banner + one alert; hourly re-check while FATAL; recovery resumes the FATAL-failed variant and clears the banner', async () => {
    const d = newDay(cfg({ DIGEST_APPROVAL_REQUIRED: 'false' }));
    d.sender.fail('health', 'FATAL', 2, { http: 401 });
    d.sender.fail('createDraft', 'FATAL', 1, { http: 401 }); // FREE's create at 06:30
    await tick(d, 6, 15);
    let run = (await runOf(d))!;
    expect(run.healthOk).toBe(false);
    expect(run.healthError).toMatch(/^FATAL: /);
    expect(run.healthError).not.toContain('@');
    expect((await digestStatus({ portal: d.portal, now: ist(6, 16), cfg: d.c })).attention?.code).toBe('health_failed');
    expect(mailsLike(d, /rejected the health check/)).toHaveLength(1); // emailed before the build

    await tick(d, 6, 30);
    expect((await sendOf(d)).state).toBe('FAILED');
    expect((await sendOf(d)).lastErrorKind).toBe('FATAL');
    await tick(d, 7, 15); // slot: fails again
    expect(d.sender.count('health')).toBe(2);
    await tick(d, 7, 45); // FATAL open: hourly, not every slot-less minute
    expect(d.sender.count('health')).toBe(2);
    await tick(d, 7, 50);
    expect(d.sender.count('schedule')).toBe(1); // PREMIUM went; FREE waits (FATAL is never retried by the cron)

    await tick(d, 8, 15); // the key was fixed: passes, resumes FREE
    expect(d.sender.count('health')).toBe(3);
    run = (await runOf(d))!;
    expect(run.healthOk).toBe(true);
    expect((await sendOf(d)).state).toBe('SCHEDULED');
    expect(d.sender.count('createDraft')).toBe(3);
    expect(d.sender.count('schedule')).toBe(2);
    expect(mailsLike(d, /answering again/)).toHaveLength(1);
    expect(mailsLike(d, /rejected the health check/)).toHaveLength(1);
    await tick(d, 9, 15);
    expect(d.sender.count('health')).toBe(3); // nothing open any more: no hourly check
  });

  it('never resumes a provider-FAILED campaign; a passing check after a pass sends no recovery note', async () => {
    const d = newDay(cfg({ DIGEST_APPROVAL_REQUIRED: 'false' }));
    await tick(d, 6, 15);
    await tick(d, 6, 30);
    await tick(d, 7, 30);
    d.sender.setStatus({ state: 'FAILED', targeted: 100, reached: 0 });
    await tick(d, 7, 40);
    expect((await sendOf(d)).lastError).toMatch(/^provider_failed/);
    const r = await tick(d, 8, 15);
    expect(r.portals[0].did).not.toContain('health:ok'); // provider_failed is not FATAL-open: no hourly check
    expect(d.sender.count('schedule')).toBe(2);
    expect(mailsLike(d, /answering again/)).toHaveLength(0);
  });

  it('healthDueSince: slots, restart (one check covers missed slots), hourly only while FATAL', () => {
    const base = { runDate: new Date(Date.UTC(2026, 9, 23)), healthOk: null, healthError: null, healthCheckedAt: null };
    const c = cfg();
    expect(healthDueSince(ist(6, 14), base, [], c)).toBeNull();
    expect(healthDueSince(ist(6, 15), base, [], c)).toEqual(ist(6, 15));
    expect(healthDueSince(ist(10, 0), base, [], c)).toEqual(ist(7, 15)); // started late: one check
    expect(healthDueSince(ist(10, 0), { ...base, healthCheckedAt: ist(7, 20) }, [], c)).toBeNull();
    const fatal = { ...base, healthOk: false, healthError: 'FATAL: 401', healthCheckedAt: ist(7, 15) };
    expect(healthDueSince(ist(8, 14), fatal, [], c)).toBeNull();
    expect(healthDueSince(ist(8, 15), fatal, [], c)).not.toBeNull(); // exactly an hour later
    const fatalVariant = [{ state: 'FAILED', lastError: 'mailercloud createDraft: HTTP 401', lastErrorKind: 'FATAL' }];
    expect(healthDueSince(ist(8, 15), { ...base, healthOk: true, healthCheckedAt: ist(7, 15) }, fatalVariant, c)).not.toBeNull();
    const terminal = [{ state: 'FAILED', lastError: 'provider_failed: nobody reached', lastErrorKind: null }];
    expect(healthDueSince(ist(8, 15), { ...base, healthOk: true, healthCheckedAt: ist(7, 15) }, terminal, c)).toBeNull();
    expect(healthDueSince(ist(17, 0), fatal, [], c)).toBeNull(); // never at or after the cut-off
    const retryable = { ...fatal, healthError: 'RETRYABLE: timeout' };
    expect(healthDueSince(ist(8, 15), retryable, [], c)).toBeNull();
  });

  it('daily webhook status: read once at the first slot; inactive → alert + banner; unreadable → tried again at the next slot', async () => {
    const c = cfg({ DIGEST_WEBHOOKS_ENABLED: 'true', MAILERCLOUD_WEBHOOK_ID: 'wh-1', DIGEST_APPROVAL_REQUIRED: 'false' });
    const d = newDay(c);
    d.sender.webhookActive = false;
    await tick(d, 6, 15);
    await tick(d, 7, 15);
    expect(d.sender.count('webhookStatus')).toBe(1);
    expect(d.sender.calls.find((x) => x.method === 'webhookStatus')?.args).toEqual(['wh-1']);
    expect((await runOf(d))!.webhookActive).toBe(false);
    expect((await alertsOf(d)).webhook_disabled).toBeDefined();
    expect(mailsLike(d, /webhook is switched off/)).toHaveLength(1);
    expect((await digestStatus({ portal: d.portal, now: ist(7, 16), cfg: c })).attention?.code).toBe('webhook_disabled');

    const e = newDay(c);
    e.sender.fail('webhookStatus', 'RETRYABLE', 1);
    await tick(e, 6, 15);
    expect((await runOf(e))!.webhookActive).toBeNull(); // unreadable is never "off"
    await tick(e, 6, 45);
    expect(e.sender.count('webhookStatus')).toBe(1);
    await tick(e, 7, 15);
    expect(e.sender.count('webhookStatus')).toBe(2);
    expect((await runOf(e))!.webhookActive).toBe(true);
    expect((await alertsOf(e)).webhook_disabled).toBeUndefined();
  });

  it('no MAILERCLOUD_WEBHOOK_ID: the status endpoint is never called (the liveness check watches)', async () => {
    const d = newDay(cfg({ DIGEST_WEBHOOKS_ENABLED: 'true' }));
    await tick(d, 6, 15);
    expect(d.sender.count('webhookStatus')).toBe(0);
  });
});

describe('preview mode (DIGEST_SEND_LIVE off): recovery up to the draft, never a schedule', () => {
  it('health recovery re-creates a FATAL-failed draft, and nothing is ever scheduled', async () => {
    const d = newDay(cfg({ DIGEST_SEND_LIVE: 'false', DIGEST_APPROVAL_REQUIRED: 'false' }));
    d.sender.fail('createDraft', 'FATAL', 1, { http: 401 });
    await tick(d, 6, 15);
    await tick(d, 6, 30);
    expect((await sendOf(d)).state).toBe('FAILED');
    await tick(d, 7, 15);
    expect((await sendOf(d)).state).toBe('CREATED');
    expect(d.sender.count('createDraft')).toBe(3);
    for (const [h, m] of [[7, 30], [9, 0], [16, 59]] as const) await tick(d, h, m);
    expect(d.sender.count('schedule')).toBe(0);
  });

  it('…and in live mode the same recovery goes on to schedule', async () => {
    const d = newDay(cfg({ DIGEST_APPROVAL_REQUIRED: 'false' }));
    d.sender.fail('createDraft', 'FATAL', 1, { http: 401 });
    await tick(d, 6, 15);
    await tick(d, 6, 30);
    await tick(d, 7, 15);
    await tick(d, 7, 30);
    expect(d.sender.count('schedule')).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/* Complaint-rate hold                                                 */
/* ------------------------------------------------------------------ */

/** Yesterday's digest, sent to `delivered` readers (null = unknown), with `spam` complaints and (optionally) webhook proof. */
async function yesterday(d: Day, delivered: number | null, spam: number, proof = true): Promise<void> {
  const runDate = new Date(Date.UTC(2026, 9, 22));
  const run = await prisma.digestRun.create({
    data: {
      portal: d.portal,
      runDate,
      windowStart: ist(6, 30, 21),
      build: 'BUILT',
      builtAt: ist(6, 30, 22),
      sends: {
        create: (['FREE', 'PREMIUM'] as const).map((audience) => ({
          audience,
          state: 'SENT' as const,
          subject: 's',
          preheader: 'p',
          htmlBytes: 0,
          mcCampaignName: digestProviderCampaignName(d.portal, runDate, audience),
          mcCampaignId: `${d.portal}-${audience}-y`,
          sendAfter: ist(7, 30, 22),
          sentConfirmedAt: ist(7, 40, 22),
          reached: audience === 'FREE' ? delivered : 1000,
          targeted: 1000,
        })),
      },
    },
    include: { sends: true },
  });
  for (const s of run.sends) {
    if (proof) {
      await prisma.emailEvent.create({ data: { type: 'CAMPAIGN_SENT', sendId: s.id, mcCampaignId: s.mcCampaignId, dedupeKey: `${PORTAL_PREFIX}${s.id}-sent` } });
    }
    const n = s.audience === 'FREE' ? spam : 0;
    for (let i = 0; i < n; i++) {
      await prisma.emailEvent.create({ data: { type: 'SPAM', sendId: s.id, emailHash: `h${i}`, dedupeKey: `${PORTAL_PREFIX}${s.id}-spam-${i}` } });
    }
  }
}

describe('complaint-rate hold (design §8; DIGEST_COMPLAINT_HOLD_PCT, default 0.3%)', () => {
  const auto = (over: NodeJS.ProcessEnv = {}) => cfg({ DIGEST_APPROVAL_REQUIRED: 'false', DIGEST_WEBHOOKS_ENABLED: 'true', ...over });

  it('above 0.3%: today is held for approval even in auto mode; the alert names the rate; approval releases it', async () => {
    const d = newDay(auto());
    await yesterday(d, 1000, 4); // 0.4%
    await tick(d, 6, 15);
    let run = (await runOf(d))!;
    expect(run.approval).toBe('PENDING');
    expect(run.complaintCheck).toMatchObject({ held: true, thresholdPct: 0.3, previousRunDate: '2026-10-22' });
    expect((await alertsOf(d)).complaint_hold).toMatchObject({ ratePct: 0.4, complaints: 4, delivered: 1000, audience: 'FREE' });
    expect(mailsLike(d, /spam-complaint rate 0\.40%/)).toHaveLength(1);

    await tick(d, 6, 30);
    const r = await tick(d, 7, 30);
    expect(r.portals[0].did).toContain('FREE:wait:complaint_hold');
    expect(d.sender.count('schedule')).toBe(0);
    expect((await digestStatus({ portal: d.portal, now: ist(7, 31), cfg: d.c })).attention).toMatchObject({ code: 'complaint_hold' });
    expect(mailsLike(d, /ready for approval/)).toHaveLength(2); // the hold makes it an approval day

    run = (await runOf(d))!;
    await prisma.digestRun.update({ where: { id: run.id }, data: { approval: 'APPROVED' } });
    await tick(d, 7, 35);
    expect(d.sender.count('schedule')).toBe(2);
  });

  it('exactly 0.3% (not above) and below: no hold, auto-sends at 07:30', async () => {
    for (const spam of [3, 1]) {
      const d = newDay(auto());
      await yesterday(d, 1000, spam);
      await tick(d, 6, 15);
      expect((await runOf(d))!.complaintCheck).toMatchObject({ held: false });
      await tick(d, 6, 30);
      await tick(d, 7, 30);
      expect(d.sender.count('schedule')).toBe(2);
    }
  });

  it('a held day not approved by 17:00 is skipped as complaint_hold_expired', async () => {
    const d = newDay(auto());
    await yesterday(d, 1000, 5);
    await tick(d, 6, 15);
    await tick(d, 6, 30);
    await tick(d, 17, 0);
    expect((await runOf(d))!.skipReason).toBe('complaint_hold_expired');
  });

  it('UNKNOWN (no webhook proof) is not 0 and does not hold — the banner names the cause (the silent webhook)', async () => {
    const d = newDay(auto());
    await yesterday(d, 1000, 9, false); // 9 complaints, but no campaign_sent proof → unknown
    await tick(d, 6, 15);
    const check = (await runOf(d))!.complaintCheck as { held: boolean; sends: { ratePct: number | null }[] };
    expect(check.held).toBe(false);
    expect(check.sends.map((s) => s.ratePct)).toEqual([null, null]);
    await tick(d, 6, 30);
    // No proof for a send polled SENT hours ago = the webhook is silent: that outranks "rate unknown".
    expect((await digestStatus({ portal: d.portal, now: ist(6, 31), cfg: d.c })).attention?.code).toBe('webhook_silent');
    await tick(d, 7, 30);
    expect(d.sender.count('schedule')).toBe(2);
  });

  it('UNKNOWN with a live webhook (no delivered count): no hold, and the banner says the rate is unknown', async () => {
    const d = newDay(auto());
    await yesterday(d, null, 9); // proof, complaints, but no delivered figure from Mailercloud
    await tick(d, 6, 15);
    const check = (await runOf(d))!.complaintCheck as { held: boolean; sends: { audience: string; ratePct: number | null }[] };
    expect(check.held).toBe(false);
    expect(check.sends.find((s) => s.audience === 'FREE')?.ratePct).toBeNull();
    expect(check.sends.find((s) => s.audience === 'PREMIUM')?.ratePct).toBe(0);
    await tick(d, 6, 30);
    const banner = (await digestStatus({ portal: d.portal, now: ist(6, 31), cfg: d.c })).attention!;
    expect(banner.code).toBe('complaint_rate_unknown');
    expect(banner.headline).toMatch(/Free digest \(2026-10-22\) is unknown/);
    // Preview mode would not show it: nothing is being protected then.
    expect((await digestStatus({ portal: d.portal, now: ist(6, 31), cfg: { ...d.c, sendLive: false } })).attention).toBeNull();
    await tick(d, 7, 30);
    expect(d.sender.count('schedule')).toBe(2);
  });

  it('a send still unconfirmed at the 17:00 cut-off is judged as UNKNOWN: the banner says so, nothing is held (owner, 2026-10-23)', async () => {
    const d = newDay(auto());
    await yesterday(d, 1000, 0);
    // FREE was never confirmed sent by the cut-off yesterday (FAILED not_confirmed_by_cutoff).
    await prisma.digestSend.updateMany({
      where: { run: { portal: d.portal, runDate: new Date(Date.UTC(2026, 9, 22)) }, audience: 'FREE' },
      data: { state: 'FAILED', lastError: 'not_confirmed_by_cutoff', sentConfirmedAt: null },
    });
    await tick(d, 6, 15);
    const run = (await runOf(d))!;
    expect(run.approval).not.toBe('PENDING');
    const check = run.complaintCheck as { held: boolean; previousRunDate: string; sends: { audience: string; ratePct: number | null; unconfirmed?: boolean }[] };
    expect(check.held).toBe(false);
    expect(check.previousRunDate).toBe('2026-10-22');
    expect(check.sends.find((s) => s.audience === 'FREE')).toMatchObject({ ratePct: null, unconfirmed: true });
    expect(check.sends.find((s) => s.audience === 'PREMIUM')?.ratePct).toBe(0);
    await tick(d, 6, 30);
    const banner = (await digestStatus({ portal: d.portal, now: ist(6, 31), cfg: d.c })).attention!;
    expect(banner.code).toBe('complaint_rate_unknown');
    expect(banner.headline).toMatch(/Free digest \(2026-10-22\) is unknown: it was never confirmed sent by the 17:00 IST cut-off/);
    await tick(d, 7, 30);
    expect(d.sender.count('schedule')).toBe(2); // unknown never holds
  });

  it('the most recent run had ONLY unconfirmed sends: it is still the one judged (an older sent run is not used instead)', async () => {
    const d = newDay(auto());
    await yesterday(d, 1000, 0);
    await prisma.digestSend.updateMany({
      where: { run: { portal: d.portal, runDate: new Date(Date.UTC(2026, 9, 22)) } },
      data: { state: 'FAILED', lastError: 'not_confirmed_by_cutoff: timeout', sentConfirmedAt: null },
    });
    await tick(d, 6, 15);
    const check = (await runOf(d))!.complaintCheck as { held: boolean; previousRunDate: string; sends: { ratePct: number | null }[] };
    expect(check).toMatchObject({ held: false, previousRunDate: '2026-10-22' });
    expect(check.sends.map((s) => s.ratePct)).toEqual([null, null]);
  });

  it('webhooks off: every rate is unknown (the history shows — too); no previous send: nothing to judge', async () => {
    const d = newDay(cfg({ DIGEST_APPROVAL_REQUIRED: 'false' }));
    await yesterday(d, 1000, 9);
    await tick(d, 6, 15);
    expect(((await runOf(d))!.complaintCheck as { held: boolean }).held).toBe(false);
    const e = newDay(auto());
    await tick(e, 6, 15);
    expect((await runOf(e))!.complaintCheck).toMatchObject({ held: false, previousRunDate: null, sends: [] });
  });
});

/* ------------------------------------------------------------------ */

describe('duplicate campaign names are their own problem (7b)', () => {
  it('two campaigns with our exact name: duplicate_name, its own banner and alert (not "not answering"); deleting the extra one lets it carry on', async () => {
    const d = newDay(cfg({ DIGEST_APPROVAL_REQUIRED: 'false' }));
    let twins = true;
    d.sender.findCampaignByName = async (name: string) => {
      if (twins && name.endsWith('-FREE')) {
        throw new SenderError('RETRYABLE', 'mailercloud findCampaignByName: lookup inconclusive: 2 campaigns have this exact name', { code: 'duplicate_name' });
      }
      return null;
    };
    await tick(d, 6, 15);
    await tick(d, 6, 30);
    const free = await sendOf(d);
    expect(free.state).toBe('PENDING');
    expect(free.lastError).toBe(`duplicate_name: two campaigns named "${free.mcCampaignName}" exist in Mailercloud`);
    const alerts = await alertsOf(d);
    expect(alerts.duplicate_name).toMatchObject({ audience: 'FREE', campaignName: free.mcCampaignName });
    expect(alerts.retrying).toBeUndefined();
    const banner = (await digestStatus({ portal: d.portal, now: ist(6, 31), cfg: d.c })).attention!;
    expect(banner.code).toBe('duplicate_name');
    expect(banner.headline).toContain(`Two campaigns named "${free.mcCampaignName}" exist in Mailercloud`);
    expect(banner.headline).not.toMatch(/not answering/);
    expect(mailsLike(d, /Two digest campaigns with the same name/)).toHaveLength(1);

    twins = false; // a person deleted the extra one
    await tick(d, 6, 31);
    expect((await sendOf(d)).state).toBe('CREATED');
    expect(d.sender.count('createDraft')).toBe(2);
  });
});

describe('alert recipients', () => {
  it('editor kinds go to active ADMIN + PUBLISHER users; other kinds to active ADMIN users only', async () => {
    const tag = `${Date.now()}-${randomBytes(3).toString('hex')}`;
    const mk = (role: 'ADMIN' | 'PUBLISHER', isActive = true) =>
      prisma.user.create({ data: { email: `tick-role-${role.toLowerCase()}-${isActive ? 'on' : 'off'}-${tag}@team.test`, passwordHash: 'x', role, isActive } });
    await mk('ADMIN');
    await mk('PUBLISHER');
    await mk('PUBLISHER', false);
    const mine = (list: string[]) => list.filter((e) => e.includes(tag)).sort();
    expect(mine(await digestAlertRecipients('ready_for_approval'))).toEqual([`tick-role-admin-on-${tag}@team.test`, `tick-role-publisher-on-${tag}@team.test`]);
    expect(mine(await digestAlertRecipients('not_approved_yet'))).toHaveLength(2);
    expect(mine(await digestAlertRecipients('fatal'))).toEqual([`tick-role-admin-on-${tag}@team.test`]);
    expect(mine(await digestAlertRecipients())).toEqual([`tick-role-admin-on-${tag}@team.test`]);
  });
});
