/**
 * Brief 2026-11-03-digest-story-row-fit: the built-in digest's story row is in proportion to the reading pane (picture
 * and text side by side from ~600 px up), the text is compact enough to sit beside the picture, ICYMI stays aligned.
 * Pure renderer tests; the real-browser check is in the brief's REPORT (screenshots).
 */
import * as fs from 'fs';
import * as path from 'path';
import { parseDigestEnv, type DigestEnv } from '../lib/env';
import type { FrozenItem } from '../services/digest/builder';
import { renderDigest, fitSummary, HEADLINE_2LINE_CHARS, SUMMARY_1LINE_CHARS, SUMMARY_2LINE_CHARS } from '../services/digest/renderer';

const ASSET = 'https://push.taxscan.in';
const PIC = 'https://documents.taxscan.in/cms/media/a-4242.jpg';
const cfg = (): DigestEnv =>
  parseDigestEnv({
    DIGEST_ENABLED: 'true', DIGEST_SEND_LIVE: 'true', DIGEST_APPROVAL_REQUIRED: 'false',
    DIGEST_FREE_LIST_IDS: 'a', DIGEST_FREE_EXCLUDE_LIST_IDS: 'b', DIGEST_PREMIUM_LIST_IDS: 'b',
    DIGEST_POSTAL_ADDRESS: 'Taxscan Media, Kochi, Kerala 682001, India', DIGEST_ASSET_BASE_URL: ASSET,
  });
const mk = (i: number, o: Partial<FrozenItem> = {}): FrozenItem => ({
  rank: i, section: 'MAIN', articleKey: `article:${9000 + i}`, campaignId: null, title: `Headline ${i}`,
  url: `https://www.taxscan.in/gst/s-${i}/${9000 + i}`, authority: null, category: 'GST', excerpt: 'A short summary.',
  capturedAt: new Date('2026-11-02T10:00:00Z'), readRate: null, imageUrl: PIC, ...o,
});
const render = (items: FrozenItem[]) => renderDigest({ items, audience: 'FREE', runDate: new Date(Date.UTC(2026, 10, 3)), cfg: cfg(), assetBaseUrl: ASSET });
const rowOf = (html: string, rank: number) => new RegExp(`<td [^>]*data-item="${rank}"[\\s\\S]*?</td></tr>(?=\n)`).exec(html)![0];
const base = (n: number, o: Partial<FrozenItem> = {}) => Array.from({ length: n }, (_, i) => mk(i + 1, o));

describe('1. proportional columns', () => {
  const r = render([...base(5), mk(6, { section: 'ICYMI', imageUrl: null })]);
  const row = rowOf(r.html, 1);
  it('percentage widths with min-width floors, in a font-size:0 cell; no fixed 280/560 caps', () => {
    expect(row).toContain('style="display:inline-block;width:33%;min-width:180px;vertical-align:top;"');
    expect(row).toContain('<div class="ts-stgap" style="display:inline-block;width:2.5%;');
    expect(row).toContain('style="display:inline-block;width:64%;min-width:300px;vertical-align:top;"');
    expect(row).toContain('font-size:0;line-height:0;');
    expect(row).not.toMatch(/max-width:(280|560)px/);
    expect(row).not.toMatch(/(?<![-\w])width:(280|560|300)px/);
  });
  it('the Outlook table is 100 % wide with 33 / 3 / 64 % cells', () => {
    expect(row).toContain('<!--[if mso]><table width="100%" cellpadding="0" cellspacing="0"><tr><td width="33%" valign="top"><![endif]-->');
    expect(row).toContain('<td width="3%"></td><td width="64%" valign="top">');
    expect(row).not.toContain('width="860"');
  });
  it('the ICYMI spacer is picture column + gap in the same proportions (Outlook 36 / 64 %)', () => {
    const icy = rowOf(r.html, 6);
    expect(icy).toContain('<div class="ts-stgap" style="display:inline-block;width:33%;min-width:180px;vertical-align:top;height:0;"></div>');
    expect(icy).toContain('width:2.5%;');
    expect(icy).toContain('<td width="36%" valign="top">');
    expect(icy).not.toMatch(/(?<![-\w])width:300px/);
  });
  it('the brand block follows the picture column and keeps 1.91:1 (Outlook gets a 147 px cell)', () => {
    const b = rowOf(render(base(5, { imageUrl: null })).html, 1);
    expect(b).toMatch(/class="ts-brand" width="100%"[^>]*style="width:100%;aspect-ratio:1200\/628;/);
    expect(b).not.toMatch(/class="ts-brand"[^>]*max-width:280px/);
    expect(b).toContain('<!--[if mso]><td width="1" height="147"');
  });
});

describe('2. summary fits its line budget', () => {
  const long = 'Court held the notice invalid because the assessing officer ignored the reply and evidence filed by the assessee in time. '.repeat(4).trim();
  it('short headline → at most 130 chars (2 lines), a word boundary, ending "…"', () => {
    const s = fitSummary(long, 'Short headline')!;
    expect(s.length).toBeLessThanOrEqual(SUMMARY_2LINE_CHARS);
    expect(s.length).toBeGreaterThan(SUMMARY_2LINE_CHARS - 25);
    expect(s.endsWith('…')).toBe(true);
    expect(long.startsWith(s.slice(0, -1))).toBe(true);
    expect(long.charAt(s.length - 1)).toBe(' ');
  });
  it('a headline that runs to 3 lines (> 104 chars) → at most 62 chars (1 line)', () => {
    const title = 'x '.repeat(60).trim();
    expect(title.length).toBeGreaterThan(HEADLINE_2LINE_CHARS);
    const s = fitSummary(long, title)!;
    expect(s.length).toBeLessThanOrEqual(SUMMARY_1LINE_CHARS);
    expect(s.endsWith('…')).toBe(true);
    expect(fitSummary('Fits already.', title)).toBe('Fits already.');
  });
  it('never trims the headline; an empty summary renders no <p>', () => {
    const title = 'Supreme Court Upholds Reassessment Notice u/s 148, Allows Aggregation of Escaped Income Across Multiple Assessment Years u/s 149(1A) [Read Order]';
    const html = render(base(5, { title, excerpt: long })).html;
    expect(rowOf(html, 1)).toContain(`>${title}</a></h2>`);
    expect(rowOf(render(base(5, { excerpt: null })).html, 1)).not.toContain('<p ');
    expect(fitSummary(null, 'x')).toBeNull();
  });
});

describe('3. compact sizes, phone overrides', () => {
  const html = render(base(5)).html;
  const row = rowOf(html, 1);
  it('desktop: headline 16/21, summary 14/19, Read More 30 px tall', () => {
    expect(row).toMatch(/<h2 class="ts-hl" style="[^"]*font-size:16px;line-height:21px;mso-line-height-rule:exactly/);
    expect(row).toMatch(/<p style="margin:6px 0 0 0;[^"]*font-size:14px;line-height:19px;mso-line-height-rule:exactly;color:#333333;" class="ts-body ts-sum">/);
    expect(row).toContain('<div class="ts-more" style="padding-top:7px;">');
    expect(row).toMatch(/class="ts-btn" style="display:block;height:30px;line-height:30px;/);
  });
  it('phones (≤ 600 px): stacked, min-width released, Read More 43 px full column, roomier text', () => {
    expect(html).toContain('.ts-stcol{display:block!important;width:100%!important;min-width:0!important;max-width:100%!important}');
    expect(html).toContain('.ts-btnt{width:100%!important}.ts-btn{display:block!important;width:auto!important;height:43px!important;line-height:43px!important}');
    expect(html).toContain('.ts-sum{margin-top:15px!important;font-size:16px!important;line-height:24px!important}');
  });
});

describe('4. the 15-story fixture', () => {
  const fx: { title: string; summary: string }[] = JSON.parse(fs.readFileSync(path.join(__dirname, '../../docs/briefs/2026-11-03-digest-story-row-fit.fixture.json'), 'utf8'));
  it('has 15 stories and renders under the 80 KB warning', () => {
    expect(fx).toHaveLength(15);
    const r = render(fx.map((f, i) => mk(i + 1, { title: f.title, excerpt: f.summary })));
    expect(r.budgetBytes).toBeLessThan(80 * 1024);
    expect(Buffer.byteLength(r.html)).toBeLessThan(80 * 1024);
  });
});
