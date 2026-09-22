/**
 * Event retention: the sweeper must be able to delete millions of rows without
 * changing a single number anyone sees. That is the contract, and it is what
 * these tests hold it to — parity first, safety second, mechanics third.
 *
 * Against the shared dev DB, like the other service tests. Every fixture is
 * tagged so cleanup is exact, and lifetime totals are compared as before/after
 * on the SAME database rather than as absolutes, because other suites write
 * events concurrently.
 */

import request from 'supertest';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { buildMetrics, campaignStats, listCampaigns } from '../services/metrics';
import { sweepEventRetention } from '../sweepers/eventRetention';

const app = createApp();
const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-09-22T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

const campaignIds: string[] = [];
const subscriberIds: string[] = [];

async function seedCampaign(title: string) {
  const c = await prisma.campaign.create({
    data: { portal: 'taxscan', title, body: '.', url: `https://taxscan.in/x/${uniq()}`, target: { type: 'all' }, status: 'SENT', createdAt: daysAgo(40) },
  });
  campaignIds.push(c.id);
  return c;
}

async function seedSubscriber() {
  const s = await prisma.subscriber.create({
    data: { portal: 'taxscan', endpoint: `https://push.example/ret-${uniq()}`, p256dh: 'p', auth: 'a', topics: ['all'] },
  });
  subscriberIds.push(s.id);
  return s;
}

async function addEvents(campaignId: string, subscriberId: string, spec: Array<[type: 'SENT' | 'CLICKED' | 'FAILED' | 'DISMISSED', ageDays: number]>) {
  await prisma.event.createMany({
    data: spec.map(([type, age]) => ({ type, campaignId, subscriberId, createdAt: daysAgo(age) })),
  });
}

afterAll(async () => {
  // Events cascade-null on campaign delete, so remove them explicitly first.
  if (campaignIds.length) await prisma.event.deleteMany({ where: { campaignId: { in: campaignIds } } });
  if (subscriberIds.length) await prisma.event.deleteMany({ where: { subscriberId: { in: subscriberIds } } });
  if (campaignIds.length) await prisma.campaign.deleteMany({ where: { id: { in: campaignIds } } });
  if (subscriberIds.length) await prisma.subscriber.deleteMany({ where: { id: { in: subscriberIds } } });
  await prisma.$disconnect();
});

describe('event retention — parity (the numbers must not move)', () => {
  it('per-campaign sent/clicked/failed/ctr/sentAt are identical before and after a sweep', async () => {
    const c = await seedCampaign('parity');
    const s = await seedSubscriber();
    // 3 old SENT (will roll), 2 recent SENT (stay); 1 old + 1 recent CLICKED; 1 old FAILED; 2 DISMISSED.
    await addEvents(c.id, s.id, [
      ['SENT', 45], ['SENT', 44], ['SENT', 35], ['SENT', 5], ['SENT', 1],
      ['CLICKED', 44], ['CLICKED', 2],
      ['FAILED', 40],
      ['DISMISSED', 40], ['DISMISSED', 1],
    ]);

    const before = (await campaignStats([c.id])).get(c.id)!;
    expect(before).toMatchObject({ sent: 5, clicked: 2, failed: 1 });
    expect(before.sentAt?.getTime()).toBe(daysAgo(45).getTime());

    const r = await sweepEventRetention({ now: NOW, retentionDays: 30, batchSize: 1000 });
    // Rolled: 3 SENT + 1 CLICKED + 1 FAILED older than 30d, and BOTH dismissals regardless of age.
    expect(r.deleted.SENT).toBeGreaterThanOrEqual(3);
    expect(r.deleted.DISMISSED).toBeGreaterThanOrEqual(2);

    const after = (await campaignStats([c.id])).get(c.id)!;
    expect(after).toEqual(before); // sent, clicked, failed AND sentAt — exact

    // And what actually remains on disk is only the recent, windowed rows.
    const remaining = await prisma.event.findMany({ where: { campaignId: c.id }, select: { type: true, createdAt: true } });
    expect(remaining).toHaveLength(3); // SENT@5, SENT@1, CLICKED@2
    for (const e of remaining) {
      expect(e.type).not.toBe('DISMISSED');
      expect(e.createdAt.getTime()).toBeGreaterThanOrEqual(daysAgo(30).getTime());
    }
    // The roll-up carried the rest.
    const camp = await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(camp).toMatchObject({ rolledSent: 3, rolledClicked: 1, rolledFailed: 1 });
    expect(camp.rolledFirstSentAt?.getTime()).toBe(daysAgo(45).getTime());
  });

  it('lifetime totals on the Dashboard are identical before and after a sweep', async () => {
    const c = await seedCampaign('lifetime');
    const s = await seedSubscriber();
    await addEvents(c.id, s.id, [['SENT', 50], ['SENT', 50], ['CLICKED', 50], ['FAILED', 50], ['SENT', 3]]);

    const before = (await buildMetrics(NOW)).totals;
    await sweepEventRetention({ now: NOW, retentionDays: 30, batchSize: 1000 });
    const after = (await buildMetrics(NOW)).totals;

    expect(after.sent).toBe(before.sent);
    expect(after.clicked).toBe(before.clicked);
    expect(after.failed).toBe(before.failed);
  });

  it('the Campaigns list shows the same figures for a fully rolled-up campaign', async () => {
    const c = await seedCampaign('list');
    const s = await seedSubscriber();
    await addEvents(c.id, s.id, [['SENT', 60], ['SENT', 60], ['SENT', 60], ['CLICKED', 60]]);

    const find = (rows: Awaited<ReturnType<typeof listCampaigns>>) => rows.find((x) => x.id === c.id);
    const before = find(await listCampaigns(500));
    await sweepEventRetention({ now: NOW, retentionDays: 30, batchSize: 1000 });
    const after = find(await listCampaigns(500));

    expect(before).toBeTruthy();
    expect(after).toBeTruthy();
    expect(after!.sent).toBe(3);
    expect(after!.clicked).toBe(1);
    expect(after!.ctr).toBe(before!.ctr);
    expect(after!.sentAt).toBe(before!.sentAt);
    // Nothing live is left for it; every figure came from the roll-up.
    expect(await prisma.event.count({ where: { campaignId: c.id } })).toBe(0);
  });
});

describe('event retention — safety', () => {
  it('never deletes a windowed row younger than the window', async () => {
    const c = await seedCampaign('young');
    const s = await seedSubscriber();
    await addEvents(c.id, s.id, [['SENT', 29], ['SENT', 30], ['SENT', 31], ['CLICKED', 0], ['FAILED', 15]]);

    await sweepEventRetention({ now: NOW, retentionDays: 30, batchSize: 1000 });

    const left = await prisma.event.findMany({ where: { campaignId: c.id }, select: { createdAt: true } });
    // 29d and the exact-cutoff 30d row stay (cutoff is strict "<"); 31d goes.
    for (const e of left) expect(e.createdAt.getTime()).toBeGreaterThanOrEqual(daysAgo(30).getTime());
    expect(left).toHaveLength(4);
  });

  it('keeps SUBSCRIBED / UNSUBSCRIBED / PROMPT_* forever, however old', async () => {
    const s = await seedSubscriber();
    await prisma.event.createMany({
      data: [
        { type: 'SUBSCRIBED', subscriberId: s.id, createdAt: daysAgo(400), meta: { source: 'recapture' } },
        { type: 'PROMPT_SHOWN', subscriberId: s.id, createdAt: daysAgo(400) },
        { type: 'PROMPT_ACCEPTED', subscriberId: s.id, createdAt: daysAgo(400) },
        { type: 'UNSUBSCRIBED', subscriberId: s.id, createdAt: daysAgo(400) },
      ],
    });
    await sweepEventRetention({ now: NOW, retentionDays: 30, batchSize: 1000 });
    expect(await prisma.event.count({ where: { subscriberId: s.id } })).toBe(4);
  });

  it('a dry run counts but writes nothing', async () => {
    const c = await seedCampaign('dry');
    const s = await seedSubscriber();
    await addEvents(c.id, s.id, [['SENT', 90], ['DISMISSED', 1]]);

    const r = await sweepEventRetention({ now: NOW, retentionDays: 30, dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.deleted.SENT).toBeGreaterThanOrEqual(1);
    expect(r.deleted.DISMISSED).toBeGreaterThanOrEqual(1);
    expect(await prisma.event.count({ where: { campaignId: c.id } })).toBe(2);
    const camp = await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(camp.rolledSent).toBe(0);
  });

  it('is idempotent — a second sweep finds nothing to do', async () => {
    const c = await seedCampaign('idem');
    const s = await seedSubscriber();
    await addEvents(c.id, s.id, [['SENT', 90], ['SENT', 90]]);
    await sweepEventRetention({ now: NOW, retentionDays: 30, batchSize: 1000 });
    const first = await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } });
    const again = await sweepEventRetention({ now: NOW, retentionDays: 30, batchSize: 1000 });
    const second = await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(second.rolledSent).toBe(first.rolledSent);
    // Other suites may leave old rows around, so only assert OUR campaign is untouched.
    expect(await prisma.event.count({ where: { campaignId: c.id } })).toBe(0);
    expect(again.dryRun).toBe(false);
  });
});

describe('event retention — mechanics', () => {
  it('processes a backlog larger than one batch, and maxBatches bounds a run', async () => {
    const c = await seedCampaign('batch');
    const s = await seedSubscriber();
    await addEvents(c.id, s.id, Array.from({ length: 7 }, (_, i) => ['SENT', 60 + i] as ['SENT', number]));

    const bounded = await sweepEventRetention({ now: NOW, retentionDays: 30, batchSize: 2, maxBatches: 1 });
    expect(bounded.batches).toBe(1);
    expect(bounded.more).toBe(true);
    // Exactly one batch of 2 folded; the rest still live; totals still exact.
    expect((await campaignStats([c.id])).get(c.id)!.sent).toBe(7);

    const rest = await sweepEventRetention({ now: NOW, retentionDays: 30, batchSize: 2, maxBatches: 0 });
    expect(rest.more).toBe(false);
    expect((await campaignStats([c.id])).get(c.id)!.sent).toBe(7);
    const camp = await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(camp.rolledSent).toBe(7);
  });

  it('POST /api/track no longer stores DISMISSED, but still answers 204', async () => {
    const c = await seedCampaign('track');
    const s = await seedSubscriber();
    const res = await request(app)
      .post('/api/track')
      .send({ type: 'DISMISSED', endpoint: s.endpoint, campaignId: c.id });
    expect(res.status).toBe(204);
    expect(await prisma.event.count({ where: { campaignId: c.id, type: 'DISMISSED' } })).toBe(0);

    // CLICKED still records — the change is scoped to the one type with no reader.
    const clk = await request(app).post('/api/track').send({ type: 'CLICKED', endpoint: s.endpoint, campaignId: c.id });
    expect(clk.status).toBe(204);
    expect(await prisma.event.count({ where: { campaignId: c.id, type: 'CLICKED' } })).toBe(1);
  });
});
