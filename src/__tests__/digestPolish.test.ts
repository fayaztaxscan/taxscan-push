/**
 * Brief 2026-10-29-digest-polish: the built-in digest keeps its brand colours, picture sizes, alignment and ad
 * shape in every mail app. Pure renderer tests (the browser checks are in the REPORT).
 */
import fs from 'fs';
import path from 'path';
import { parseDigestEnv, type DigestEnv } from '../lib/env';
import type { FrozenItem } from '../services/digest/builder';
import { renderDigest, LOGO_PATH, STORY_IMAGE_WIDTH, STORY_IMAGE_HEIGHT, AD_IMAGE_DISPLAY_WIDTH, type RenderAd } from '../services/digest/renderer';
import { worstCaseFixture } from '../services/digest/templates';

const RUN_DATE = new Date(Date.UTC(2026, 9, 29));
const ASSET = 'https://push.taxscan.in';
const PIC = 'https://documents.taxscan.in/cms/media/gst-registration-cancelled-itc-4242.jpg';

function cfg(): DigestEnv {
  return parseDigestEnv({
    DIGEST_ENABLED: 'true',
    DIGEST_SEND_LIVE: 'true',
    DIGEST_APPROVAL_REQUIRED: 'false',
    DIGEST_FREE_LIST_IDS: 'list-free',
    DIGEST_FREE_EXCLUDE_LIST_IDS: 'list-premium',
    DIGEST_PREMIUM_LIST_IDS: 'list-premium',
    DIGEST_POSTAL_ADDRESS: 'Taxscan Media, 1st Floor, Example Building, Kochi, Kerala 682001, India',
    DIGEST_ASSET_BASE_URL: ASSET,
  });
}

const items = (k: number, img: string | null): FrozenItem[] =>
  Array.from({ length: k }, (_, i) => ({
    rank: i + 1,
    section: 'MAIN' as const,
    articleKey: `article:${7000 + i}`,
    campaignId: null,
    title: `Story headline number ${i + 1}`,
    url: `https://www.taxscan.in/gst/story-${i + 1}/${7000 + i}`,
    authority: 'Karnataka High Court',
    category: 'GST',
    excerpt: `Summary ${i + 1}.`,
    capturedAt: new Date('2026-10-28T10:00:00Z'),
    readRate: null,
    imageUrl: img,
  }));
const ad = (slot: number, w: number, h: number): RenderAd => ({
  slot,
  adId: `ad${slot}`,
  kind: 'HOUSE',
  headline: `Ad ${slot}`,
  body: null,
  ctaText: 'Go',
  linkUrl: 'https://academy.taxscan.in/x',
  altText: `Banner ${slot}`,
  image: { url: `${ASSET}/email-assets/${'c'.repeat(64)}.png`, width: w, height: h },
});
const render = (its: FrozenItem[], ads: RenderAd[] = [ad(1, 800, 210), ad(2, 1200, 628), ad(3, 1200, 628)]) =>
  renderDigest({ items: its, audience: 'FREE', runDate: RUN_DATE, cfg: cfg(), assetBaseUrl: ASSET, ads });
// A row ends at `</td></tr>` + newline (the story markup holds `</td></tr>` inside its MSO table and brand block).
const rowOf = (html: string, rank: number) => new RegExp(`<td [^>]*data-item="${rank}"[\\s\\S]*?</td></tr>(?=\n)`).exec(html)![0];

describe('1. brand colours hold in every mode', () => {
  const html = render(items(10, PIC)).html;
  it('declares light only (meta + :root) and has no dark palette', () => {
    expect(html).toContain('<meta name="color-scheme" content="light">');
    expect(html).toContain('<meta name="supported-color-schemes" content="light">');
    expect(html).toContain(':root{color-scheme:light;supported-color-schemes:light}');
    expect(html).not.toContain('prefers-color-scheme');
    expect(html).not.toContain('#111214'); // the old dark page colour
  });
  it('the header carries background-color AND the gradient fallback, plus Gmail forced-colour hooks', () => {
    expect(html).toMatch(/class="ts-pad ts-hdr"[^>]*background-color:#3b3543;background-image:linear-gradient\(#3b3543,#3b3543\);/);
    expect(html).toContain('[data-ogsb] .ts-hdr{background-color:#3b3543!important}');
    expect(html).toContain('[data-ogsc] .ts-hdr-text{color:#ffffff!important}');
  });
  it('every Read more / CTA button carries both too', () => {
    const btns = html.match(/<a href="[^"]*" class="ts-btn" style="[^"]*">/g) ?? [];
    expect(btns.length).toBeGreaterThan(0);
    for (const b of btns) expect(b).toContain('background-color:#FEE620;background-image:linear-gradient(#FEE620,#FEE620);');
  });
  it('the logo is the on-dark PNG, which exists, is 440×106 and has no transparency', () => {
    expect(LOGO_PATH).toBe('/email/taxscan-logo-on-dark-440.png');
    expect(html).toContain(`<img class="ts-logo" src="${ASSET}/email/taxscan-logo-on-dark-440.png" width="220" height="53"`);
    const png = fs.readFileSync(path.join(__dirname, '../../public/email/taxscan-logo-on-dark-440.png'));
    expect(png.readUInt32BE(16)).toBe(440);
    expect(png.readUInt32BE(20)).toBe(106);
    expect(png[25]).toBe(2); // colour type 2 = RGB, no alpha channel
    expect(fs.existsSync(path.join(__dirname, '../../public/email/taxscan-logo-white-440.png'))).toBe(true); // sent mail uses it
  });
});

describe('2. pictures keep their size in every app', () => {
  const row = rowOf(render(items(10, PIC)).html, 1);
  it('explicit width AND height attributes plus fixed inline sizes (desktop 280 px, 1.91:1 box)', () => {
    expect(STORY_IMAGE_WIDTH).toBe(280);
    expect(STORY_IMAGE_HEIGHT).toBe(147);
    expect(row).toMatch(/<img class="ts-pic adapt-img"[^>]* width="280" height="147" /);
    expect(row).toContain('style="display:block;width:280px;max-width:100%;height:147px;object-fit:cover;');
  });
  it('stripping <style> (Zoho-like) leaves the picture at those sizes', () => {
    const stripped = render(items(10, PIC)).html.replace(/<style>[\s\S]*?<\/style>/, '');
    expect(rowOf(stripped, 1)).toContain('width:280px;max-width:100%;height:147px');
  });
  it('phones: the stylesheet makes it full width at its natural aspect', () => {
    expect(render(items(10, PIC)).html).toContain('.ts-pic,.adapt-img{width:100%!important;max-width:100%!important;height:auto!important}');
  });
});

describe('3. alignment', () => {
  const row = rowOf(render(items(10, PIC)).html, 1);
  it('picture and text columns both start at the top (cells valign=top, vertical-align:top)', () => {
    expect((row.match(/valign="top"/g) ?? []).length).toBe(2);
    expect((row.match(/class="ts-stcol[^"]*"[^>]*style="[^"]*vertical-align:top/g) ?? []).length).toBe(2);
  });
  it('no padding above the headline; Read More has 13 px above it', () => {
    expect(row).not.toMatch(/class="ts-head"[^>]*padding/);
    expect(row).toContain('<div style="padding-top:13px;">');
  });
  it('Read More is a fixed 96×38 box (the old newsletter\'s is 95), text centred both ways, as a table cell (Outlook paints the cell), one link', () => {
    expect(row).toContain('class="ts-btn" style="display:block;height:38px;line-height:38px;text-align:center;');
    expect(row).toMatch(/<td align="center" width="96" height="38" bgcolor="#FEE620"/);
    expect(row).not.toContain('v:rect'); // one URL per button: no VML copy
    expect((row.match(/href=/g) ?? []).length).toBe(3); // picture, headline, Read More
  });
});

describe('4. ads at full content width, real aspect', () => {
  it('an 800×210 banner and a 1200×628 banner both draw at 860 px wide with heights from the stored size', () => {
    const html = render(items(10, null)).html;
    const imgs = [...html.matchAll(/<img class="adapt-img" src="[^"]*email-assets[^"]*" width="(\d+)" height="(\d+)"/g)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(AD_IMAGE_DISPLAY_WIDTH).toBe(860);
    expect(imgs).toEqual([
      [860, 226], // 800×210
      [860, 450], // 1200×628
      [860, 450],
    ]);
    expect(html).toContain('style="display:block;width:100%;max-width:860px;height:auto;');
  });
});

describe('size: the worst case stays under 75 KB', () => {
  it('both audiences; the figures', () => {
    const c = cfg();
    const f = worstCaseFixture(c);
    const out: string[] = [];
    for (const audience of ['FREE', 'PREMIUM'] as const) {
      const r = renderDigest({ items: f.items, audience, runDate: RUN_DATE, cfg: c, ads: f.ads, assetBaseUrl: ASSET, mode: 'check' });
      out.push(`${audience}: html ${r.htmlBytes} B, budget ${r.budgetBytes} B`);
      expect(r.budgetBytes).toBeLessThan(75 * 1024);
    }
    // eslint-disable-next-line no-console
    console.info(out.join('\n'));
  });
});
