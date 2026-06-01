import { sendToSubscriber } from '../lib/push';
import { prisma } from '../lib/prisma';
import { validKeys } from './helpers';

// These tests exercise sendToSubscriber without hitting the real push service.
// We construct a Subscriber that web-push will reject synchronously inside
// generateRequestDetails — that's the exact path that previously crashed the
// dispatcher in production.

afterAll(async () => {
  await prisma.$disconnect();
});

function fakeSubscriber(p256dh: string, auth: string) {
  return {
    id: 'test-sub-' + Math.random().toString(36).slice(2),
    portal: 'taxscan',
    endpoint: 'https://example.com/push/' + Math.random().toString(36).slice(2),
    p256dh,
    auth,
    topics: [],
    userAgent: null,
    status: 'ACTIVE',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as never;
}

describe('sendToSubscriber error handling', () => {
  it('returns a failed outcome instead of throwing when p256dh is the wrong size', async () => {
    const sub = fakeSubscriber('not-a-valid-key', validKeys().auth);
    const outcome = await sendToSubscriber(sub, { title: 't', body: 'b' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok && outcome.expired === false) {
      expect(outcome.failed).toBe(true);
      expect(typeof outcome.error).toBe('string');
    } else {
      throw new Error('expected a failed (non-expired) outcome');
    }
  });

  it('returns a failed outcome when auth is the wrong size', async () => {
    const sub = fakeSubscriber(validKeys().p256dh, 'short');
    const outcome = await sendToSubscriber(sub, { title: 't', body: 'b' });
    expect(outcome.ok).toBe(false);
  });
});
