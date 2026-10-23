import { prisma } from '../lib/prisma';

/**
 * TEST-ONLY: three house ads (any slot, both audiences) so the real renderer
 * can fill every slot of a test portal's digest (task 9: a slot is never left
 * empty — without ads the build fails closed). Idempotent per portal.
 */
export async function ensureTestAds(portal: string): Promise<void> {
  if ((await prisma.digestAd.count({ where: { portal } })) >= 3) return;
  await prisma.digestAd.createMany({
    data: [1, 2, 3].map((i) => ({
      portal,
      name: `Test house ad ${i}`,
      kind: 'HOUSE',
      headline: `Taxscan Academy course ${i}`,
      altText: `Course ${i}`,
      ctaText: 'Enrol now',
      linkUrl: `https://academy.taxscan.in/course-${i}`,
      audience: 'ALL',
      slots: [],
      priority: 10 - i,
      status: 'ACTIVE',
    })),
  });
}

/** Ads of these portals go after their runs (placements cascade with the runs; ads are RESTRICT). */
export async function deleteTestAds(portalPrefix: string): Promise<void> {
  await prisma.digestAdPlacement.deleteMany({ where: { ad: { portal: { startsWith: portalPrefix } } } });
  await prisma.digestAd.deleteMany({ where: { portal: { startsWith: portalPrefix } } });
}
