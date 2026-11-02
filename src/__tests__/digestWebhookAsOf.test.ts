import { randomBytes } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { parseDigestEnv } from '../lib/env';
import { noAddressRecently, webhookHealth } from '../services/digest/webhookLiveness';

/**
 * Regression for the intermittent digestTick failures (brief 2026-11-02-token-expiry-and-flaky-tests, B): the webhook-health read
 * is "as of `now"`. An opt-out-without-address (NO_ADDRESS) event stamped AFTER `now` has not arrived yet and never counts. Before
 * this, a real-time row from another test file (digestWebhook.test.ts) made the digest tests, which run on a fixed past clock,
 * show `webhook_no_address` instead of the banner they expected.
 *
 * The row here is dated in 2099, so it can never be seen by any real-time read in another file running at the same moment.
 */
const RUN = randomBytes(4).toString('hex');
const KEY = `asof-${RUN}`;
const EVENT_AT = new Date('2099-06-01T10:00:00Z');
const cfg = parseDigestEnv({ DIGEST_ENABLED: 'true', DIGEST_WEBHOOKS_ENABLED: 'true' });

beforeAll(async () => {
  await prisma.emailEvent.create({ data: { type: 'NO_ADDRESS', dedupeKey: KEY, meta: { day: '2099-06-01', count: 2 }, receivedAt: EVENT_AT } });
});
afterAll(async () => {
  await prisma.emailEvent.deleteMany({ where: { dedupeKey: KEY } });
  await prisma.$disconnect();
});

describe('noAddressRecently is "as of now"', () => {
  const at = (iso: string) => ({ lastNoAddressAt: iso });
  it('counts an event from the last 24 hours, not an older one, and never one stamped after now', () => {
    const now = new Date('2026-11-02T12:00:00Z');
    expect(noAddressRecently(at('2026-11-02T11:00:00Z'), now)).toBe(true);
    expect(noAddressRecently(at('2026-11-01T11:59:00Z'), now)).toBe(false); // 24 h and a minute ago
    expect(noAddressRecently(at('2026-11-02T12:00:00Z'), now)).toBe(true); // exactly now
    expect(noAddressRecently(at('2026-11-02T12:00:01Z'), now)).toBe(false); // a second in the future: not arrived yet
    expect(noAddressRecently(at('2099-01-01T00:00:00Z'), now)).toBe(false);
    expect(noAddressRecently({ lastNoAddressAt: null }, now)).toBe(false);
  });
});

describe('webhookHealth reads events as of now', () => {
  const health = (now: string) => webhookHealth({ portal: `test-asof-${RUN}`, now: new Date(now), cfg });
  it('an event after `now` is not seen', async () => {
    expect((await health('2099-05-31T10:00:00Z')).lastNoAddressAt).toBeNull();
  });
  it('an event within the last 24 hours is seen, and is the banner\'s trigger', async () => {
    const h = await health('2099-06-01T12:00:00Z');
    expect(h.lastNoAddressAt).toBe(EVENT_AT.toISOString());
    expect(h.noAddressCount).toBe(2);
    expect(noAddressRecently(h, new Date('2099-06-01T12:00:00Z'))).toBe(true);
  });
  it('an older event is still reported (14 days) but no longer triggers the banner', async () => {
    const h = await health('2099-06-05T10:00:00Z');
    expect(h.lastNoAddressAt).toBe(EVENT_AT.toISOString());
    expect(noAddressRecently(h, new Date('2099-06-05T10:00:00Z'))).toBe(false);
  });
});
