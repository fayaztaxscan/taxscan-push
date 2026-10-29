import type { DigestAudience } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { env, parseDigestEnv, type DigestEnv } from '../lib/env';
import { advanceRun, ensureRun } from '../services/digest/runner';
import { collapseRows, type DigestSelection, type FrozenItem } from '../services/digest/builder';
import {
  AD_SLOTS,
  FREE_REASON,
  PREMIUM_REASON,
  PREHEADER_MAX,
  RenderError,
  SUBJECT_MAX,
  UNSUBSCRIBE_TAG,
  WRAP,
  clean,
  graphemes,
  isNoReplyAddress,
  trimWords,
  renderDigest,
  senderAddressProblems,
  withUtm,
  type RenderInput,
} from '../services/digest/renderer';
import { startDigestScheduler } from '../services/digest/scheduler';
import { renderDigestContent, toRenderAd } from '../services/digest/content';
import { loadAdPool } from '../services/digest/ads';
import { deleteTestAds, ensureTestAds } from './digestAdFixtures';
import { FakeSender } from './digestFakeSender';

/**
 * Email digest task 5 (docs/EMAIL_DIGEST_DESIGN.md §4, §13): renderer v0.
 * One test per requirement, both directions where a guard exists, plus one
 * integration test through the runner (FakeSender, dev DB rows under a unique
 * `test-digest-render-*` portal, removed afterwards).
 */

jest.spyOn(console, 'log').mockImplementation(() => undefined);
jest.spyOn(console, 'warn').mockImplementation(() => undefined);
jest.spyOn(console, 'error').mockImplementation(() => undefined);

const RUN_DATE = new Date(Date.UTC(2026, 9, 22)); // IST date 22 Oct 2026 (DigestRun.runDate shape)

function cfg(over: NodeJS.ProcessEnv = {}): DigestEnv {
  return parseDigestEnv({
    DIGEST_ENABLED: 'true',
    DIGEST_SEND_LIVE: 'true',
    DIGEST_APPROVAL_REQUIRED: 'false',
    DIGEST_FREE_LIST_IDS: 'list-free',
    DIGEST_FREE_EXCLUDE_LIST_IDS: 'list-premium',
    DIGEST_PREMIUM_LIST_IDS: 'list-premium',
    DIGEST_POSTAL_ADDRESS: 'Taxscan Media, 1st Floor, Example Building, Kochi, Kerala 682001, India',
    ...over,
  });
}

let seq = 0;
function item(o: Partial<FrozenItem> = {}): FrozenItem {
  const n = ++seq;
  return {
    rank: n,
    section: 'MAIN',
    articleKey: `article:${1000 + n}`,
    campaignId: `c${n}`,
    title: `Supreme Court holds test ruling number ${n} applies to assessees`,
    url: `https://www.taxscan.in/top-stories/test-ruling-number-${n}/${1000 + n}`,
    authority: 'Supreme Court',
    category: 'Income Tax',
    excerpt: `A short summary of test ruling ${n}.`,
    capturedAt: new Date('2026-10-21T10:00:00Z'),
    readRate: null,
    ...o,
  };
}

function items(nMain: number, nIcymi = 0): FrozenItem[] {
  const out: FrozenItem[] = [];
  for (let i = 0; i < nMain; i++) out.push(item());
  for (let i = 0; i < nIcymi; i++) out.push(item({ section: 'ICYMI', authority: 'Bombay High Court' }));
  return out.map((it, i) => ({ ...it, rank: i + 1 }));
}

function render(over: Partial<RenderInput> = {}) {
  return renderDigest({ items: items(6), audience: 'FREE', runDate: RUN_DATE, cfg: cfg(), ...over });
}

function expectRefused(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(RenderError);
    expect((e as RenderError).code).toBe(code);
    return;
  }
  throw new Error(`expected RenderError ${code}`);
}

const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));

/** The worst case: 12 MAIN + 3 ICYMI, max-length headlines and summaries, long URLs with params. */
function worstCase(): FrozenItem[] {
  const long = (n: number) =>
    `Supreme Court & Bombay High Court: "Section 148A" notice under Income Tax Act quashed — ₹${n},00,00,000 addition on alleged bogus purchases, cash credits and unexplained investment set aside as AO failed to consider reply, CIT(A) order reversed and matter remanded <b>${n}</b>`.slice(0, 300);
  const excerpt = (n: number) =>
    `The Supreme Court of India, in a significant ruling number ${n}, has held that the reassessment notice issued under Section 148A of the Income Tax Act, 1961 was invalid where the Assessing Officer failed to consider the assessee's reply & the evidence of ₹ payments; the Bench comprising Justices "A" and 'B' set aside the order and remanded the matter.`.slice(0, 280);
  const out: FrozenItem[] = [];
  for (let i = 0; i < 15; i++) {
    out.push(
      item({
        section: i < 12 ? 'MAIN' : 'ICYMI',
        title: long(i),
        excerpt: excerpt(i),
        authority: i % 2 ? 'Bombay High Court' : 'Supreme Court',
        url: `https://www.taxscan.in/top-stories/supreme-court-bombay-high-court-section-148a-notice-income-tax-act-quashed-addition-bogus-purchases-cash-credits-unexplained-investment-set-aside-${i}/${400000 + i}?ref=feed&amp=1`,
      }),
    );
  }
  return out.map((it, i) => ({ ...it, rank: i + 1 }));
}

describe('1. subject = lead headline, ≤ 90 chars on a word boundary', () => {
  it('a short lead headline is the subject unchanged', () => {
    const its = items(5);
    expect(render({ items: its }).subject).toBe(its[0].title);
  });
  it('a long lead headline is trimmed on a word boundary with "…"', () => {
    const title = 'Delhi High Court quashes reassessment notice issued under section 148 after the limitation period expired for AY 2015-16';
    const r = render({ items: [item({ title }), ...items(4)] });
    expect([...r.subject].length).toBeLessThanOrEqual(SUBJECT_MAX);
    expect(r.subject.endsWith('…')).toBe(true);
    const stem = r.subject.slice(0, -1);
    expect(title.startsWith(stem)).toBe(true);
    expect(title[stem.length]).toBe(' '); // cut at a space, not mid-word
  });
  it('the lead is the first MAIN item even if ICYMI items come first in the input', () => {
    const its = items(5, 1);
    const reordered = [its[5], ...its.slice(0, 5)];
    expect(render({ items: reordered }).subject).toBe(its[0].title);
  });
});

describe('2. preheader', () => {
  it('"Plus N more: <2nd headline>…" and hidden at the top of the HTML', () => {
    const its = items(6);
    const r = render({ items: its });
    expect(r.preheader).toBe(`Plus 5 more: ${its[1].title}…`);
    const bodyStart = r.html.indexOf('<body');
    const hidden = r.html.indexOf('display:none', bodyStart);
    expect(hidden).toBeGreaterThan(bodyStart);
    expect(r.html.indexOf(r.preheader)).toBeGreaterThan(hidden);
    expect(r.html.indexOf(r.preheader)).toBeLessThan(r.html.indexOf('data-item="1"'));
  });
  it('a long 2nd headline keeps the preheader ≤ 110 chars', () => {
    const its = items(5);
    its[1] = { ...its[1], title: 'x '.repeat(50) + 'Calcutta High Court directs refund of IGST paid on ocean freight with interest under section 56 of CGST Act' };
    const r = render({ items: its });
    expect([...r.preheader].length).toBeLessThanOrEqual(PREHEADER_MAX);
    expect(r.preheader.startsWith('Plus 4 more: ')).toBe(true);
    expect(r.preheader.endsWith('…')).toBe(true);
  });
});

describe('3. visible date from runDate in IST', () => {
  it('"22 October 2026" for the 22 Oct run, in HTML and text', () => {
    const r = render();
    expect(r.html).toContain('22 October 2026');
    expect(r.text).toContain('22 October 2026');
  });
  it('an instant late on 22 Oct UTC is already 23 Oct in IST', () => {
    const r = render({ runDate: new Date('2026-10-22T20:00:00Z') }); // 01:30 IST on 23 Oct
    expect(r.html).toContain('23 October 2026');
    expect(r.html).not.toContain('22 October 2026');
  });
  it('a date inside a headline is never used as the visible date', () => {
    const r = render({ items: [item({ title: 'Circular dated Oct 15 2026 explained' }), ...items(4)] });
    expect(r.html).toContain('Daily Digest &middot; 22 October 2026');
  });
});

describe('4. footer', () => {
  it('an empty postal address is refused', () => {
    expectRefused(() => render({ cfg: cfg({ DIGEST_POSTAL_ADDRESS: '   ' }) }), 'no_postal_address');
  });
  it('carries the address and the unsubscribe tag, never "all types" wording', () => {
    const r = render();
    expect(r.html).toContain('Kochi, Kerala 682001');
    expect(r.html).toContain(`href="${UNSUBSCRIBE_TAG}"`);
    expect(r.text).toContain(UNSUBSCRIBE_TAG);
    expect(r.text).toContain('Kochi, Kerala 682001');
    expect(`${r.html}\n${r.text}`).not.toMatch(/all types? of e-?mails/i);
  });
  it('PREMIUM has the subscription line, FREE the subscribed line — never each other', () => {
    const p = render({ audience: 'PREMIUM' });
    const f = render({ audience: 'FREE' });
    expect(p.html).toContain("You&#39;re receiving this daily digest as part of your Taxscan Premium subscription.");
    expect(p.text).toContain(PREMIUM_REASON);
    expect(p.html).not.toContain('subscribed to Taxscan updates');
    expect(f.text).toContain(FREE_REASON);
    expect(f.html).toContain('You&#39;re receiving this because you subscribed to Taxscan updates.');
    expect(f.html).not.toContain('Premium subscription');
  });
});

describe('5. no-reply sender / reply address refused', () => {
  it.each(['noreply@news.taxscan.in', 'no-reply@x.in', 'No_Reply+digest@x.in', 'do-not-reply@x.in'])('%s is refused', (a) => {
    expect(isNoReplyAddress(a)).toBe(true);
    expect(senderAddressProblems({ senderEmail: '', replyEmail: a })).toHaveLength(1);
    expect(senderAddressProblems({ senderEmail: a, replyEmail: '' })).toHaveLength(1);
  });
  it.each(['digest@news.taxscan.in', 'editor@taxscan.in', 'noreplyx@x.in', 'reply@x.in'])('%s is accepted', (a) => {
    expect(isNoReplyAddress(a)).toBe(false);
    expect(senderAddressProblems({ senderEmail: a, replyEmail: a })).toEqual([]);
  });
  it('the problem text never echoes the address', () => {
    expect(senderAddressProblems({ senderEmail: 'noreply@secret.example', replyEmail: '' }).join(' ')).not.toContain('secret.example');
  });
  it('renderDigestContent refuses a no-reply config; accepts a monitored one', async () => {
    const portal = `test-digest-render-noreply-${Date.now()}`;
    await ensureTestAds(portal);
    const base = { runId: 'r', runDate: RUN_DATE, audience: 'FREE' as DigestAudience, items: items(5), portal };
    await expect(renderDigestContent({ ...base, cfg: cfg({ MAILERCLOUD_REPLY_EMAIL: 'noreply@news.taxscan.in' }) })).rejects.toMatchObject({
      code: 'noreply_address',
    });
    await expect(renderDigestContent({ ...base, cfg: cfg({ MAILERCLOUD_REPLY_EMAIL: 'digest@news.taxscan.in' }) })).resolves.toHaveProperty('html');
    await deleteTestAds(portal);
  });
  it('the scheduler refuses to start at boot with a no-reply sender', () => {
    expect(startDigestScheduler(cfg({ MAILERCLOUD_API_KEY: 'k', MAILERCLOUD_SENDER_EMAIL: 'no-reply@news.taxscan.in' }), { start: '23:00', end: '07:00' })).toBe(
      'config_invalid',
    );
    // Never a real cron in a test (task 13: 'ready' now starts the 1-minute tick).
    const noCron = () => ({ stop: () => undefined });
    expect(
      startDigestScheduler(cfg({ MAILERCLOUD_API_KEY: 'k', MAILERCLOUD_SENDER_EMAIL: 'digest@news.taxscan.in' }), { start: '23:00', end: '07:00' }, { startCron: noCron }),
    ).toBe('ready');
  });
});

describe('6. alt text on every image', () => {
  it('v0 default (text wordmark): no <img> without a non-empty alt', () => {
    const r = renderDigest({ items: worstCase(), audience: 'PREMIUM', runDate: RUN_DATE, cfg: cfg() });
    for (const tag of r.html.match(/<img\b[^>]*>/gi) ?? []) expect(tag).toMatch(/\balt="[^"]+"/);
  });
  it('with a logo image: it carries alt="Taxscan"', () => {
    const r = render({ logoUrl: 'https://www.taxscan.in/logo.png' });
    const imgs = r.html.match(/<img\b[^>]*>/gi) ?? [];
    expect(imgs).toHaveLength(1);
    expect(imgs[0]).toContain('alt="Taxscan"');
    for (const tag of imgs) expect(tag).toMatch(/\balt="[^"]+"/);
  });
  it('an off-allowlist logo is refused', () => {
    expectRefused(() => render({ logoUrl: 'https://cdn.example.com/logo.png' }), 'link_not_allowed');
  });
});

describe('7. links: allowlist + digest UTM', () => {
  it('every href is allowlisted and carries the digest UTM (except the exact unsubscribe tag)', () => {
    for (const audience of ['FREE', 'PREMIUM'] as const) {
      const r = renderDigest({ items: worstCase(), audience, runDate: RUN_DATE, cfg: cfg() });
      const links = hrefs(r.html).filter((h) => h !== UNSUBSCRIBE_TAG);
      expect(links.length).toBeGreaterThan(15);
      for (const h of links) {
        const u = new URL(h);
        expect(['www.taxscan.in', 'taxscan.in', 'academy.taxscan.in', 'shop.taxscan.in']).toContain(u.hostname);
        expect(u.searchParams.getAll('utm_source')).toEqual(['taxscan-digest']);
        expect(u.searchParams.getAll('utm_medium')).toEqual(['email']);
        expect(u.searchParams.getAll('utm_campaign')).toEqual([`digest-2026-10-22-${audience.toLowerCase()}`]);
      }
      expect(hrefs(r.html).filter((h) => h === UNSUBSCRIBE_TAG)).toHaveLength(1);
    }
  });
  it('an off-allowlist item link is refused, and the error names only the host', () => {
    const bad = item({ url: 'https://evil.example.com/path/with-secret?token=abc' });
    try {
      render({ items: [...items(5), bad] });
      throw new Error('not refused');
    } catch (e) {
      expect((e as RenderError).code).toBe('link_not_allowed');
      expect((e as Error).message).toContain('evil.example.com');
      expect((e as Error).message).not.toContain('token=abc');
    }
  });
  it('a javascript: link is refused', () => {
    expectRefused(() => render({ items: [...items(5), item({ url: 'javascript:alert(1)' })] }), 'link_not_allowed');
  });
  it('withUtm keeps existing params and the fragment and never duplicates utm_*', () => {
    const u = new URL(withUtm('https://www.taxscan.in/a/1?ref=x&utm_source=rss&utm_campaign=old#top', { campaign: 'digest-2026-10-22-free', content: 'item1' }));
    expect(u.searchParams.get('ref')).toBe('x');
    expect(u.hash).toBe('#top');
    expect(u.searchParams.getAll('utm_source')).toEqual(['taxscan-digest']);
    expect(u.searchParams.getAll('utm_campaign')).toEqual(['digest-2026-10-22-free']);
    expect(u.searchParams.getAll('utm_content')).toEqual(['item1']);
    const twice = withUtm(u.toString(), { campaign: 'digest-2026-10-22-free', content: 'item1' });
    expect(twice).toBe(u.toString());
  });
});

describe('8. size budget', () => {
  it('the worst case (12 MAIN + 3 ICYMI, max-length text) stays under the 90 KB limit, both variants', () => {
    for (const audience of ['FREE', 'PREMIUM'] as const) {
      const r = renderDigest({ items: worstCase(), audience, runDate: RUN_DATE, cfg: cfg() });
      expect(r.htmlBytes).toBe(Buffer.byteLength(r.html, 'utf8'));
      expect(r.budgetBytes).toBeLessThan(90 * 1024);
      expect(r.sizeWarning).toBe(false);
    }
  });
  it('above the limit is refused', () => {
    expectRefused(() => renderDigest({ items: worstCase(), audience: 'FREE', runDate: RUN_DATE, cfg: cfg({ DIGEST_MAX_HTML_KB: '20' }) }), 'over_size_limit');
  });
  it('at/above the warn threshold it renders with sizeWarning', () => {
    const r = renderDigest({ items: worstCase(), audience: 'FREE', runDate: RUN_DATE, cfg: cfg({ DIGEST_HTML_WARN_KB: '10' }) });
    expect(r.sizeWarning).toBe(true);
  });
});

describe('9. responsive, email-safe HTML', () => {
  const r = renderDigest({ items: worstCase(), audience: 'FREE', runDate: RUN_DATE, cfg: cfg() });
  it('fluid 600 px single column, MSO fixed wrapper, colour-scheme metas, viewport', () => {
    expect(r.html).toContain('max-width:600px');
    expect(r.html).toMatch(/width="100%"[^>]*style="width:100%;max-width:600px/);
    expect(r.html).toContain('<!--[if mso]><table role="presentation" width="600"');
    expect(r.html).toContain('<meta name="color-scheme" content="light dark">');
    expect(r.html).toContain('<meta name="supported-color-schemes" content="light dark">');
    expect(r.html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
  });
  it('works without media queries: stripping <style> leaves every layout style inline', () => {
    const stripped = r.html.replace(/<style>[\s\S]*?<\/style>/, '');
    expect(stripped).toContain('max-width:600px');
    expect((stripped.match(/data-item="/g) ?? []).length).toBe(15);
    for (const td of stripped.match(/<td class="ts-card[^>]*>/g) ?? []) expect(td).toMatch(/style="[^"]*padding/);
  });
  it('no JS, no external CSS, no web fonts; text never pure black', () => {
    expect(r.html).not.toMatch(/<script|<link\b|@import|@font-face|fonts\.googleapis/i);
    expect(r.html).not.toMatch(/color:#000(000)?\b/i);
    expect(r.html).toContain("font-family:Arial,'Helvetica Neue',Helvetica,sans-serif"); // the look readers know (owner, 2026-10-23)
  });
  it('body text ≥ 16 px, no font under 14 px; every link has a ≥ 44 px tap target', () => {
    const sizes = [...r.html.matchAll(/font-size:(\d+)px/g)].map((m) => Number(m[1])).filter((n) => n !== 1); // 1px = hidden preheader
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(14);
    for (const p of r.html.match(/<p [^>]*class="ts-body"/g) ?? []) expect(p).toContain('font-size:16px');
    for (const a of r.html.match(/<a\s[^>]*>/g) ?? []) {
      const style = /style="([^"]*)"/.exec(a)?.[1] ?? '';
      const ok = /min-height:44px/.test(style) || /padding:9px 0/.test(style); // 26px line + 18px padding
      expect(ok).toBe(true);
    }
  });
});

describe('10. escaping', () => {
  it('<script>, &, quotes are escaped; ₹ survives as UTF-8', () => {
    const nasty = item({
      title: `<script>alert("x")</script> Tax & "duty" on ₹5 lakh — O'Brien`,
      excerpt: `<img src=x onerror=alert(1)> & 'quoted' ₹`,
      authority: `<b>High Court</b>`,
    });
    const r = render({ items: [nasty, ...items(4)] });
    expect(r.html).not.toContain('<script>');
    expect(r.html).not.toContain('<img src=x');
    expect(r.html).not.toContain('<b>High Court</b>');
    expect(r.html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; Tax &amp; &quot;duty&quot; on ₹5 lakh — O&#39;Brien');
    expect(r.html).toContain('&lt;b&gt;High Court&lt;/b&gt;');
    expect(r.html).toContain('&amp; &#39;quoted&#39; ₹');
    expect(r.subject).toBe(`<script>alert("x")</script> Tax & "duty" on ₹5 lakh — O'Brien`); // plain header text
    expect(r.html).toContain('<title>&lt;script&gt;');
  });
});

describe('11. ICYMI section', () => {
  it('labelled heading after all MAIN items, only when ICYMI items exist', () => {
    const r = render({ items: items(5, 2) });
    const heading = r.html.indexOf('In case you missed it');
    expect(heading).toBeGreaterThan(r.html.lastIndexOf('data-section="MAIN"'));
    expect(heading).toBeLessThan(r.html.indexOf('data-section="ICYMI"'));
    expect((r.html.match(/data-section="ICYMI"/g) ?? []).length).toBe(2);
    expect(r.text).toContain('IN CASE YOU MISSED IT');
    const none = render({ items: items(5) });
    expect(none.html).not.toContain('In case you missed it');
    expect(none.text).not.toContain('IN CASE YOU MISSED IT');
  });
});

describe('12. plain-text part', () => {
  it('same items, readable, with UTM URLs and no HTML', () => {
    const its = items(5, 1);
    const r = render({ items: its });
    for (const it of its) expect(r.text).toContain(it.title);
    const urls = r.text.match(/https:\/\/\S+/g) ?? [];
    expect(urls.length).toBe(its.length + 1); // + the home link
    for (const u of urls) expect(new URL(u).searchParams.get('utm_source')).toBe('taxscan-digest');
    expect(r.text).not.toMatch(/<[a-z]/i);
    expect(r.text).toContain('22 October 2026');
  });
});

describe('13. campaign name', () => {
  it('"Taxscan Digest · 22 Oct 2026 · Free" / "· Premium"', () => {
    expect(render({ audience: 'FREE' }).campaignName).toBe('Taxscan Digest · 22 Oct 2026 · Free');
    expect(render({ audience: 'PREMIUM' }).campaignName).toBe('Taxscan Digest · 22 Oct 2026 · Premium');
  });
});

describe('14. ad slots (no ads in v0)', () => {
  it('v0 renders no ad markup', () => {
    const r = renderDigest({ items: worstCase(), audience: 'FREE', runDate: RUN_DATE, cfg: cfg() });
    expect(r.html).not.toMatch(/data-ad|ad-slot/i);
  });
  it('the hooks sit after MAIN item 4, after item 9 and before the footer', () => {
    const r = renderDigest({
      items: worstCase(),
      audience: 'FREE',
      runDate: RUN_DATE,
      cfg: cfg(),
      adSlot: (s) => `<tr><td data-ad-slot="${s.slot}">ad</td></tr>`,
    });
    const at = (needle: string) => r.html.indexOf(needle);
    expect(AD_SLOTS.map((s) => s.slot)).toEqual([1, 2, 3]);
    expect(at('data-ad-slot="1"')).toBeGreaterThan(at('data-item="4"'));
    expect(at('data-ad-slot="1"')).toBeLessThan(at('data-item="5"'));
    expect(at('data-ad-slot="2"')).toBeGreaterThan(at('data-item="9"'));
    expect(at('data-ad-slot="2"')).toBeLessThan(at('data-item="10"'));
    expect(at('data-ad-slot="3"')).toBeGreaterThan(at('data-item="15"'));
    expect(at('data-ad-slot="3"')).toBeLessThan(at('data-footer="1"'));
  });
});

describe('15. item content', () => {
  it('headline link, authority label, 1–2 line summary; nothing else', () => {
    const long = 'word '.repeat(100);
    const r = render({ items: [item({ excerpt: long, authority: null, category: 'GST' }), ...items(4)] });
    const first = /<td [^>]*data-item="1"[\s\S]*?<\/td><\/tr>/.exec(r.html)![0];
    expect(first).toContain('>GST<'); // category stands in when there is no authority
    const summary = /class="ts-body">([^<]*)</.exec(first)![1];
    expect(summary.length).toBeLessThanOrEqual(180);
    expect(summary.endsWith('…')).toBe(true);
    expect((first.match(/<a /g) ?? []).length).toBe(2); // headline + "Read more", same href
    expect(first).not.toMatch(/<img|capturedAt|readRate|article:/);
    const second = /<td [^>]*data-item="2"[\s\S]*?<\/td><\/tr>/.exec(r.html)![0];
    expect(second).toContain('>Supreme Court<');
  });
});

describe('structure + determinism', () => {
  it('same input twice → byte-identical output', () => {
    const its = worstCase();
    const a = renderDigest({ items: its, audience: 'PREMIUM', runDate: RUN_DATE, cfg: cfg() });
    const b = renderDigest({ items: structuredClone(its), audience: 'PREMIUM', runDate: new Date(RUN_DATE), cfg: cfg() });
    expect(b).toEqual(a);
    expect(b.html === a.html && b.text === a.text).toBe(true);
  });
  it('item count, ICYMI heading only with items, Premium line only in PREMIUM', () => {
    const p = render({ audience: 'PREMIUM', items: items(7, 3) });
    expect((p.html.match(/data-item="/g) ?? []).length).toBe(10);
    expect((p.html.match(/data-heading="icymi"/g) ?? []).length).toBe(1);
    expect((p.html.match(/Premium subscription/g) ?? []).length).toBe(1);
    const f = render({ audience: 'FREE', items: items(7) });
    expect((f.html.match(/data-item="/g) ?? []).length).toBe(7);
    expect(f.html).not.toContain('data-heading="icymi"');
    expect(f.html).not.toContain('Premium');
  });
  it('no MAIN item → refused; renderDigestContent without items → refused', async () => {
    expectRefused(() => render({ items: items(0, 2) }), 'no_main_items');
    await expect(renderDigestContent({ runId: 'r', runDate: RUN_DATE, audience: 'FREE', cfg: cfg() })).rejects.toMatchObject({ code: 'no_main_items' });
  });
});

describe('QA follow-ups', () => {
  it('1. a 136-char unbroken word wraps: every text cell/element carries both wrap properties; table stays max 600 px', () => {
    const word = 'x'.repeat(136);
    const r = render({ items: [item({ title: `Ruling ${word}`, excerpt: `Summary ${word}` }), ...items(4, 1)], cfg: cfg({ DIGEST_POSTAL_ADDRESS: `Kochi ${word}` }) });
    expect(WRAP).toContain('word-break:break-word');
    expect(WRAP).toContain('overflow-wrap:anywhere');
    const textTags = [
      ...(r.html.match(/<td [^>]*(data-item|data-heading|data-footer)=[^>]*>/g) ?? []),
      ...(r.html.match(/<(p|h2) [^>]*>/g) ?? []).filter((t) => !t.startsWith('<p style="margin:0 0 12px 0;">')),
      ...(r.html.match(/<a [^>]*class="ts-head"[^>]*>/g) ?? []),
    ];
    expect(textTags.length).toBeGreaterThan(20);
    for (const t of textTags) expect(t).toContain(WRAP);
    expect(r.html).toContain('max-width:600px');
  });

  it('2. a blank lead headline is skipped (next MAIN leads); no MAIN with a headline → refused', () => {
    const its = items(5);
    const r = render({ items: [item({ title: ' ​ \r\n ' }), ...its] });
    expect(r.subject).toBe(its[0].title);
    expect((r.html.match(/data-item="/g) ?? []).length).toBe(5);
    expectRefused(() => render({ items: [item({ title: '' }), item({ title: '   ' }), ...items(0, 2)] }), 'no_main_items');
  });

  it('3a. trim is grapheme-safe: an emoji ZWJ sequence is never split', () => {
    const fam = '👨‍👩‍👧‍👦';
    expect(graphemes(fam)).toHaveLength(1);
    const t = trimWords(`${'a'.repeat(20)}${fam.repeat(30)}`, 30);
    expect(graphemes(t)).toHaveLength(30);
    expect(t.endsWith('…')).toBe(true);
    for (const g of graphemes(t.slice(0, -1))) expect(g === 'a' || g === fam).toBe(true);
    expect(clean(`A ${fam} B`)).toBe(`A ${fam} B`); // the ZWJ inside the sequence survives
  });

  it('3b. trim prefers the last word boundary after ~60% of the limit, else cuts at a grapheme', () => {
    const words = trimWords('alpha beta gamma delta epsilon zeta eta theta', 30);
    expect(words).toBe('alpha beta gamma delta…');
    const early = trimWords(`short ${'y'.repeat(60)}`, 30); // the only space is at 5/30 < 60%
    expect(graphemes(early)).toHaveLength(30);
    expect(early.startsWith('short yyyy')).toBe(true);
  });

  it('3c. zero-width and bidi controls are stripped from subject, preheader, headlines and footer', () => {
    const zw = '​‌‍⁠﻿‪‫‬‭‮⁦⁧⁨⁩';
    const its = items(5);
    its[0] = { ...its[0], title: `Lead${zw} ruling` };
    its[1] = { ...its[1], title: `Second${zw} ruling` };
    const r = render({ items: its, cfg: cfg({ DIGEST_POSTAL_ADDRESS: `Kochi${zw} 682001` }) });
    const bad = /[\u200b-\u200d\u2060\ufeff\u202a-\u202e\u2066-\u2069]/; // zero-width and bidi controls (as escapes: the literal characters are invisible)
    expect(r.subject).toBe('Lead ruling');
    expect(r.preheader).toContain('Second ruling');
    expect(r.subject + r.preheader + r.text).not.toMatch(bad);
    expect(r.html.replace(/&zwnj;/g, '')).not.toMatch(bad);
    expect(r.html).toContain('Taxscan &middot; Kochi 682001');
  });

  it('4. a link with an explicit non-default port is refused; default ports pass', () => {
    expectRefused(() => render({ items: [...items(5), item({ url: 'https://www.taxscan.in:8443/a/1' })] }), 'link_not_allowed');
    expectRefused(() => render({ items: [...items(5), item({ url: 'http://www.taxscan.in:8080/a/1' })] }), 'link_not_allowed');
    expect(() => render({ items: [...items(5), item({ url: 'https://www.taxscan.in:443/a/1' })] })).not.toThrow();
  });

  it('5. CR/LF in a headline or the postal address never reaches subject, preheader or footer', () => {
    const its = items(5);
    its[0] = { ...its[0], title: 'Lead\r\nBcc: victim@example.com\rruling' };
    its[1] = { ...its[1], title: 'Second\r\nX-Injected: 1' };
    const r = render({ items: its, cfg: cfg({ DIGEST_POSTAL_ADDRESS: 'Line one\r\nLine two\nKochi' }) });
    expect(r.subject).not.toMatch(/[\r\n]/);
    expect(r.preheader).not.toMatch(/[\r\n]/);
    expect(r.subject).toBe('Lead Bcc: victim@example.com ruling');
    const footer = /<td [^>]*data-footer="1"[\s\S]*?<\/td>/.exec(r.html)![0];
    expect(footer).not.toMatch(/[\r\n]/);
    expect(footer).toContain('Line one Line two Kochi');
    expect(r.text).toContain('Taxscan · Line one Line two Kochi\n');
  });

  it('6. under the limit by raw bytes but over it with the per-link allowance → refused', () => {
    const probe = renderDigest({ items: worstCase(), audience: 'FREE', runDate: RUN_DATE, cfg: cfg({ DIGEST_MAX_HTML_KB: '1000' }) });
    const kb = Math.ceil(probe.htmlBytes / 1024);
    expect(probe.htmlBytes).toBeLessThan(kb * 1024);
    expect(probe.budgetBytes).toBeGreaterThan(kb * 1024);
    expectRefused(() => renderDigest({ items: worstCase(), audience: 'FREE', runDate: RUN_DATE, cfg: cfg({ DIGEST_MAX_HTML_KB: String(kb) }) }), 'over_size_limit');
    const roomy = Math.ceil(probe.budgetBytes / 1024);
    expect(() => renderDigest({ items: worstCase(), audience: 'FREE', runDate: RUN_DATE, cfg: cfg({ DIGEST_MAX_HTML_KB: String(roomy) }) })).not.toThrow();
  });

  it('7. allow-all mode (ALLOWED_PUSH_HOSTS=""): javascript:, data:, ftp: are still refused', () => {
    const saved = [...env.allowedPushHosts];
    env.allowedPushHosts.splice(0);
    try {
      expect(() => render({ items: [...items(5), item({ url: 'https://anything.example.org/a' })] })).not.toThrow(); // allow-all really is on
      for (const url of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'ftp://www.taxscan.in/a']) {
        expectRefused(() => render({ items: [...items(5), item({ url })] }), 'link_not_allowed');
      }
    } finally {
      env.allowedPushHosts.push(...saved);
    }
    expect(env.allowedPushHosts.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* Through the runner                                                  */
/* ------------------------------------------------------------------ */

describe('runner integration', () => {
  const PORTAL_PREFIX = 'test-digest-render-';
  const IST = (h: number, min = 0) => new Date(Date.UTC(2026, 9, 22, h, min) - (5 * 60 + 30) * 60_000);

  afterAll(async () => {
    await prisma.digestRun.deleteMany({ where: { portal: { startsWith: PORTAL_PREFIX } } });
    await deleteTestAds(PORTAL_PREFIX);
    await prisma.$disconnect();
  });

  function selection(raw: Record<DigestAudience, FrozenItem[]>): DigestSelection {
    // No Campaign rows exist for these fixtures: drop the provenance FK.
    const per = { FREE: raw.FREE.map((i) => ({ ...i, campaignId: null })), PREMIUM: raw.PREMIUM.map((i) => ({ ...i, campaignId: null })) };
    return {
      windowStart: IST(6, 30),
      windowEnd: IST(6, 30),
      candidateCount: per.FREE.length,
      outcome: 'ok',
      perAudience: per,
      mainCounts: { FREE: per.FREE.filter((i) => i.section === 'MAIN').length, PREMIUM: per.PREMIUM.filter((i) => i.section === 'MAIN').length },
      rows: collapseRows(per),
      reads: { used: false, source: 'test', note: null },
      droppedDead: 0,
    };
  }

  it('the stored DigestSend html/subject/preheader/text are the renderer output, unchanged on a later retry', async () => {
    const c = cfg();
    const its = items(6, 1);
    const per = { FREE: its, PREMIUM: its };
    const run = await ensureRun({ portal: `${PORTAL_PREFIX}${Date.now()}`, now: IST(6, 0), cfg: c });
    await ensureTestAds(run.portal);
    const sender = new FakeSender();
    let selects = 0;
    const step = (now: Date) =>
      advanceRun(run.id, 'cron', {
        sender,
        now,
        cfg: c,
        quiet: { start: '23:00', end: '07:00' },
        selectItems: async () => {
          selects++;
          return selection(per);
        },
      });

    await step(IST(6, 30));
    const sends = await prisma.digestSend.findMany({ where: { runId: run.id } });
    expect(sends).toHaveLength(2);
    const pool = await loadAdPool(run.portal);
    for (const s of sends) {
      // The ads drawn are the recorded placements (6 items → slots 1 and 3).
      const placed = await prisma.digestAdPlacement.findMany({ where: { sendId: s.id }, orderBy: { slot: 'asc' } });
      expect(placed.map((p) => p.slot)).toEqual([1, 3]);
      const ads = placed.map((p) => toRenderAd({ slot: p.slot, ad: pool.find((a) => a.id === p.adId)!, utmContent: p.utmContent, viaDefault: false }, c.assetBaseUrl));
      const expected = renderDigest({ items: its, audience: s.audience, runDate: run.runDate, cfg: c, ads, assetBaseUrl: c.assetBaseUrl });
      expect(s).toMatchObject({
        subject: expected.subject,
        preheader: expected.preheader,
        html: expected.html,
        text: expected.text,
        htmlBytes: expected.htmlBytes,
      });
      expect(s.mcCampaignName).toBe(`TS-DIGEST-${run.portal}-2026-10-22-${s.audience}`); // unique provider name: portal + date + audience
    }
    const draftHtml = sender.calls.filter((x) => x.method === 'createDraft').map((x) => (x.args[0] as { html: string; preheader: string }));
    expect(draftHtml.map((d) => d.html).sort()).toEqual(sends.map((s) => s.html).sort());

    // A failed schedule, then a later retry: the frozen copy is what stays and what is sent.
    sender.fail('schedule', 'RETRYABLE', 2, { notSent: true });
    await step(IST(7, 30));
    await advanceRun(run.id, 'retry', { sender, now: IST(9, 0), cfg: c, quiet: { start: '23:00', end: '07:00' } });
    const after = await prisma.digestSend.findMany({ where: { runId: run.id } });
    for (const s of after) {
      const before = sends.find((x) => x.audience === s.audience)!;
      expect(s.html).toBe(before.html);
      expect(s.subject).toBe(before.subject);
      expect(s.preheader).toBe(before.preheader);
      expect(s.text).toBe(before.text);
    }
    expect(selects).toBe(1);
    expect(sender.count('createDraft')).toBe(2);
    expect(sender.count('schedule')).toBeGreaterThanOrEqual(3);
  });

  it('a render refusal (off-allowlist link) fails the build loud: BUILD_FAILED, alert, no variant created', async () => {
    const c = cfg();
    const its = [...items(5), item({ url: 'https://evil.example.com/x' })];
    const run = await ensureRun({ portal: `${PORTAL_PREFIX}${Date.now()}-bad`, now: IST(6, 0), cfg: c });
    await ensureTestAds(run.portal);
    const sender = new FakeSender();
    await advanceRun(run.id, 'cron', {
      sender,
      now: IST(6, 30),
      cfg: c,
      quiet: { start: '23:00', end: '07:00' },
      selectItems: async () => selection({ FREE: its, PREMIUM: its }),
    });
    const r = await prisma.digestRun.findUniqueOrThrow({ where: { id: run.id }, include: { sends: true, items: true } });
    expect(r.build).toBe('BUILD_FAILED');
    expect(r.sends).toHaveLength(0);
    expect(r.items).toHaveLength(0);
    expect((r.alerts as Record<string, unknown>).build_failed).toBeDefined();
    expect(sender.count('createDraft')).toBe(0);
  });

  it('a no-reply reply address is config_invalid before any build', async () => {
    const c = cfg({ MAILERCLOUD_REPLY_EMAIL: 'noreply@news.taxscan.in' });
    const run = await ensureRun({ portal: `${PORTAL_PREFIX}${Date.now()}-noreply`, now: IST(6, 0), cfg: c });
    const sender = new FakeSender();
    await advanceRun(run.id, 'cron', { sender, now: IST(6, 30), cfg: c, quiet: { start: '23:00', end: '07:00' }, selectItems: async () => selection({ FREE: items(5), PREMIUM: items(5) }) });
    const r = await prisma.digestRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(r).toMatchObject({ build: 'SKIPPED', skipReason: 'config_invalid' });
    expect(JSON.stringify(r.alerts)).not.toContain('noreply@');
    expect(sender.calls).toHaveLength(0);
  });
});
