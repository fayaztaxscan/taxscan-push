/**
 * Brief 2026-10-29-digest-lookalike: the built-in digest template looks like the old Mailercloud newsletter.
 * (1) a picture beside each story, (2) the og:image fetch is fail-open and never touches a real network,
 * (3) no label above a headline; image ads are the banner only, (4) the five fixed social links,
 * (5) the size of the worst case. Pure renderer / fake fetch tests, plus one freeze round trip.
 */
import { prisma } from '../lib/prisma';
import { parseDigestEnv, type DigestEnv } from '../lib/env';
import { attachImages, writeDigestItems, type FrozenItem } from '../services/digest/builder';
import {
  fetchArticleImage,
  fetchArticleImages,
  isAllowedArticleImage,
  parseOgImage,
  ARTICLE_STEP_CAP_MS,
  ARTICLE_FETCH_TIMEOUT_MS,
  type FetchLike,
} from '../services/digest/articleImage';
import { renderDigest, isAllowedTemplateImage, isSocialUrl, isContactMailto, SOCIAL_LINKS, scanStartTags, BUILTIN_TEMPLATE_HTML, FREE_REASON, PREMIUM_REASON, RenderError, type RenderAd } from '../services/digest/renderer';
import { validateTemplate, worstCaseFixture } from '../services/digest/templates';

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

let n = 0;
function item(o: Partial<FrozenItem> = {}): FrozenItem {
  n += 1;
  return {
    rank: n,
    section: 'MAIN',
    articleKey: `article:${5000 + n}`,
    campaignId: null,
    title: `GST Registration Cancelled Over ₹8.87 Lakh ITC & more ${n}`,
    url: `https://www.taxscan.in/gst/central-govt-releases-${n}/${5000 + n}`,
    authority: 'Karnataka High Court',
    category: 'GST',
    excerpt: `The Karnataka High Court quashed the cancellation ${n}.`,
    capturedAt: new Date('2026-10-28T10:00:00Z'),
    readRate: null,
    imageUrl: null,
    ...o,
  };
}
const stories = (k: number, img: (i: number) => string | null): FrozenItem[] => Array.from({ length: k }, (_, i) => item({ imageUrl: img(i) })).map((it, i) => ({ ...it, rank: i + 1 }));
const render = (items: FrozenItem[], over: Partial<Parameters<typeof renderDigest>[0]> = {}) =>
  renderDigest({ items, audience: 'FREE', runDate: RUN_DATE, cfg: cfg(), assetBaseUrl: ASSET, ...over });
const rowOf = (html: string, rank: number) => new RegExp(`<td [^>]*data-item="${rank}"[\\s\\S]*?</td></tr>`).exec(html)![0];

/* ------------------------------------------------------------------ */
/* Acceptance 1: the picture beside a story                             */
/* ------------------------------------------------------------------ */

describe('a story with a picture is a two-column row; without one, plain text', () => {
  it('imageUrl → picture left (the ORIGINAL url, 280 px), 20 px gap, text 560 px, alt = headline; phones stack', () => {
    const its = stories(5, (i) => (i === 0 ? PIC : null));
    const r = render(its);
    const row = rowOf(r.html, 1);
    expect(row).toContain('data-image="1"');
    expect(row).toContain(`<img class="ts-pic adapt-img" src="${PIC}" width="280" height="147"`);
    expect(row).toContain('alt="GST Registration Cancelled Over ₹8.87 Lakh ITC &amp; more'); // alt = the (escaped) headline
    expect(row).toMatch(/<td class="ts-stcol ts-stpic" width="280" valign="top"/);
    expect(row).toMatch(/<td class="ts-stgap" width="20"/);
    expect(row).toMatch(/<td class="ts-stcol ts-sttext" width="560" valign="top"/);
    expect((row.match(/<a /g) ?? []).length).toBe(3); // picture link, headline, Read more — one href
    expect(new Set([...row.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1])).size).toBe(1);
    expect(r.html).toContain('@media only screen and (max-width:600px){');
    expect(r.html).toContain('.ts-stcol{display:block!important;width:100%!important}.ts-stgap{display:none!important}');
    expect(r.html).toContain('.ts-pic,.adapt-img{width:100%!important;max-width:100%!important;height:auto!important}');
    // The second story has no picture: today's single column.
    const plain = rowOf(r.html, 2);
    expect(plain).not.toContain('<img');
    expect(plain).not.toContain('data-image');
    expect(plain).toContain('>Read More</a>');
  });

  it('a picture URL that is not exactly documents.taxscan.in .jpg/.jpeg/.png renders text-only', () => {
    const bad = [
      'https://evil.example/x.jpg',
      'http://documents.taxscan.in/cms/media/a.jpg', // http
      'https://documents.taxscan.in/cms/media/a.webp', // the WebP-only resizer's format
      'https://www.taxscan.in/_img/a.jpg', // the resizer host
      'https://documents.taxscan.in:8443/cms/media/a.jpg', // port
      'https://u:p@documents.taxscan.in/cms/media/a.jpg', // userinfo
      'https://documents.taxscan.in.evil.example/a.jpg', // look-alike host
      'https://documents.taxscan.in/cms/media/a.gif',
      'javascript:alert(1)',
    ];
    for (const u of bad) {
      expect(isAllowedArticleImage(u)).toBe(false);
      const row = rowOf(render(stories(5, (i) => (i === 0 ? u : null))).html, 1);
      expect([u, row.includes('<img')]).toEqual([u, false]);
    }
    for (const ok of [PIC, 'https://documents.taxscan.in/a/b.JPEG', 'https://documents.taxscan.in/a/b.png']) expect(isAllowedArticleImage(ok)).toBe(true);
  });

  it('the image allowlist gained exactly that host: a template may use it, nothing broader', () => {
    expect(isAllowedTemplateImage(PIC, ASSET)).toBe(true);
    expect(isAllowedTemplateImage('https://documents.taxscan.in/cms/media/a.webp', ASSET)).toBe(false);
    expect(isAllowedTemplateImage('https://cdn.example.com/a.jpg', ASSET)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Acceptance 2: the og:image fetch is fail-open                        */
/* ------------------------------------------------------------------ */

const page = (head: string): FetchLike => async () => ({ ok: true, status: 200, text: async () => `<html><head>${head}</head><body></body></html>` });
const og = (u: string) => `<meta property="og:image" content="${u}">`;
const never: FetchLike = (_u, init) => new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))));
const ARTICLE = 'https://www.taxscan.in/gst/central-govt-releases-9/4242';

describe('fetchArticleImage / fetchArticleImages: every failure is "no picture", the build completes', () => {
  it('reads og:image in either attribute order, decodes entities, and asks for no redirect', async () => {
    const seen: Array<{ url: string; redirect: string }> = [];
    const f: FetchLike = async (url, init) => {
      seen.push({ url, redirect: init.redirect });
      return { ok: true, status: 200, text: async () => `<head><meta content='${PIC}?a=1&amp;b=2' property='og:image'></head>`.replace('?a=1&amp;b=2', '') };
    };
    expect(await fetchArticleImage(ARTICLE, { fetchFn: f })).toBe(PIC);
    expect(seen).toEqual([{ url: ARTICLE, redirect: 'error' }]);
    expect(parseOgImage(`<meta name="og:image" content="${PIC}">`)).toBe(PIC);
    expect(parseOgImage('<meta property="og:title" content="x">')).toBeNull();
  });

  const cases: [string, FetchLike, string][] = [
    ['a 404', async () => ({ ok: false, status: 404, text: async () => '' }), ARTICLE],
    ['a 500', async () => ({ ok: false, status: 500, text: async () => '' }), ARTICLE],
    ['a page with no og:image', page('<title>x</title>'), ARTICLE],
    ['a redirect (redirect:"error" makes fetch reject)', async () => Promise.reject(new TypeError('fetch failed: redirect')), ARTICLE],
    ['a network error', async () => Promise.reject(new Error('ECONNRESET')), ARTICLE],
    ['an http article URL', page(og(PIC)), 'http://www.taxscan.in/gst/x/4242'],
    ['a host that is not allowed', page(og(PIC)), 'https://evil.example/gst/x/4242'],
    ['an og:image on another host', page(og('https://evil.example/a.jpg')), ARTICLE],
    ['an og:image that is the WebP resizer', page(og('https://www.taxscan.in/_img/a.webp')), ARTICLE],
    ['an og:image that is not https', page(og('http://documents.taxscan.in/a.jpg')), ARTICLE],
    ['a body that throws', async () => ({ ok: true, status: 200, text: async () => Promise.reject(new Error('boom')) }), ARTICLE],
  ];
  it.each(cases)('%s → null (never throws)', async (_name, fetchFn, url) => {
    await expect(fetchArticleImage(url, { fetchFn })).resolves.toBeNull();
  });

  it('a page slower than its timeout → null', async () => {
    const t0 = Date.now();
    await expect(fetchArticleImage(ARTICLE, { fetchFn: never, timeoutMs: 30 })).resolves.toBeNull();
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(ARTICLE_FETCH_TIMEOUT_MS).toBe(5000);
  });

  it('the whole step is capped: slow pages past the cap give null for everything unfinished, and it returns at the cap', async () => {
    expect(ARTICLE_STEP_CAP_MS).toBe(30_000);
    const urls = Array.from({ length: 10 }, (_, i) => `https://www.taxscan.in/gst/s/${100 + i}`);
    const t0 = Date.now();
    const out = await fetchArticleImages(urls, { fetchFn: never, timeoutMs: 60_000, totalMs: 80 });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect([...out.values()].every((v) => v === null)).toBe(true);
    expect(out.size).toBe(10);
  });

  it('a page that answers after the cap does not count; fast ones before it do', async () => {
    const f: FetchLike = (url, init) =>
      url.endsWith('/1')
        ? Promise.resolve({ ok: true, status: 200, text: async () => og(PIC) })
        : new Promise((res, rej) => {
            const t = setTimeout(() => res({ ok: true, status: 200, text: async () => og(PIC) }), 400);
            init.signal.addEventListener('abort', () => (clearTimeout(t), rej(new Error('aborted'))));
          });
    const out = await fetchArticleImages(['https://www.taxscan.in/a/1', 'https://www.taxscan.in/a/2'], { fetchFn: f, totalMs: 100 });
    expect(out.get('https://www.taxscan.in/a/1')).toBe(PIC);
    expect(out.get('https://www.taxscan.in/a/2')).toBeNull();
  });

  it('never more than 4 pages at once', async () => {
    let live = 0;
    let max = 0;
    const f: FetchLike = async () => {
      live += 1;
      max = Math.max(max, live);
      await new Promise((r) => setTimeout(r, 15));
      live -= 1;
      return { ok: true, status: 200, text: async () => og(PIC) };
    };
    const urls = Array.from({ length: 12 }, (_, i) => `https://www.taxscan.in/gst/c/${200 + i}`);
    const out = await fetchArticleImages(urls, { fetchFn: f });
    expect(max).toBeLessThanOrEqual(4);
    expect(max).toBeGreaterThan(1);
    expect([...out.values()].every((v) => v === PIC)).toBe(true);
  });
});

describe('attachImages (the build step): fail-open, once per page, never blocks', () => {
  const lists = () => ({ FREE: [item(), item({ imageUrl: PIC })], PREMIUM: [item()] }) as Record<'FREE' | 'PREMIUM', FrozenItem[]>;

  it('fills the missing ones from one fetch per distinct page; keeps a picture an item already has (roll-forward)', async () => {
    const l = lists();
    const asked: string[][] = [];
    await attachImages(l, async (urls) => (asked.push(urls), new Map(urls.map((u) => [u, PIC] as const))));
    expect(asked).toHaveLength(1);
    expect(asked[0]).toHaveLength(2); // the two items without one; the one that has it is not asked again
    expect([...l.FREE, ...l.PREMIUM].every((i) => i.imageUrl === PIC)).toBe(true);
  });

  it('a fetcher that throws, or answers garbage, leaves every story text-only and the step completes', async () => {
    const l = lists();
    l.FREE[1].imageUrl = null;
    await attachImages(l, async () => Promise.reject(new Error('down')));
    expect([...l.FREE, ...l.PREMIUM].map((i) => i.imageUrl)).toEqual([null, null, null]);
    const l2 = lists();
    await attachImages(l2, async (urls) => new Map(urls.map((u) => [u, 'https://evil.example/a.jpg'] as const)));
    expect(l2.FREE[0].imageUrl).toBeNull();
    expect(l2.FREE[1].imageUrl).toBe(PIC);
  });
});

describe('the picture is frozen with the item (DigestItem.imageUrl) and read back', () => {
  const portal = `test-lookalike-${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  afterAll(async () => {
    await prisma.digestRun.deleteMany({ where: { portal } });
    await prisma.$disconnect();
  });
  it('writeDigestItems stores imageUrl (null when there is none)', async () => {
    const run = await prisma.digestRun.create({ data: { portal, runDate: new Date(Date.UTC(2027, 0, 5)), windowStart: new Date() } });
    const a = item({ imageUrl: PIC });
    const b = item({ imageUrl: null });
    await prisma.$transaction((tx) => writeDigestItems(tx, run.id, [{ ...a, rank: 1, audience: null }, { ...b, rank: 2, audience: null }]));
    const rows = await prisma.digestItem.findMany({ where: { runId: run.id }, orderBy: { rank: 'asc' } });
    expect(rows.map((r) => r.imageUrl)).toEqual([PIC, null]);
  });
});

/* ------------------------------------------------------------------ */
/* Acceptance 3: labels and ads                                         */
/* ------------------------------------------------------------------ */

const ad = (slot: number, o: Partial<RenderAd> = {}): RenderAd => ({
  slot,
  adId: `ad${slot}`,
  kind: 'HOUSE',
  headline: `Ad headline ${slot}`,
  body: 'Ad body text.',
  ctaText: 'Enrol now',
  linkUrl: 'https://academy.taxscan.in/gst-appeals',
  altText: `Banner ${slot} alt`,
  image: { url: `${ASSET}/email-assets/${'b'.repeat(64)}.jpg`, width: 1200, height: 600 },
  ...o,
});

describe('no label above a headline; an ad with a picture is the banner only', () => {
  it('no authority / category label is drawn on any story (with or without a picture)', () => {
    const r = render(stories(5, (i) => (i % 2 === 0 ? PIC : null)).map((it) => ({ ...it, authority: 'ZZ AUTHORITY MARKER', category: 'ZZ CATEGORY MARKER' })));
    expect(r.html).not.toMatch(/ZZ AUTHORITY MARKER|ZZ CATEGORY MARKER/i);
    expect(r.html).not.toContain('ts-label"');
    for (let i = 1; i <= 5; i++) expect(rowOf(r.html, i)).not.toMatch(/text-transform:uppercase/);
  });

  it('an ad with an image: one linked image, its alt text, nothing else; without: label + headline + button', () => {
    const r = render(stories(10, () => null), { ads: [ad(1), ad(2, { image: null }), ad(3)] });
    const img = new RegExp('<td [^>]*data-ad-slot="1"[\\s\\S]*?</td></tr>').exec(r.html)![0];
    expect(img).toMatch(/<a href="[^"]+"[^>]*><img [^>]*alt="Banner 1 alt"/);
    expect(img).not.toMatch(/From Taxscan|Ad headline 1|Ad body|Enrol now|<h3|<p /);
    const text = new RegExp('<td [^>]*data-ad-slot="2"[\\s\\S]*?</td></tr>').exec(r.html)![0];
    expect(text).toContain('From Taxscan');
    expect(text).toContain('Ad headline 2');
    expect(text).toContain('>Enrol now</a>');
    expect(text).not.toContain('<img');
  });
});

/* ------------------------------------------------------------------ */
/* Acceptance 4: the social row                                         */
/* ------------------------------------------------------------------ */

describe('the social icons row: exactly the five fixed links', () => {
  const FIVE = [
    'https://www.facebook.com/taxscan/',
    'https://twitter.com/tax_scan',
    'https://www.instagram.com/taxscan/',
    'https://www.linkedin.com/company/tax-scan-9aa530129/',
    'https://www.taxscan.in/',
  ];

  it('five links, each an icon with alt text, centred, above the footer, no UTM', () => {
    const r = render(stories(5, () => null));
    const row = new RegExp('<td [^>]*data-social="1"[\\s\\S]*?</td></tr>').exec(r.html)![0];
    const hrefs = [...row.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(FIVE);
    expect(row).not.toMatch(/utm_/);
    const imgs = scanStartTags(row).filter((t) => t.name === 'img');
    expect(imgs).toHaveLength(5);
    expect(imgs.map((t) => t.attrs.find((a) => a.name === 'alt')!.value)).toEqual(['Facebook', 'X', 'Instagram', 'LinkedIn', 'Taxscan website']);
    expect(imgs.map((t) => t.attrs.find((a) => a.name === 'src')!.value)).toEqual(
      ['facebook', 'x', 'instagram', 'linkedin', 'website'].map((k) => `${ASSET}/email/social-${k}.png`),
    );
    expect(imgs.every((t) => Number(t.attrs.find((a) => a.name === 'width')!.value) >= 24 && Number(t.attrs.find((a) => a.name === 'width')!.value) <= 32)).toBe(true);
    expect(row).toContain('text-align:center');
    expect(r.html.indexOf('data-social="1"')).toBeLessThan(r.html.indexOf('data-footer="1"'));
    expect(SOCIAL_LINKS.map((l) => l.href)).toEqual(FIVE);
  });

  it('the footer parts: no unsubscribe link of ours, postal address, reply line, no "noreply"', () => {
    const r = render(stories(5, () => null));
    expect(r.html).not.toContain('{{unsubscribe_link}}'); // Mailercloud appends its own footer; ours would arrive dead
    expect(r.html).toContain('Kochi, Kerala 682001');
    expect(r.html).not.toContain('Just reply'); // replaced 29 Oct: replies land at Mailercloud, readers are sent to a real mailbox
    expect(r.html.toLowerCase()).not.toContain('noreply');
  });

  it('without an asset host there is no icon row (no broken pictures); the footer is still there', () => {
    const r = renderDigest({ items: stories(5, () => null), audience: 'FREE', runDate: RUN_DATE, cfg: cfg() });
    expect(r.html).not.toContain('data-social');
    expect(r.html).toContain('data-footer="1"');
  });

  it('the allowlist: exactly these five (string-equal), nothing broader', () => {
    for (const u of FIVE) expect(isSocialUrl(u)).toBe(true);
    for (const u of ['https://www.facebook.com/other/', 'https://www.facebook.com/taxscan', 'https://twitter.com/tax_scan/extra', 'https://x.com/tax_scan', 'https://www.facebook.com/taxscan/?utm=1', 'http://www.facebook.com/taxscan/']) {
      expect([u, isSocialUrl(u)]).toEqual([u, false]);
    }
  });

  it('the template checklist passes the built-in; any OTHER social link in a template is still refused', () => {
    const c = cfg();
    const run = (html: string) => validateTemplate({ audience: 'FREE', compiledHtml: html, compileError: null }, { cfg: c, now: RUN_DATE });
    const built = run(BUILTIN_TEMPLATE_HTML);
    expect(built.checks.find((x) => x.id === 'links')).toMatchObject({ ok: true });
    expect(built.ok).toBe(true);
    // A template may carry the five fixed links…
    const withFixed = BUILTIN_TEMPLATE_HTML.replace('</body>', '<p><a href="https://www.facebook.com/taxscan/">f</a></p></body>');
    expect(run(withFixed).checks.find((x) => x.id === 'links')).toMatchObject({ ok: true });
    // …and nothing else on a social host.
    const other = BUILTIN_TEMPLATE_HTML.replace('</body>', '<p><a href="https://www.facebook.com/someone-else/">f</a></p></body>');
    const l = run(other).checks.find((x) => x.id === 'links')!;
    expect(l.ok).toBe(false);
    expect(l.problems.join(' ')).toContain('facebook.com');
  });
});

/* ------------------------------------------------------------------ */
/* Acceptance 5: size                                                   */
/* ------------------------------------------------------------------ */

describe('size: the worst case (max items, every picture, three image ads, social row)', () => {
  it('stays under DIGEST_HTML_WARN_KB for both audiences; the figures', () => {
    const c = cfg();
    const f = worstCaseFixture(c);
    expect(f.items.every((i) => i.imageUrl)).toBe(true);
    expect(f.items).toHaveLength(c.maxItems);
    const out: string[] = [];
    for (const audience of ['FREE', 'PREMIUM'] as const) {
      const r = renderDigest({ items: f.items, audience, runDate: RUN_DATE, cfg: c, ads: f.ads, assetBaseUrl: ASSET, mode: 'check' });
      out.push(`${audience}: html ${r.htmlBytes} B, budget ${r.budgetBytes} B (limit ${c.htmlWarnKb * 1024} B warn / ${c.maxHtmlKb * 1024} B max)`);
      expect(r.sizeWarning).toBe(false);
      expect(r.budgetBytes).toBeLessThan(c.htmlWarnKb * 1024);
    }
    // A typical day: recent stories (the 12 stories, pictures on, plain ads).
    const recent = renderDigest({ items: stories(c.maxItems, () => PIC), audience: 'FREE', runDate: RUN_DATE, cfg: c, ads: [ad(1), ad(2), ad(3)], assetBaseUrl: ASSET, mode: 'check' });
    out.push(`recent (12 pictured short stories, 3 image ads): html ${recent.htmlBytes} B, budget ${recent.budgetBytes} B`);
    expect(recent.sizeWarning).toBe(false);
    // eslint-disable-next-line no-console
    console.info(out.join('\n'));
  });
});

/* ------------------------------------------------------------------ */
/* Brief 2026-10-29-digest-footer-contact                               */
/* ------------------------------------------------------------------ */

describe('the footer says "Questions or feedback? Write to info@taxscan.in" (a real mailbox: replies to Mailercloud go nowhere)', () => {
  const link = '<a href="mailto:info@taxscan.in" class="ts-link" style="color:#1376c8;text-decoration:underline;padding:9px 0;">info@taxscan.in</a>'; // padding: a >= 44 px tap area without changing the sentence's line height

  it.each([
    ['FREE', FREE_REASON],
    ['PREMIUM', PREMIUM_REASON],
  ] as const)('%s: the HTML has the sentence and a mailto link; the text has the plain sentence; no "Just reply"; the reason line is unchanged', (audience, reason) => {
    const r = render(stories(5, () => null), { audience });
    const footer = new RegExp('<td [^>]*data-footer="1"[\\s\\S]*?</td></tr>').exec(r.html)![0];
    expect(footer).toContain(`${reason.replace(/'/g, '&#39;')} Questions or feedback? Write to ${link}</p>`); // the reason line is the same text as before, HTML-escaped
    expect(footer).not.toContain('unsubscribe'); // none of ours: Mailercloud adds its own footer
    expect(footer).toContain('Kochi, Kerala 682001'); // postal address untouched
    expect(r.html).not.toContain('Just reply');
    expect((r.html.match(/href="mailto:/g) ?? []).length).toBe(1);
    expect(r.html).not.toMatch(/mailto:[^"]*utm_/); // no UTM on it
    expect(r.text).toContain(`${reason} Questions or feedback? Write to info@taxscan.in`);
    expect(r.text).not.toContain('Just reply');
    expect(r.html.toLowerCase()).not.toContain('noreply');
  });

  it('the link checks accept exactly mailto:info@taxscan.in and still refuse any other mailto in a template', () => {
    for (const ok of ['mailto:info@taxscan.in']) expect(isContactMailto(ok)).toBe(true);
    for (const bad of ['mailto:other@taxscan.in', 'mailto:info@taxscan.in?subject=x', 'MAILTO:info@taxscan.in', 'mailto:info@hello.taxscan.in', 'mailto:info@taxscan.in ', 'mailto:', 'info@taxscan.in']) {
      expect([bad, isContactMailto(bad)]).toEqual([bad, false]);
    }
    const c = cfg();
    const links = (html: string) => validateTemplate({ audience: 'FREE', compiledHtml: html, compileError: null }, { cfg: c, now: RUN_DATE }).checks.find((x) => x.id === 'links')!;
    // The built-in (which now carries the mailto in its footer) passes; so does a template with exactly that mailto.
    expect(links(BUILTIN_TEMPLATE_HTML)).toMatchObject({ ok: true });
    expect(links(BUILTIN_TEMPLATE_HTML.replace('</body>', '<p><a href="mailto:info@taxscan.in">Write to us</a></p></body>'))).toMatchObject({ ok: true });
    // Any other mailto is refused by the checklist…
    for (const bad of ['mailto:other@taxscan.in', 'mailto:info@taxscan.in?subject=x', 'mailto:someone@example.com']) {
      const l = links(BUILTIN_TEMPLATE_HTML.replace('</body>', `<p><a href="${bad}">x</a></p></body>`));
      expect([bad, l.ok]).toEqual([bad, false]);
    }
    // …and a send with such a template is refused outright (fail closed); the exact one is left as written, no UTM.
    const withTemplate = (href: string) => renderDigest({ items: stories(5, () => null), audience: 'FREE', runDate: RUN_DATE, cfg: c, assetBaseUrl: ASSET, template: { html: BUILTIN_TEMPLATE_HTML.replace('</body>', `<p><a href="${href}">x</a></p></body>`) } });
    expect(() => withTemplate('mailto:other@taxscan.in')).toThrow(RenderError);
    expect(withTemplate('mailto:info@taxscan.in').html).toContain('<a href="mailto:info@taxscan.in">x</a>');
  });

  it('the worst case stays under the 75 KB warning with the new line (the figures)', () => {
    const c = cfg();
    const f = worstCaseFixture(c);
    const out: string[] = [];
    for (const audience of ['FREE', 'PREMIUM'] as const) {
      const r = renderDigest({ items: f.items, audience, runDate: RUN_DATE, cfg: c, ads: f.ads, assetBaseUrl: ASSET, mode: 'check' });
      out.push(`${audience}: html ${r.htmlBytes} B, budget ${r.budgetBytes} B (warn ${c.htmlWarnKb * 1024} B, max ${c.maxHtmlKb * 1024} B)`);
      expect(r.sizeWarning).toBe(false);
      expect(r.budgetBytes).toBeLessThan(c.htmlWarnKb * 1024);
    }
    // eslint-disable-next-line no-console
    console.info(out.join('\n'));
  });
});
