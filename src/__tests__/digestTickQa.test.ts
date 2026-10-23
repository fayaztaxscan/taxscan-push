import { randomBytes } from 'node:crypto';
import type { DigestAudience } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { parseDigestEnv, type DigestEnv } from '../lib/env';
import type { EmailSender } from '../lib/email';
import { advanceRun, digestProviderCampaignName, type AdvanceDeps, type SelectItems } from '../services/digest/runner';
import { createDigestTicker, digestTick, resetDigestTickLogForTests, type TickDeps } from '../services/digest/scheduler';
import { EDITOR_KINDS, sendDigestAlerts } from '../services/digest/alerts';
import { digestStatus } from '../services/digest/status';
import { placeholderContent } from './digestPlaceholderContent';
import { FakeSender } from './digestFakeSender';

/**
 * QA of task 13 (cae7363): clock edges, downtime, doors racing the tick, two
 * processes, and the stale-claim stamp. Same harness as digestTick.test.ts
 * (FakeSender, a fake clock per tick, unique `test-digest-tickqa-*` portals,
 * alert emails to a recording sender). No real Mailercloud, no real email.
 */

jest.spyOn(console, 'log').mockImplementation(() => undefined);
jest.spyOn(console, 'warn').mockImplementation(() => undefined);

const PORTAL_PREFIX = 'test-digest-tickqa-';
const QUIET = { start: '23:00', end: '07:00' };
const IST_OFFSET_MIN = 5 * 60 + 30;
const DAY = 24 * 60 * 60 * 1000;

function ist(h: number, min = 0, day = 23): Date {
  return new Date(Date.UTC(2026, 9, day, h, min) - IST_OFFSET_MIN * 60 * 1000);
}

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
const auto = (over: NodeJS.ProcessEnv = {}) => cfg({ DIGEST_APPROVAL_REQUIRED: 'false', ...over });

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

type Day = { portal: string; sender: FakeSender; c: DigestEnv; mails: { to: string; subject: string }[]; now: Date };

let n = 0;
function newDay(c: DigestEnv = cfg()): Day {
  return {
    portal: `${PORTAL_PREFIX}${Date.now()}-${++n}-${randomBytes(3).toString('hex')}`,
    sender: new FakeSender({ withLookup: true }),
    c,
    mails: [],
    now: ist(0, 0),
  };
}

function alertsHook(d: Day): AdvanceDeps['alerts'] {
  const emailSender: EmailSender = async (m) => {
    d.mails.push({ to: m.to, subject: m.subject });
    return { ok: true };
  };
  return (runId) =>
    sendDigestAlerts(runId, {
      cfg: d.c,
      now: d.now,
      emailSender,
      isConfigured: () => true,
      recipients: async (kind) => (kind && EDITOR_KINDS.has(kind) ? ['a@team.test', 'p@team.test'] : ['a@team.test']),
    });
}

function deps(d: Day, extra: Partial<TickDeps> = {}): TickDeps {
  return {
    sender: d.sender,
    cfg: d.c,
    quiet: QUIET,
    now: d.now,
    portals: [d.portal],
    buildContent: placeholderContent,
    selectItems,
    awaitAlerts: true,
    log: () => undefined,
    alerts: alertsHook(d),
    ...extra,
  };
}

async function tick(d: Day, h: number, min = 0, day = 23, extra: Partial<TickDeps> = {}) {
  d.now = ist(h, min, day);
  return digestTick(deps(d, extra));
}

/** The runner door as a route calls it (Retry now / Send now), same sender and config. */
function door(d: Day, at: Date, extra: Partial<AdvanceDeps> = {}): AdvanceDeps {
  return {
    sender: d.sender,
    now: at,
    clock: () => at,
    cfg: d.c,
    quiet: QUIET,
    buildContent: placeholderContent,
    selectItems,
    alerts: false,
    log: () => undefined,
    ...extra,
  };
}

const runDate = (day = 23) => new Date(Date.UTC(2026, 9, day));
async function runOf(d: Day, day = 23) {
  return prisma.digestRun.findUnique({ where: { portal_runDate: { portal: d.portal, runDate: runDate(day) } } });
}
async function sendOf(d: Day, audience: DigestAudience = 'FREE', day = 23) {
  const run = await runOf(d, day);
  return prisma.digestSend.findUniqueOrThrow({ where: { runId_audience: { runId: run!.id, audience } } });
}
/** schedule() calls per campaign id. */
function schedulesById(s: FakeSender): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of s.calls.filter((x) => x.method === 'schedule')) out[c.args[0] as string] = (out[c.args[0] as string] ?? 0) + 1;
  return out;
}

afterAll(async () => {
  const runs = await prisma.digestRun.findMany({ where: { portal: { startsWith: PORTAL_PREFIX } }, select: { sends: { select: { id: true } } } });
  const sendIds = runs.flatMap((r) => r.sends.map((s) => s.id));
  await prisma.emailEvent.deleteMany({ where: { OR: [{ sendId: { in: sendIds } }, { dedupeKey: { startsWith: PORTAL_PREFIX } }] } });
  await prisma.digestRun.deleteMany({ where: { portal: { startsWith: PORTAL_PREFIX } } });
  await prisma.$disconnect();
});

beforeEach(() => resetDigestTickLogForTests());

describe('downtime (design §8 "Our app down at T": a late attempt, same version, before 17:00 only)', () => {
  it('down from 06:00 to 09:00: the first tick at 09:00 opens, builds and sends once — a late morning send', async () => {
    const d = newDay(auto());
    await tick(d, 9, 0);
    expect((await runOf(d))!.build).toBe('BUILT');
    expect(d.sender.count('health')).toBe(1); // one check covers the missed 06:15 and 07:15 slots
    expect(d.sender.count('createDraft')).toBe(2);
    expect(d.sender.count('schedule')).toBe(2);
    for (const m of [1, 2, 10, 40]) await tick(d, 9, m);
    expect(d.sender.count('schedule')).toBe(2);
    expect(d.sender.count('createDraft')).toBe(2);
  });

  it('built at 06:30, then down from 07:00 to 18:00: swept on return, never scheduled', async () => {
    const d = newDay(auto());
    await tick(d, 6, 15);
    await tick(d, 6, 30);
    await tick(d, 18, 0);
    expect((await sendOf(d)).state).toBe('SKIPPED');
    expect((await sendOf(d, 'PREMIUM')).state).toBe('SKIPPED');
    expect(d.sender.count('schedule')).toBe(0);
  });

  it('down all day (06:00 → 18:00): no run is created, nothing is sent', async () => {
    const d = newDay(auto());
    await tick(d, 18, 0);
    await tick(d, 23, 59);
    expect(await runOf(d)).toBeNull();
    expect(d.sender.calls).toHaveLength(0);
  });
});

describe('the IST day boundary', () => {
  it('23:59 → 00:00 → 06:14 on the next day: nothing is created for the new day; the old day is never sent', async () => {
    const d = newDay(auto());
    await tick(d, 6, 15);
    await tick(d, 6, 30); // drafts exist for the 23rd
    await prisma.digestRun.update({ where: { id: (await runOf(d))!.id }, data: { approval: 'HELD' } }); // so it stays unsent
    await tick(d, 23, 59);
    await tick(d, 0, 0, 24);
    await tick(d, 0, 1, 24);
    await tick(d, 6, 14, 24);
    expect(await runOf(d, 24)).toBeNull();
    expect(d.sender.count('schedule')).toBe(0);
    expect((await sendOf(d, 'FREE', 23)).state).toBe('SKIPPED');
    await tick(d, 6, 15, 24);
    expect((await runOf(d, 24))!.build).toBe('BUILDING');
  });

  it('restart at 06:20 with yesterday still SCHEDULED: its final check records what Mailercloud says, nothing is re-sent', async () => {
    const d = newDay(auto());
    await tick(d, 6, 15, 22);
    await tick(d, 6, 30, 22);
    await tick(d, 7, 30, 22); // scheduled on the 22nd, then the process died before any verify poll
    const y = await sendOf(d, 'FREE', 22);
    const yp = await sendOf(d, 'PREMIUM', 22);
    expect(y.state).toBe('SCHEDULED');
    d.sender.campaigns.get(y.mcCampaignId!)!.state = 'SENT';
    // PREMIUM stays "SCHEDULED" at Mailercloud (never confirmed).
    await tick(d, 6, 20, 23);
    expect((await sendOf(d, 'FREE', 22)).state).toBe('SENT');
    const p = await sendOf(d, 'PREMIUM', 22);
    expect(p.state).toBe('FAILED');
    expect(p.lastError).toMatch(/^not_confirmed_by_cutoff/);
    expect(schedulesById(d.sender)).toEqual({ [y.mcCampaignId!]: 1, [yp.mcCampaignId!]: 1 });
    // …and it is final: later ticks leave yesterday alone.
    const statusCalls = d.sender.count('status');
    await tick(d, 6, 21, 23);
    await tick(d, 6, 22, 23);
    expect(d.sender.count('status')).toBe(statusCalls);
  });
});

describe('doors racing the tick (one schedule per campaign, ever)', () => {
  it('Retry now pressed while the 07:30 tick is scheduling', async () => {
    const d = newDay(auto());
    await tick(d, 6, 15);
    await tick(d, 6, 30);
    d.sender.delayMs.schedule = 150;
    d.now = ist(7, 30);
    const run = (await runOf(d))!;
    await Promise.all([digestTick(deps(d)), advanceRun(run.id, 'retry', door(d, ist(7, 30)))]);
    await tick(d, 7, 31);
    const free = await sendOf(d);
    const premium = await sendOf(d, 'PREMIUM');
    expect(schedulesById(d.sender)).toEqual({ [free.mcCampaignId!]: 1, [premium.mcCampaignId!]: 1 });
    expect(d.sender.count('createDraft')).toBe(2);
  });

  it('Send now pressed at 07:10 while the tick runs: still one schedule per campaign', async () => {
    const d = newDay(auto());
    await tick(d, 6, 15);
    await tick(d, 6, 30);
    d.sender.delayMs.schedule = 150;
    d.now = ist(7, 10);
    const run = (await runOf(d))!;
    const [, sn] = await Promise.all([digestTick(deps(d)), advanceRun(run.id, 'send_now', door(d, ist(7, 10)))]);
    await tick(d, 7, 11);
    await tick(d, 7, 30);
    expect(sn.outcome).not.toBe('disabled');
    const free = await sendOf(d);
    const premium = await sendOf(d, 'PREMIUM');
    expect(schedulesById(d.sender)).toEqual({ [free.mcCampaignId!]: 1, [premium.mcCampaignId!]: 1 });
  });
});

describe('two processes (deploy overlap)', () => {
  it('both first see the day at 09:00 with a complaint hold in auto mode: neither schedules', async () => {
    const d = newDay(auto({ DIGEST_WEBHOOKS_ENABLED: 'true' }));
    // Yesterday: 5 complaints of 1000 delivered (0.5%) with webhook proof.
    const y = await prisma.digestRun.create({
      data: {
        portal: d.portal,
        runDate: runDate(22),
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
            mcCampaignName: `qa-${d.portal}-${audience}`,
            mcCampaignId: `${d.portal}-${audience}-y`,
            sendAfter: ist(7, 30, 22),
            sentConfirmedAt: ist(7, 40, 22),
            reached: 1000,
            targeted: 1000,
          })),
        },
      },
      include: { sends: true },
    });
    for (const s of y.sends) {
      await prisma.emailEvent.create({ data: { type: 'CAMPAIGN_SENT', sendId: s.id, mcCampaignId: s.mcCampaignId, dedupeKey: `${PORTAL_PREFIX}${s.id}-sent` } });
    }
    const free = y.sends.find((s) => s.audience === 'FREE')!;
    for (let i = 0; i < 5; i++) {
      await prisma.emailEvent.create({ data: { type: 'SPAM', sendId: free.id, emailHash: `qa${i}`, dedupeKey: `${PORTAL_PREFIX}${free.id}-spam-${i}` } });
    }
    d.sender.delayMs.health = 80;
    const one = createDigestTicker({ ...deps(d), now: () => ist(9, 0) });
    const two = createDigestTicker({ ...deps(d), now: () => ist(9, 0) });
    await Promise.all([one.tick(), two.tick()]);
    await Promise.all([one.tick(), two.tick()]);
    expect((await runOf(d))!.complaintCheck).toMatchObject({ held: true });
    expect(d.sender.count('schedule')).toBe(0);
    expect(d.mails.filter((m) => /spam-complaint rate/.test(m.subject))).toHaveLength(1);
  });

  it('"still waiting for approval" is emailed once even with two tickers at 08:30', async () => {
    const d = newDay();
    await tick(d, 6, 15);
    await tick(d, 6, 30);
    const before = d.mails.length;
    d.now = ist(8, 30);
    const one = createDigestTicker({ ...deps(d), now: () => ist(8, 30) });
    const two = createDigestTicker({ ...deps(d), now: () => ist(8, 30) });
    await Promise.all([one.tick(), two.tick()]);
    await Promise.all([one.tick(), two.tick()]);
    const nag = d.mails.slice(before).filter((m) => /still waiting/.test(m.subject));
    expect(nag.map((m) => m.to).sort()).toEqual(['a@team.test', 'p@team.test']);
  });
});

describe('the step claim is stamped with the live clock (a slow tick must not look abandoned)', () => {
  it('a tick that started at 07:30 but claims at 07:41 is not taken over by another process at 07:42', async () => {
    const d = newDay(auto());
    await tick(d, 6, 15);
    await tick(d, 6, 30);
    const run = (await runOf(d))!;
    d.sender.delayMs.schedule = 300;
    // Process A: its tick began at 07:30 but (after slow earlier steps) reaches the claim at 07:41.
    const a = advanceRun(run.id, 'cron', door(d, ist(7, 30), { clock: () => ist(7, 41) }));
    await new Promise((r) => setTimeout(r, 100)); // A holds FREE's claim, its schedule() is in flight
    // Process B ticks at 07:42: A's claim is one minute old, not eleven.
    const b = advanceRun(run.id, 'cron', door(d, ist(7, 42)));
    await Promise.all([a, b]);
    const free = await sendOf(d);
    expect(schedulesById(d.sender)[free.mcCampaignId!]).toBe(1);
  });
});

describe('health recovery after a FATAL schedule error reuses the saved campaign', () => {
  it('schedule 401 → FAILED; the next passing check schedules the SAME id once and never creates a second draft', async () => {
    const d = newDay(auto());
    await tick(d, 6, 15);
    await tick(d, 6, 30);
    d.sender.fail('schedule', 'FATAL', 2, { http: 401 });
    d.sender.fail('health', 'FATAL', 1, { http: 401 });
    await tick(d, 7, 15); // health fails FATAL
    await tick(d, 7, 30); // both schedules refused FATAL
    expect((await sendOf(d)).state).toBe('FAILED');
    const ids = [(await sendOf(d)).mcCampaignId!, (await sendOf(d, 'PREMIUM')).mcCampaignId!];
    await tick(d, 8, 14);
    expect(d.sender.count('health')).toBe(2);
    await tick(d, 8, 15); // hourly re-check passes → resume
    expect(d.sender.count('createDraft')).toBe(2);
    const by = schedulesById(d.sender);
    expect(by[ids[0]]).toBe(2); // the refused call + the one after recovery
    expect(by[ids[1]]).toBe(2);
    expect(Object.keys(by).sort()).toEqual([...ids].sort());
    expect((await sendOf(d)).state).toBe('SCHEDULED');
  });
});

describe('owner decision A, narrowed (owner, 2026-10-23): only a draft this database never tried to create waits for a person', () => {
  const HELD = 'Digest draft already in Mailercloud — held for approval';
  const heldMails = (d: Day) => d.mails.filter((m) => m.subject.includes(HELD));

  it('auto mode: a create whose reply was lost (our create marker exists) is adopted and sent normally — no hold, no alert', async () => {
    const d = newDay(auto());
    d.sender.fail('createDraft', 'AMBIGUOUS', 1, { applied: true });
    await tick(d, 6, 15);
    await tick(d, 6, 30); // FREE's create reached Mailercloud, the reply was lost
    await tick(d, 6, 31); // the retry looks the name up and adopts it as our own
    const free = await sendOf(d);
    expect(free.mcCampaignId).not.toBeNull();
    expect(free.adoptedDraftAt).toBeNull();
    expect(free.ownApprovalRequired).toBe(false);
    await tick(d, 7, 30);
    const premium = await sendOf(d, 'PREMIUM');
    expect(schedulesById(d.sender)).toEqual({ [free.mcCampaignId!]: 1, [premium.mcCampaignId!]: 1 });
    expect(d.sender.count('createDraft')).toBe(2);
    expect(heldMails(d)).toHaveLength(0);
    expect(((await runOf(d))!.alerts as Record<string, unknown>).adopted_existing).toBeUndefined();
  });

  it('auto mode, our marker, status unreadable at adoption: treated as our draft; the status is read again before the schedule', async () => {
    const d = newDay(auto());
    d.sender.fail('createDraft', 'AMBIGUOUS', 1, { applied: true });
    await tick(d, 6, 15);
    await tick(d, 6, 30);
    d.sender.fail('status', 'RETRYABLE', 1); // the adoption's status read fails
    await tick(d, 6, 31);
    const free = await sendOf(d);
    expect(free.mcCampaignId).not.toBeNull();
    expect(free.adoptedDraftAt).toBeNull();
    expect(free.scheduleAttemptedAt).not.toBeNull(); // the schedule step asks status() first
    const statusBefore = d.sender.count('status');
    await tick(d, 7, 30);
    expect(d.sender.count('status')).toBeGreaterThan(statusBefore);
    expect(schedulesById(d.sender)[free.mcCampaignId!]).toBe(1);
    expect(heldMails(d)).toHaveLength(0);
  });

  it('auto mode: a campaign this database never tried to create (a restore, or hand-made) waits for its own Approve and raises the alert', async () => {
    const d = newDay(auto());
    await tick(d, 6, 15);
    const run = (await runOf(d))!;
    const foreign = 'made-before-the-restore';
    d.sender.campaigns.set(foreign, { id: foreign, name: digestProviderCampaignName(d.portal, run.runDate, 'FREE'), state: 'DRAFT', input: {} as never });
    await tick(d, 6, 30); // first create: the lookup finds it — no create marker of ours predates it
    const free = await sendOf(d);
    expect(free.mcCampaignId).toBe(foreign);
    expect(free.adoptedDraftAt).not.toBeNull();
    expect(free.ownApprovalRequired).toBe(true);
    await tick(d, 7, 30);
    const premium = await sendOf(d, 'PREMIUM');
    expect(schedulesById(d.sender)).toEqual({ [premium.mcCampaignId!]: 1 }); // FREE waits for an Approve
    expect(d.sender.count('createDraft')).toBe(1);
    expect(heldMails(d).length).toBeGreaterThan(0);
    const banner = (await digestStatus({ portal: d.portal, now: ist(7, 31), cfg: d.c })).attention;
    expect(banner?.code).toBe('adopted_draft');
    expect(banner?.headline).toMatch(/which this system did not create \(e\.g\. after a database restore or a hand-made campaign\) — check it before approving/);
  });

  it('no marker of ours and the status unreadable: approval needed too', async () => {
    const d = newDay(auto());
    await tick(d, 6, 15);
    const run = (await runOf(d))!;
    const foreign = 'hand-made-unreadable';
    d.sender.campaigns.set(foreign, { id: foreign, name: digestProviderCampaignName(d.portal, run.runDate, 'FREE'), state: 'DRAFT', input: {} as never });
    d.sender.fail('status', 'RETRYABLE', 1);
    await tick(d, 6, 30);
    const free = await sendOf(d);
    expect(free.adoptedDraftAt).not.toBeNull();
    const alert = ((await runOf(d))!.alerts as Record<string, { providerState?: string; draft?: boolean }>).adopted_existing;
    expect(alert).toMatchObject({ providerState: 'UNKNOWN', draft: true });
    await tick(d, 7, 30);
    expect(schedulesById(d.sender)[foreign]).toBeUndefined();
  });

  it('QA: a first LOOKUP that fails (no create ever issued) does not turn a foreign draft into "ours" on the retry', async () => {
    const d = newDay(auto());
    await tick(d, 6, 15);
    const run = (await runOf(d))!;
    const foreign = 'made-before-the-restore-lookup-flaked';
    d.sender.campaigns.set(foreign, { id: foreign, name: digestProviderCampaignName(d.portal, run.runDate, 'FREE'), state: 'DRAFT', input: {} as never });
    d.sender.fail('findCampaignByName', 'RETRYABLE', 1); // Mailercloud blips on the very first lookup
    await tick(d, 6, 30);
    const freeName = digestProviderCampaignName(d.portal, run.runDate, 'FREE');
    expect([...d.sender.campaigns.values()].filter((c) => c.name === freeName).map((c) => c.id)).toEqual([foreign]); // no create of ours for FREE
    expect((await sendOf(d)).createAttemptedAt).toBeNull(); // the failed first lookup clears the marker its claim wrote
    await tick(d, 6, 31);
    await tick(d, 6, 35);
    const free = await sendOf(d);
    expect(free.mcCampaignId).toBe(foreign);
    expect(free.adoptedDraftAt).not.toBeNull();
    expect(free.ownApprovalRequired).toBe(true);
    await tick(d, 7, 30);
    expect(schedulesById(d.sender)[foreign]).toBeUndefined();
  });
});

describe('the banner uses the same "who must approve" rule as the runner (holds.ts)', () => {
  it('complaint-held auto-mode day, approved, then a later-rendered version waits for its own approval: the banner says so', async () => {
    const d = newDay(auto({ DIGEST_WEBHOOKS_ENABLED: 'true' }));
    await tick(d, 6, 15);
    await tick(d, 6, 30);
    const run = (await runOf(d))!;
    await prisma.digestRun.update({
      where: { id: run.id },
      data: {
        approval: 'APPROVED',
        approvedAt: ist(7, 0),
        complaintCheck: { checkedAt: ist(6, 15).toISOString(), thresholdPct: 0.3, held: true, previousRunDate: '2026-10-22', sends: [{ audience: 'FREE', complaints: 5, delivered: 1000, ratePct: 0.5 }] },
      },
    });
    // FREE was rendered after that approval (its ads were fixed late): it needs its own.
    await prisma.digestSend.update({ where: { id: (await sendOf(d)).id }, data: { ownApprovalRequired: true, approvedAt: null } });
    const r = await tick(d, 7, 30);
    expect(r.portals[0].did).toContain('FREE:wait:awaiting_variant_approval'); // the runner holds it …
    const banner = (await digestStatus({ portal: d.portal, now: ist(7, 31), cfg: d.c })).attention;
    expect(banner?.code).toBe('awaiting_approval'); // … and the banner says why
    expect(banner?.headline).toMatch(/Free digest is waiting for approval/);
  });
});

describe('the last clock look is AFTER the provider status read (issueSchedule)', () => {
  it('a status() call that crosses 17:00 stops the schedule; the marker goes back to what it was', async () => {
    const d = newDay(auto());
    await tick(d, 6, 15);
    await tick(d, 6, 30);
    const run = (await runOf(d))!;
    // An earlier schedule attempt left the marker; Mailercloud still shows the campaign as a draft.
    await prisma.digestSend.updateMany({ where: { runId: run.id }, data: { scheduleAttemptedAt: ist(7, 30) } });
    const clock = () => (d.sender.count('status') > 0 ? ist(17, 0) : ist(16, 59));
    const r = await advanceRun(run.id, 'retry', door(d, ist(16, 59), { clock }));
    expect(d.sender.count('status')).toBeGreaterThan(0);
    expect(d.sender.count('schedule')).toBe(0);
    expect(r.steps).toEqual(expect.arrayContaining(['FREE:wait:past_cutoff']));
    expect((await sendOf(d)).scheduleAttemptedAt).toEqual(ist(7, 30));
    expect((await sendOf(d)).stepClaimedAt).toBeNull();
  });
});
