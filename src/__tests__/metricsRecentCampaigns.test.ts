/**
 * Regression test for the dashboard "Recent campaigns" feed (buildMetrics).
 *
 * The panel is sorted by PUSH time, but the candidate query was ordered by
 * CAPTURE time (createdAt) with take:20 — so a campaign pushed recently but
 * captured earlier (the pacer sends oldest-first; morning backfill + manual
 * Push-now replay older drafts) fell outside the window and went missing.
 * buildMetrics now also unions in the most-recently-pushed campaigns.
 *
 * Note: buildMetrics queries campaigns globally (no portal scope), so this test
 * seeds enough fresh captures to push the old-but-just-sent campaign out of the
 * newest-20-by-createdAt window, then asserts it still appears via the push path.
 */
import { buildMetrics } from '../services/metrics';
import { prisma } from '../lib/prisma';

const ids: string[] = [];
const tag = `metrics-recent-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

async function makeCampaign(opts: { createdAt: Date; sentAt?: Date; title: string }): Promise<string> {
  const c = await prisma.campaign.create({
    data: {
      portal: 'taxscan',
      title: opts.title,
      body: '.',
      url: 'https://taxscan.in',
      target: { type: 'all' },
      status: opts.sentAt ? 'SENT' : 'DRAFT',
      createdAt: opts.createdAt,
    },
  });
  ids.push(c.id);
  if (opts.sentAt) {
    await prisma.event.create({ data: { campaignId: c.id, type: 'SENT', createdAt: opts.sentAt } });
  }
  return c.id;
}

afterAll(async () => {
  if (ids.length) {
    await prisma.event.deleteMany({ where: { campaignId: { in: ids } } });
    await prisma.campaign.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.$disconnect();
});

it('surfaces a recently-pushed campaign captured outside the newest-20 window', async () => {
  const now = new Date();
  // Captured 10 days ago but PUSHED just now — the case that used to disappear.
  const oldId = await makeCampaign({
    createdAt: new Date(now.getTime() - 10 * 24 * 3600 * 1000),
    sentAt: now,
    title: `${tag}-old-but-just-pushed`,
  });
  // 22 freshly-captured drafts so the old one is well outside the newest-20.
  for (let i = 0; i < 22; i++) {
    await makeCampaign({ createdAt: new Date(now.getTime() - i * 1000), title: `${tag}-fresh-${i}` });
  }

  const m = await buildMetrics();
  const found = m.campaigns.find((c) => c.id === oldId);
  expect(found).toBeDefined(); // present despite being outside the newest-20 captures
  expect(found?.sentAt).not.toBeNull(); // and its push time resolved
});
