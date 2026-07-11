import { prisma } from '../lib/prisma';
import { listCampaigns, readsPath } from '../services/metrics';
import { env } from '../lib/env';

describe('readsPath', () => {
  it('normalizes taxscan URLs to a slash-trimmed path; null for other hosts', () => {
    expect(readsPath('https://www.taxscan.in/top-stories/x-123456/')).toBe('/top-stories/x-123456');
    expect(readsPath('https://taxscan.in/top-stories/x-123456')).toBe('/top-stories/x-123456');
    expect(readsPath('https://academy.taxscan.in/course/gst-101')).toBeNull();
    expect(readsPath('not a url')).toBeNull();
  });
});

describe('listCampaigns reads join', () => {
  const portal = `test-creads-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  const slug = `/top-stories/${portal}-123456`;
  const ids: string[] = [];

  afterAll(async () => {
    await prisma.campaign.deleteMany({ where: { id: { in: ids } } });
    await prisma.articleReadStat.deleteMany({ where: { pagePath: { startsWith: slug } } });
  });

  it('sums ArticleReadStat across days (and trailing-slash spellings); null when no data', async () => {
    const mk = (title: string, url: string) =>
      prisma.campaign.create({
        data: { portal, title, body: '.', url, target: { type: 'all' } },
      });
    const withReads = await mk('with reads', `https://www.taxscan.in${slug}/`);
    const noReads = await mk('no reads', `https://www.taxscan.in/top-stories/${portal}-777777`);
    const storefront = await mk('storefront', 'https://academy.taxscan.in/course/x');
    ids.push(withReads.id, noReads.id, storefront.id);

    await prisma.articleReadStat.createMany({
      data: [
        // GA reported the path without a trailing slash one day, with it the next.
        { portal: env.rss.portal, pagePath: slug, date: new Date('2026-07-09'), totalViews: 100, pushViews: 10 },
        { portal: env.rss.portal, pagePath: `${slug}/`, date: new Date('2026-07-10'), totalViews: 40, pushViews: 5 },
      ],
    });

    const rows = await listCampaigns(200);
    const find = (id: string) => rows.find((r) => r.id === id);
    expect(find(withReads.id)).toMatchObject({ reads: 140, pushReads: 15 });
    expect(find(noReads.id)).toMatchObject({ reads: null, pushReads: null });
    expect(find(storefront.id)).toMatchObject({ reads: null, pushReads: null });
  });
});
