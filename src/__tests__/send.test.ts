import type { Subscriber } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { dispatchCampaign, type Sender } from '../services/send';
import type { PushPayload } from '../lib/push';
import { startOfTodayIST } from '../lib/quietHours';
import { validKeys } from './helpers';

const TAXSCAN_BRAND_ICON =
  'https://www.taxscan.in/images/icons/icon-192x192.png';

const IST_OFFSET_MIN = 5 * 60 + 30;
function ist(year: number, month: number, day: number, hour: number, minute = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - IST_OFFSET_MIN * 60 * 1000);
}

const TEST_PREFIX = 'https://test-send.example.com/sub/';

const subscriberIds: string[] = [];
const campaignIds: string[] = [];

function uniquePortal(name: string): string {
  return `test-send-${name}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

async function makeSubscriber(
  portal: string,
  suffix: string,
  topics: string[] = [],
): Promise<Subscriber> {
  const keys = validKeys();
  const sub = await prisma.subscriber.create({
    data: {
      endpoint: `${TEST_PREFIX}${suffix}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
      p256dh: keys.p256dh,
      auth: keys.auth,
      portal,
      topics,
    },
  });
  subscriberIds.push(sub.id);
  return sub;
}

function okSender(): Sender {
  return async () => ({ ok: true, statusCode: 201 });
}

function expiredSenderFor(endpoints: Set<string>): Sender {
  return async (sub) => {
    if (endpoints.has(sub.endpoint)) {
      await prisma.subscriber.update({ where: { id: sub.id }, data: { status: 'EXPIRED' } });
      return { ok: false, statusCode: 410, expired: true, error: 'Gone' };
    }
    return { ok: true, statusCode: 201 };
  };
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

describe('dispatchCampaign', () => {
  it('sends to all ACTIVE subscribers and records SENT events linked to the campaign', async () => {
    const portal = uniquePortal('happy');
    const a = await makeSubscriber(portal, 'happy-a');
    const b = await makeSubscriber(portal, 'happy-b');

    const result = await dispatchCampaign(
      {
        portal,
        title: 'hello',
        body: 'world',
        url: 'https://taxscan.in/article/1',
        target: { type: 'all' },
      },
      { sender: okSender(), now: ist(2026, 6, 1, 12, 0), cap: 100 },
    );
    campaignIds.push(result.campaignId);

    expect(result.status).toBe('SENT');
    expect(result.sent).toBe(2);
    expect(result.capped).toBe(0);

    const events = await prisma.event.findMany({
      where: { campaignId: result.campaignId, type: 'SENT' },
    });
    expect(events.length).toBe(2);
    expect(events.map((e) => e.subscriberId).sort()).toEqual([a.id, b.id].sort());

    const campaign = await prisma.campaign.findUnique({ where: { id: result.campaignId } });
    expect(campaign?.status).toBe('SENT');
  });

  it('filters by topics', async () => {
    const portal = uniquePortal('topics');
    const a = await makeSubscriber(portal, 'topic-gst', ['gst']);
    const b = await makeSubscriber(portal, 'topic-other', ['it']);

    const result = await dispatchCampaign(
      {
        portal,
        title: 'gst news',
        body: '...',
        url: 'https://taxscan.in/gst',
        target: { type: 'topics', topics: ['gst'] },
      },
      { sender: okSender(), now: ist(2026, 6, 1, 12, 0), cap: 100 },
    );
    campaignIds.push(result.campaignId);

    expect(result.sent).toBe(1);
    const events = await prisma.event.findMany({
      where: { campaignId: result.campaignId, type: 'SENT' },
    });
    expect(events.map((e) => e.subscriberId)).toEqual([a.id]);
    // sanity — `b` did not receive
    expect(events.find((e) => e.subscriberId === b.id)).toBeUndefined();
  });

  it('topic-targeted dispatch also reaches "All news" subscribers', async () => {
    const portal = uniquePortal('all-overlap');
    const gst = await makeSubscriber(portal, 'gst', ['gst']);
    const allSub = await makeSubscriber(portal, 'all', ['all']);
    const corp = await makeSubscriber(portal, 'corp', ['corporate']);

    const result = await dispatchCampaign(
      {
        portal,
        title: 'gst ruling',
        body: '...',
        url: 'https://taxscan.in/gst',
        target: { type: 'topics', topics: ['gst'] },
      },
      { sender: okSender(), now: ist(2026, 6, 1, 12, 0), cap: 100 },
    );
    campaignIds.push(result.campaignId);

    const events = await prisma.event.findMany({
      where: { campaignId: result.campaignId, type: 'SENT' },
      select: { subscriberId: true },
    });
    const reached = new Set(events.map((e) => e.subscriberId));
    expect(reached.has(gst.id)).toBe(true);
    expect(reached.has(allSub.id)).toBe(true); // "All news" subscriber receives every topic dispatch
    expect(reached.has(corp.id)).toBe(false); // Corporate-only subscriber doesn't
  });

  it('topics:["all"] dispatch reaches only "All news" subscribers (the fallback case)', async () => {
    const portal = uniquePortal('only-all');
    const gst = await makeSubscriber(portal, 'gst', ['gst']);
    const allSub = await makeSubscriber(portal, 'all', ['all']);

    const result = await dispatchCampaign(
      {
        portal,
        title: 'other taxations',
        body: '...',
        url: 'https://taxscan.in/ot',
        target: { type: 'topics', topics: ['all'] },
      },
      { sender: okSender(), now: ist(2026, 6, 1, 12, 0), cap: 100 },
    );
    campaignIds.push(result.campaignId);

    const events = await prisma.event.findMany({
      where: { campaignId: result.campaignId, type: 'SENT' },
      select: { subscriberId: true },
    });
    const reached = new Set(events.map((e) => e.subscriberId));
    expect(reached.has(allSub.id)).toBe(true);
    expect(reached.has(gst.id)).toBe(false);
  });

  it('skips subscribers already at cap', async () => {
    const now = ist(2026, 6, 1, 12, 0);
    const todayStart = startOfTodayIST(now);
    const portal = uniquePortal('cap');

    const fresh = await makeSubscriber(portal, 'cap-fresh');
    const maxed = await makeSubscriber(portal, 'cap-maxed');
    // 2 SENT events for `maxed` today → capped at 2
    await prisma.event.create({
      data: { type: 'SENT', subscriberId: maxed.id, createdAt: todayStart },
    });
    await prisma.event.create({
      data: { type: 'SENT', subscriberId: maxed.id, createdAt: todayStart },
    });

    const result = await dispatchCampaign(
      {
        portal,
        title: 'capped run',
        body: '...',
        url: 'https://taxscan.in',
        target: { type: 'all' },
      },
      { sender: okSender(), now, cap: 2 },
    );
    campaignIds.push(result.campaignId);

    expect(result.sent).toBe(1);
    expect(result.capped).toBe(1);

    const events = await prisma.event.findMany({
      where: { campaignId: result.campaignId, type: 'SENT' },
    });
    expect(events.map((e) => e.subscriberId)).toEqual([fresh.id]);
  });

  it('defers during quiet hours and marks SCHEDULED', async () => {
    const portal = uniquePortal('quiet');
    await makeSubscriber(portal, 'quiet');
    const now = ist(2026, 6, 1, 2, 0); // inside 23:00→07:00

    const result = await dispatchCampaign(
      {
        portal,
        title: 'late night',
        body: '...',
        url: 'https://taxscan.in',
        target: { type: 'all' },
      },
      { sender: okSender(), now, quietStart: '23:00', quietEnd: '07:00' },
    );
    campaignIds.push(result.campaignId);

    expect(result.status).toBe('SCHEDULED');
    expect(result.sent).toBe(0);
    expect(result.deferred?.scheduledAt).toBe(ist(2026, 6, 1, 7, 0).toISOString());

    const campaign = await prisma.campaign.findUnique({ where: { id: result.campaignId } });
    expect(campaign?.status).toBe('SCHEDULED');
    expect(campaign?.scheduledAt?.toISOString()).toBe(ist(2026, 6, 1, 7, 0).toISOString());

    const events = await prisma.event.findMany({
      where: { campaignId: result.campaignId, type: 'SENT' },
    });
    expect(events).toHaveLength(0);
  });

  it('breaking flag bypasses quiet hours', async () => {
    const portal = uniquePortal('breaking');
    await makeSubscriber(portal, 'breaking');
    const now = ist(2026, 6, 1, 2, 0);

    const result = await dispatchCampaign(
      {
        portal,
        title: 'breaking!',
        body: '...',
        url: 'https://taxscan.in',
        target: { type: 'all' },
        breaking: true,
      },
      { sender: okSender(), now, cap: 100, quietStart: '23:00', quietEnd: '07:00' },
    );
    campaignIds.push(result.campaignId);

    expect(result.status).toBe('SENT');
    expect(result.sent).toBeGreaterThanOrEqual(1);
  });

  it('isolates per-subscriber failures so one bad sender call cannot abort the batch', async () => {
    const portal = uniquePortal('isolate');
    const good = await makeSubscriber(portal, 'good');
    const syncBad = await makeSubscriber(portal, 'sync-bad');
    const webpushBad = await makeSubscriber(portal, 'webpush-bad');

    const sender: Sender = async (sub) => {
      if (sub.id === syncBad.id) {
        // Mirrors what web-push throws synchronously from generateRequestDetails
        // when p256dh isn't a valid 65-byte key.
        throw new Error('Invalid p256dh - must be 65 bytes');
      }
      if (sub.id === webpushBad.id) {
        // A WebPushError-shaped throw (non-404/410): isWebPushError matches,
        // and the new failed branch is what we're asserting on.
        const err = Object.assign(new Error('500 Internal Error'), {
          statusCode: 500,
          endpoint: sub.endpoint,
          body: 'oops',
        });
        throw err;
      }
      return { ok: true, statusCode: 201 };
    };

    const result = await dispatchCampaign(
      {
        portal,
        title: 'mixed batch',
        body: 'b',
        url: 'https://taxscan.in',
        target: { type: 'all' },
        breaking: true, // deterministic — bypass quiet hours
      },
      { sender, now: ist(2026, 6, 1, 12, 0), cap: 100 },
    );
    campaignIds.push(result.campaignId);

    expect(result.status).toBe('SENT');
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(2);
    expect(result.expiredPruned).toBe(0);

    const events = await prisma.event.findMany({
      where: { campaignId: result.campaignId, type: 'SENT' },
    });
    expect(events.map((e) => e.subscriberId)).toEqual([good.id]);

    // The two bad subscribers remain ACTIVE (404/410 is the only path that flips status).
    const stillActive = await prisma.subscriber.findMany({
      where: { id: { in: [syncBad.id, webpushBad.id] } },
      select: { id: true, status: true },
    });
    expect(stillActive.every((s) => s.status === 'ACTIVE')).toBe(true);

    // FAILED events are recorded for both non-expired failures so the
    // delivery-rate metric can count them.
    const failedEvents = await prisma.event.findMany({
      where: { campaignId: result.campaignId, type: 'FAILED' },
      select: { subscriberId: true, meta: true },
    });
    expect(failedEvents).toHaveLength(2);
    expect(failedEvents.every((e) => (e.meta as { reason: string }).reason === 'error')).toBe(
      true,
    );
  });

  // Two assertions guard the icon fallback. The first locks in the default
  // (taxscan.in's existing brand icon) so notifications never ship without
  // an icon URL again — that 404 was the source of the "generic browser
  // bell" mobile-UX finding. The second proves an explicit campaign icon
  // is left alone, so admin-set or Phase 2 per-portal overrides still win.
  it('defaults the icon + badge to the taxscan brand URL when campaign.icon is unset', async () => {
    const portal = uniquePortal('icon-default');
    await makeSubscriber(portal, 'icon-default');

    const captured: PushPayload[] = [];
    const sender: Sender = async (_sub, payload) => {
      captured.push(payload);
      return { ok: true, statusCode: 201 };
    };

    const result = await dispatchCampaign(
      {
        portal,
        title: 'No icon set',
        body: 'b',
        url: 'https://taxscan.in/x',
        target: { type: 'all' },
        breaking: true,
      },
      { sender, now: ist(2026, 6, 1, 12, 0), cap: 100 },
    );
    campaignIds.push(result.campaignId);

    expect(captured).toHaveLength(1);
    expect(captured[0].icon).toBe(TAXSCAN_BRAND_ICON);
    expect(captured[0].badge).toBe(TAXSCAN_BRAND_ICON);
  });

  it('preserves an explicit campaign.icon when set', async () => {
    const portal = uniquePortal('icon-explicit');
    await makeSubscriber(portal, 'icon-explicit');

    const captured: PushPayload[] = [];
    const sender: Sender = async (_sub, payload) => {
      captured.push(payload);
      return { ok: true, statusCode: 201 };
    };

    const explicitIcon = 'https://www.taxscan.in/images/special-icon.png';
    const result = await dispatchCampaign(
      {
        portal,
        title: 'Custom icon',
        body: 'b',
        url: 'https://taxscan.in/x',
        icon: explicitIcon,
        target: { type: 'all' },
        breaking: true,
      },
      { sender, now: ist(2026, 6, 1, 12, 0), cap: 100 },
    );
    campaignIds.push(result.campaignId);

    expect(captured).toHaveLength(1);
    expect(captured[0].icon).toBe(explicitIcon);
    expect(captured[0].badge).toBe(explicitIcon);
  });

  it('prunes EXPIRED subscribers on 410 and does not record SENT for them', async () => {
    const portal = uniquePortal('expire');
    const a = await makeSubscriber(portal, 'expire-a');
    const b = await makeSubscriber(portal, 'expire-b');

    const result = await dispatchCampaign(
      {
        portal,
        title: 'prune',
        body: '...',
        url: 'https://taxscan.in',
        target: { type: 'all' },
      },
      {
        sender: expiredSenderFor(new Set([b.endpoint])),
        now: ist(2026, 6, 1, 12, 0),
        cap: 100,
      },
    );
    campaignIds.push(result.campaignId);

    expect(result.sent).toBeGreaterThanOrEqual(1);
    expect(result.expiredPruned).toBe(1);

    const reloadedB = await prisma.subscriber.findUnique({ where: { id: b.id } });
    expect(reloadedB?.status).toBe('EXPIRED');

    const sentForB = await prisma.event.findMany({
      where: { campaignId: result.campaignId, subscriberId: b.id, type: 'SENT' },
    });
    expect(sentForB).toHaveLength(0);

    const sentForA = await prisma.event.findMany({
      where: { campaignId: result.campaignId, subscriberId: a.id, type: 'SENT' },
    });
    expect(sentForA).toHaveLength(1);

    // The 410 also records a FAILED event tagged with reason:'expired'.
    const failedForB = await prisma.event.findMany({
      where: { campaignId: result.campaignId, subscriberId: b.id, type: 'FAILED' },
      select: { meta: true },
    });
    expect(failedForB).toHaveLength(1);
    expect((failedForB[0].meta as { reason: string }).reason).toBe('expired');
  });
});
