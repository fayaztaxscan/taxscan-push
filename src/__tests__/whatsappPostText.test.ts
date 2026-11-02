import { buildPostText, cleanHeadline, shortLine, articleContentOf, SHORT_LINE_MAX } from '../services/whatsapp/postText';
import { withWhatsAppUtm, WA_UTM_SOURCE, WA_UTM_MEDIUM, WA_UTM_CAMPAIGN } from '../services/whatsapp/utm';

/** Brief 2026-11-02-whatsapp-channel-queue, acceptance 1 and 2. */
const URL_ = 'https://www.taxscan.in/income-tax/itat-allows-deduction-1451580';
const c = (over: Partial<{ id: string; title: string; body: string; url: string }> = {}) => ({ id: 'c1', title: 'ITAT allows deduction', body: 'The Tribunal held that the claim was valid.', url: URL_, ...over });

describe('1. the post text', () => {
  it('is the bold headline, the short line and the UTM link, each on its own paragraph', () => {
    expect(buildPostText(c())).toBe(
      '*ITAT allows deduction*\n\nThe Tribunal held that the claim was valid.\n\n' +
        'https://www.taxscan.in/income-tax/itat-allows-deduction-1451580?utm_source=taxscan-whatsapp&utm_medium=social&utm_campaign=whatsapp-channel&utm_content=1451580',
    );
  });
  it('strips * _ ~ and backticks from the headline', () => {
    expect(cleanHeadline('*Bold* _it_ ~strike~ `code` ruling')).toBe('Bold it strike code ruling');
    expect(buildPostText(c({ title: 'A *big* _ruling_ ~here~ `now`' }))!.startsWith('*A big ruling here now*\n\n')).toBe(true);
  });
  it('drops the middle line (and its blank line) when the body is empty or equals the headline', () => {
    for (const body of ['', '   ', 'ITAT allows deduction', 'itat  allows\ndeduction']) {
      const t = buildPostText(c({ body }))!;
      expect(t.split('\n\n')).toHaveLength(2);
      expect(t.startsWith('*ITAT allows deduction*\n\nhttps://www.taxscan.in/')).toBe(true);
    }
  });
  it('collapses whitespace and cuts the line at a word boundary to ≤ 160 characters with "…"', () => {
    const body = 'word '.repeat(80);
    const line = shortLine(body);
    expect(line.length).toBeLessThanOrEqual(SHORT_LINE_MAX);
    expect(line.endsWith('…')).toBe(true);
    expect(line).toMatch(/^(word )*word…$/);
    expect(shortLine('a\n\n  b   c')).toBe('a b c');
    expect(shortLine('x'.repeat(200))).toBe(`${'x'.repeat(159)}…`); // no space to cut at
    expect(shortLine('y'.repeat(160))).toBe('y'.repeat(160)); // exactly at the limit: untouched
  });
  it('is null for a link that is not a taxscan article, or is off the allowlist', () => {
    expect(buildPostText(c({ url: 'https://www.taxscan.in/' }))).toBeNull();
    expect(buildPostText(c({ url: 'https://academy.taxscan.in/course-123456' }))).toBeNull();
    expect(buildPostText(c({ url: 'not a url' }))).toBeNull();
    expect(articleContentOf(c())).toBe('1451580');
  });
  it('G4: the home page, a section page and academy / shop are excluded; a no-id /<section>/<slug> is an article', () => {
    for (const url of ['https://www.taxscan.in/', 'https://www.taxscan.in', 'https://www.taxscan.in/income-tax', 'https://www.taxscan.in/income-tax/', 'https://taxscan.in/gst', 'https://academy.taxscan.in/a/b', 'https://shop.taxscan.in/products/some-book-123456', 'https://example.com/a/b', 'ftp://www.taxscan.in/a/b']) {
      expect(articleContentOf({ url })).toBeNull();
      expect(buildPostText(c({ url }))).toBeNull();
    }
    expect(articleContentOf({ url: 'https://www.taxscan.in/income-tax/some-ruling-itat' })).toBe('some-ruling-itat');
    expect(articleContentOf({ url: 'https://taxscan.in/gst/x-1234' })).toBe('1234');
    expect(articleContentOf({ url: 'https://www.taxscan.in/gst-1451580' })).toBe('1451580'); // one segment, but an old id
  });
});

describe('G2. utm_content: the id when there is one, else the slug (≤ 100 characters)', () => {
  const NOID = 'https://www.taxscan.in/income-tax/interest-received-on-enhanced-compensation-us-28-of-land-acquisition-act-is-not-taxable-us-562viii-rws-57iv-of-it-act-itat-read-order';
  it('a no-id URL carries utm_content=<slug>; an id URL keeps utm_content=<id>', () => {
    const t = buildPostText(c({ url: NOID }))!;
    const link = new URL(t.split('\n\n').pop()!);
    expect(link.searchParams.getAll('utm_content')).toEqual([NOID.split('/').pop()!.slice(0, 100)]);
    expect(link.searchParams.get('utm_content')!.length).toBeLessThanOrEqual(100);
    expect(link.searchParams.get('utm_source')).toBe('taxscan-whatsapp');
    expect(new URL(buildPostText(c())!.split('\n\n').pop()!).searchParams.get('utm_content')).toBe('1451580');
  });
});

describe('2. the UTMs', () => {
  const q = (u: string) => new URL(u).searchParams;
  it('has exactly one each of source / medium / campaign / content', () => {
    const p = q(withWhatsAppUtm(URL_, '1451580'));
    expect(p.getAll('utm_source')).toEqual([WA_UTM_SOURCE]);
    expect(p.getAll('utm_medium')).toEqual([WA_UTM_MEDIUM]);
    expect(p.getAll('utm_campaign')).toEqual([WA_UTM_CAMPAIGN]);
    expect(p.getAll('utm_content')).toEqual(['1451580']);
    expect([WA_UTM_SOURCE, WA_UTM_MEDIUM, WA_UTM_CAMPAIGN]).toEqual(['taxscan-whatsapp', 'social', 'whatsapp-channel']);
  });
  it('replaces the push\'s own UTMs (SET, never duplicate), keeping other params and the fragment', () => {
    const out = withWhatsAppUtm(`${URL_}?utm_source=taxscan-push&utm_medium=push&utm_term=x&ref=home&UTM_Campaign=old#comments`, '1451580');
    const p = q(out);
    expect(p.getAll('utm_source')).toEqual(['taxscan-whatsapp']);
    expect(p.getAll('utm_medium')).toEqual(['social']);
    expect(p.has('utm_term')).toBe(false);
    expect([...p.keys()].filter((k) => k.toLowerCase() === 'utm_campaign')).toEqual(['utm_campaign']);
    expect(p.get('ref')).toBe('home');
    expect(new URL(out).hash).toBe('#comments');
  });
  it('the post text never carries the push\'s tagged URL', () => {
    const t = buildPostText(c({ url: `${URL_}?utm_source=taxscan-push&utm_medium=push` }))!;
    expect(t).not.toContain('taxscan-push');
    expect((t.match(/utm_source=/g) ?? []).length).toBe(1);
  });
});
