import { prisma } from '../lib/prisma';
import { readsSummaryForWindow, titleFromPath } from '../services/readsReport';
import { renderReportEmail, type Report } from '../services/reports';

describe('titleFromPath', () => {
  it('derives readable text from the slug, dropping the article id', () => {
    expect(titleFromPath('/top-stories/gst-council-recommendations-binding-1448729')).toBe(
      'Gst council recommendations binding',
    );
    expect(titleFromPath('/x-123456/')).toBe('X');
  });
});

describe('readsSummaryForWindow', () => {
  const portal = `test-remail-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  const slug = (s: string) => `/top-stories/${portal}-${s}`;
  const campaignIds: string[] = [];

  // Window: 2026-07-06 .. 2026-07-13 (end exclusive), IST midnights.
  const start = new Date('2026-07-05T18:30:00.000Z'); // = 2026-07-06 00:00 IST
  const end = new Date('2026-07-12T18:30:00.000Z'); // = 2026-07-13 00:00 IST

  afterAll(async () => {
    await prisma.articleReadStat.deleteMany({ where: { portal } });
    await prisma.campaign.deleteMany({ where: { id: { in: campaignIds } } });
  });

  it('sums article reads in the window, classifies from slugs, uses captured titles', async () => {
    await prisma.articleReadStat.createMany({
      data: [
        // in-window, article, two days + a trailing-slash spelling of the same path
        { portal, pagePath: slug('itat-cash-deposits-111111'), date: new Date('2026-07-07'), totalViews: 60, pushViews: 6 },
        { portal, pagePath: `${slug('itat-cash-deposits-111111')}/`, date: new Date('2026-07-08'), totalViews: 40, pushViews: 4 },
        { portal, pagePath: slug('gst-fraud-arrest-222222'), date: new Date('2026-07-09'), totalViews: 30, pushViews: 1 },
        // non-article page → excluded
        { portal, pagePath: '/', date: new Date('2026-07-09'), totalViews: 500, pushViews: 0 },
        // out of window → excluded
        { portal, pagePath: slug('income-tax-old-333333'), date: new Date('2026-07-04'), totalViews: 999, pushViews: 9 },
      ],
    });
    // Captured campaign supplies the real headline for the top article.
    const c = await prisma.campaign.create({
      data: {
        portal,
        title: 'ITAT deletes addition on cash deposits',
        body: '.',
        url: `https://www.taxscan.in${slug('itat-cash-deposits-111111')}/`,
        target: { type: 'all' },
      },
    });
    campaignIds.push(c.id);

    const s = await readsSummaryForWindow({ start, end, portal });
    expect(s).not.toBeNull();
    expect(s!.totalReads).toBe(130); // 60+40+30; home page + out-of-window excluded
    expect(s!.pushReads).toBe(11);
    expect(s!.topArticles[0]).toMatchObject({
      title: 'ITAT deletes addition on cash deposits', // captured headline, slash-spellings folded
      reads: 100,
      pushReads: 10,
    });
    expect(s!.topArticles[1].reads).toBe(30);
    expect(s!.topArticles[1].title.toLowerCase()).toContain('gst fraud arrest'); // slug fallback
    const cat = Object.fromEntries(s!.byCategory.map((x) => [x.label, x.reads]));
    expect(cat['Income Tax']).toBe(100); // "itat …" slug classifies via title rules
    expect(cat['GST']).toBe(30);
  });

  it('returns null when the window has no read data', async () => {
    const s = await readsSummaryForWindow({
      start: new Date('2020-01-01T00:00:00Z'),
      end: new Date('2020-01-08T00:00:00Z'),
      portal,
    });
    expect(s).toBeNull();
  });
});

describe('renderReportEmail reads section', () => {
  const report: Report = {
    period: 'weekly',
    start: '2026-07-06',
    end: '2026-07-12',
    dates: ['2026-07-06'],
    total: 5,
    prevTotal: 4,
    byCategory: { rows: [], dates: ['2026-07-06'], dayTotals: [5], grandTotal: 5 },
    byBench: { rows: [], dates: ['2026-07-06'], dayTotals: [5], grandTotal: 5 },
    quality: { qualified: 3, fallback: 1, review: 1, uncategorized: 0 },
    gaps: { benchesWithNothing: [] },
  } as unknown as Report;

  it('renders "How it was read" only when a summary is passed', () => {
    const without = renderReportEmail(report);
    expect(without.html).not.toContain('How it was read');

    const withReads = renderReportEmail(report, {
      totalReads: 156000,
      pushReads: 2300,
      byCategory: [{ label: 'Income Tax', reads: 80000 }],
      topArticles: [{ title: 'ITAT deletes addition', reads: 4900, pushReads: 14 }],
    });
    expect(withReads.html).toContain('How it was read');
    expect(withReads.html).toContain('156.0k');
    expect(withReads.html).toContain('ITAT deletes addition');
    expect(withReads.text).toContain('156.0k article reads');
  });
});
