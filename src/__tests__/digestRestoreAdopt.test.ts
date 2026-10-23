import { randomBytes } from 'node:crypto';
import request from 'supertest';
import type { DigestAudience } from '@prisma/client';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { parseDigestEnv, type DigestEnv } from '../lib/env';
import { advanceRun, digestProviderCampaignName, ensureRun, type DigestTrigger } from '../services/digest/runner';
import { alertCopy } from '../services/digest/alerts';
import type { ProviderCampaignState } from '../services/digest/sender';
import { placeholderContent } from './digestPlaceholderContent';
import { FakeSender } from './digestFakeSender';

/**
 * QA O1 (owner-approved 2026-10-23): a database restored mid-day must not send
 * a second digest.
 *
 * The backup runs at 02:20 IST and the build at 06:30, so a restored database
 * never holds today's run; `ensureRun` makes a fresh one whose write-ahead
 * markers are all null. Campaign names are therefore deterministic per portal
 * + date + audience, and the runner asks the provider (`findCampaignByName`)
 * before EVERY first create, so the campaign the lost run sent this morning is
 * found and adopted. Its provider status drives the variant; schedule() is
 * never called on a campaign the provider reports as accepted or sent.
 *
 * Rows live under unique `test-digest-restore-*` portals (cascade-deleted).
 */

jest.spyOn(console, 'log').mockImplementation(() => undefined);

const PORTAL_PREFIX = 'test-digest-restore-';
const QUIET = { start: '23:00', end: '07:00' };
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
function ist(h: number, min = 0, day = 23): Date {
  return new Date(Date.UTC(2026, 9, day, h, min) - IST_OFFSET_MS);
}

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
const newPortal = () => `${PORTAL_PREFIX}${Date.now()}-${++n}-${Math.floor(Math.random() * 1e6)}`;

function step(runId: string, trigger: DigestTrigger, now: Date, sender: FakeSender, c: DigestEnv = cfg()) {
  return advanceRun(runId, trigger, { sender, now, cfg: c, quiet: QUIET, buildContent: placeholderContent, alerts: false });
}

function sendOf(runId: string, audience: DigestAudience = 'FREE') {
  return prisma.digestSend.findUniqueOrThrow({ where: { runId_audience: { runId, audience } } });
}

async function alertsOf(runId: string): Promise<Record<string, Record<string, unknown>>> {
  const r = await prisma.digestRun.findUniqueOrThrow({ where: { id: runId } });
  return r.alerts as Record<string, Record<string, unknown>>;
}

/** Puts a campaign with today's name for `audience` into the fake provider, as a lost run would have left it. */
function seedProvider(sender: FakeSender, portal: string, audience: DigestAudience, state: ProviderCampaignState, day = 23): string {
  const id = `fake-preexisting-${audience}-${randomBytes(4).toString('hex')}`;
  const name = digestProviderCampaignName(portal, new Date(Date.UTC(2026, 9, day)), audience);
  sender.campaigns.set(id, { id, name, state, input: {} as never });
  return id;
}

/** Simulates "restore from the 02:20 backup": today's run (and its sends) never existed in this database. */
async function restoreWithoutTodaysRun(runId: string): Promise<void> {
  await prisma.digestRun.delete({ where: { id: runId } });
}

afterAll(async () => {
  await prisma.digestRun.deleteMany({ where: { portal: { startsWith: PORTAL_PREFIX } } });
  await prisma.$disconnect();
});

describe('campaign names: date + audience (+ portal unless taxscan), no run id', () => {
  it('taxscan has no portal part; other portals do; the same inputs always give the same name', () => {
    const d = new Date(Date.UTC(2026, 9, 23));
    expect(digestProviderCampaignName('taxscan', d, 'FREE')).toBe('TS-DIGEST-2026-10-23-FREE');
    expect(digestProviderCampaignName('taxscan', d, 'PREMIUM')).toBe('TS-DIGEST-2026-10-23-PREMIUM');
    expect(digestProviderCampaignName('academy', d, 'FREE')).toBe('TS-DIGEST-academy-2026-10-23-FREE');
    expect(digestProviderCampaignName('taxscan', d, 'FREE')).toBe(digestProviderCampaignName('taxscan', new Date(d), 'FREE'));
  });

  it('a fresh run for the same day computes the same names as the run it replaces', async () => {
    const portal = newPortal();
    const a = await ensureRun({ portal, now: ist(6, 0), cfg: cfg() });
    const sender = new FakeSender({ withLookup: true });
    await step(a.id, 'cron', ist(6, 30), sender);
    const before = (await prisma.digestSend.findMany({ where: { runId: a.id }, orderBy: { audience: 'asc' } })).map((s) => s.mcCampaignName);
    await restoreWithoutTodaysRun(a.id);
    const b = await ensureRun({ portal, now: ist(9, 0), cfg: cfg() });
    expect(b.id).not.toBe(a.id);
    await step(b.id, 'cron', ist(9, 0), sender);
    const after = (await prisma.digestSend.findMany({ where: { runId: b.id }, orderBy: { audience: 'asc' } })).map((s) => s.mcCampaignName);
    expect(after).toEqual(before);
    expect(after).toEqual([`TS-DIGEST-${portal}-2026-10-23-FREE`, `TS-DIGEST-${portal}-2026-10-23-PREMIUM`]);
  });
});

describe('restore end to end: today was already sent, the database forgot', () => {
  it('a fresh run adopts the SENT campaigns and sends nothing', async () => {
    const portal = newPortal();
    const sender = new FakeSender({ withLookup: true });
    // The morning as it really happened: built 06:30, sent 07:30, confirmed.
    const lost = await ensureRun({ portal, now: ist(6, 0), cfg: cfg() });
    await step(lost.id, 'cron', ist(6, 30), sender);
    await step(lost.id, 'cron', ist(7, 30), sender);
    for (const c of sender.campaigns.values()) c.state = 'SENT';
    await step(lost.id, 'cron', ist(7, 41), sender);
    expect((await sendOf(lost.id)).state).toBe('SENT');
    expect(sender.count('createDraft')).toBe(2);
    expect(sender.count('schedule')).toBe(2);

    // 11:00: the database is restored from 02:20 and the scheduler carries on.
    await restoreWithoutTodaysRun(lost.id);
    const fresh = await ensureRun({ portal, now: ist(11, 0), cfg: cfg() });
    const r = await step(fresh.id, 'cron', ist(11, 0), sender);

    expect(sender.count('createDraft')).toBe(2); // no second campaign
    expect(sender.count('schedule')).toBe(2); // nothing sent again
    expect(sender.campaigns.size).toBe(2);
    for (const a of ['FREE', 'PREMIUM'] as const) {
      const s = await sendOf(fresh.id, a);
      expect(s.state).toBe('SENT');
      expect([...sender.campaigns.values()].find((c) => c.id === s.mcCampaignId)?.name).toBe(s.mcCampaignName);
    }
    expect(r.state).toBe('sent');
    expect(r.steps).toContain('FREE:create:adopted_existing:accepted');
    expect((await alertsOf(fresh.id)).adopted_existing).toMatchObject({ providerState: 'SENT' });

    // Every later door changes nothing.
    for (const [t, at] of [['cron', ist(12, 0)], ['retry', ist(12, 1)], ['send_now', ist(12, 2)], ['cron', ist(17, 0)]] as const) {
      await step(fresh.id, t, at, sender);
    }
    expect(sender.count('createDraft')).toBe(2);
    expect(sender.count('schedule')).toBe(2);
  });
});

describe('fresh run, provider already has today\'s campaign', () => {
  async function freshRun(state: ProviderCampaignState, c: DigestEnv = cfg()) {
    const portal = newPortal();
    const sender = new FakeSender({ withLookup: true });
    const ids = { FREE: seedProvider(sender, portal, 'FREE', state), PREMIUM: seedProvider(sender, portal, 'PREMIUM', state) };
    const run = await ensureRun({ portal, now: ist(6, 0), cfg: c });
    return { run, sender, ids, c };
  }

  it('SENT → adopted, verified SENT, never scheduled', async () => {
    const { run, sender, ids } = await freshRun('SENT');
    await step(run.id, 'cron', ist(6, 30), sender);
    expect(sender.count('createDraft')).toBe(0);
    expect(sender.count('schedule')).toBe(0);
    const s = await sendOf(run.id);
    expect(s.mcCampaignId).toBe(ids.FREE);
    expect(s.state).toBe('SENT');
    expect(s.sentVia).toBe('status_poll');
  });

  it('SCHEDULED → adopted as SCHEDULED, polled, never scheduled again; SENT once the provider says so', async () => {
    const { run, sender, ids } = await freshRun('SCHEDULED');
    await step(run.id, 'cron', ist(6, 30), sender);
    expect(sender.count('createDraft')).toBe(0);
    expect(sender.count('schedule')).toBe(0);
    expect((await sendOf(run.id)).state).toBe('SCHEDULED');
    // Even at the send time, with every gate open, schedule() is not called on it.
    await step(run.id, 'cron', ist(7, 30), sender);
    await step(run.id, 'send_now', ist(7, 31), sender);
    expect(sender.count('schedule')).toBe(0);
    sender.campaigns.get(ids.FREE)!.state = 'SENT';
    sender.campaigns.get(ids.PREMIUM)!.state = 'SENT';
    await step(run.id, 'cron', ist(8, 30), sender);
    expect((await sendOf(run.id)).state).toBe('SENT');
    expect(sender.count('schedule')).toBe(0);
  });

  it('SENDING → adopted as SCHEDULED, never scheduled', async () => {
    const { run, sender } = await freshRun('SENDING');
    await step(run.id, 'cron', ist(7, 30), sender);
    expect(sender.count('schedule')).toBe(0);
    expect((await sendOf(run.id, 'PREMIUM')).state).toBe('SCHEDULED');
  });

  it('DRAFT (left by a crashed earlier run) → adopted, not duplicated; held for a person (decision A), then scheduled once after a fresh status check', async () => {
    const { run, sender, ids } = await freshRun('DRAFT');
    await step(run.id, 'cron', ist(6, 30), sender);
    const s = await sendOf(run.id);
    expect(s.state).toBe('CREATED');
    expect(s.mcCampaignId).toBe(ids.FREE);
    expect(s.scheduleAttemptedAt).not.toBeNull(); // the schedule step must ask the provider first
    expect(s.adoptedDraftAt).not.toBeNull();
    expect(s.ownApprovalRequired).toBe(true);
    expect(sender.count('createDraft')).toBe(0);
    // Owner decision A (2026-10-23): an adopted draft raises adopted_existing too, naming the draft.
    expect((await alertsOf(run.id)).adopted_existing).toMatchObject({ providerState: 'DRAFT', draft: true });

    // Approval is OFF in this config, yet the adopted draft is not scheduled without a person.
    const r = await step(run.id, 'cron', ist(7, 30), sender);
    expect(r.steps).toContain('FREE:wait:awaiting_variant_approval');
    expect(sender.count('schedule')).toBe(0);

    await prisma.digestSend.updateMany({ where: { runId: run.id }, data: { approvedAt: ist(7, 31) } });
    const statusBefore = sender.count('status');
    await step(run.id, 'cron', ist(7, 32), sender);
    expect(sender.count('status')).toBeGreaterThan(statusBefore);
    expect(sender.count('schedule')).toBe(2);
    expect(sender.calls.filter((c) => c.method === 'schedule').map((c) => c.args[0]).sort()).toEqual([ids.FREE, ids.PREMIUM].sort());
    expect(sender.count('createDraft')).toBe(0);
    expect(sender.campaigns.size).toBe(2);
  });

  it('DRAFT that someone scheduled in Mailercloud before our send time → not scheduled again', async () => {
    const { run, sender, ids } = await freshRun('DRAFT');
    await step(run.id, 'cron', ist(6, 30), sender);
    sender.campaigns.get(ids.FREE)!.state = 'SCHEDULED';
    await prisma.digestSend.updateMany({ where: { runId: run.id }, data: { approvedAt: ist(7, 0) } });
    await step(run.id, 'cron', ist(7, 30), sender);
    const calls = sender.calls.filter((c) => c.method === 'schedule').map((c) => c.args[0]);
    expect(calls).toEqual([ids.PREMIUM]);
    expect((await sendOf(run.id)).state).toBe('SCHEDULED');
  });

  it('FAILED → terminal for the day: no create, no schedule, no door resumes it', async () => {
    const { run, sender } = await freshRun('FAILED');
    await step(run.id, 'cron', ist(6, 30), sender);
    const s = await sendOf(run.id);
    expect(s.state).toBe('FAILED');
    expect(s.lastError).toMatch(/^provider_failed/);
    const r = await step(run.id, 'retry', ist(7, 35), sender);
    expect(r.outcome).toBe('refused');
    await step(run.id, 'send_now', ist(7, 36), sender);
    await step(run.id, 'health', ist(8, 0), sender);
    await step(run.id, 'cron', ist(17, 0), sender);
    expect(sender.count('createDraft')).toBe(0);
    expect(sender.count('schedule')).toBe(0);
    expect((await sendOf(run.id)).state).toBe('FAILED');
    expect((await alertsOf(run.id)).provider_failed).toBeDefined();
  });

  it('FAILED with readers reached → PARTIALLY_SENT, never re-sent', async () => {
    const { run, sender } = await freshRun('FAILED');
    sender.setStatus({ state: 'FAILED', targeted: 100, reached: 40 });
    await step(run.id, 'cron', ist(6, 30), sender);
    expect((await sendOf(run.id)).state).toBe('PARTIALLY_SENT');
    expect(sender.count('schedule')).toBe(0);
  });

  it('status unreadable at adoption → CREATED, held for a person like a draft; schedule() still asks the provider first', async () => {
    const { run, sender } = await freshRun('SENT');
    sender.fail('status', 'RETRYABLE', 2);
    await step(run.id, 'cron', ist(6, 30), sender);
    const s = await sendOf(run.id);
    expect(s.state).toBe('CREATED');
    expect(s.scheduleAttemptedAt).not.toBeNull();
    expect(s.adoptedDraftAt).not.toBeNull(); // content unconfirmed: decision A applies
    expect((await alertsOf(run.id)).adopted_existing).toMatchObject({ providerState: 'UNKNOWN', draft: true });
    await step(run.id, 'cron', ist(7, 30), sender);
    expect(sender.count('schedule')).toBe(0);
    // Approved: the provider is asked first, says SENT, and nothing is scheduled.
    await prisma.digestSend.updateMany({ where: { runId: run.id }, data: { approvedAt: ist(7, 40) } });
    await step(run.id, 'cron', ist(7, 41), sender);
    expect(sender.count('schedule')).toBe(0);
    expect(sender.count('createDraft')).toBe(0);
    expect((await sendOf(run.id)).state).not.toBe('PENDING');
  });

  it('only one audience already exists → that one is adopted, the other is created normally', async () => {
    const portal = newPortal();
    const sender = new FakeSender({ withLookup: true });
    const premium = seedProvider(sender, portal, 'PREMIUM', 'SENT');
    const run = await ensureRun({ portal, now: ist(6, 0), cfg: cfg() });
    await step(run.id, 'cron', ist(6, 30), sender);
    await step(run.id, 'cron', ist(7, 30), sender);
    expect((await sendOf(run.id, 'PREMIUM')).mcCampaignId).toBe(premium);
    expect(sender.count('createDraft')).toBe(1);
    expect(sender.draftInputs()[0].audience).toBe('FREE');
    expect(sender.calls.filter((c) => c.method === 'schedule').map((c) => c.args[0])).toEqual([(await sendOf(run.id)).mcCampaignId]);
  });

  it('yesterday\'s campaign of the same audience is not today\'s', async () => {
    const portal = newPortal();
    const sender = new FakeSender({ withLookup: true });
    seedProvider(sender, portal, 'FREE', 'SENT', 22);
    const run = await ensureRun({ portal, now: ist(6, 0), cfg: cfg() });
    await step(run.id, 'cron', ist(6, 30), sender);
    expect(sender.count('createDraft')).toBe(2);
  });
});

describe('no existing campaign → creates normally', () => {
  it('asks once per audience, then creates and schedules each once', async () => {
    const sender = new FakeSender({ withLookup: true });
    const run = await ensureRun({ portal: newPortal(), now: ist(6, 0), cfg: cfg() });
    await step(run.id, 'cron', ist(6, 30), sender);
    expect(sender.count('findCampaignByName')).toBe(2);
    expect(sender.count('createDraft')).toBe(2);
    await step(run.id, 'cron', ist(7, 30), sender);
    expect(sender.count('schedule')).toBe(2);
    expect(sender.count('findCampaignByName')).toBe(2); // the saved id is used from here on
    expect((await sendOf(run.id)).scheduleAttemptedAt).not.toBeNull();
  });

  it('a failed lookup creates nothing; the retry policy asks again', async () => {
    const sender = new FakeSender({ withLookup: true }).fail('findCampaignByName', 'RETRYABLE', 1);
    const run = await ensureRun({ portal: newPortal(), now: ist(6, 0), cfg: cfg() });
    await step(run.id, 'cron', ist(6, 30), sender);
    const s = await sendOf(run.id);
    expect(s.state).toBe('PENDING');
    // No create was issued, so no "create sent" stamp (2026-10-23): a draft the retry finds
    // can't be mistaken for our own lost create. The claim marker itself may stay.
    expect(s.createSentAt).toBeNull();
    expect(sender.draftInputs().map((d) => d.audience)).toEqual(['PREMIUM']);
    await step(run.id, 'cron', ist(6, 31), sender);
    expect((await sendOf(run.id)).state).toBe('CREATED');
    expect(sender.count('createDraft')).toBe(2);
  });

  it('a sender with no lookup still creates (its own marker is the only proof it has)', async () => {
    const sender = new FakeSender();
    const run = await ensureRun({ portal: newPortal(), now: ist(6, 0), cfg: cfg() });
    await step(run.id, 'cron', ist(6, 30), sender);
    expect(sender.count('createDraft')).toBe(2);
  });
});

describe('the adopted_existing alert and the webhook', () => {
  it('the alert copy says nothing was sent twice and names the campaign', () => {
    const c = alertCopy('adopted_existing', { audience: 'FREE', campaignName: 'TS-DIGEST-2026-10-23-FREE', providerState: 'SENT' });
    expect(c.what).toContain('TS-DIGEST-2026-10-23-FREE');
    expect(c.what).toContain('(sent)');
    expect(c.did).toMatch(/Nothing was created or sent a second time/);
  });

  it('name-only campaign_sent events link to both old-format and new-format stored names', async () => {
    const token = randomBytes(32).toString('hex');
    const c = parseDigestEnv({ DIGEST_ENABLED: 'true', DIGEST_WEBHOOKS_ENABLED: 'true', MAILERCLOUD_WEBHOOK_TOKEN: token });
    const app = createApp({ webhooks: { cfg: c, invalidPerMin: 10_000 }, digest: { cfg: c } });
    const now = new Date();
    const sends: { id: string; name: string }[] = [];
    for (const [i, kind] of (['old', 'new'] as const).entries()) {
      const portal = newPortal();
      const run = await prisma.digestRun.create({
        data: { portal, runDate: new Date(Date.UTC(2026, 9, 1 + i)), windowStart: now, build: 'BUILT', builtAt: now },
      });
      const name = kind === 'old' ? `TS-DIGEST-2026-10-01-FREE-${run.id}` : digestProviderCampaignName(portal, run.runDate, 'FREE');
      const send = await prisma.digestSend.create({
        data: { runId: run.id, audience: 'FREE', state: 'SENT', subject: 's', preheader: 'p', htmlBytes: 1, mcCampaignName: name, sendAfter: now },
      });
      sends.push({ id: send.id, name });
    }
    for (const s of sends) {
      const res = await request(app).post(`/api/webhooks/mailercloud/${token}`).send({ event: 'campaign_sent', campaign_name: s.name });
      expect(res.status).toBe(200);
      const ev = await prisma.emailEvent.findFirst({ where: { sendId: s.id } });
      expect(ev?.type).toBe('CAMPAIGN_SENT');
      await prisma.emailEvent.deleteMany({ where: { sendId: s.id } });
    }
  });
});
