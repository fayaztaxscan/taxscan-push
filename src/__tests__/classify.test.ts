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

  it('Supreme Court outranks a tribunal mention', () => {
    const c = classify('Supreme Court reverses ITAT order on Section 263 revision');
    expect(c.authority).toBe('Supreme Court');
    expect(c.tier).toBe(1);
  });

  it('does not false-match ITAT inside GSTAT', () => {
    expect(classify('GSTAT confirms profiteering').authority).toBe('GSTAT');
  });
});
