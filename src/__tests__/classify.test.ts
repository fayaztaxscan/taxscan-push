import { classify } from '../services/classify';

describe('classify (editorial push policy)', () => {
  // Real taxscan titles pulled from the live feeds (2026-06-16).
  const QUALIFIED: Array<[string, string]> = [
    [
      'GSTAT Procedure Rules Proposed Amendments: What Changed & What It Means for GST Litigation',
      'GSTAT',
    ],
    ['Lifestyle International kept GST-inclusive prices unchanged: GSTAT confirms profiteering', 'GSTAT'],
    ['ICAI finds CA Not Guilty in CBI Trap Case Linked to Income Tax Bribery with Tax Officer', 'ICAI'],
    [
      'IBBI Issues Fourth Amendment to Insolvency Rules, Enhancing Creditor Role [Read Notification]',
      'IBBI',
    ],
    ['Supreme Court upholds reassessment notice under Income Tax Act [Read Judgment]', 'Supreme Court'],
    ['Delhi High Court quashes GST demand for lack of hearing [Read Order]', 'High Court'],
    ['CBDT notifies new TDS rates for FY 2026-27 [Read Notification]', 'CBDT'],
    ['CBIC clarifies customs valuation for related-party imports [Read Circular]', 'CBIC'],
    ['DGFT amends export policy for agricultural goods', 'DGFT'],
  ];

  const FALLBACK: Array<[string, string]> = [
    ['Disallowance under Income Tax Act cannot be based on Cash Deposits: ITAT [Read Order]', 'ITAT'],
    ['Renting Residential Premises to Educational Foundation Not Service Taxable: CESTAT [Read Order]', 'CESTAT'],
    ['NCLAT upholds resolution plan rejecting belated claim', 'NCLAT'],
    ['NCLT Admits SBI Insolvency Plea Against Personal Guarantor', 'NCLT'],
  ];

  const REVIEW: string[] = [
    'GST on Renting of Property: Understanding the Tax Implications for Landlords and Tenants',
    'Next GST Council Meet to Advance Process Reforms, Address Inverted Duty Issues',
    'GST on RWA Maintenance Charges: Understanding the Legal and Practical Landscape',
  ];

  it.each(QUALIFIED)('QUALIFIED: %s', (title, authority) => {
    const c = classify(title);
    expect(c.queue).toBe('QUALIFIED');
    expect(c.authority).toBe(authority);
    expect(c.tier).toBeLessThan(10);
  });

  it.each(FALLBACK)('FALLBACK: %s', (title, authority) => {
    const c = classify(title);
    expect(c.queue).toBe('FALLBACK');
    expect(c.authority).toBe(authority);
  });

  it.each(REVIEW)('REVIEW (no authority): %s', (title) => {
    const c = classify(title);
    expect(c.queue).toBe('REVIEW');
    expect(c.authority).toBeNull();
  });

  it('higher court wins a mixed-authority title (HC over CESTAT)', () => {
    const c = classify(
      'CESTAT Set Aside Demand Under Extended Limitation: Jharkhand HC Directs GST Authority',
    );
    expect(c.queue).toBe('QUALIFIED');
    expect(c.authority).toBe('High Court');
  });

  it('detects Bombay High Court as a priority bench (tier 2, distinct authority)', () => {
    const full = classify('Bombay High Court quashes reassessment notice [Read Order]');
    expect(full.queue).toBe('QUALIFIED');
    expect(full.authority).toBe('Bombay High Court');
    expect(full.tier).toBe(2);

    const abbrev = classify('Sanction for Reopening Invalid: Bombay HC Quashes Notices [Read Order]');
    expect(abbrev.authority).toBe('Bombay High Court');
    expect(abbrev.tier).toBe(2);
  });

  it('a non-priority High Court stays generic (tier 3)', () => {
    const c = classify('Karnataka HC dismisses tax appeal over delay [Read Order]');
    expect(c.authority).toBe('High Court');
    expect(c.tier).toBe(3);
  });

  it('Supreme Court still wins over a priority High Court in a mixed title', () => {
    const c = classify('Supreme Court sets aside Bombay HC order on Section 148 [Read Judgment]');
    expect(c.authority).toBe('Supreme Court');
    expect(c.tier).toBe(1);
  });

  it('Supreme Court outranks a tribunal mention', () => {
    const c = classify('Supreme Court reverses ITAT order on Section 263 revision');
    expect(c.authority).toBe('Supreme Court');
    expect(c.tier).toBe(1);
  });

  it('does not false-match ITAT inside GSTAT', () => {
    expect(classify('GSTAT confirms profiteering').authority).toBe('GSTAT');
  });

  it('routes job / recruitment posts to REVIEW (never auto-sent)', () => {
    for (const title of [
      'MBA, B.com, CA Vacancy In Deloitte',
      'Walk-in Interview for Accountants at XYZ Pvt Ltd',
      'Internship Opportunity at ABC LLP for CA students',
      'EY Hiring Tax Associates — Apply Now',
    ]) {
      const c = classify(title);
      expect(c.queue).toBe('REVIEW');
      expect(c.authority).toBeNull();
    }
  });

  it('a recruitment post that names an authority still goes to REVIEW', () => {
    // "ICAI Recruitment" would otherwise classify as QUALIFIED (ICAI); the job
    // rule takes precedence so an editor decides.
    const c = classify('ICAI Recruitment 2026: Apply for Various Officer Posts');
    expect(c.queue).toBe('REVIEW');
  });

  it('does not treat "Job Work under GST" as a job post', () => {
    // Bare "job"/"job work" is a GST concept, not a vacancy — must classify by
    // its authority, not get swept into the job→REVIEW rule.
    const c = classify('Job Work Charges Not Taxable under GST: CESTAT [Read Order]');
    expect(c.queue).toBe('FALLBACK');
    expect(c.authority).toBe('CESTAT');
  });
});
