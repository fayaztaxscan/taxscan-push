import fs from 'fs';
import path from 'path';
import { buildCommentary, buildPost, escapeLittleText, fetchCmsArticle, hashtagsFor, hashtagTemplate, parseCmsArticle, sectionTag, camelCase, slugOf, MAX_HASHTAGS } from '../services/linkedin/post';
import { withLinkedInUtm } from '../services/linkedin/pages';
import { isPublicArticleCampaign, isTestSegmentOnly } from '../services/social/publicCampaign';
import { withWhatsAppUtm } from '../services/whatsapp/utm';

/** Brief 2026-11-02-linkedin-page-posting, acceptance 1–3 (commentary, hashtags from recorded CMS fixtures, UTM link). */
jest.spyOn(console, 'log').mockImplementation(() => undefined);

const fixture = (n: string) => parseCmsArticle(JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/linkedin', `cms-${n}.json`), 'utf8')))!;
const tagsOf = (cms: ReturnType<typeof fixture> | null, authority: string | null = null, categories: string[] = []) => hashtagsFor({ cms, authority, categories });
const line = (tags: string[]) => tags.map((t) => `#${t}`).join(' ');

describe('1. the commentary (little text format)', () => {
  it('escapes every reserved character with a backslash', () => {
    expect(escapeLittleText('\\ | { } @ [ ] ( ) < > # * _ ~')).toBe('\\\\ \\| \\{ \\} \\@ \\[ \\] \\( \\) \\< \\> \\# \\* \\_ \\~');
    expect(escapeLittleText('plain text, 2026-27: ok & fine')).toBe('plain text, 2026-27: ok & fine');
  });
  it('is the escaped headline, a blank line, then well-formed hashtag templates', () => {
    const { tags } = tagsOf(null, 'CBDT', ['Income Tax']);
    expect(buildCommentary('CBDT Sets Cost Inflation Index at 384 for FY 2026-27 [Read Notification]', tags)).toBe(
      'CBDT Sets Cost Inflation Index at 384 for FY 2026-27 \\[Read Notification\\]\n\n{hashtag|\\#|CBDT} {hashtag|\\#|IncomeTax} {hashtag|\\#|taxscan}',
    );
    expect(hashtagTemplate('GST')).toBe('{hashtag|\\#|GST}');
    expect(buildCommentary('Interest u/s 28 (2) is not taxable', ['taxscan'])).toBe('Interest u/s 28 \\(2\\) is not taxable\n\n{hashtag|\\#|taxscan}');
  });
});

describe('2. hashtags from the CMS\'s editorial data (the three 2 Nov articles, recorded)', () => {
  it('ITAT Panaji, Land Acquisition interest', () => {
    expect(line(tagsOf(fixture('itat-panaji')).tags)).toBe('#ITATPanaji #IncomeTax #NFAC #LandAcquisitionAct #Section57 #taxscan');
  });
  it('ICAI revaluation reserve (the ICAI keyword and the long institute name drop out; Other Taxations is skipped)', () => {
    expect(line(tagsOf(fixture('icai-revaluation')).tags)).toBe('#ICAI #CashFlowStatement #CharteredAccountant #RevaluationReserve #taxscan');
  });
  it('Telangana HC GST arrest', () => {
    expect(line(tagsOf(fixture('telangana-gst-arrest')).tags)).toBe('#TelanganaHighCourt #GST #GSTArrest #Section69CGST #DGGIInvestigation #taxscan');
  });
  it('max 6, unique case-insensitively, letters and digits only, taxscan last, never #TaxNews', () => {
    for (const n of ['itat-panaji', 'icai-revaluation', 'telangana-gst-arrest']) {
      const { tags, source } = tagsOf(fixture(n));
      expect(source).toBe('cms');
      expect(tags.length).toBeLessThanOrEqual(MAX_HASHTAGS);
      expect(new Set(tags.map((t) => t.toLowerCase())).size).toBe(tags.length);
      for (const t of tags) expect(t).toMatch(/^[A-Za-z0-9]+$/);
      expect(tags[tags.length - 1]).toBe('taxscan');
      expect(tags.map((t) => t.toLowerCase())).not.toContain('taxnews');
    }
  });
  it('the building blocks: SC → SupremeCourt, section tags, CamelCase with acronyms', () => {
    expect(tagsOf({ keywords: [], courts: [{ name: 'Supreme Court of India', shortName: 'SC' }], category: 'GST' }).tags).toEqual(['SupremeCourt', 'GST', 'taxscan']);
    expect(sectionTag('Section 270A')).toBe('Section270A');
    expect(sectionTag('Section 145A(b)')).toBe('Section145A');
    expect(sectionTag('Section 57(iv) of the Income Tax Act')).toBe('Section57');
    expect(sectionTag('Section 69 CGST Act')).toBe('Section69CGST');
    expect(sectionTag('Section 17(5) IGST')).toBe('Section17IGST');
    expect(sectionTag('Article 226')).toBeNull();
    expect(camelCase('input tax credit')).toBe('InputTaxCredit');
    expect(camelCase('gst arrest')).toBe('GSTArrest');
  });
  it('a long SEO keyword, apostrophes, brackets and stop-list keywords are dropped', () => {
    const cms = { keywords: ['Income Tax Act', 'Interest', 'Assessing Officer', 'Tax', 'Order', 'Judgment', 'Result Date', "Bank's Auditor", 'CIT(A)', 'ICAI disciplinary action against auditor', 'Writ Petition'], courts: [], category: 'Income Tax' };
    expect(tagsOf(cms).tags).toEqual(['IncomeTax', 'WritPetition', 'taxscan']);
  });
  it('a CMS timeout / 404 / 500 / bad body → the fallback (authority + category + taxscan), and the post is still built', async () => {
    expect(tagsOf(null, 'Supreme Court', ['Income Tax', 'Top Stories'])).toEqual({ tags: ['SupremeCourt', 'IncomeTax', 'taxscan'], source: 'fallback' });
    expect(tagsOf(null, 'CESTAT', ['Customs,Top Stories']).tags).toEqual(['CESTAT', 'Customs', 'taxscan']);
    expect(tagsOf({ keywords: [], courts: [], category: 'GST' }, 'ITAT', []).source).toBe('fallback'); // no usable editorial data
    const c = { id: 'c1', title: 'GST ruling [Read Order]', url: 'https://www.taxscan.in/gst/some-ruling-read-order', authority: 'Supreme Court', categories: ['GST'] };
    for (const fail of [() => Promise.resolve(null), () => Promise.reject(new Error('boom'))]) {
      const p = await buildPost(c, 'taxscan', fail);
      expect(p).not.toBeNull();
      expect(p!.hashtagSource).toBe('fallback');
      expect(p!.hashtags).toEqual(['SupremeCourt', 'GST', 'taxscan']);
    }
  });
  it('fetchCmsArticle: parses a good answer; null on 404, 500, a timeout/abort, junk, an oversized body, and never leaves api.taxscan.in', async () => {
    const ok = JSON.stringify({ keywords: ['NFAC'], courts: [{ name: 'Income Tax Appellate Tribunal', shortName: 'ITAT' }], category_name: 'Income Tax' });
    const res = (status: number, body: string, headers: Record<string, string> = {}) => ({ ok: status < 400, status, headers: new Headers(headers), arrayBuffer: async () => new TextEncoder().encode(body).buffer }) as unknown as Response;
    const calls: string[] = [];
    const f = (r: Response | Error) => (async (url: string) => { calls.push(url); if (r instanceof Error) throw r; return r; }) as unknown as typeof fetch;
    expect(await fetchCmsArticle('a-slug', f(res(200, ok)))).toEqual({ keywords: ['NFAC'], courts: [{ name: 'Income Tax Appellate Tribunal', shortName: 'ITAT' }], category: 'Income Tax' });
    expect(calls[0]).toBe('https://api.taxscan.in/api/v1/articles/a-slug');
    expect(await fetchCmsArticle('a-slug', f(res(404, 'x')))).toBeNull();
    expect(await fetchCmsArticle('a-slug', f(res(500, 'x')))).toBeNull();
    expect(await fetchCmsArticle('a-slug', f(Object.assign(new Error('aborted'), { name: 'AbortError' })))).toBeNull();
    expect(await fetchCmsArticle('a-slug', f(res(200, 'not json')))).toBeNull();
    expect(await fetchCmsArticle('a-slug', f(res(200, ok, { 'content-length': String(3 * 1024 * 1024) })))).toBeNull();
    expect(await fetchCmsArticle('../evil', f(res(200, ok)))).not.toBeUndefined(); // the slug is encoded into the path, the host is fixed
    expect(calls.every((u) => new URL(u).hostname === 'api.taxscan.in')).toBe(true);
    expect(slugOf('https://www.taxscan.in/gst/a-slug-1451580')).toBe('a-slug-1451580');
  });
});

describe('H. the shared predicate (WhatsApp queue + LinkedIn worker)', () => {
  const url = 'https://www.taxscan.in/gst/a-ruling-read-order';
  it('qualifies a public article whoever sent it; not a test-segment-only target, nor a non-article', () => {
    expect(isPublicArticleCampaign({ url, target: { type: 'all' } })).toBe(true);
    expect(isPublicArticleCampaign({ url, target: { type: 'topics', topics: ['gst'] } })).toBe(true);
    expect(isPublicArticleCampaign({ url })).toBe(true);
    expect(isPublicArticleCampaign({ url, target: { type: 'topics', topics: ['test'] } }, 'test')).toBe(false);
    expect(isPublicArticleCampaign({ url, target: { type: 'topics', topics: [' Test '] } }, 'test')).toBe(false);
    expect(isPublicArticleCampaign({ url, target: { type: 'topics', topics: ['test', 'gst'] } }, 'test')).toBe(true);
    expect(isPublicArticleCampaign({ url, target: { type: 'topics', topics: ['staff-only'] } }, 'staff-only')).toBe(false); // TEST_SEGMENT_TOPIC is configurable
    expect(isTestSegmentOnly({ type: 'all' }, 'test')).toBe(false);
    expect(isTestSegmentOnly({ type: 'topics', topics: [] }, 'test')).toBe(false);
    expect(isPublicArticleCampaign({ url: 'https://www.taxscan.in/', target: { type: 'all' } })).toBe(false);
    expect(isPublicArticleCampaign({ url: 'https://academy.taxscan.in/a/b', target: { type: 'all' } })).toBe(false);
  });
});

describe('3. the UTM link', () => {
  const q = (u: string) => new URL(u).searchParams;
  it('exactly one each of source / medium / campaign / content, for both URL shapes; other params and the fragment survive', () => {
    const noId = 'https://www.taxscan.in/income-tax/some-long-slug-itat';
    const withId = 'https://www.taxscan.in/top-stories/old-shape-1451580';
    for (const [url, content] of [[noId, 'some-long-slug-itat'], [withId, '1451580']] as const) {
      const p = q(withLinkedInUtm(`${url}?utm_source=taxscan-push&utm_medium=push&ref=home#c`, 'taxscan', content));
      expect(p.getAll('utm_source')).toEqual(['taxscan-linkedin']);
      expect(p.getAll('utm_medium')).toEqual(['social']);
      expect(p.getAll('utm_campaign')).toEqual(['linkedin-taxscan']);
      expect(p.getAll('utm_content')).toEqual([content]);
      expect(p.get('ref')).toBe('home');
    }
    expect(new URL(withLinkedInUtm('https://www.taxscan.in/a/b#frag', 'taxscan', 'b')).hash).toBe('#frag');
    expect(q(withLinkedInUtm(noId, 'shopscan', 'x')).get('utm_campaign')).toBe('linkedin-shopscan'); // a later page = config only
  });
  it('the built post carries that link (slug as utm_content for a no-id URL) and the WhatsApp helper still builds its own', async () => {
    const p = await buildPost({ id: 'c', title: 'T', url: 'https://www.taxscan.in/gst/the-slug-read-order', authority: null, categories: [] }, 'taxscan', async () => null);
    expect(q(p!.link).get('utm_content')).toBe('the-slug-read-order');
    expect(q(p!.link).get('utm_source')).toBe('taxscan-linkedin');
    expect(q(withWhatsAppUtm('https://www.taxscan.in/gst/x-1234', '1234')).get('utm_source')).toBe('taxscan-whatsapp');
  });
  it('is null for academy / shop / the home page', async () => {
    for (const url of ['https://academy.taxscan.in/a/b', 'https://www.taxscan.in/', 'https://www.taxscan.in/gst']) {
      expect(await buildPost({ id: 'c', title: 'T', url, authority: null, categories: [] }, 'taxscan', async () => null)).toBeNull();
    }
  });
});
