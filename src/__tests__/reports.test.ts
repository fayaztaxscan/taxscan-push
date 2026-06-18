import { prisma } from '../lib/prisma';
import { buildReport, detectBench, reportCategory } from '../services/reports';

const IST_OFFSET_MIN = 5 * 60 + 30;
function ist(y: number, m: number, d: number, h = 0, min = 0): Date {
  return new Date(Date.UTC(y, m - 1, d, h, min) - IST_OFFSET_MIN * 60 * 1000);
}

const portal = `test-report-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
const ids: string[] = [];

async function art(opts: { title: string; categories: string[]; at: Date; queue?: 'QUALIFIED' | 'FALLBACK' | 'REVIEW' }) {
  const c = await prisma.campaign.create({
    data: {
      portal,
      title: opts.title,
      body: '.',
      url: 'https://taxscan.in',
      target: { type: 'all' },
      status: 'DRAFT',
      sendQueue: opts.queue ?? null,
      categories: opts.categories,
      createdAt: opts.at,
    },
  });
  ids.push(c.id);
  return c;
}

afterAll(async () => {
  if (ids.length) {
    await prisma.event.deleteMany({ where: { campaignId: { in: ids } } });
    await prisma.campaign.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.$disconnect();
});

describe('detectBench', () => {
  it('detects courts/tribunals by title (specific HC before generic, else Unspecified)', () => {
    expect(detectBench('Supreme Court rules on reassessment [Read Judgment]')).toBe('Supreme Court');
    expect(detectBench('Bombay HC quashes notice [Read Order]')).toBe('Bombay High Court');
    expect(detectBench('Delhi High Court allows appeal')).toBe('Delhi High Court');
    expect(detectBench('Karnataka HC dismisses petition')).toBe('Karnataka High Court');
    expect(detectBench('Relief granted: ITAT [Read Order]')).toBe('ITAT');
    expect(detectBench('CESTAT sets aside demand')).toBe('CESTAT');
    expect(detectBench('Some other High Court order')).toBe('High Court');
    expect(detectBench('Understanding GST on Renting of Property')).toBe('Unspecified');
  });
});

describe('reportCategory', () => {
  it('maps tags to rows, skips cross-cutting, falls back sensibly', () => {
    expect(reportCategory(['Income Tax', 'Top Stories'])).toBe('Income Tax');
    expect(reportCategory(['CST & VAT / GST'])).toBe('GST');
    expect(reportCategory(['Excise & Customs'])).toBe('Customs');
    expect(reportCategory(['SEBI'])).toBe('SEBI/RBI');
    expect(reportCategory(['Top Stories'])).toBe('Uncategorized'); // only cross-cutting
    expect(reportCategory([])).toBe('Uncategorized');
    expect(reportCategory(['Some New Section'])).toBe('Some New Section'); // unknown → as-is
  });
});

describe('buildReport', () => {
  it('aggregates categories, benches, totals, quality and previous-period total', async () => {
    const start = ist(2026, 6, 15);
    const end = ist(2026, 6, 22); // 7 days: 06-15 .. 06-21
    await art({ title: 'old piece', categories: ['Income Tax'], at: ist(2026, 6, 10, 10) }); // prior window
    await art({ title: 'Bombay HC ruling [Read Order]', categories: ['Income Tax', 'Top Stories'], at: ist(2026, 6, 16, 10), queue: 'QUALIFIED' });
    await art({ title: 'Relief: ITAT [Read Order]', categories: ['Income Tax'], at: ist(2026, 6, 16, 11), queue: 'FALLBACK' });
    await art({ title: 'GST on Renting: an explainer', categories: ['CST & VAT / GST'], at: ist(2026, 6, 17, 9), queue: 'REVIEW' });

    const r = await buildReport({ portal, period: 'weekly', start, end });

    expect(r.dates.length).toBe(7);
    expect(r.total).toBe(3);
    expect(r.prevTotal).toBe(1);

    expect(r.byCategory.rows.find((x) => x.label === 'Income Tax')?.total).toBe(2);
    expect(r.byCategory.rows.find((x) => x.label === 'GST')?.total).toBe(1);
    expect(r.byCategory.grandTotal).toBe(3);

    expect(r.byBench.rows.find((x) => x.label === 'Bombay High Court')?.total).toBe(1);
    expect(r.byBench.rows.find((x) => x.label === 'ITAT')?.total).toBe(1);
    expect(r.byBench.rows.find((x) => x.label === 'Unspecified')?.total).toBe(1); // the explainer

    expect(r.quality).toMatchObject({ qualified: 1, fallback: 1, review: 1 });
  });
});
