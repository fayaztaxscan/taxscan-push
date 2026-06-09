/**
 * Unit tests for the /api/metrics short-TTL cache (getMetrics). These exercise
 * the caching logic only — an injected builder stands in for buildMetrics, so
 * no DB is touched and the clock is controlled via explicit `now` values.
 */

import { getMetrics, __resetMetricsCache, type Metrics } from '../services/metrics';

function fakeMetrics(active: number): Metrics {
  return {
    activeSubscribers: active,
    growth: [],
    funnel: { promptShown: 0, promptAccepted: 0, subscribed: 0 },
    unsubscribeRate: null,
    optInRate: null,
    deliveryRate: null,
    totals: { sent: 0, clicked: 0, expired: 0, failed: 0 },
    subscribersBySource: { 'soft-prompt': 0, recapture: 0, pushsubscriptionchange: 0, import: 0 },
    campaigns: [],
  };
}

/** A builder that counts calls and returns a value reflecting the call count. */
function countingBuilder(): { build: (now: Date) => Promise<Metrics>; calls: () => number } {
  let n = 0;
  return {
    build: async () => {
      n += 1;
      return fakeMetrics(n);
    },
    calls: () => n,
  };
}

const base = new Date('2026-06-09T00:00:00.000Z').getTime();
const at = (ms: number): Date => new Date(base + ms);

beforeEach(() => __resetMetricsCache());

describe('getMetrics cache', () => {
  it('serves a cached payload for repeat calls within the TTL (builder runs once)', async () => {
    const b = countingBuilder();
    const first = await getMetrics(at(0), { ttlMs: 20_000, builder: b.build });
    const second = await getMetrics(at(5_000), { ttlMs: 20_000, builder: b.build });

    expect(b.calls()).toBe(1);
    expect(first.activeSubscribers).toBe(1);
    expect(second.activeSubscribers).toBe(1); // same cached object
  });

  it('recomputes once the TTL has elapsed', async () => {
    const b = countingBuilder();
    await getMetrics(at(0), { ttlMs: 20_000, builder: b.build });
    const stale = await getMetrics(at(19_999), { ttlMs: 20_000, builder: b.build });
    const fresh = await getMetrics(at(20_001), { ttlMs: 20_000, builder: b.build });

    expect(b.calls()).toBe(2);
    expect(stale.activeSubscribers).toBe(1); // still cached at 19.999s
    expect(fresh.activeSubscribers).toBe(2); // recomputed past 20s
  });

  it('bypasses the cache entirely when ttlMs <= 0 (builder runs every call)', async () => {
    const b = countingBuilder();
    await getMetrics(at(0), { ttlMs: 0, builder: b.build });
    await getMetrics(at(1), { ttlMs: 0, builder: b.build });
    expect(b.calls()).toBe(2);
  });

  it('__resetMetricsCache forces the next call to recompute', async () => {
    const b = countingBuilder();
    await getMetrics(at(0), { ttlMs: 20_000, builder: b.build });
    __resetMetricsCache();
    await getMetrics(at(1_000), { ttlMs: 20_000, builder: b.build });
    expect(b.calls()).toBe(2);
  });
});
