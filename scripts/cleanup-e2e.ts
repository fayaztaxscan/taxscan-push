import { prisma } from '../src/lib/prisma';

const TEST_PREFIX = 'https://e2e-test.example.com/sub/';

(async () => {
  // Subscribers seeded by the Playwright E2E suite (and their events).
  const subs = await prisma.subscriber.findMany({
    where: { endpoint: { startsWith: TEST_PREFIX } },
    select: { id: true },
  });
  const subIds = subs.map((s) => s.id);
  if (subIds.length) {
    await prisma.event.deleteMany({ where: { subscriberId: { in: subIds } } });
    await prisma.subscriber.deleteMany({ where: { id: { in: subIds } } });
  }

  // Campaigns created by the spec — match on the "E2E " title prefix.
  const campaigns = await prisma.campaign.findMany({
    where: { title: { startsWith: 'E2E ' } },
    select: { id: true },
  });
  const campaignIds = campaigns.map((c) => c.id);
  if (campaignIds.length) {
    await prisma.event.deleteMany({ where: { campaignId: { in: campaignIds } } });
    await prisma.campaign.deleteMany({ where: { id: { in: campaignIds } } });
  }

  // eslint-disable-next-line no-console
  console.log(`[e2e-cleanup] removed ${subs.length} subscribers, ${campaigns.length} campaigns`);
  await prisma.$disconnect();
})().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
