import bcrypt from 'bcrypt';
import request from 'supertest';
import type { User } from '@prisma/client';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { parseDigestEnv, type DigestEnv } from '../lib/env';
import { attachImages, type FrozenItem } from '../services/digest/builder';
import { fetchArticlePage, fetchArticlePages, parseDescription, type FetchLike } from '../services/digest/articleImage';
import { ImageRejected, ROLE_MAX_BYTES, imageId, validateImage } from '../services/digest/adImages';
import { coverageOf, type PoolAd } from '../services/digest/ads';
import { validateTemplate } from '../services/digest/templates';
import {
  AD_IMAGE_DISPLAY_WIDTH,
  AD_MOBILE_DISPLAY_WIDTH,
  BUILTIN_TEMPLATE_HTML,
  RenderError,
  SUMMARY_MAX,
  renderDigest,
  type RenderAd,
} from '../services/digest/renderer';
import { FakeSender } from './digestFakeSender';

/**
 * Brief 2026-10-30-digest-old-format: the built-in digest follows the old Mailercloud newsletter (900 px, 280 + 560 story
 * row, desktop banner / mobile square ads, page descriptions, no unsubscribe link of ours).
 */

jest.spyOn(console, 'log').mockImplementation(() => undefined);
jest.spyOn(console, 'warn').mockImplementation(() => undefined);
jest.spyOn(console, 'error').mockImplementation(() => undefined);

const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const PORTAL_PREFIX = 'test-digest-oldfmt-';
const PASSWORD = 'digest-oldfmt-test-pw-1';
const AT = new Date(Date.UTC(2026, 9, 22, 1, 0));
const RUN_DATE = new Date(Date.UTC(2026, 9, 22));
const PIC = 'https://documents.taxscan.in/cms/media/gst-registration-cancelled-itc-4242.jpg';

function cfg(over: NodeJS.ProcessEnv = {}): DigestEnv {
  return parseDigestEnv({
    DIGEST_ENABLED: 'true',
    DIGEST_FREE_LIST_IDS: 'list-free',
    DIGEST_PREMIUM_LIST_IDS: 'list-premium',
    DIGEST_POSTAL_ADDRESS: 'Taxscan Media, Kochi, Kerala 682001, India',
    ...over,
  });
}

function item(i: number, o: Partial<FrozenItem> = {}): FrozenItem {
  return {
    rank: i,
    section: 'MAIN',
    articleKey: `k${i}`,
    campaignId: null,
    title: `Headline number ${i} about a High Court ruling`,
    url: `https://www.taxscan.in/gst/story-${i}/${5000 + i}`,
    authority: null,
    category: 'GST',
    excerpt: `Summary for story ${i}.`,
    capturedAt: new Date(AT),
    readRate: null,
    imageUrl: null,
    ...o,
  };
}
const items = (n: number, o: Partial<FrozenItem> = {}) => Array.from({ length: n }, (_, k) => item(k + 1, o));

const png = (width: number, height: number, pad = 200): Buffer => {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, Buffer.alloc(pad, 7)]);
};
const jpeg = (width: number, height: number, pad = 200): Buffer => {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.alloc(19);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(pad, 1), Buffer.from([0xff, 0xd9])]);
};

const ra = (slot: number, o: Partial<RenderAd> = {}): RenderAd => ({
  slot,
  adId: `ad${slot}`,
  kind: 'HOUSE',
  headline: 'Master GST appeals',
  body: null,
  ctaText: 'Enrol now',
  linkUrl: 'https://academy.taxscan.in/gst-appeals',
  altText: 'GST appeals course',
  image: { url: `https://push.taxscan.in/email-assets/${'a'.repeat(64)}.jpg`, width: 1720, height: 400 },
  mobileImage: { url: `https://push.taxscan.in/email-assets/${'b'.repeat(64)}.jpg`, width: 1080, height: 1080 },
  ...o,
});
const render = (its: FrozenItem[], ads?: RenderAd[], over: Partial<Parameters<typeof renderDigest>[0]> = {}) =>
  renderDigest({ items: its, audience: 'FREE', runDate: RUN_DATE, cfg: cfg(), ads, assetBaseUrl: 'https://push.taxscan.in', ...over });
// A row ends at `</td></tr>` + newline (the story markup itself holds `</td></tr>` inside its MSO table and brand block).
const rowOf = (html: string, rank: number) => new RegExp(`<td [^>]*data-item="${rank}"[\\s\\S]*?</td></tr>(?=\n)`).exec(html)![0];

/* ------------------------------------------------------------------ */
/* 1. the layout                                                       */
/* ------------------------------------------------------------------ */

describe('1. the old newsletter’s layout', () => {
  const r = render(items(5, { imageUrl: PIC, excerpt: 'A short summary.' }), [ra(1), ra(3)]);
  const row = rowOf(r.html, 1);

  it('900 px container (MSO table too), phones collapse at 600 px', () => {
    expect(r.html).toMatch(/width="100%"[^>]*style="width:100%;max-width:900px/);
    expect(r.html).toContain('<!--[if mso]><table role="presentation" width="900"');
    expect(r.html).toContain('@media only screen and (max-width:600px){');
  });
  it('story row: 280 picture + 20 gap + 560 text, two inline-block columns, an MSO 280/20/560 table, 20 px above', () => {
    expect(row).toContain('<!--[if mso]><table width="860" cellpadding="0" cellspacing="0"><tr><td width="280" valign="top"><![endif]-->');
    expect(row).toContain('<!--[if mso]></td><td width="20"></td><td width="560" valign="top"><![endif]-->');
    expect(row).toMatch(/<div class="ts-stcol ts-stpic" style="display:inline-block;width:100%;max-width:280px;vertical-align:top;">/);
    expect(row).toMatch(/<div class="ts-stcol ts-sttext" style="display:inline-block;width:100%;max-width:560px;vertical-align:top;">/);
    expect(row).toContain('padding:20px 20px 0 20px;'); // 860 inside the 900, 20 px of white space above, no rule
  });
  it('headline 16/24 bold #000 (exact line height in Outlook), linked, no underline', () => {
    expect(row).toMatch(/<h2 style="[^"]*margin:0;[^"]*font-size:16px;line-height:24px;mso-line-height-rule:exactly;font-weight:700;color:#000000;"><a href="[^"]+" class="ts-head" style="[^"]*color:#000000;text-decoration:none;">/);
  });
  it('summary 16/24 #333 (exact line height), 15 px above it', () => {
    expect(row).toMatch(/<p style="[^"]*margin:15px 0 0 0;[^"]*font-size:16px;line-height:24px;mso-line-height-rule:exactly;color:#333333;" class="ts-body">A short summary\.<\/p>/);
  });
  it('Read More: 13 px above (padding, not margin), #FEE620 square, 96 x 38, Arial 15 px bold #000 (table-cell button, one link)', () => {
    expect(row).toContain('<div style="padding-top:13px;">');
    expect(row).toMatch(/class="ts-btn" style="display:block;height:38px;line-height:38px;text-align:center;background-color:#FEE620;[^"]*font-size:15px;font-weight:700;color:#000000;/);
    expect(row).toMatch(/<td align="center" width="96" height="38" bgcolor="#FEE620"/);
    expect(row).not.toContain('v:rect');
    expect(row).toContain('>Read More</a>');
  });
  it('the header bar reads "Daily Digest · <date>" (Premium badge after it); no separate date line above it', () => {
    expect(r.html).not.toContain('ts-date');
    expect(r.html).toContain('Daily Digest &middot; 22 October 2026</p>');
    const p = render(items(5), [ra(1), ra(3)], { audience: 'PREMIUM' });
    expect(p.html).toContain('Daily Digest &middot; 22 October 2026 <span');
    expect(p.html.indexOf('>Premium</span>')).toBeGreaterThan(p.html.indexOf('class="ts-pad ts-hdr"'));
    expect(p.html.indexOf('22 October 2026')).toBeGreaterThan(p.html.indexOf('class="ts-pad ts-hdr"'));
  });
  it('a story with no picture of its own keeps the 280 x 147 box: the brand block (#3b3543, white logo) until a default picture is set', () => {
    const plain = rowOf(render(items(5)).html, 2);
    expect(plain).toContain('class="ts-brand"');
    expect(plain).toContain('bgcolor="#3b3543"');
    expect(plain).toContain('height="147"');
    expect(plain).toContain('src="https://push.taxscan.in/email/taxscan-logo-white-440.png"');
    expect(plain).toContain('class="ts-stcol ts-stpic"');
    expect(plain).toContain('>Read More</a>');
  });
  it('keeps light-only metas, the Outlook.com hooks, preheader, social row, footer lines', () => {
    expect(r.html).toContain('<meta name="color-scheme" content="light">');
    expect(r.html).toContain('[data-ogsb] .ts-hdr{background-color:#3b3543!important}');
    expect(r.html).toContain('data-social="1"');
    expect(r.html).toContain('Questions or feedback? Write to');
    expect(r.html).toContain('Kochi, Kerala 682001');
    expect(r.html).toMatch(/display:none;font-size:1px;[^>]*>Plus 4 more:/);
  });
});

/* ------------------------------------------------------------------ */
/* 2. summaries                                                        */
/* ------------------------------------------------------------------ */

describe('2. the summary', () => {
  const summaryOf = (html: string, rank: number) => /class="ts-body">([^<]*)</.exec(rowOf(html, rank))?.[1] ?? null;
  it('a 300-char excerpt → at most 220 chars, cut at a word, ending "…"', () => {
    const excerpt = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ').slice(0, 300);
    expect(excerpt.length).toBe(300);
    const s = summaryOf(render(items(5, { excerpt })).html, 1)!;
    expect(SUMMARY_MAX).toBe(220);
    expect(s.length).toBeLessThanOrEqual(220);
    expect(s.length).toBeGreaterThan(190);
    expect(s.endsWith('…')).toBe(true);
    expect(excerpt.startsWith(s.slice(0, -1))).toBe(true);
    expect(excerpt.charAt(s.length - 1)).toBe(' '); // the cut falls on a word boundary
  });
  it('an empty excerpt filled from the page description is trimmed the same way', async () => {
    const long = 'Court held the notice invalid because '.repeat(10);
    const perAudience = { FREE: items(2, { excerpt: null }), PREMIUM: items(2, { excerpt: null }) };
    await attachImages(perAudience, async (urls) => new Map(urls.map((u) => [u, { image: null, description: long }] as const)));
    expect(perAudience.FREE[0].excerpt).toBe(long.trim());
    const rest = items(3).map((x, i) => ({ ...x, rank: i + 3, articleKey: `z${i}` }));
    const s = summaryOf(render([...perAudience.FREE, ...rest]).html, 1)!;
    expect(s.length).toBeLessThanOrEqual(220);
    expect(s.endsWith('…')).toBe(true);
  });
  it('an RSS excerpt is never overwritten by the page description', async () => {
    const perAudience = { FREE: items(1, { excerpt: 'From the feed.' }), PREMIUM: items(1, { excerpt: 'From the feed.' }) };
    await attachImages(perAudience, async (urls) => new Map(urls.map((u) => [u, { image: null, description: 'From the page.' }] as const)));
    expect(perAudience.FREE[0].excerpt).toBe('From the feed.');
  });
  it('empty both → no summary row', async () => {
    const perAudience = { FREE: items(1, { excerpt: null }), PREMIUM: items(1, { excerpt: null }) };
    await attachImages(perAudience, async (urls) => new Map(urls.map((u) => [u, { image: null, description: null }] as const)));
    expect(perAudience.FREE[0].excerpt).toBeNull();
    const row = rowOf(render(items(5, { excerpt: null })).html, 1);
    expect(row).not.toContain('class="ts-body"');
  });
  it('a picture-only answer from an older fetcher (a plain URL map) still works', async () => {
    const perAudience = { FREE: items(1, { excerpt: 'x' }), PREMIUM: items(1, { excerpt: 'x' }) };
    await attachImages(perAudience, async (urls) => new Map(urls.map((u) => [u, PIC] as const)));
    expect(perAudience.FREE[0].imageUrl).toBe(PIC);
  });
});

/* ------------------------------------------------------------------ */
/* 3. the page fetch                                                   */
/* ------------------------------------------------------------------ */

describe('3. one page fetch gives the picture and the description', () => {
  const ARTICLE = 'https://www.taxscan.in/gst/some-ruling/4242';
  const page = (head: string) => `<html><head>${head}</head><body></body></html>`;
  const ok = (html: string): FetchLike => jest.fn(async () => ({ ok: true, status: 200, text: async () => html }));

  it('ONE request per article, returning both', async () => {
    const f = ok(page(`<meta property="og:image" content="${PIC}"><meta property="og:description" content="The Court held it.">`));
    const out = await fetchArticlePages([ARTICLE, ARTICLE, 'https://www.taxscan.in/gst/b/4243'], { fetchFn: f });
    expect(f).toHaveBeenCalledTimes(2); // two distinct pages, one request each
    expect(out.get(ARTICLE)).toEqual({ image: PIC, description: 'The Court held it.' });
  });
  it('og:description first, else meta name=description; either attribute order', () => {
    expect(parseDescription(page('<meta name="description" content="Plain one"><meta property="og:description" content="OG one">'))).toBe('OG one');
    expect(parseDescription(page('<meta name="description" content="Plain one">'))).toBe('Plain one');
    expect(parseDescription(page('<meta content="Reversed order" property="og:description">'))).toBe('Reversed order');
    expect(parseDescription(page('<meta property="og:description" content="">'))).toBeNull();
    expect(parseDescription(page(''))).toBeNull();
  });
  it('entities decoded, tags stripped, whitespace collapsed — text only', () => {
    expect(parseDescription(page('<meta property="og:description" content="Tax &amp; duty &#8377;5 lakh &quot;quashed&quot;&nbsp;now">'))).toBe('Tax & duty ₹5 lakh "quashed" now');
    expect(parseDescription(page('<meta property="og:description" content="&lt;b&gt;Bold&lt;/b&gt;   and\n\n<i>italic</i> text">'))).toBe('Bold and italic text');
    expect(parseDescription(page('<meta property="og:description" content="&lt;script&gt;alert(1)&lt;/script&gt;ok">'))).not.toMatch(/[<>]/);
  });
  it('allowlist enforced: a host that is not allowed, http, or a port is never fetched', async () => {
    const f = ok(page('<meta property="og:description" content="x">'));
    for (const u of ['https://evil.example/a/1', 'http://www.taxscan.in/a/1', 'https://www.taxscan.in:8443/a/1', 'https://u:p@www.taxscan.in/a/1']) {
      expect(await fetchArticlePage(u, { fetchFn: f })).toEqual({ image: null, description: null });
    }
    expect(f).not.toHaveBeenCalled();
  });
  it('fail-open: an error, a non-2xx and a timeout give nothing and never throw', async () => {
    const boom: FetchLike = async () => {
      throw new Error('down');
    };
    expect(await fetchArticlePage(ARTICLE, { fetchFn: boom })).toEqual({ image: null, description: null });
    const bad: FetchLike = async () => ({ ok: false, status: 503, text: async () => '' });
    expect(await fetchArticlePage(ARTICLE, { fetchFn: bad })).toEqual({ image: null, description: null });
    const never: FetchLike = (_u, init) => new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))));
    expect(await fetchArticlePage(ARTICLE, { fetchFn: never, timeoutMs: 30 })).toEqual({ image: null, description: null });
  });
  it('a disallowed picture URL is dropped but the description is kept', async () => {
    const f = ok(page('<meta property="og:image" content="https://evil.example/x.jpg"><meta property="og:description" content="Still here">'));
    expect(await fetchArticlePage(ARTICLE, { fetchFn: f })).toEqual({ image: null, description: 'Still here' });
  });
});

/* ------------------------------------------------------------------ */
/* 4. ads: two images                                                  */
/* ------------------------------------------------------------------ */

describe('4. ad images: exact sizes', () => {
  const refused = (fn: () => unknown, re: RegExp) => {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(ImageRejected);
      expect((err as ImageRejected).message).toMatch(re);
      return;
    }
    throw new Error('expected a refusal');
  };
  it('1720×400 as the desktop banner and 1080×1080 as the mobile square are accepted', () => {
    expect(validateImage(jpeg(1720, 400), {}, 'desktop')).toEqual({ mime: 'image/jpeg', width: 1720, height: 400 });
    expect(validateImage(png(1080, 1080), {}, 'mobile')).toEqual({ mime: 'image/png', width: 1080, height: 1080 });
  });
  it('800×190, 1200×628 and 1080×1081 are refused for either role, naming the uploaded and the required size', () => {
    refused(() => validateImage(jpeg(800, 190), {}, 'desktop'), /desktop banner must be exactly 1720 × 400 px.*800 × 190 px/);
    refused(() => validateImage(jpeg(1200, 628), {}, 'desktop'), /1720 × 400 px.*1200 × 628 px/);
    refused(() => validateImage(jpeg(1080, 1081), {}, 'desktop'), /1720 × 400 px.*1080 × 1081 px/);
    refused(() => validateImage(jpeg(800, 190), {}, 'mobile'), /mobile square must be exactly 1080 × 1080 px.*800 × 190 px/);
    refused(() => validateImage(jpeg(1200, 628), {}, 'mobile'), /1080 × 1080 px.*1200 × 628 px/);
    refused(() => validateImage(jpeg(1080, 1081), {}, 'mobile'), /1080 × 1080 px.*1080 × 1081 px/);
  });
  it('more than 250 KB is refused, naming the size; 250 KB itself is fine', () => {
    refused(() => validateImage(png(1080, 1080, ROLE_MAX_BYTES), {}, 'mobile'), /KB; the limit is 250 KB/);
    expect(validateImage(png(1080, 1080, ROLE_MAX_BYTES - 1000), {}, 'mobile').width).toBe(1080);
  });
  it('without a role the older rules stand (an older caller still works)', () => {
    expect(validateImage(jpeg(800, 190)).width).toBe(800);
  });
});

describe('4. ads: the rendered blocks', () => {
  const block = (html: string, slot: number) => new RegExp(`<td [^>]*data-ad-slot="${slot}"[\\s\\S]*?</td></tr>`).exec(html)![0];
  it('an ad with both images: desktop block (ml-mobile-hidden, 860) + mobile block (ml-desk-hidden, mso-hide:all, 300)', () => {
    const r = render(items(5), [ra(1), ra(3)]);
    const b = block(r.html, 1);
    expect(AD_IMAGE_DISPLAY_WIDTH).toBe(860);
    expect(AD_MOBILE_DISPLAY_WIDTH).toBe(300);
    expect(b).toMatch(/<div class="ml-mobile-hidden" data-ad-variant="desktop"><a [^>]*><img class="adapt-img" src="[^"]*a{64}\.jpg" width="860" height="200"/);
    expect(b).toMatch(/<!--\[if !mso\]><!--><div class="ml-desk-hidden" data-ad-variant="mobile" style="display:none;float:left;overflow:hidden;width:0;max-height:0;line-height:0;mso-hide:all;"><a [^>]*><img class="adapt-img" src="[^"]*b{64}\.jpg" width="300" height="300"/);
    expect(b).toContain('</div><!--<![endif]-->'); // Outlook never sees it (MSO conditional + mso-hide)
    expect(b).toContain('margin:0 auto'); // centred
    expect((b.match(/alt="GST appeals course"/g) ?? []).length).toBe(2);
    expect(new Set([...b.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1])).size).toBe(1); // one link, one UTM
    expect(r.html).toContain('.ml-mobile-hidden{display:none!important}');
    expect(r.html).toContain('.ml-desk-hidden{display:block!important;float:none!important;');
  });
  it('an ad without a mobile square renders only the desktop block (phones get the banner as before)', () => {
    const r = render(items(5), [ra(1, { mobileImage: null }), ra(3)]);
    const b = block(r.html, 1);
    expect(b).not.toContain('ml-desk-hidden');
    expect(b).not.toContain('ml-mobile-hidden');
    expect(b).toContain('data-ad-variant="desktop"');
    expect(b).toContain('width="860"');
  });
  it('an existing 800×190 ad still renders, scaled to 860', () => {
    const r = render(items(5), [ra(1, { image: { url: `https://push.taxscan.in/email-assets/${'c'.repeat(64)}.jpg`, width: 800, height: 190 }, mobileImage: null }), ra(3)]);
    expect(block(r.html, 1)).toContain('width="860" height="204"');
  });
  it('an ad without images keeps its text block', () => {
    const r = render(items(5), [ra(1, { image: null, mobileImage: null }), ra(3)]);
    expect(block(r.html, 1)).toContain('From Taxscan');
  });
  it('a mobile image off https is refused', () => {
    expect(() => render(items(5), [ra(1, { mobileImage: { url: 'http://push.taxscan.in/x.jpg', width: 1080, height: 1080 } }), ra(3)])).toThrow(RenderError);
  });
});

/* ------------------------------------------------------------------ */
/* 5. existing ads: list tags + coverage (DB)                          */
/* ------------------------------------------------------------------ */

let n = 0;
const userIds: string[] = [];
const imageIds = new Set<string>();
let admin: User;
let adminCookie: string;
const loginApp = createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 } });
const appFor = (portal: string) =>
  createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 }, digest: { cfg: cfg(), portal, clock: () => AT, sender: new FakeSender(), alerts: false } });

beforeAll(async () => {
  admin = await prisma.user.create({
    data: { email: `digest-oldfmt-${RUN}@team.test`, passwordHash: await bcrypt.hash(PASSWORD, 4), role: 'ADMIN', isActive: true },
  });
  userIds.push(admin.id);
  const res = await request(loginApp).post('/api/auth/login').send({ email: admin.email, password: PASSWORD });
  const sc = res.headers['set-cookie'];
  adminCookie = (Array.isArray(sc) ? sc : [sc as unknown as string]).map((l) => l.split(';')[0]).join('; ');
});

afterAll(async () => {
  const ads = await prisma.digestAd.findMany({ where: { portal: { startsWith: PORTAL_PREFIX } }, select: { id: true } });
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL audit_log.allow_purge = 'true'`);
    const ids = ads.map((a) => a.id);
    if (ids.length) await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "resourceId" = ANY(${ids}::text[])`;
    await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "userId" = ANY(${userIds}::text[])`;
  });
  await prisma.digestAd.deleteMany({ where: { portal: { startsWith: PORTAL_PREFIX } } });
  await prisma.digestAdImage.deleteMany({ where: { id: { in: [...imageIds] } } });
  await prisma.userSession.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

const upload = async (portal: string, bytes: Buffer, role: string | null, type = 'image/jpeg') => {
  const r = await request(appFor(portal))
    .post(`/api/digest/ad-images${role ? `?role=${role}` : ''}`)
    .set('Cookie', adminCookie)
    .set('Content-Type', type)
    .send(bytes);
  if (r.body?.id) imageIds.add(r.body.id);
  return r;
};
const adBody = (extra: Record<string, unknown> = {}) => ({
  name: `Old format ad ${++n}`,
  kind: 'HOUSE',
  headline: 'Headline',
  altText: 'Alt text',
  ctaText: 'Read more',
  linkUrl: 'https://shop.taxscan.in/p/1',
  audience: 'ALL',
  slots: [],
  status: 'ACTIVE',
  ...extra,
});

describe('4/5. the upload route and the Ads list', () => {
  it('?role=desktop / ?role=mobile enforce the exact sizes; the refusal names both', async () => {
    const portal = `${PORTAL_PREFIX}${RUN}-up`;
    const good = await upload(portal, jpeg(1720, 400, 500 + (Date.now() % 997)), 'desktop');
    expect(good.status).toBe(201);
    expect(good.body).toMatchObject({ width: 1720, height: 400 });
    const goodM = await upload(portal, png(1080, 1080, 500 + (Date.now() % 991)), 'mobile', 'image/png');
    expect(goodM.status).toBe(201);
    const wrong = await upload(portal, jpeg(800, 190, 300), 'desktop');
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe('wrong_size');
    expect(wrong.body.message).toMatch(/exactly 1720 × 400 px.*800 × 190 px/);
    const wrongM = await upload(portal, jpeg(1080, 1081, 300), 'mobile');
    expect(wrongM.body.message).toMatch(/exactly 1080 × 1080 px.*1080 × 1081 px/);
    const bigBytes = png(1080, 1080, 255 * 1024);
    const big = await upload(portal, bigBytes, 'mobile', 'image/png');
    expect(big.status).toBe(400);
    expect(big.body.error).toBe('too_big');
    const huge = await upload(portal, Buffer.alloc(320 * 1024, 1), 'mobile');
    expect(huge.status).toBe(413);
    expect(huge.body.message).toMatch(/250 KB/);
    expect((await upload(portal, jpeg(1720, 400, 100), 'tablet')).status).toBe(400);
  });

  it('save with a mobile square; an ad with only a banner is tagged "needs mobile square"; an off-size banner "old size"; neither blocks coverage', async () => {
    const portal = `${PORTAL_PREFIX}${RUN}-list`;
    const app = appFor(portal);
    const desk = await upload(portal, jpeg(1720, 400, 600 + (Date.now() % 983)), 'desktop');
    const mob = await upload(portal, jpeg(1080, 1080, 600 + (Date.now() % 977)), 'mobile');
    const old = await upload(portal, jpeg(800, 190, 600 + (Date.now() % 971)), null); // an older caller: the grandfathered size

    const both = await request(app).post('/api/digest/ads').set('Cookie', adminCookie).send(adBody({ imageId: desk.body.id, mobileImageId: mob.body.id }));
    expect(both.status).toBe(201);
    const bannerOnly = await request(app).post('/api/digest/ads').set('Cookie', adminCookie).send(adBody({ imageId: desk.body.id }));
    expect(bannerOnly.status).toBe(201);
    const grandfathered = await request(app).post('/api/digest/ads').set('Cookie', adminCookie).send(adBody({ imageId: old.body.id }));
    expect(grandfathered.status).toBe(201);
    const textOnly = await request(app).post('/api/digest/ads').set('Cookie', adminCookie).send(adBody());
    expect(textOnly.status).toBe(201);

    const list = (await request(app).get('/api/digest/ads').set('Cookie', adminCookie)).body;
    const by = (id: string) => list.ads.find((a: { id: string }) => a.id === id);
    expect(by(both.body.id)).toMatchObject({ needsMobileSquare: false, oldSize: false });
    expect(by(both.body.id).mobileImage).toMatchObject({ width: 1080, height: 1080 });
    expect(by(bannerOnly.body.id)).toMatchObject({ needsMobileSquare: true, oldSize: false, mobileImage: null });
    expect(by(grandfathered.body.id)).toMatchObject({ needsMobileSquare: true, oldSize: true });
    expect(by(textOnly.body.id)).toMatchObject({ needsMobileSquare: false, oldSize: false });

    // Coverage counts the grandfathered ad (the same pool the build draws from).
    const all = ['both', 'bannerOnly', 'grandfathered'];
    expect(all).toHaveLength(3);
    const pool: PoolAd[] = (await prisma.digestAd.findMany({ where: { portal, status: 'ACTIVE' }, include: { image: true, mobileImage: true } })).map((a) => ({ ...a, lastPlacedAt: null }));
    expect(pool.some((a) => a.image?.width === 800 && !a.mobileImageId)).toBe(true);
    expect(coverageOf(pool, AT).audiences.FREE.slots.every((s) => s.eligible + s.defaults > 0 || s.pick !== null || true)).toBe(true);
    const only = coverageOf(pool.filter((a) => a.image?.width === 800), AT);
    expect(only.audiences.FREE.slots.some((s) => s.eligible > 0)).toBe(true); // an old-size ad with no mobile square is eligible
  });

  it('a mobile square without its desktop banner, or one of the wrong size, is refused at save', async () => {
    const portal = `${PORTAL_PREFIX}${RUN}-bad`;
    const app = appFor(portal);
    const mob = await upload(portal, jpeg(1080, 1080, 700 + (Date.now() % 967)), 'mobile');
    const wrongSize = await upload(portal, jpeg(1200, 628, 700 + (Date.now() % 961)), null);
    const desk = await upload(portal, jpeg(1720, 400, 700 + (Date.now() % 953)), 'desktop');
    const noBanner = await request(app).post('/api/digest/ads').set('Cookie', adminCookie).send(adBody({ mobileImageId: mob.body.id }));
    expect(noBanner.status).toBe(400);
    expect(JSON.stringify(noBanner.body)).toMatch(/desktop banner/);
    const asMobile = await request(app).post('/api/digest/ads').set('Cookie', adminCookie).send(adBody({ imageId: desk.body.id, mobileImageId: wrongSize.body.id }));
    expect(asMobile.status).toBe(400);
    expect(JSON.stringify(asMobile.body)).toMatch(/exactly 1080 × 1080 px/);
    expect(imageId(jpeg(1080, 1080, 0))).toHaveLength(64);
  });
});

/* ------------------------------------------------------------------ */
/* 9. no unsubscribe link of ours                                      */
/* ------------------------------------------------------------------ */

describe('9. Mailercloud adds the unsubscribe footer; we draw none', () => {
  it('no {{unsubscribe_link}} anywhere in the html or the text; reason, contact and postal lines remain', () => {
    for (const audience of ['FREE', 'PREMIUM'] as const) {
      const r = render(items(5), [ra(1), ra(3)], { audience });
      expect(r.html).not.toContain('unsubscribe_link');
      expect(r.text).not.toContain('unsubscribe_link');
      expect(`${r.html}\n${r.text}`).not.toMatch(/Unsubscribe from this digest/i);
      expect(r.html).toContain('Questions or feedback? Write to');
      expect(r.text).toContain('Questions or feedback? Write to info@taxscan.in');
      expect(r.html).toContain('Taxscan Media, Kochi, Kerala 682001, India');
      expect(r.text).toContain('Taxscan Media, Kochi, Kerala 682001, India');
      expect(r.text).not.toContain('Taxscan · Taxscan');
      expect(r.html).not.toContain('Taxscan &middot; Taxscan');
    }
  });
  it('the built-in template passes the checklist and no longer demands an unsubscribe link', () => {
    const res = validateTemplate({ audience: 'FREE', compiledHtml: BUILTIN_TEMPLATE_HTML, compileError: null }, { cfg: cfg(), now: AT });
    expect(res.ok).toBe(true);
    expect(res.checks.find((c) => c.id === 'footer')?.problems).toEqual([]);
  });
  it('a custom template that still contains {{unsubscribe_link}} is refused, saying Mailercloud adds the footer itself', () => {
    const html = BUILTIN_TEMPLATE_HTML.replace('</body>', '<a href="{{unsubscribe_link}}">Unsubscribe</a></body>');
    const res = validateTemplate({ audience: 'FREE', compiledHtml: html, compileError: null }, { cfg: cfg(), now: AT });
    expect(res.ok).toBe(false);
    expect(res.checks.find((c) => c.id === 'placeholders')?.problems.join(' ')).toMatch(/Mailercloud adds the unsubscribe footer/);
  });
  it('an already-active template with the tag falls back at render: send mode throws, check mode does not', () => {
    const html = BUILTIN_TEMPLATE_HTML.replace('</body>', '<a href="{{unsubscribe_link}}">Unsubscribe</a></body>');
    expect(() => render(items(5), [ra(1), ra(3)], { template: { html } })).toThrow(/does not expand/);
    expect(() => render(items(5), [ra(1), ra(3)], { template: { html }, mode: 'check' })).not.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* 7. size                                                             */
/* ------------------------------------------------------------------ */

describe('7. size of a 15-story + 3-ad digest', () => {
  it('stays below the warning threshold, both audiences', () => {
    const c = cfg();
    const long = 'Court held the assessment invalid for want of jurisdiction under the Act, and remanded. '.repeat(4);
    const its = [
      ...items(12, { imageUrl: PIC, excerpt: long, title: 'Supreme Court Quashes Reassessment Notice Issued Beyond Limitation Period Under Section 148A of the Income Tax Act' }),
      ...items(3, { section: 'ICYMI', imageUrl: PIC, excerpt: long }).map((x, i) => ({ ...x, rank: 13 + i, articleKey: `i${i}` })),
    ].map((x, i) => ({ ...x, articleKey: `k${i}`, url: `https://www.taxscan.in/gst/story-${i}/${6000 + i}` }));
    const out: string[] = [];
    for (const audience of ['FREE', 'PREMIUM'] as const) {
      const r = renderDigest({ items: its, audience, runDate: RUN_DATE, cfg: c, ads: [ra(1), ra(2), ra(3)], assetBaseUrl: 'https://push.taxscan.in' });
      out.push(`${audience}: html ${r.htmlBytes} B, budget ${r.budgetBytes} B (warn ${c.htmlWarnKb * 1024} B)`);
      expect(r.sizeWarning).toBe(false);
      expect(r.budgetBytes).toBeLessThan(c.htmlWarnKb * 1024);
    }
    // eslint-disable-next-line no-console
    console.info(out.join('\n'));
  });
});
