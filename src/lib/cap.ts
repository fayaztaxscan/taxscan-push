import type { Subscriber } from '@prisma/client';
import { prisma } from './prisma';
import { startOfTodayIST } from './quietHours';

/**
 * Splits subscribers into who should receive this campaign vs. who to hold back.
 *
 * - `capped`: already at the daily frequency cap (≥ `cap` SENT events since the
 *   start of the IST day).
 * - `cooled`: received a notification within the last `minGapMs` (the
 *   per-subscriber cooldown). Prevents back-to-back bursts when several
 *   campaigns dispatch close together. `minGapMs <= 0` disables this check.
 *
 * Precedence is capped → cooled → kept (a subscriber over the daily cap is
 * reported as `capped` even if also inside the cooldown window).
 */
export async function filterByCap(
  subscribers: Subscriber[],
  cap: number,
  now: Date,
  minGapMs = 0,
): Promise<{ kept: Subscriber[]; capped: Subscriber[]; cooled: Subscriber[] }> {
  if (subscribers.length === 0) return { kept: [], capped: [], cooled: [] };

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

  // Cooldown: anyone with a SENT event newer than (now - minGapMs) is still
  // "warm" and gets skipped this round. One extra query, only when enabled.
  const cooledSet = new Set<string>();
  if (minGapMs > 0) {
    const cutoff = new Date(now.getTime() - minGapMs);
    const recent = await prisma.event.findMany({
      where: { type: 'SENT', subscriberId: { in: ids }, createdAt: { gte: cutoff } },
      select: { subscriberId: true },
      distinct: ['subscriberId'],
    });
    for (const r of recent) {
      if (r.subscriberId) cooledSet.add(r.subscriberId);
    }
  }

  const kept: Subscriber[] = [];
  const capped: Subscriber[] = [];
  const cooled: Subscriber[] = [];
  for (const s of subscribers) {
    if ((countMap.get(s.id) ?? 0) >= cap) capped.push(s);
    else if (cooledSet.has(s.id)) cooled.push(s);
    else kept.push(s);
  }
  return { kept, capped, cooled };
}
