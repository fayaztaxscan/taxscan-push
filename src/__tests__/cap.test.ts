import type { Subscriber } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { filterByCap } from '../lib/cap';
import { startOfTodayIST } from '../lib/quietHours';
import { validKeys } from './helpers';

const IST_OFFSET_MIN = 5 * 60 + 30;
function ist(year: number, month: number, day: number, hour: number, minute = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - IST_OFFSET_MIN * 60 * 1000);
}

const TEST_PREFIX = 'https://test-cap.example.com/sub/';
const created: string[] = [];

async function makeSubscriber(suffix: string): Promise<Subscriber> {
  const keys = validKeys();
  const sub = await prisma.subscriber.create({
    data: {
      endpoint: `${TEST_PREFIX}${suffix}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
      p256dh: keys.p256dh,
      auth: keys.auth,
      portal: 'test-cap',
      topics: [],
    },
  });
  created.push(sub.id);
  return sub;
}

async function seedSentEvent(subscriberId: string, createdAt: Date) {
  await prisma.event.create({
    data: { type: 'SENT', subscriberId, createdAt },
  });
}

afterAll(async () => {
  if (created.length) {
    await prisma.event.deleteMany({ where: { subscriberId: { in: created } } });
    await prisma.subscriber.deleteMany({ where: { id: { in: created } } });
  }
  await prisma.$disconnect();
});

describe('filterByCap', () => {
  it('keeps subscribers under the cap and caps the rest', async () => {
    const now = new Date();
    const todayStart = startOfTodayIST(now);

    const a = await makeSubscriber('under');
    const b = await makeSubscriber('atcap');
    const c = await makeSubscriber('overcap');

    await seedSentEvent(a.id, todayStart);
    await seedSentEvent(b.id, todayStart);
    await seedSentEvent(b.id, todayStart);
    await seedSentEvent(c.id, todayStart);
    await seedSentEvent(c.id, todayStart);
    await seedSentEvent(c.id, todayStart);

    const { kept, capped } = await filterByCap([a, b, c], 2, now);
    expect(kept.map((s) => s.id)).toEqual([a.id]);
    expect(capped.map((s) => s.id).sort()).toEqual([b.id, c.id].sort());
  });

  it('ignores SENT events from before the IST day boundary', async () => {
    const now = ist(2026, 6, 1, 9, 0);
    const yesterday = ist(2026, 5, 31, 22, 0);

    const s = await makeSubscriber('yesterday');
    await seedSentEvent(s.id, yesterday);
    await seedSentEvent(s.id, yesterday);

    const { kept, capped } = await filterByCap([s], 1, now);
    expect(kept.map((x) => x.id)).toEqual([s.id]);
    expect(capped).toHaveLength(0);
  });

  it('returns empty arrays for an empty input', async () => {
    const result = await filterByCap([], 4, new Date());
    expect(result).toEqual({ kept: [], capped: [] });
  });
});
