import type { Subscriber } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { dispatchCampaign, type Sender } from '../services/send';
import { sweepScheduledCampaigns } from '../services/sweeper';

const IST_OFFSET_MIN = 5 * 60 + 30;
function ist(year: number, month: number, day: number, hour: number, minute = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - IST_OFFSET_MIN * 60 * 1000);
}

const TEST_PREFIX = 'https://test-sweep.example.com/sub/';
const subscriberIds: string[] = [];
const campaignIds: string[] = [];

function uniquePortal(name: string): string {
  return `test-sweep-${name}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

async function makeSubscriber(portal: string, suffix: string): Promise<Subscriber> {
  const sub = await prisma.subscriber.create({
    data: {
      endpoint: `${TEST_PREFIX}${suffix}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
      p256dh: 'p',
      auth: 'a',
      portal,
      topics: [],
    },
  });
  subscriberIds.push(sub.id);
  return sub;
}

function okSender(): { sender: Sender; count: () => number } {
  let n = 0;
  const sender: Sender = async () => {
    n++;
    return { ok: true, statusCode: 201 };
  };
  return { sender, count: () => n };
}

afterAll(async () => {
  if (campaignIds.length) {
    await prisma.event.deleteMany({ where: { campaignId: { in: campaignIds } } });
    await prisma.campaign.deleteMany({ where: { id: { in: campaignIds } } });
  }
  if (subscriberIds.length) {
    await prisma.event.deleteMany({ where: { subscriberId: { in: subscriberIds } } });
    await prisma.subscriber.deleteMany({ where: { id: { in: subscriberIds } } });
  }
  await prisma.$disconnect();
});

describe('sweepScheduledCampaigns', () => {
  it('picks up a campaign whose scheduledAt has passed and runs the send loop', async () => {
    const portal = uniquePortal('due');
    const sub = await makeSubscriber(portal, 'sweep-due');

    // Build a SCHEDULED campaign directly so we control scheduledAt.
    const c = await prisma.campaign.create({
      data: {
        portal,
        title: 'Due',
        body: 'b',
        url: 'https://taxscan.in',
        target: { type: 'all' },
        status: 'SCHEDULED',
        scheduledAt: ist(2026, 6, 1, 7, 0),
      },
    });
    campaignIds.push(c.id);

    const { sender } = okSender();
    await sweepScheduledCampaigns({
      sender,
      now: ist(2026, 6, 1, 7, 1),
      cap: 100,
    });

    const reloaded = await prisma.campaign.findUnique({ where: { id: c.id } });
    expect(reloaded?.status).toBe('SENT');

    const events = await prisma.event.findMany({
      where: { campaignId: c.id, type: 'SENT' },
    });
    expect(events.map((e) => e.subscriberId)).toEqual([sub.id]);
  });

  it('does not pick up campaigns whose scheduledAt is in the future', async () => {
    const portal = uniquePortal('future');
    await makeSubscriber(portal, 'sweep-future');

    const c = await prisma.campaign.create({
      data: {
        portal,
        title: 'Future',
        body: 'b',
        url: 'https://taxscan.in',
        target: { type: 'all' },
        status: 'SCHEDULED',
        scheduledAt: ist(2026, 6, 1, 8, 0),
      },
    });
    campaignIds.push(c.id);

    const { sender } = okSender();
    await sweepScheduledCampaigns({
      sender,
      now: ist(2026, 6, 1, 7, 30),
      cap: 100,
    });

    const reloaded = await prisma.campaign.findUnique({ where: { id: c.id } });
    expect(reloaded?.status).toBe('SCHEDULED');
    expect(reloaded?.scheduledAt?.toISOString()).toBe(ist(2026, 6, 1, 8, 0).toISOString());
  });

  it('pushes scheduledAt forward when sweep lands inside a quiet window', async () => {
    const portal = uniquePortal('still-quiet');
    await makeSubscriber(portal, 'sweep-still-quiet');

    const originalScheduledAt = ist(2026, 6, 1, 1, 0);
    const c = await prisma.campaign.create({
      data: {
        portal,
        title: 'Quiet',
        body: 'b',
        url: 'https://taxscan.in',
        target: { type: 'all' },
        status: 'SCHEDULED',
        scheduledAt: originalScheduledAt,
      },
    });
    campaignIds.push(c.id);

    const { sender } = okSender();
    await sweepScheduledCampaigns({
      sender,
      now: ist(2026, 6, 1, 2, 0), // inside 23:00→07:00
      cap: 100,
      quietStart: '23:00',
      quietEnd: '07:00',
    });

    const reloaded = await prisma.campaign.findUnique({ where: { id: c.id } });
    expect(reloaded?.status).toBe('SCHEDULED');
    expect(reloaded?.scheduledAt?.toISOString()).toBe(ist(2026, 6, 1, 7, 0).toISOString());
  });

  it('end-to-end: dispatch during quiet hours → SCHEDULED → sweep after scheduledAt → SENT exactly once', async () => {
    const portal = uniquePortal('e2e');
    const sub = await makeSubscriber(portal, 'e2e');

    const { sender, count } = okSender();
    const quietNow = ist(2026, 6, 1, 2, 0);

    const dispatchResult = await dispatchCampaign(
      {
        portal,
        title: 'Late article',
        body: 'b',
        url: 'https://taxscan.in/late',
        target: { type: 'all' },
      },
      { sender, now: quietNow, cap: 100, quietStart: '23:00', quietEnd: '07:00' },
    );
    campaignIds.push(dispatchResult.campaignId);

    expect(dispatchResult.status).toBe('SCHEDULED');
    expect(dispatchResult.deferred?.scheduledAt).toBe(ist(2026, 6, 1, 7, 0).toISOString());
    expect(count()).toBe(0);

    // Sweep before scheduledAt — our campaign is not yet due. Reload to confirm.
    await sweepScheduledCampaigns({
      sender,
      now: ist(2026, 6, 1, 6, 30),
      cap: 100,
      quietStart: '23:00',
      quietEnd: '07:00',
    });
    const beforeDue = await prisma.campaign.findUnique({ where: { id: dispatchResult.campaignId } });
    expect(beforeDue?.status).toBe('SCHEDULED');

    // Jump past scheduledAt (07:00 IST) — sweeper should send our campaign.
    await sweepScheduledCampaigns({
      sender,
      now: ist(2026, 6, 1, 7, 5),
      cap: 100,
      quietStart: '23:00',
      quietEnd: '07:00',
    });

    const reloaded = await prisma.campaign.findUnique({ where: { id: dispatchResult.campaignId } });
    expect(reloaded?.status).toBe('SENT');

    const sentEvents = await prisma.event.findMany({
      where: { campaignId: dispatchResult.campaignId, type: 'SENT' },
    });
    expect(sentEvents.map((e) => e.subscriberId)).toEqual([sub.id]);

    // A subsequent sweep must NOT re-send. The campaign is now SENT, so it won't
    // be picked up, and the SENT-event count for this campaign+subscriber stays 1.
    await sweepScheduledCampaigns({
      sender,
      now: ist(2026, 6, 1, 8, 0),
      cap: 100,
    });

    const sentEventsAfter = await prisma.event.findMany({
      where: { campaignId: dispatchResult.campaignId, subscriberId: sub.id, type: 'SENT' },
    });
    expect(sentEventsAfter).toHaveLength(1);
  });
});
