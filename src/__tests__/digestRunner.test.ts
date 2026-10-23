import type { DigestAudience } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { parseDigestEnv, type DigestEnv } from '../lib/env';
import { advanceRun, ensureRun, type DigestTrigger } from '../services/digest/runner';
import type { BuildContent } from '../services/digest/renderer';
import { placeholderContent } from './digestPlaceholderContent';
import { FakeSender } from './digestFakeSender';

/**
 * Email digest task 3 (docs/EMAIL_DIGEST_DESIGN.md §2.1, §4, §8, §10): the
 * runner state machine against a scriptable FakeSender. Every gate is pinned
 * in both directions. Rows live under unique `test-digest-runner-*` portals
 * and are removed afterwards (DigestSend cascades from DigestRun).
 */

jest.spyOn(console, 'log').mockImplementation(() => undefined);

const PORTAL_PREFIX = 'test-digest-runner-';
const QUIET = { start: '23:00', end: '07:00' };
const IST_OFFSET_MIN = 5 * 60 + 30;
/** UTC instant of an IST wall-clock time on 23 Oct 2026 (or `day`). */
function ist(h: number, min = 0, day = 23): Date {
  return new Date(Date.UTC(2026, 9, day, h, min) - IST_OFFSET_MIN * 60 * 1000);
}

/** Live-capable config with complete audiences; approval off unless overridden. */
function cfg(over: NodeJS.ProcessEnv = {}): DigestEnv {
  return parseDigestEnv({
    DIGEST_ENABLED: 'true',
    DIGEST_SEND_LIVE: 'true',
    DIGEST_APPROVAL_REQUIRED: 'false',
    DIGEST_FREE_LIST_IDS: 'list-free',
    DIGEST_FREE_EXCLUDE_LIST_IDS: 'list-premium',
    DIGEST_PREMIUM_LIST_IDS: 'list-premium',
    DIGEST_POSTAL_ADDRESS: 'Test address, Kochi',
    ...over,
  });
}

let n = 0;
async function newRun(c: DigestEnv = cfg(), now = ist(6, 0)) {
  const portal = `${PORTAL_PREFIX}${Date.now()}-${++n}-${Math.floor(Math.random() * 1e6)}`;
  return ensureRun({ portal, now, cfg: c });
}

function step(runId: string, trigger: DigestTrigger, now: Date, sender: FakeSender, c: DigestEnv = cfg(), buildContent?: BuildContent) {
  return advanceRun(runId, trigger, { sender, now, cfg: c, quiet: QUIET, buildContent: buildContent ?? placeholderContent });
}

function sendOf(runId: string, audience: DigestAudience = 'FREE') {
  return prisma.digestSend.findUniqueOrThrow({ where: { runId_audience: { runId, audience } } });
}

async function alertsOf(runId: string): Promise<Record<string, unknown>> {
  const r = await prisma.digestRun.findUniqueOrThrow({ where: { id: runId } });
  return r.alerts as Record<string, unknown>;
}

/** Built + both drafts created at 06:30, nothing scheduled. */
async function createdRun(c: DigestEnv = cfg()) {
  const run = await newRun(c);
  const sender = new FakeSender();
  await step(run.id, 'cron', ist(6, 30), sender, c);
  return { run, sender };
}

afterAll(async () => {
  await prisma.digestRun.deleteMany({ where: { portal: { startsWith: PORTAL_PREFIX } } });
  await prisma.$disconnect();
});

describe('flags', () => {
  it('DIGEST_ENABLED off: nothing happens at all', async () => {
    const run = await newRun();
    const sender = new FakeSender();
    const r = await step(run.id, 'cron', ist(7, 30), sender, cfg({ DIGEST_ENABLED: 'false' }));
    expect(r.outcome).toBe('disabled');
    expect(sender.calls).toHaveLength(0);
    expect(await prisma.digestSend.count({ where: { runId: run.id } })).toBe(0);
  });

  it('DIGEST_SEND_LIVE off: drafts are created (they cannot send), schedule() is never called', async () => {
    const c = cfg({ DIGEST_SEND_LIVE: 'false' });
    const run = await newRun(c);
    const sender = new FakeSender();
    const r = await step(run.id, 'cron', ist(7, 30), sender, c);
    expect(sender.count('createDraft')).toBe(2);
    expect(sender.count('schedule')).toBe(0);
    expect(r.steps).toContain('FREE:wait:preview_only');
    expect(r.state).toBe('created');
    // Even the human doors cannot schedule with SEND_LIVE off.
    await step(run.id, 'send_now', ist(9, 0), sender, c);
    await step(run.id, 'retry', ist(9, 1), sender, c);
    expect(sender.count('schedule')).toBe(0);
  });

  it('DIGEST_SEND_LIVE on: schedules each variant once at the send time', async () => {
    const { run, sender } = await createdRun();
    const r = await step(run.id, 'cron', ist(7, 30), sender);
    expect(sender.count('schedule')).toBe(2);
    expect(r.state).toBe('scheduled');
  });
});

describe('fail-closed audience config', () => {
  it('Free without a premium exclude: build SKIPPED config_invalid, nothing created', async () => {
    const c = cfg({ DIGEST_FREE_EXCLUDE_LIST_IDS: '' });
    const run = await newRun(c);
    const sender = new FakeSender();
    const r = await step(run.id, 'cron', ist(6, 30), sender, c);
    expect(sender.count('createDraft')).toBe(0);
    expect(r.state).toBe('skipped');
    const row = await prisma.digestRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.skipReason).toBe('config_invalid');
    expect(Object.keys(await alertsOf(run.id))).toContain('config_invalid');
  });

  it('with the exclude, the Free draft carries it', async () => {
    const { sender } = await createdRun();
    const free = sender.draftInputs().find((d) => d.audience === 'FREE');
    expect(free?.target.excludeListIds).toEqual(['list-premium']);
  });

  it('an empty postal address stops the build', async () => {
    const c = cfg({ DIGEST_POSTAL_ADDRESS: '' });
    const run = await newRun(c);
    const sender = new FakeSender();
    await step(run.id, 'cron', ist(6, 30), sender, c);
    expect(sender.count('createDraft')).toBe(0);
  });
});

describe('quiet hours (never send in 23:00–07:00 IST)', () => {
  it('blocks a send at 06:59 IST even through Send now', async () => {
    const { run, sender } = await createdRun();
    const r = await step(run.id, 'send_now', ist(6, 59), sender);
    expect(sender.count('schedule')).toBe(0);
    expect(r.steps).toContain('FREE:wait:quiet_hours');
  });

  it('allows it at 07:00 IST', async () => {
    const { run, sender } = await createdRun();
    await step(run.id, 'send_now', ist(7, 0), sender);
    expect(sender.count('schedule')).toBe(2);
  });

  it('the cron waits for the planned send time (07:29 waits, 07:30 sends)', async () => {
    const { run, sender } = await createdRun();
    const r = await step(run.id, 'cron', ist(7, 29), sender);
    expect(r.steps).toContain('FREE:wait:waiting_send_time');
    expect(sender.count('schedule')).toBe(0);
    await step(run.id, 'cron', ist(7, 30), sender);
    expect(sender.count('schedule')).toBe(2);
  });
});

describe('cut-off 17:00 IST', () => {
  it('16:59 still attempts', async () => {
    const c0 = cfg({ DIGEST_SEND_LIVE: 'false' });
    const run = await newRun(c0);
    const sender = new FakeSender();
    await step(run.id, 'cron', ist(6, 30), sender, c0);
    await step(run.id, 'cron', ist(16, 59), sender);
    expect(sender.count('schedule')).toBe(2);
  });

  it('17:00 → every unscheduled variant SKIPPED, no provider call', async () => {
    const c0 = cfg({ DIGEST_SEND_LIVE: 'false' });
    const run = await newRun(c0);
    const sender = new FakeSender();
    await step(run.id, 'cron', ist(6, 30), sender, c0);
    const before = sender.calls.length;
    const r = await step(run.id, 'retry', ist(17, 0), sender);
    expect(sender.calls.length).toBe(before);
    expect(r.state).toBe('skipped');
    expect((await sendOf(run.id)).state).toBe('SKIPPED');
    const row = await prisma.digestRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.skipReason).toBe('cutoff_passed');
  });

  it('a run never built by the cut-off is SKIPPED', async () => {
    const run = await newRun();
    const sender = new FakeSender();
    const r = await step(run.id, 'cron', ist(17, 30), sender);
    expect(r.state).toBe('skipped');
    expect(sender.calls).toHaveLength(0);
    expect(await prisma.digestSend.count({ where: { runId: run.id } })).toBe(0);
  });

  it('never sends on a later day', async () => {
    const c0 = cfg({ DIGEST_SEND_LIVE: 'false' });
    const run = await newRun(c0);
    const sender = new FakeSender();
    await step(run.id, 'cron', ist(6, 30), sender, c0);
    await step(run.id, 'send_now', ist(9, 0, 24), sender);
    expect(sender.count('schedule')).toBe(0);
    expect((await sendOf(run.id, 'PREMIUM')).state).toBe('SKIPPED');
  });
});

describe('approval', () => {
  const approvalCfg = cfg({ DIGEST_APPROVAL_REQUIRED: 'true' });

  it('unapproved → no schedule; approved → schedule called once per variant', async () => {
    const run = await newRun(approvalCfg);
    expect(run.approval).toBe('PENDING');
    const sender = new FakeSender();
    const r = await step(run.id, 'cron', ist(7, 30), sender, approvalCfg);
    expect(r.steps).toContain('FREE:wait:awaiting_approval');
    expect(sender.count('createDraft')).toBe(2); // drafts are made ahead; they cannot send
    expect(sender.count('schedule')).toBe(0);
    await step(run.id, 'retry', ist(8, 0), sender, approvalCfg);
    expect(sender.count('schedule')).toBe(0);

    await prisma.digestRun.update({ where: { id: run.id }, data: { approval: 'APPROVED', approvedAt: ist(9, 0) } });
    await step(run.id, 'cron', ist(9, 1), sender, approvalCfg);
    await step(run.id, 'cron', ist(9, 2), sender, approvalCfg);
    expect(sender.count('schedule')).toBe(2);
  });

  it('still unapproved at the cut-off → SKIPPED not_approved', async () => {
    const run = await newRun(approvalCfg);
    const sender = new FakeSender();
    await step(run.id, 'cron', ist(7, 30), sender, approvalCfg);
    const r = await step(run.id, 'cron', ist(17, 0), sender, approvalCfg);
    expect(r.state).toBe('skipped');
    expect(sender.count('schedule')).toBe(0);
    const row = await prisma.digestRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.skipReason).toBe('not_approved');
  });

  it('HELD waits even when approval is not required', async () => {
    const { run, sender } = await createdRun();
    await prisma.digestRun.update({ where: { id: run.id }, data: { approval: 'HELD' } });
    const r = await step(run.id, 'send_now', ist(8, 0), sender);
    expect(r.steps).toContain('FREE:wait:held_by_editor');
    expect(sender.count('schedule')).toBe(0);
  });
});

describe('one digest per day', () => {
  it('ensureRun returns the same run for the same IST day; a second row is refused by the DB', async () => {
    const run = await newRun();
    const again = await ensureRun({ portal: run.portal, now: ist(16, 0), cfg: cfg() });
    expect(again.id).toBe(run.id);
    await expect(
      prisma.digestRun.create({ data: { portal: run.portal, runDate: run.runDate, windowStart: ist(0, 0) } }),
    ).rejects.toThrow();
  });

  it('after SCHEDULED, and after SENT, no door calls createDraft or schedule again', async () => {
    const { run, sender } = await createdRun();
    await step(run.id, 'cron', ist(7, 30), sender);
    expect(sender.count('schedule')).toBe(2);
    const r = await step(run.id, 'send_now', ist(7, 31), sender);
    expect(r.outcome).toBe('refused');
    await step(run.id, 'retry', ist(7, 32), sender);
    await step(run.id, 'health', ist(7, 33), sender);
    sender.setStatus({ state: 'SENT', targeted: 100, reached: 100 });
    await step(run.id, 'cron', ist(7, 45), sender);
    expect((await step(run.id, 'retry', ist(9, 0), sender)).state).toBe('sent');
    await step(run.id, 'cron', ist(10, 0), sender);
    expect(sender.count('schedule')).toBe(2);
    expect(sender.count('createDraft')).toBe(2);
  });
});

describe('two-step send: the stored campaign id is reused on every retry', () => {
  it('schedule fails twice → createDraft still called once, schedule always on the same id', async () => {
    const { run, sender } = await createdRun();
    const id = (await sendOf(run.id)).mcCampaignId;
    expect(id).toBeTruthy();
    sender.fail('schedule', 'RETRYABLE', 2, { http: 503 });
    await step(run.id, 'cron', ist(7, 30), sender); // FREE fails, PREMIUM fails
    await step(run.id, 'cron', ist(7, 31), sender); // both retry: succeed
    const free = await sendOf(run.id);
    expect(free.state).toBe('SCHEDULED');
    expect(free.mcCampaignId).toBe(id);
    expect(sender.count('createDraft')).toBe(2); // one per variant, ever
    const freeScheduleIds = sender.calls.filter((c) => c.method === 'schedule' && c.args[0] === id);
    expect(freeScheduleIds.length).toBe(2);
  });

  it('a create failure retries only the create; nothing is created twice', async () => {
    const run = await newRun();
    const sender = new FakeSender().fail('createDraft', 'RETRYABLE', 1, { http: 429 });
    await step(run.id, 'cron', ist(6, 30), sender); // FREE fails, PREMIUM ok
    expect((await sendOf(run.id)).state).toBe('PENDING');
    expect((await sendOf(run.id, 'PREMIUM')).state).toBe('CREATED');
    await step(run.id, 'cron', ist(6, 31), sender);
    expect((await sendOf(run.id)).state).toBe('CREATED');
    expect(sender.count('createDraft')).toBe(3);
    expect(sender.campaigns.size).toBe(2);
  });
});

describe('step claim', () => {
  it('a live claim blocks the step; a stale one (> 10 min) is taken over', async () => {
    const run = await newRun();
    const sender = new FakeSender().fail('createDraft', 'RETRYABLE', 2, { notSent: true });
    await step(run.id, 'cron', ist(6, 30), sender); // both PENDING, retry at 06:31
    await prisma.digestSend.updateMany({ where: { runId: run.id }, data: { stepClaimedAt: ist(6, 35) } });
    const r = await step(run.id, 'cron', ist(6, 40), sender);
    expect(r.steps).toContain('FREE:create:claimed_elsewhere');
    expect(sender.count('createDraft')).toBe(2);
    await step(run.id, 'cron', ist(6, 46), sender);
    expect(sender.count('createDraft')).toBe(4);
    expect((await sendOf(run.id)).state).toBe('CREATED');
  });

  it('two concurrent runners: createDraft runs once per variant', async () => {
    const run = await newRun();
    const sender = new FakeSender().fail('createDraft', 'RETRYABLE', 2, { notSent: true });
    await step(run.id, 'cron', ist(6, 30), sender);
    sender.delayMs.createDraft = 150;
    await Promise.all([step(run.id, 'retry', ist(6, 32), sender), step(run.id, 'retry', ist(6, 32), sender)]);
    expect(sender.count('createDraft')).toBe(4); // 2 failed + exactly 1 more per variant
    expect(sender.campaigns.size).toBe(2);
  });

  it('two concurrent runners: schedule runs once per variant', async () => {
    const { run, sender } = await createdRun();
    sender.delayMs.schedule = 150;
    await Promise.all([step(run.id, 'cron', ist(7, 30), sender), step(run.id, 'cron', ist(7, 30), sender)]);
    expect(sender.count('schedule')).toBe(2);
  });

  it('two concurrent builds freeze the content once', async () => {
    const run = await newRun();
    const sender = new FakeSender();
    await Promise.all([step(run.id, 'cron', ist(6, 30), sender), step(run.id, 'cron', ist(6, 30), sender)]);
    expect(await prisma.digestSend.count({ where: { runId: run.id } })).toBe(2);
  });
});

describe('error kinds', () => {
  it('FATAL (9002) is not retried by the tick; alert marker set; health recovery resumes', async () => {
    const run = await newRun();
    const sender = new FakeSender().fail('createDraft', 'FATAL', 2, { code: '9002', http: 400 });
    await step(run.id, 'cron', ist(6, 30), sender);
    const free = await sendOf(run.id);
    expect(free.state).toBe('FAILED');
    expect(free.lastErrorKind).toBe('FATAL');
    expect(free.nextAttemptAt).toBeNull();
    expect(free.lastError).not.toMatch(/@/); // fake error text contains an address
    expect(Object.keys(await alertsOf(run.id))).toContain('fatal');

    await step(run.id, 'cron', ist(6, 31), sender);
    await step(run.id, 'cron', ist(8, 0), sender);
    expect(sender.count('createDraft')).toBe(2);

    await step(run.id, 'health', ist(9, 0), sender);
    expect(sender.count('createDraft')).toBe(4);
    expect((await sendOf(run.id)).state).toBe('SCHEDULED');
  });

  it('FATAL on schedule: no retry; recovery schedules the SAME id', async () => {
    const { run, sender } = await createdRun();
    const id = (await sendOf(run.id)).mcCampaignId;
    sender.fail('schedule', 'FATAL', 2, { http: 401 });
    await step(run.id, 'cron', ist(7, 30), sender);
    await step(run.id, 'cron', ist(8, 30), sender);
    expect(sender.count('schedule')).toBe(2);
    await step(run.id, 'retry', ist(9, 0), sender);
    expect(sender.count('createDraft')).toBe(2);
    const free = await sendOf(run.id);
    expect(free.state).toBe('SCHEDULED');
    expect(free.mcCampaignId).toBe(id);
  });

  it('AMBIGUOUS create with no provider lookup: never re-created by the tick or health; alert names the draft', async () => {
    const run = await newRun();
    const sender = new FakeSender().fail('createDraft', 'AMBIGUOUS', 1, { applied: true });
    await step(run.id, 'cron', ist(6, 30), sender);
    const free = await sendOf(run.id);
    expect(free.state).toBe('FAILED');
    expect(free.lastErrorKind).toBe('AMBIGUOUS');
    const alert = (await alertsOf(run.id)).ambiguous_create as { campaignName: string };
    expect(alert.campaignName).toBe(free.mcCampaignName);
    await step(run.id, 'cron', ist(6, 31), sender);
    await step(run.id, 'health', ist(7, 0), sender);
    expect(sender.count('createDraft')).toBe(2); // FREE once (ambiguous), PREMIUM once
    // A human "Retry now" (after checking the provider UI) may create.
    await step(run.id, 'retry', ist(8, 0), sender);
    expect(sender.count('createDraft')).toBe(3);
  });

  it('AMBIGUOUS create with lookup, provider DID create it: the id is adopted, no second create', async () => {
    const run = await newRun();
    const sender = new FakeSender({ withLookup: true }).fail('createDraft', 'AMBIGUOUS', 1, { applied: true });
    await step(run.id, 'cron', ist(6, 30), sender);
    expect((await sendOf(run.id)).state).toBe('PENDING');
    await step(run.id, 'retry', ist(6, 31), sender); // even the human door looks up first
    const free = await sendOf(run.id);
    expect(free.state).toBe('CREATED');
    expect(sender.count('createDraft')).toBe(2);
    expect(sender.campaigns.size).toBe(2);
    expect(sender.campaigns.get(free.mcCampaignId as string)?.name).toBe(free.mcCampaignName);
  });

  it('AMBIGUOUS create with lookup, provider did NOT create it: safe to create again', async () => {
    const run = await newRun();
    const sender = new FakeSender({ withLookup: true }).fail('createDraft', 'AMBIGUOUS', 1);
    await step(run.id, 'cron', ist(6, 30), sender);
    await step(run.id, 'cron', ist(6, 31), sender);
    expect((await sendOf(run.id)).state).toBe('CREATED');
    // Asked before each first create (FREE, PREMIUM) and again before the FREE re-create.
    expect(sender.count('findCampaignByName')).toBe(3);
    expect(sender.campaigns.size).toBe(2);
  });

  it('AMBIGUOUS schedule that went through: status is checked and schedule is not issued again', async () => {
    const { run, sender } = await createdRun();
    sender.fail('schedule', 'AMBIGUOUS', 1, { applied: true });
    await step(run.id, 'cron', ist(7, 30), sender); // FREE ambiguous, PREMIUM ok
    expect((await sendOf(run.id)).state).toBe('CREATED');
    await step(run.id, 'cron', ist(7, 31), sender);
    expect((await sendOf(run.id)).state).toBe('SCHEDULED');
    expect(sender.count('schedule')).toBe(2);
  });
});

describe('retry schedule', () => {
  it('next attempts are exactly +1, +5, +15 min, then hourly; the tick waits in between', async () => {
    const run = await newRun();
    const sender = new FakeSender().fail('createDraft', 'RETRYABLE', 100, { notSent: true });
    const freeNext = async () => (await sendOf(run.id)).nextAttemptAt?.toISOString();

    await step(run.id, 'cron', ist(6, 30), sender);
    expect(await freeNext()).toBe(ist(6, 31).toISOString());
    const calls = sender.count('createDraft');
    await step(run.id, 'cron', new Date(ist(6, 30).getTime() + 30_000), sender); // 06:30:30 — waits
    expect(sender.count('createDraft')).toBe(calls);

    await step(run.id, 'cron', ist(6, 31), sender);
    expect(await freeNext()).toBe(ist(6, 35).toISOString());
    await step(run.id, 'cron', ist(6, 35), sender);
    expect(await freeNext()).toBe(ist(6, 45).toISOString());
    await step(run.id, 'cron', ist(6, 45), sender);
    expect(await freeNext()).toBe(ist(7, 45).toISOString());
    await step(run.id, 'cron', ist(7, 45), sender);
    expect(await freeNext()).toBe(ist(8, 45).toISOString());
    const free = await sendOf(run.id);
    expect(free.attempts).toBe(5);
    expect(free.firstFailureAt?.toISOString()).toBe(ist(6, 30).toISOString());
  });

  it('when the next schedule attempt would be at/after 17:00, nothing more is called and the cut-off sweep skips it after asking the provider', async () => {
    const { run, sender } = await createdRun();
    sender.fail('schedule', 'RETRYABLE', 100);
    await step(run.id, 'send_now', ist(15, 0), sender); // first failure 15:00
    for (const [h, m] of [[15, 1], [15, 5], [15, 15]] as const) await step(run.id, 'cron', ist(h, m), sender);
    expect((await sendOf(run.id)).nextAttemptAt?.toISOString()).toBe(ist(16, 15).toISOString());
    await step(run.id, 'cron', ist(16, 15), sender); // next would be 17:15
    let free = await sendOf(run.id);
    expect(free.state).toBe('CREATED');
    expect(free.nextAttemptAt?.toISOString()).toBe(ist(17, 0).toISOString());
    expect(free.attempts).toBe(5);
    const n0 = sender.count('schedule');
    await step(run.id, 'cron', ist(16, 30), sender);
    expect(sender.count('schedule')).toBe(n0);

    await step(run.id, 'cron', ist(17, 0), sender); // provider says DRAFT → provably unsent → SKIPPED
    free = await sendOf(run.id);
    expect(free.state).toBe('SKIPPED');
    const row = await prisma.digestRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.skipReason).toBe('cutoff_passed');
    expect(Object.keys(row.alerts as object)).toEqual(expect.arrayContaining(['retrying', 'skipped']));
    expect(sender.count('schedule')).toBe(n0);
  });

  it('a create failure retries only the create; when create runs out of time the variant is SKIPPED (no id, nothing could send)', async () => {
    const run = await newRun();
    const sender = new FakeSender().fail('createDraft', 'RETRYABLE', 100, { notSent: true });
    await step(run.id, 'send_now', ist(16, 0), sender);
    await step(run.id, 'cron', ist(16, 1), sender);
    await step(run.id, 'cron', ist(16, 5), sender);
    await step(run.id, 'cron', ist(16, 15), sender); // next would be 17:15
    expect((await sendOf(run.id)).state).toBe('SKIPPED');
  });
});

describe('frozen content', () => {
  it('a late retry sends the SAME stored html, never a rebuild', async () => {
    const run = await newRun();
    const v1: BuildContent = async ({ audience }) => ({
      subject: `v1 ${audience}`,
      preheader: 'p1',
      html: `<p>frozen-v1-${audience}</p>`,
      text: 't1',
    });
    const v2: BuildContent = async ({ audience }) => ({
      subject: `v2 ${audience}`,
      preheader: 'p2',
      html: `<p>REBUILT-v2-${audience}</p>`,
      text: 't2',
    });
    const sender = new FakeSender().fail('createDraft', 'RETRYABLE', 2, { notSent: true });
    await step(run.id, 'cron', ist(6, 30), sender, cfg(), v1);
    await step(run.id, 'retry', ist(15, 30), sender, cfg(), v2);
    const inputs = sender.draftInputs();
    expect(inputs).toHaveLength(4);
    for (const d of inputs) expect(d.html).toBe(`<p>frozen-v1-${d.audience}</p>`);
    const free = await sendOf(run.id);
    expect(free.html).toBe('<p>frozen-v1-FREE</p>');
    expect(free.subject).toBe('v1 FREE');
    expect(free.htmlBytes).toBe(Buffer.byteLength('<p>frozen-v1-FREE</p>'));
  });
});

describe('verification after schedule', () => {
  async function scheduledRun() {
    const { run, sender } = await createdRun();
    await step(run.id, 'cron', ist(7, 30), sender);
    return { run, sender };
  }

  it('first poll at +10 min; SENT with full reach → SENT with counts', async () => {
    const { run, sender } = await scheduledRun();
    expect((await sendOf(run.id)).nextAttemptAt?.toISOString()).toBe(ist(7, 40).toISOString());
    sender.setStatus({ state: 'SENT', targeted: 120, reached: 120 });
    await step(run.id, 'cron', ist(7, 35), sender);
    expect(sender.count('status')).toBe(0);
    const r = await step(run.id, 'cron', ist(7, 40), sender);
    const free = await sendOf(run.id);
    expect(free.state).toBe('SENT');
    expect([free.targeted, free.reached, free.sentVia]).toEqual([120, 120, 'status_poll']);
    expect(r.state).toBe('sent');
  });

  it('reached < targeted → PARTIALLY_SENT, alert, never re-sent', async () => {
    const { run, sender } = await scheduledRun();
    sender.setStatus({ state: 'SENT', targeted: 100, reached: 60 });
    const r = await step(run.id, 'cron', ist(7, 40), sender);
    expect(r.state).toBe('partially_sent');
    expect((await sendOf(run.id)).reached).toBe(60);
    expect(Object.keys(await alertsOf(run.id))).toContain('partial_send');
    await step(run.id, 'retry', ist(8, 0), sender);
    expect(sender.count('schedule')).toBe(2);
  });

  it('still sending → polled again later; unconfirmed at the cut-off → FAILED not_confirmed_by_cutoff', async () => {
    const { run, sender } = await scheduledRun();
    sender.setStatus({ state: 'SENDING', targeted: null, reached: null });
    await step(run.id, 'cron', ist(7, 40), sender);
    const s1 = await sendOf(run.id);
    expect(s1.state).toBe('SCHEDULED');
    expect(s1.nextAttemptAt?.toISOString()).toBe(ist(8, 0).toISOString());
    const r = await step(run.id, 'cron', ist(17, 0), sender);
    const free = await sendOf(run.id);
    expect(free.state).toBe('FAILED');
    expect(free.lastError).toBe('not_confirmed_by_cutoff');
    expect(r.state).toBe('failed');
    expect(sender.count('schedule')).toBe(2);
  });

  it('a status error changes nothing', async () => {
    const { run, sender } = await scheduledRun();
    sender.fail('status', 'RETRYABLE', 2);
    await step(run.id, 'cron', ist(7, 40), sender);
    const free = await sendOf(run.id);
    expect(free.state).toBe('SCHEDULED');
    expect(free.attempts).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* QA round 1: no path may schedule (or create) the same variant twice */
/* ------------------------------------------------------------------ */

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** schedule() calls made for one campaign id. */
function schedulesFor(sender: FakeSender, campaignId: string | null): number {
  return sender.calls.filter((c) => c.method === 'schedule' && c.args[0] === campaignId).length;
}

describe('QA #1 stale snapshot', () => {
  it('a slow runner reaching PREMIUM after Send now got AMBIGUOUS asks the provider and does not schedule again', async () => {
    const { run, sender } = await createdRun();
    const premiumId = (await sendOf(run.id, 'PREMIUM')).mcCampaignId;
    // Call 1 (runner A, FREE) is slow and succeeds; call 2 (runner B, PREMIUM) is applied but its reply is lost.
    sender.delays('schedule', [300, 0]).pass('schedule', 1).fail('schedule', 'AMBIGUOUS', 1, { applied: true });
    const a = step(run.id, 'retry', ist(7, 30), sender);
    await waitFor(() => sender.count('schedule') >= 1);
    const b = await step(run.id, 'send_now', ist(7, 30), sender);
    expect(b.steps).toContain('FREE:schedule:claimed_elsewhere');
    await a;
    expect(schedulesFor(sender, premiumId)).toBe(1);
    expect((await sendOf(run.id, 'PREMIUM')).state).toBe('SCHEDULED');
    expect((await sendOf(run.id, 'FREE')).state).toBe('SCHEDULED');
  });
});

describe('QA #2 crash between schedule() and saving SCHEDULED', () => {
  async function crashedAfterSchedule() {
    const { run, sender } = await createdRun();
    const free = await sendOf(run.id);
    await sender.schedule(free.mcCampaignId as string, 'now'); // the call that went out before the crash
    await prisma.digestSend.update({
      where: { id: free.id },
      data: { stepClaimedAt: ist(7, 30), scheduleAttemptedAt: ist(7, 30) },
    });
    return { run, sender, freeId: free.mcCampaignId };
  }

  it('the stale-claim takeover asks status() and adopts SCHEDULED without calling schedule() again', async () => {
    const { run, sender, freeId } = await crashedAfterSchedule();
    const r1 = await step(run.id, 'cron', ist(7, 35), sender); // claim still live
    expect(r1.steps).toContain('FREE:schedule:claimed_elsewhere');
    const r2 = await step(run.id, 'cron', ist(7, 41), sender); // > 10 min: taken over
    expect(r2.steps).toContain('FREE:schedule:already_accepted');
    expect(schedulesFor(sender, freeId)).toBe(1);
    expect((await sendOf(run.id)).state).toBe('SCHEDULED');
  });

  it('status unknown → no schedule(), schedule_unconfirmed alert; still unknown at 17:00 → FAILED not_confirmed_by_cutoff', async () => {
    const { run, sender, freeId } = await crashedAfterSchedule();
    sender.fail('status', 'RETRYABLE', 100);
    await step(run.id, 'retry', ist(7, 41), sender);
    expect(schedulesFor(sender, freeId)).toBe(1);
    expect((await sendOf(run.id)).state).toBe('CREATED');
    expect(Object.keys(await alertsOf(run.id))).toContain('schedule_unconfirmed');
    await step(run.id, 'retry', ist(9, 0), sender);
    expect(schedulesFor(sender, freeId)).toBe(1);
    await step(run.id, 'cron', ist(17, 0), sender);
    const free = await sendOf(run.id);
    expect(free.state).toBe('FAILED');
    expect(free.lastError).toMatch(/^not_confirmed_by_cutoff/);
    expect(schedulesFor(sender, freeId)).toBe(1);
  });
});

describe('QA #3 provider-reported FAILED is final for the day', () => {
  it('Retry now / Send now / health refuse with a reason; reach unknown stays null', async () => {
    const { run, sender } = await createdRun();
    await step(run.id, 'cron', ist(7, 30), sender);
    sender.setStatus({ state: 'FAILED', targeted: null, reached: null });
    await step(run.id, 'cron', ist(7, 40), sender);
    const free = await sendOf(run.id);
    expect(free.state).toBe('FAILED');
    expect(free.lastError).toBe('provider_failed: reach unknown');
    expect(free.reached).toBeNull();
    expect(Object.keys(await alertsOf(run.id))).toContain('provider_failed');

    const r = await step(run.id, 'retry', ist(8, 0), sender);
    expect(r.outcome).toBe('refused');
    expect(r.reason).toMatch(/provider_failed/);
    await step(run.id, 'health', ist(8, 1), sender);
    await step(run.id, 'send_now', ist(8, 2), sender);
    expect(sender.count('schedule')).toBe(2);
    // The cut-off leaves it FAILED (not SKIPPED) — it may have reached people.
    await step(run.id, 'cron', ist(17, 0), sender);
    expect((await sendOf(run.id)).state).toBe('FAILED');
  });

  it('provider FAILED with a KNOWN reach > 0 → PARTIALLY_SENT; known 0 → FAILED nobody reached', async () => {
    const a = await createdRun();
    await step(a.run.id, 'cron', ist(7, 30), a.sender);
    a.sender.setStatus({ state: 'FAILED', targeted: 100, reached: 40 });
    await step(a.run.id, 'cron', ist(7, 40), a.sender);
    expect((await sendOf(a.run.id)).state).toBe('PARTIALLY_SENT');

    const b = await createdRun();
    await step(b.run.id, 'cron', ist(7, 30), b.sender);
    b.sender.setStatus({ state: 'FAILED', targeted: 100, reached: 0 });
    await step(b.run.id, 'cron', ist(7, 40), b.sender);
    expect((await sendOf(b.run.id)).lastError).toBe('provider_failed: nobody reached');
  });

  it('SENT with unknown counts is SENT, not partial', async () => {
    const { run, sender } = await createdRun();
    await step(run.id, 'cron', ist(7, 30), sender);
    sender.setStatus({ state: 'SENT', targeted: 100, reached: null });
    await step(run.id, 'cron', ist(7, 40), sender);
    expect((await sendOf(run.id)).state).toBe('SENT');
  });
});

describe('QA #4 crash after createDraft before the id was saved', () => {
  async function crashedAfterCreate(withLookup: boolean) {
    const run = await newRun();
    const sender = new FakeSender({ withLookup }).fail('createDraft', 'RETRYABLE', 2, { notSent: true }); // pre-send: marker cleared
    await step(run.id, 'cron', ist(6, 30), sender);
    const free = await sendOf(run.id);
    expect(free.createAttemptedAt).toBeNull();
    const made = await sender.createDraft({ ...sender.draftInputs()[0], name: free.mcCampaignName });
    await prisma.digestSend.update({ where: { id: free.id }, data: { stepClaimedAt: ist(6, 31), createAttemptedAt: ist(6, 31) } });
    return { run, sender, madeId: made.campaignId };
  }

  it('with a lookup: the takeover adopts the existing draft; no second create', async () => {
    const { run, sender, madeId } = await crashedAfterCreate(true);
    const before = sender.count('createDraft');
    await step(run.id, 'cron', ist(6, 45), sender);
    const free = await sendOf(run.id);
    expect(free.mcCampaignId).toBe(madeId);
    expect(free.state).toBe('CREATED');
    expect(sender.count('createDraft')).toBe(before + 1); // only PREMIUM's first create
    expect([...sender.campaigns.values()].filter((c) => c.name === free.mcCampaignName)).toHaveLength(1);
  });

  it('without a lookup: FAILED + ambiguous_create alert; the tick never creates', async () => {
    const { run, sender } = await crashedAfterCreate(false);
    await step(run.id, 'cron', ist(6, 45), sender);
    await step(run.id, 'cron', ist(7, 45), sender);
    const free = await sendOf(run.id);
    expect(free.state).toBe('FAILED');
    expect(free.mcCampaignId).toBeNull();
    expect(Object.keys(await alertsOf(run.id))).toContain('ambiguous_create');
    expect(sender.draftInputs().filter((d) => d.name === free.mcCampaignName)).toHaveLength(2); // 1 failed + the crashed one
  });

  it('a 5xx create (may have been applied) keeps the marker: no blind retry without a lookup', async () => {
    const run = await newRun();
    const sender = new FakeSender().fail('createDraft', 'RETRYABLE', 1, { http: 503 });
    await step(run.id, 'cron', ist(6, 30), sender);
    const free = await sendOf(run.id);
    expect(free.state).toBe('FAILED');
    expect(free.createAttemptedAt).not.toBeNull();
    await step(run.id, 'cron', ist(6, 31), sender);
    expect(sender.count('createDraft')).toBe(2);
  });

  it('a RETRYABLE create with NO http status but not marked notSent (socket reset after send) keeps the marker', async () => {
    const run = await newRun();
    const sender = new FakeSender().fail('createDraft', 'RETRYABLE', 1); // http null, notSent false
    await step(run.id, 'cron', ist(6, 30), sender);
    const free = await sendOf(run.id);
    expect(free.state).toBe('FAILED');
    expect(free.createAttemptedAt).not.toBeNull();
    await step(run.id, 'cron', ist(6, 31), sender);
    await step(run.id, 'cron', ist(6, 45), sender);
    expect(sender.count('createDraft')).toBe(2); // FREE once (no blind retry) + PREMIUM once
  });
});

describe('QA #5 cut-off sweep asks the provider before calling anything skipped', () => {
  it('AMBIGUOUS schedule that went out → found SENT at 17:00, not SKIPPED', async () => {
    const { run, sender } = await createdRun();
    sender.fail('schedule', 'AMBIGUOUS', 2, { applied: true });
    await step(run.id, 'cron', ist(7, 30), sender);
    expect((await sendOf(run.id)).state).toBe('CREATED');
    sender.setStatus({ state: 'SENT', targeted: 10, reached: 10 });
    const r = await step(run.id, 'cron', ist(17, 0), sender);
    expect((await sendOf(run.id)).state).toBe('SENT');
    expect(r.state).toBe('sent');
    expect(sender.count('schedule')).toBe(2);
  });

  it('marker set but status unknown at 17:00 → FAILED not_confirmed_by_cutoff + alert, not SKIPPED', async () => {
    const { run, sender } = await createdRun();
    sender.fail('schedule', 'AMBIGUOUS', 2, { applied: true });
    await step(run.id, 'cron', ist(7, 30), sender);
    sender.fail('status', 'RETRYABLE', 10);
    await step(run.id, 'cron', ist(17, 0), sender);
    const free = await sendOf(run.id);
    expect(free.state).toBe('FAILED');
    expect(free.lastError).toMatch(/^not_confirmed_by_cutoff/);
    expect(Object.keys(await alertsOf(run.id))).toContain('not_confirmed_by_cutoff');
  });

  it('marker set and the provider says DRAFT → SKIPPED (provably unsent)', async () => {
    const { run, sender } = await createdRun();
    sender.fail('schedule', 'AMBIGUOUS', 2); // not applied
    await step(run.id, 'cron', ist(7, 30), sender);
    await step(run.id, 'cron', ist(17, 0), sender);
    expect((await sendOf(run.id)).state).toBe('SKIPPED');
  });
});

describe('QA #6 fresh-clock re-check right before schedule()', () => {
  it('a slow create that crosses 17:00 does not schedule', async () => {
    const run = await newRun();
    const sender = new FakeSender();
    const r = await advanceRun(run.id, 'send_now', {
      sender,
      now: ist(16, 59),
      clock: () => (sender.count('createDraft') > 0 ? ist(17, 0) : ist(16, 59)),
      cfg: cfg(),
      quiet: QUIET,
      buildContent: placeholderContent,
    });
    expect(sender.count('createDraft')).toBe(2);
    expect(sender.count('schedule')).toBe(0);
    expect(r.steps).toContain('FREE:wait:past_cutoff');
    expect((await sendOf(run.id)).scheduleAttemptedAt).toBeNull();
  });

  it('a slow create that crosses into quiet hours does not schedule', async () => {
    const run = await newRun();
    const sender = new FakeSender();
    const r = await advanceRun(run.id, 'send_now', {
      sender,
      now: ist(11, 59),
      clock: () => (sender.count('createDraft') > 0 ? ist(12, 0) : ist(11, 59)),
      cfg: cfg(),
      quiet: { start: '12:00', end: '07:00' },
      buildContent: placeholderContent,
    });
    expect(sender.count('schedule')).toBe(0);
    expect(r.steps).toContain('FREE:wait:quiet_hours');
  });
});

describe('QA #7 per-step retry bookkeeping', () => {
  it('a schedule failure hours after a create failure starts its own +1/+5/+15 sequence', async () => {
    const run = await newRun();
    const sender = new FakeSender().fail('createDraft', 'RETRYABLE', 1, { notSent: true });
    await step(run.id, 'cron', ist(6, 30), sender); // FREE create fails
    await step(run.id, 'cron', ist(6, 31), sender); // FREE created
    let free = await sendOf(run.id);
    expect([free.stepAttempts, free.stepFirstFailureAt]).toEqual([0, null]);

    sender.fail('schedule', 'RETRYABLE', 1);
    await step(run.id, 'cron', ist(9, 0), sender); // FREE schedule fails
    free = await sendOf(run.id);
    expect(free.nextAttemptAt?.toISOString()).toBe(ist(9, 1).toISOString());
    expect(free.stepAttempts).toBe(1);
    expect(free.stepFirstFailureAt?.toISOString()).toBe(ist(9, 0).toISOString());
    expect(free.attempts).toBe(2); // total, for display
    expect(free.firstFailureAt?.toISOString()).toBe(ist(6, 30).toISOString());
  });
});
