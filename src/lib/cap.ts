import type { Subscriber } from '@prisma/client';
import { prisma } from './prisma';
import { startOfTodayIST } from './quietHours';

export async function filterByCap(
  subscribers: Subscriber[],
  cap: number,
  now: Date,
): Promise<{ kept: Subscriber[]; capped: Subscriber[] }> {
  if (subscribers.length === 0) return { kept: [], capped: [] };

  const todayStart = startOfTodayIST(now);
  const ids = subscribers.map((s) => s.id);

  const groups = await prisma.event.groupBy({
    by: ['subscriberId'],
    where: {
      type: 'SENT',
      subscriberId: { in: ids },
      createdAt: { gte: todayStart },
    },
    _count: { _all: true },
  });

  const countMap = new Map<string, number>();
  for (const g of groups) {
    if (g.subscriberId) countMap.set(g.subscriberId, g._count._all);
  }

  const kept: Subscriber[] = [];
  const capped: Subscriber[] = [];
  for (const s of subscribers) {
    if ((countMap.get(s.id) ?? 0) >= cap) capped.push(s);
    else kept.push(s);
  }
  return { kept, capped };
}
