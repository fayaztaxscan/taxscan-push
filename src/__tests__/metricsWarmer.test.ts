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
    // The active-subscriber figure is a GLOBAL status count that other test files change at the same moment (they create and
    // expire subscribers in this shared database), so "before + 1" is not a stable thing to assert. Pin the contract itself:
    // each build runs the status query again, and the cached lifetime totals are NOT re-read in between.
    process.env.METRICS_HEAVY_REFRESH_MS = String(60 * 60 * 1000);
    const original = prisma.subscriber.groupBy.bind(prisma.subscriber) as (args: unknown) => Promise<unknown>;
    let active = 7;
    const statusQueries: number[] = [];
    const spy = jest.spyOn(prisma.subscriber, 'groupBy').mockImplementation(((args: { by?: string[] }) => {
      if (Array.isArray(args?.by) && args.by.length === 1 && args.by[0] === 'status') {
        statusQueries.push(active);
        return Promise.resolve([{ status: 'ACTIVE', _count: { _all: active } }]);
      }
      return original(args); // anything else (the warmer's own passes) is untouched
    }) as never);
    try {
      startMetricsWarmer();
      const first = await buildMetrics();
      expect(first.activeSubscribers).toBe(7);
      const totalsBefore = first.subscribersBySource;
      active = 8; // a subscriber arrives after the first build
      const second = await buildMetrics();
      expect(second.activeSubscribers).toBe(8); // live: the status count is re-read on the request path
      expect(statusQueries).toEqual([7, 8]); // exactly one status query per build
      expect(second.subscribersBySource).toEqual(totalsBefore); // cached: the lifetime totals did not move
    } finally {
      spy.mockRestore();
      delete process.env.METRICS_HEAVY_REFRESH_MS;
    }
  });
});
