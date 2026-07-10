import { prisma } from '../lib/prisma';
import { buildReport, customReportWindow, detectBench, istDateKey, reportCategory } from '../services/reports';

const IST_OFFSET_MIN = 5 * 60 + 30;
function ist(y: number, m: number, d: number, h = 0, min = 0): Date {
  return new Date(Date.UTC(y, m - 1, d, h, min) - IST_OFFSET_MIN * 60 * 1000);
}

const portal = `test-report-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
const ids: string[] = [];

// Each article gets a unique permalink (as in production) unless an explicit
// `url` is passed — a shared URL models a re-send (backfill clone / re-push).
let urlSeq = 0;
async function art(opts: {
  title: string;
  categories: string[];
  at: Date;
  queue?: 'QUALIFIED' | 'FALLBACK' | 'REVIEW';
  url?: string;
  portal?: string;
}) {
  const c = await prisma.campaign.create({
    data: {
      portal: opts.portal ?? portal,
      title: opts.title,
      body: '.',
      url: opts.url ?? `https://taxscan.in/a/${(urlSeq += 1)}`,
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

  it('infers the category from the title when no usable RSS tag (back-fill fidelity)', () => {
    expect(reportCategory([], 'Relief: ITAT deletes addition [Read Order]')).toBe('Income Tax');
    expect(reportCategory([], 'CESTAT sets aside customs duty demand')).toBe('Customs');
    expect(reportCategory(['Top Stories'], 'GST on rent: Bombay HC [Read Order]')).toBe('GST');
    expect(reportCategory([], 'NCLT admits insolvency plea')).toBe('Corporate Law');
    expect(reportCategory([], 'A generic update with no subject signal')).toBe('Uncategorized');
  });

  it('maps the comma-joined "Other Taxations" tag to its own clean row', () => {
    // taxscan's feed emits ONE joined tag string, not separate tags.
    expect(reportCategory(['Other Taxations,Top Stories'])).toBe('Other Taxations');
    expect(reportCategory(['Other Taxations'])).toBe('Other Taxations');
    // The tag wins over title inference — respect taxscan's own tagging.
    expect(reportCategory(['Other Taxations,Top Stories'], 'How to Claim a TDS Refund: A Guide')).toBe(
      'Other Taxations',
    );
  });

  it('infers profession/audit pieces from the title (were Uncategorized)', () => {
    expect(
      reportCategory([], 'Important Pointers to Finalize Books of Accounts Before Tax Audit: A Guide'),
    ).toBe('Audit/Profession');
    expect(reportCategory([], 'ESG Auditing: The New Goldmine for Indian CA Firms')).toBe('Audit/Profession');
    expect(reportCategory([], 'ICAI releases new guidance note for members')).toBe('Audit/Profession');
    // A subject keyword still wins over the generic profession vocabulary.
    expect(reportCategory([], 'GST Audit: Department issues notices')).toBe('GST');
  });

  it('activates the previously tag-only categories from the title', () => {
    expect(reportCategory([], 'Transfer Pricing: ITAT deletes ALP adjustment')).toBe('International Tax/TP');
    expect(reportCategory([], 'India-Mauritius DTAA benefit allowed')).toBe('International Tax/TP');
    expect(reportCategory([], 'Enforcement Directorate attaches assets in Money Laundering case')).toBe(
      'Benami/PMLA',
    );
    expect(reportCategory([], 'Benami property transaction: appeal dismissed')).toBe('Benami/PMLA');
    expect(reportCategory([], 'FEMA violation: penalty upheld')).toBe('FEMA');
    expect(reportCategory([], 'EPFO issues circular on provident fund withdrawal')).toBe('Labour Law');
    // Tax keywords outrank Labour Law so TDS-on-EPF stays a tax story.
    expect(reportCategory([], 'TDS on EPF withdrawal: what you should know')).toBe('Income Tax');
  });

  it('classifies round-ups and job posts by content form, before subject keywords', () => {
    expect(reportCategory([], 'GST Case Digest: Weekly Round-Up')).toBe('Round-Ups/Digests');
    expect(reportCategory([], 'Supreme Court and High Courts Weekly Round Up')).toBe('Round-Ups/Digests');
    expect(reportCategory([], 'CA Vacancy in Deloitte')).toBe('JobScan');
    expect(reportCategory([], 'Recruitment: Income Tax Department hiring Inspectors')).toBe('JobScan');
  });
});

describe('customReportWindow', () => {
  // Fixed "now": 2026-07-10 12:00 IST.
  const now = ist(2026, 7, 10, 12);

  it('returns an inclusive [from, to] window (end = to + 1 day) and allows to = today', () => {
    const w = customReportWindow('2026-07-01', '2026-07-10', now);
    expect(istDateKey(w.start)).toBe('2026-07-01');
    expect(istDateKey(w.end)).toBe('2026-07-11'); // exclusive
    // A single-day range is valid too.
    const one = customReportWindow('2026-07-05', '2026-07-05', now);
    expect(istDateKey(one.start)).toBe('2026-07-05');
    expect(istDateKey(one.end)).toBe('2026-07-06');
  });

  it('accepts exactly 30 days and rejects 31', () => {
    expect(() => customReportWindow('2026-06-11', '2026-07-10', now)).not.toThrow(); // 30 days
    expect(() => customReportWindow('2026-06-10', '2026-07-10', now)).toThrow(/limited to 30 days/);
  });

  it('rejects reversed, future, malformed, and non-existent dates', () => {
    expect(() => customReportWindow('2026-07-08', '2026-07-05', now)).toThrow(/on or before/);
    expect(() => customReportWindow('2026-07-09', '2026-07-11', now)).toThrow(/future/);
    expect(() => customReportWindow('07/01/2026', '2026-07-10', now)).toThrow(/YYYY-MM-DD/);
    expect(() => customReportWindow('', '2026-07-10', now)).toThrow(/YYYY-MM-DD/);
    expect(() => customReportWindow('2026-02-31', '2026-03-05', now)).toThrow(/does not exist/);
  });
});

describe('buildReport', () => {
  it('builds a custom-period report over an arbitrary window with a same-length previous window', async () => {
    const p = `test-report-custom-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    // Window: 10 days, 2026-05-11 .. 2026-05-20 (inclusive).
    const { start, end } = customReportWindow('2026-05-11', '2026-05-20', ist(2026, 5, 21, 12));
    await art({ title: 'Prior-window ITAT order [Read Order]', categories: ['Income Tax'], at: ist(2026, 5, 3, 10), portal: p }); // in the preceding 10 days
    await art({ title: 'Bombay HC ruling [Read Order]', categories: ['Income Tax'], at: ist(2026, 5, 12, 10), queue: 'QUALIFIED', portal: p });
    await art({ title: 'GST circular explained', categories: ['CST & VAT / GST'], at: ist(2026, 5, 19, 9), queue: 'REVIEW', portal: p });

    const r = await buildReport({ portal: p, period: 'custom', start, end });
    expect(r.period).toBe('custom');
    expect(r.dates.length).toBe(10);
    expect(r.start).toBe('2026-05-11');
    expect(r.end).toBe('2026-05-20');
    expect(r.total).toBe(2);
    expect(r.prevTotal).toBe(1); // the 05-01..05-10 window right before
  });

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

  it('orders bench rows by hierarchy (SC → priority HC → other HC → tribunal → Unspecified), not volume', async () => {
    const p = `test-report-order-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const start = ist(2026, 7, 6);
    const end = ist(2026, 7, 13);
    const mk = async (title: string, n: number) => {
      for (let i = 0; i < n; i += 1) {
        await art({ title, categories: [], at: ist(2026, 7, 8, 9), portal: p });
      }
    };
    await mk('Relief: ITAT [Read Order]', 5); // highest volume — must NOT lead
    await mk('Supreme Court ruling [Read Judgment]', 1);
    await mk('Bombay HC quashes notice [Read Order]', 1); // priority HC
    await mk('Delhi High Court allows appeal', 1); // other HC
    await mk('GST explainer with no court', 1); // Unspecified

    const r = await buildReport({ portal: p, period: 'weekly', start, end });
    expect(r.byBench.rows.map((x) => x.label)).toEqual([
      'Supreme Court',
      'Bombay High Court',
      'Delhi High Court',
      'ITAT',
      'Unspecified',
    ]);
  });

  it('counts a re-sent article once (backfill clone / manual re-push share the URL)', async () => {
    const p = `test-report-resend-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const start = ist(2026, 8, 3);
    const end = ist(2026, 8, 10); // 7 days: 08-03 .. 08-09
    const url = 'https://taxscan.in/bombay-hc-ruling/999';
    // Original capture — classified, with RSS categories.
    await art({ title: 'Bombay HC ruling [Read Order]', categories: ['Income Tax'], at: ist(2026, 8, 4, 10), queue: 'QUALIFIED', url, portal: p });
    // Morning backfill clone re-sent next day: same URL, same createdAt, but the
    // clone drops categories (cloneForResend doesn't copy them). Must NOT recount.
    await art({ title: 'Bombay HC ruling [Read Order]', categories: [], at: ist(2026, 8, 4, 10), queue: 'QUALIFIED', url, portal: p });
    // A genuinely different article keeps its own URL and still counts.
    await art({ title: 'Delhi High Court allows appeal', categories: ['GST'], at: ist(2026, 8, 5, 9), queue: 'QUALIFIED', url: 'https://taxscan.in/delhi/1', portal: p });

    const r = await buildReport({ portal: p, period: 'weekly', start, end });
    expect(r.total).toBe(2); // re-send collapsed; the distinct article still counts
    expect(r.quality).toMatchObject({ qualified: 2 });
    // The richest row is kept, so the original's RSS category survives the dedupe.
    expect(r.byCategory.rows.find((x) => x.label === 'Income Tax')?.total).toBe(1);
    expect(r.byBench.rows.find((x) => x.label === 'Bombay High Court')?.total).toBe(1);
  });

  it('excludes academy/shop storefront pushes (not editorial articles)', async () => {
    const p = `test-report-stores-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const start = ist(2026, 9, 7);
    const end = ist(2026, 9, 14); // 7 days: 09-07 .. 09-13
    await art({ title: 'GST ruling [Read Order]', categories: ['GST'], at: ist(2026, 9, 8, 10), queue: 'QUALIFIED', url: 'https://www.taxscan.in/gst/1', portal: p });
    await art({ title: 'New CA course launched', categories: [], at: ist(2026, 9, 8, 11), url: 'https://academy.taxscan.in/courses/123', portal: p });
    await art({ title: 'Tax software 20% off', categories: [], at: ist(2026, 9, 9, 11), url: 'https://shop.taxscan.in/product/9', portal: p });
    // prior-window storefront push must not inflate prevTotal either.
    await art({ title: 'Earlier course promo', categories: [], at: ist(2026, 9, 2, 11), url: 'https://academy.taxscan.in/courses/1', portal: p });

    const r = await buildReport({ portal: p, period: 'weekly', start, end });
    expect(r.total).toBe(1); // only the taxscan.in article
    expect(r.prevTotal).toBe(0); // the prior academy promo is excluded
    expect(r.byCategory.rows.find((x) => x.label === 'GST')?.total).toBe(1);
  });
});
