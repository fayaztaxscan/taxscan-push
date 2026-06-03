/**
 * One-off cleanup: drops any Subscriber + linked Events whose portal starts
 * with `test-`. The Task 10d security audit found three rate-limit-test
 * subscribers (portal `test-sec`) had landed in the production DB because
 * jest was being pointed at the Railway connection string.
 *
 * Run once after adopting a separate test DB (see README → "Local test
 * database"). Safe to re-run — counts of zero on a clean DB are expected.
 */

import { prisma } from '../src/lib/prisma';

(async () => {
  const subs = await prisma.subscriber.findMany({
    where: { portal: { startsWith: 'test-' } },
    select: { id: true, endpoint: true, portal: true },
  });

  // eslint-disable-next-line no-console
  console.log(`[cleanup-test-portals] found ${subs.length} subscriber(s) with portal=test-*`);
  for (const s of subs) {
    // eslint-disable-next-line no-console
    console.log(`  ${s.id}  portal=${s.portal}  endpoint=…${s.endpoint.slice(-30)}`);
  }

  if (subs.length > 0) {
    const ids = subs.map((s) => s.id);
    const ev = await prisma.event.deleteMany({ where: { subscriberId: { in: ids } } });
    const su = await prisma.subscriber.deleteMany({ where: { id: { in: ids } } });
    // eslint-disable-next-line no-console
    console.log(`[cleanup-test-portals] deleted ${ev.count} event(s), ${su.count} subscriber(s)`);
  }

  const remaining = await prisma.subscriber.count({ where: { status: 'ACTIVE' } });
  // eslint-disable-next-line no-console
  console.log(`[cleanup-test-portals] activeSubscribers now: ${remaining}`);

  await prisma.$disconnect();
})().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
