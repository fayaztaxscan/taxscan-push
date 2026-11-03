/**
 * Brief 2026-10-29-digest-polish: the built-in digest keeps its brand colours, picture sizes, alignment and ad
 * shape in every mail app. Pure renderer tests (the browser checks are in the REPORT).
 */
import fs from 'fs';
import path from 'path';
import { parseDigestEnv, type DigestEnv } from '../lib/env';
import type { FrozenItem } from '../services/digest/builder';
import { renderDigest, BUILTIN_TEMPLATE_HTML, HEADER_BANNER_PATH, LOGO_PATH, STORY_IMAGE_WIDTH, STORY_IMAGE_HEIGHT, AD_IMAGE_DISPLAY_WIDTH, type RenderAd } from '../services/digest/renderer';
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
  it('dark mode recolours background and text together: no pinned yellow or purple, no Outlook forced-colour rules (owner, 2 Nov)', () => {
    expect(html).not.toContain('linear-gradient(#FEE620');
    expect(html).not.toContain('linear-gradient(#3b3543,#3b3543);text-align'); // no header cell pins its colour
    expect(html).not.toContain('[data-ogsb]');
    expect(html).not.toContain('[data-ogsc]');
    expect(html).not.toContain('class="ts-pad ts-hdr"'); // no coloured header cell any more
    expect(html).not.toContain('.ts-hdr{');
    // the brand block (a picture placeholder, no text) keeps its own pin
    expect(render(items(5, null)).html).toMatch(/class="ts-brand"[^>]*background-image:linear-gradient\(#3b3543,#3b3543\)/);
  });
  it('light mode is unchanged: every Read more / CTA button is #000000 on #FEE620, in a #FEE620 cell', () => {
    const btns = html.match(/<a href="[^"]*" class="ts-btn" style="[^"]*">/g) ?? [];
    expect(btns.length).toBeGreaterThan(0);
    for (const b of btns) {
      expect(b).toContain('background-color:#FEE620;');
      expect(b).toContain('color:#000000;');
    }
    expect((html.match(/bgcolor="#FEE620"/g) ?? []).length).toBe(btns.length);
  });
  it('the logo is the on-dark PNG, which exists, is 440×106 and has no transparency', () => {
    expect(LOGO_PATH).toBe('/email/taxscan-logo-on-dark-440.png');
    // a custom template using {{logo}} still draws it exactly as before (F5)
    const custom = renderDigest({ items: items(5, null), audience: 'FREE', runDate: RUN_DATE, cfg: cfg(), assetBaseUrl: ASSET, template: { html: BUILTIN_TEMPLATE_HTML.replace('{{header}}', '<tr><td>{{logo}}</td></tr>') } });
    expect(custom.html).toContain(`<img class="ts-logo" src="${ASSET}/email/taxscan-logo-on-dark-440.png" width="220" height="53"`);
    const png = fs.readFileSync(path.join(__dirname, '../../public/email/taxscan-logo-on-dark-440.png'));
    expect(png.readUInt32BE(16)).toBe(440);
    expect(png.readUInt32BE(20)).toBe(106);
    expect(png[25]).toBe(2); // colour type 2 = RGB, no alpha channel
    expect(fs.existsSync(path.join(__dirname, '../../public/email/taxscan-logo-white-440.png'))).toBe(true); // sent mail uses it
  });
});

describe('1b. the header is one banner picture, the date line sits below it on white (follow-up 1)', () => {
  const free = render(items(5, PIC)).html;
  const premium = renderDigest({ items: items(5, PIC), audience: 'PREMIUM', runDate: RUN_DATE, cfg: cfg(), assetBaseUrl: ASSET, ads: [ad(1, 800, 210), ad(2, 1200, 628), ad(3, 1200, 628)] }).html;
  const bannerFile = path.join(__dirname, '../../public/email/taxscan-header-1800x220.png');
  it('F1: a single <img> ending /email/taxscan-header-1800x220.png, width 900, alt Taxscan, in a link home, on a row with no colour', () => {
    expect(HEADER_BANNER_PATH).toBe('/email/taxscan-header-1800x220.png');
    for (const html of [free, premium]) {
      const banners = html.match(/<img class="ts-banner"[^>]*>/g) ?? [];
      expect(banners).toHaveLength(1);
      expect(banners[0]).toContain(`src="${ASSET}/email/taxscan-header-1800x220.png"`);
      expect(banners[0]).toContain(' width="900" alt="Taxscan"');
      expect(banners[0]).toContain('style="display:block;width:100%;max-width:900px;height:auto;');
      const row = /<tr><td align="center" style="padding:0;font-size:0;line-height:0;"><a href="https:\/\/www\.taxscan\.in\/[^"]*" style="display:block;text-decoration:none;"><img class="ts-banner"[^>]*><\/a><\/td><\/tr>/.exec(html);
      expect(row).not.toBeNull();
      expect(row![0]).not.toMatch(/bgcolor|background-color:#3b3543;[^"]*"><a/); // the picture carries the colour, not the row
    }
  });
  it('F2: the PNG is exactly 1800×220, ≤ 25 KB, and its corners are #3b3543', () => {
    const png = fs.readFileSync(bannerFile);
    expect(png.readUInt32BE(16)).toBe(1800);
    expect(png.readUInt32BE(20)).toBe(220);
    expect(png.length).toBeLessThanOrEqual(25 * 1024);
    // palette PNG: the first PLTE entry is the background (the corner pixel is index 0 of a solid fill)
    const plte = png.indexOf('PLTE');
    expect(plte).toBeGreaterThan(0);
    expect(png[25]).toBe(3);
    const entries = png.readUInt32BE(plte - 4) / 3;
    const colours = Array.from({ length: entries }, (_, i) => png.subarray(plte + 4 + i * 3, plte + 7 + i * 3).toString('hex'));
    expect(colours).toContain('3b3543');
  });
  it('F3: the date line comes after the banner, #111111 on the white card; the Premium badge is #111111 and only in Premium', () => {
    for (const html of [free, premium]) {
      const line = /<td class="ts-card ts-pad" data-header="1"[^>]*padding:14px 20px;background-color:#ffffff;[^>]*><p class="ts-hdr-text"[^>]*color:#111111;">Daily Digest &middot; [^<]*(<span[^>]*>Premium<\/span>)?<\/p>/.exec(html);
      expect(line).not.toBeNull();
      expect(html.indexOf('ts-banner')).toBeLessThan(html.indexOf('data-header="1"'));
      expect(html.indexOf('data-header="1"')).toBeLessThan(html.indexOf('data-item="1"'));
    }
    expect(premium).toMatch(/border:1px solid #111111;[^"]*color:#111111;[^"]*">Premium<\/span>/);
    expect(free).not.toContain('>Premium</span>');
  });
  it('F5: a custom template using {{logo}} / {{premium_badge}} renders the old markup unchanged', () => {
    const t = (a: 'FREE' | 'PREMIUM') =>
      renderDigest({ items: items(5, null), audience: a, runDate: RUN_DATE, cfg: cfg(), assetBaseUrl: ASSET, ads: [ad(1, 800, 210), ad(2, 1200, 628), ad(3, 1200, 628)], template: { html: BUILTIN_TEMPLATE_HTML.replace('{{header}}', '<tr><td>{{logo}} Daily Digest &middot; {{date}}{{premium_badge}}</td></tr>') } }).html;
    expect(t('FREE')).toContain(`<img class="ts-logo" src="${ASSET}/email/taxscan-logo-on-dark-440.png" width="220" height="53" alt="Taxscan" style="display:block;margin:0 auto;width:220px;max-width:100%;height:auto;border:0;outline:none;text-decoration:none;color:#ffffff;font-family:Arial,'Helvetica Neue',Helvetica,sans-serif;font-size:28px;line-height:53px;font-weight:700;letter-spacing:0.08em;">`);
    expect(t('PREMIUM')).toContain(`border:1px solid #ffffff;border-radius:12px;font-family:Arial,'Helvetica Neue',Helvetica,sans-serif;font-size:14px;line-height:20px;font-weight:700;color:#ffffff;vertical-align:middle;">Premium</span>`);
  });
});

describe('2. pictures keep their size in every app', () => {
  const row = rowOf(render(items(10, PIC)).html, 1);
  it('explicit width AND height attributes plus fixed inline sizes (desktop 280 px, 1.91:1 box)', () => {
    expect(STORY_IMAGE_WIDTH).toBe(280);
    expect(STORY_IMAGE_HEIGHT).toBe(147);
    expect(row).toMatch(/<img class="ts-pic adapt-img"[^>]* width="280" height="147" /);
    // fluid inline: it fills its column (280 px on desktop, the full column when the column stacks), always 1.91:1
    expect(row).toContain('style="display:block;width:100%;height:auto;aspect-ratio:1200/628;object-fit:cover;');
  });
  it('stripping <style> (Zoho-like) keeps the fluid inline sizes (the columns are 33 % / 64 % with min-width floors, so they stack by themselves on a narrow pane without a media query)', () => {
    const stripped = render(items(10, PIC)).html.replace(/<style>[\s\S]*?<\/style>/, '');
    expect(rowOf(stripped, 1)).toContain('width:100%;height:auto;aspect-ratio:1200/628');
    expect(rowOf(stripped, 1)).toContain('class="ts-stcol ts-stpic" style="display:inline-block;width:33%;min-width:180px;');
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
  it('no padding above the headline; Read More has 7 px above it (13 px on phones)', () => {
    expect(row).not.toMatch(/class="ts-head"[^>]*padding/);
    expect(row).toContain('<div class="ts-more" style="padding-top:7px;">');
  });
  it('Read More is a fixed 96×30 box (the old newsletter\'s is 38 × 95; compact so the text fits beside the picture), text centred both ways, as a table cell (Outlook paints the cell), one link', () => {
    expect(row).toContain('class="ts-btn" style="display:block;height:30px;line-height:30px;text-align:center;');
    expect(row).toMatch(/<td align="center" width="96" height="30" bgcolor="#FEE620"/);
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

describe('size: the worst case stays under the 80 KB warning', () => {
  it('both audiences; the figures', () => {
    const c = cfg();
    const f = worstCaseFixture(c);
    const out: string[] = [];
    for (const audience of ['FREE', 'PREMIUM'] as const) {
      const r = renderDigest({ items: f.items, audience, runDate: RUN_DATE, cfg: c, ads: f.ads, assetBaseUrl: ASSET, mode: 'check' });
      out.push(`${audience}: html ${r.htmlBytes} B, budget ${r.budgetBytes} B`);
      expect(r.budgetBytes).toBeLessThan(80 * 1024);
    }
    // eslint-disable-next-line no-console
    console.info(out.join('\n'));
  });

  it('15 main stories, no ICYMI, 3 ads: also under the warning and well under the 90 KB refusal; the figures', () => {
    const c = cfg();
    const f = worstCaseFixture(c);
    const main = f.items.map((i, n) => ({ ...i, section: 'MAIN' as const, rank: n + 1 }));
    const out: string[] = [];
    for (const audience of ['FREE', 'PREMIUM'] as const) {
      const r = renderDigest({ items: main, audience, runDate: RUN_DATE, cfg: c, ads: f.ads, assetBaseUrl: ASSET, mode: 'check' });
      out.push(`${audience} 15 main: html ${r.htmlBytes} B, budget ${r.budgetBytes} B`);
      expect(main).toHaveLength(15);
      expect(r.budgetBytes).toBeLessThan(80 * 1024);
      expect(r.budgetBytes).toBeLessThan(c.maxHtmlKb * 1024 - 10 * 1024);
    }
    // eslint-disable-next-line no-console
    console.info(out.join('\n'));
  });
});
