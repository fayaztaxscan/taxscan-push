/**
 * The lifetime-aggregate warmer behind /api/metrics.
 *
 * Why it exists: two of the dashboard's numbers need every row of Event
 * (6.4M rows, +75k/day). With Postgres' 128 MB cache evicted overnight, the
 * first load each morning read the whole index from disk — 6-7 s. These
 * tests pin the contract that fixes it: once the warmer has run, requests are
 * served from memory; a process that never starts the warmer (tests, scripts)
 * computes inline and sees fresh numbers, exactly as before.
 *
 * Against the shared dev DB, like the other service tests.
 */

import { prisma } from '../lib/prisma';
import { buildMetrics, startMetricsWarmer, __resetHeavyAggregates } from '../services/metrics';

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
const subscriberIds: string[] = [];
const eventIds: string[] = [];

async function addSubscribedEvent(source: string): Promise<void> {
  const s = await prisma.subscriber.create({
    data: { portal: 'taxscan', endpoint: `https://push.example/w-${uniq()}`, p256dh: 'p', auth: 'a', topics: ['all'] },
  });
  subscriberIds.push(s.id);
  const e = await prisma.event.create({
    data: { type: 'SUBSCRIBED', subscriberId: s.id, meta: { source } },
  });
  eventIds.push(e.id);
}

afterEach(() => __resetHeavyAggregates());

afterAll(async () => {
  if (eventIds.length) await prisma.event.deleteMany({ where: { id: { in: eventIds } } });
  if (subscriberIds.length) await prisma.subscriber.deleteMany({ where: { id: { in: subscriberIds } } });
  await prisma.$disconnect();
});

describe('metrics warmer', () => {
  it('without the warmer, every build computes inline and sees fresh totals', async () => {
    const before = (await buildMetrics()).subscribersBySource.recapture;
    await addSubscribedEvent('recapture');
    const after = (await buildMetrics()).subscribersBySource.recapture;
    expect(after).toBe(before + 1);
  });

  it('with the warmer running, builds are served from the cached aggregates', async () => {
    process.env.METRICS_HEAVY_REFRESH_MS = String(60 * 60 * 1000); // one refresh, then nothing
    try {
      startMetricsWarmer();
      // Let the immediate first pass land.
      const snapshot = (await buildMetrics()).subscribersBySource.recapture;

      // A new event after the snapshot must NOT appear until the next refresh:
      // that is the point — the request path no longer scans Event.
      await addSubscribedEvent('recapture');
      const served = (await buildMetrics()).subscribersBySource.recapture;
      expect(served).toBe(snapshot);
    } finally {
      delete process.env.METRICS_HEAVY_REFRESH_MS;
    }
  });

  it('a refresh interval of 0 disables the warmer (pre-change behaviour)', async () => {
    process.env.METRICS_HEAVY_REFRESH_MS = '0';
    try {
      startMetricsWarmer();
      const before = (await buildMetrics()).subscribersBySource.recapture;
      await addSubscribedEvent('recapture');
      const after = (await buildMetrics()).subscribersBySource.recapture;
      expect(after).toBe(before + 1);
    } finally {
      delete process.env.METRICS_HEAVY_REFRESH_MS;
    }
  });

  it('keeps the live parts live even while totals are cached', async () => {
    process.env.METRICS_HEAVY_REFRESH_MS = String(60 * 60 * 1000);
    try {
      startMetricsWarmer();
      const before = (await buildMetrics()).activeSubscribers;
      const s = await prisma.subscriber.create({
        data: { portal: 'taxscan', endpoint: `https://push.example/live-${uniq()}`, p256dh: 'p', auth: 'a', topics: ['all'] },
      });
      subscriberIds.push(s.id);
      const after = (await buildMetrics()).activeSubscribers;
      // Active subscribers is a request-path query, not a cached aggregate.
      expect(after).toBe(before + 1);
    } finally {
      delete process.env.METRICS_HEAVY_REFRESH_MS;
    }
  });
});
