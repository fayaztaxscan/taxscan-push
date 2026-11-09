import { inspect } from 'node:util';
import { parseTelegramEnv, TELEGRAM_CHANNEL_SHAPE, TELEGRAM_TOKEN_SHAPE } from '../lib/env';
import { callTelegram, checkTelegram, classify, messageBody, methodUrl, photoBody, redactBotToken, RETRY_AFTER_CAP_SEC } from '../services/telegram/client';
import { buildTelegramPost, captionOf, CAPTION_MAX, cutAtWord, escapeHtml, READ_MORE, TEXT_MAX, textOf } from '../services/telegram/post';
import { messageUrlOf, withTelegramUtm } from '../services/telegram/pages';
import type { CmsArticle } from '../services/linkedin/post';

/**
 * Brief 2026-11-09-telegram-channel, the pure parts: acceptance 1 (the four variables), 7 (the token never leaks from the client), 8
 * (escaping and the caption cut) and the error classes of 5/6. Nothing here reaches api.telegram.org: `fetch` is always a fake, and the
 * global one is replaced by a trap that fails the test if anything calls it.
 */
const realFetch = global.fetch;
const trap = jest.fn(() => {
  throw new Error('a test reached the network');
});
beforeAll(() => {
  global.fetch = trap as unknown as typeof fetch;
});
afterAll(() => {
  global.fetch = realFetch;
  expect(trap).not.toHaveBeenCalled();
});

const TOKEN = '123456789:AAHsecretSECRETsecret-0123456789_abcdefg';
const GOOD = { TELEGRAM_POSTING_ENABLED: 'true', TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHANNEL: '@taxscan_in', TELEGRAM_POST_FROM: '2026-11-10T04:00:00Z' } as NodeJS.ProcessEnv;
const without = (k: string): NodeJS.ProcessEnv => {
  const e = { ...GOOD };
  delete e[k];
  return e;
};

describe('1. the four variables: active only when all are valid, otherwise off with a reason naming them', () => {
  it('all valid → active, with the parsed go-live', () => {
    const r = parseTelegramEnv(GOOD);
    expect(r).toMatchObject({ enabled: true, off: null, config: { token: TOKEN, channel: '@taxscan_in' } });
    expect(r.config!.postFrom.toISOString()).toBe('2026-11-10T04:00:00.000Z');
    expect(parseTelegramEnv({ ...GOOD, TELEGRAM_CHANNEL: '-1001476232747' }).config!.channel).toBe('-1001476232747');
  });

  it('the flag unset or not exactly "true" → off, whatever else is set', () => {
    for (const v of [undefined, '', 'false', 'TRUE', '1', 'yes']) {
      const r = parseTelegramEnv({ ...GOOD, TELEGRAM_POSTING_ENABLED: v as string });
      expect(r).toMatchObject({ enabled: false, config: null });
      expect(r.off).toContain('TELEGRAM_POSTING_ENABLED');
    }
  });

  it.each(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHANNEL', 'TELEGRAM_POST_FROM'])('%s missing → off, and the reason names it', (name) => {
    const r = parseTelegramEnv(without(name));
    expect(r).toMatchObject({ enabled: true, config: null });
    expect(r.off).toContain(name);
    expect(r.off).toContain('not set');
  });

  it('partly set / invalid values → off; every problem is named, no value is ever printed', () => {
    const r = parseTelegramEnv({ TELEGRAM_POSTING_ENABLED: 'true', TELEGRAM_BOT_TOKEN: 'not-a-token-xyz', TELEGRAM_CHANNEL: 'taxscan_in', TELEGRAM_POST_FROM: '10/11/2026' });
    expect(r.config).toBeNull();
    for (const name of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHANNEL', 'TELEGRAM_POST_FROM']) expect(r.off).toContain(name);
    for (const value of ['not-a-token-xyz', 'taxscan_in', '10/11/2026']) expect(r.off).not.toContain(value);
    // the real token never appears either, even when only another variable is wrong
    const only = parseTelegramEnv({ ...GOOD, TELEGRAM_POST_FROM: 'tomorrow' });
    expect(only.config).toBeNull();
    expect(only.off).toContain('TELEGRAM_POST_FROM');
    expect(only.off).not.toContain(TOKEN);
  });

  it('the shapes: a channel is @name or -100…, a token is <digits>:<secret>', () => {
    for (const ok of ['@taxscan_in', '@abcde', '-1001476232747']) expect(TELEGRAM_CHANNEL_SHAPE.test(ok)).toBe(true);
    for (const bad of ['taxscan_in', '@a', '@1abcd', '-1476232747', '-100', '@has space', 'https://t.me/taxscan_in']) expect(TELEGRAM_CHANNEL_SHAPE.test(bad)).toBe(false);
    expect(TELEGRAM_TOKEN_SHAPE.test(TOKEN)).toBe(true);
    for (const bad of ['', 'abc', '123:short', 'AAH:secretsecretsecretsecretsecret', ` ${TOKEN}x y`]) expect(TELEGRAM_TOKEN_SHAPE.test(bad)).toBe(false);
  });

  it('a go-live that is not an ISO date is refused (Date.parse alone would take "Nov 4")', () => {
    for (const bad of ['Nov 4', '2026', '04/11/2026', '1700000000000']) expect(parseTelegramEnv({ ...GOOD, TELEGRAM_POST_FROM: bad }).config).toBeNull();
  });
});

describe('8. escaping and the caption cut', () => {
  const link = 'https://www.taxscan.in/gst/x?a=1&b=2';
  /** What a reader sees: the markup removed and the four named entities decoded. */
  const visible = (html: string): string => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  const clean = (html: string): void => {
    expect(html).not.toMatch(/&(?!amp;|lt;|gt;|quot;)/); // no stray ampersand, no entity cut in half
    expect(html).not.toMatch(/&[a-z]*$/); // nothing ends mid-entity
    const open = (html.match(/<(b|a)[ >]/g) ?? []).length;
    const close = (html.match(/<\/(b|a)>/g) ?? []).length;
    expect(open).toBe(close);
    // the only tags are the ones we wrote
    expect(html.replace(/<\/?b>|<a href="[^"<>]*">|<\/a>/g, '')).not.toMatch(/[<>]/);
  };

  it('escapeHtml: < > & " become the four named entities, nothing else changes', () => {
    expect(escapeHtml(`<b>"Tom & Jerry"</b> 5 > 3`)).toBe('&lt;b&gt;&quot;Tom &amp; Jerry&quot;&lt;/b&gt; 5 &gt; 3');
    expect(escapeHtml("it's é ₹ 😀")).toBe("it's é ₹ 😀");
  });

  it('a headline with <, & and " renders literally; the line too; the link is escaped inside the attribute', () => {
    const html = captionOf({ headline: 'GST <script>alert(1)</script> & "Section 16" > 5', line: 'Held: A & B <i>not</i> "C"', link });
    expect(html).toBe(
      '<b>GST &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;Section 16&quot; &gt; 5</b>\n\n' +
        'Held: A &amp; B &lt;i&gt;not&lt;/i&gt; &quot;C&quot;\n\n' +
        `<a href="https://www.taxscan.in/gst/x?a=1&amp;b=2">${READ_MORE}</a>`,
    );
    clean(html);
    expect(visible(html)).toContain('GST <script>alert(1)</script> & "Section 16" > 5');
  });

  it('a link that tries to leave the attribute cannot', () => {
    const html = captionOf({ headline: 'h', line: '', link: 'https://www.taxscan.in/a"onmouseover="x' });
    expect(html).toContain('href="https://www.taxscan.in/a&quot;onmouseover=&quot;x"');
    clean(html);
  });

  it('a caption over 1024 characters is cut at a word, with an ellipsis, and the link and markup stay intact', () => {
    const headline = Array.from({ length: 400 }, (_, i) => `Tom&Jerry<${i}>`).join(' ');
    const html = captionOf({ headline, line: 'short line that has no room', link });
    clean(html);
    expect(CAPTION_MAX).toBe(1024); // Telegram's own caption limit, pinned as a literal
    expect(TEXT_MAX).toBe(4096);
    expect(visible(html).length).toBeLessThanOrEqual(1024);
    expect(visible(html).length).toBeGreaterThan(1024 - 60); // used the room, not a stub
    expect(html.startsWith('<b>')).toBe(true);
    expect(html).toContain('…</b>');
    expect(html.endsWith(`">${READ_MORE}</a>`)).toBe(true);
    expect(html).not.toContain('short line'); // no room left: the line is dropped, not squeezed to a stub
  });

  it('the cut never lands inside a surrogate pair', () => {
    const emoji = '😀'.repeat(700);
    const html = captionOf({ headline: emoji, line: '', link });
    expect(visible(html).length).toBeLessThanOrEqual(1024);
    expect(html).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it('a text post (no picture) has the 4096 limit, not 1024', () => {
    const headline = 'word '.repeat(2000);
    const caption = visible(captionOf({ headline, line: '', link }));
    const text = visible(textOf({ headline, line: '', link }));
    expect(caption.length).toBeLessThanOrEqual(1024);
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text.length).toBeGreaterThan(1024);
    clean(textOf({ headline, line: '', link }));
  });

  it('a short headline and line are not touched', () => {
    expect(captionOf({ headline: 'SC rules on GST', line: 'The Court held that the notice was invalid.', link: 'https://www.taxscan.in/a' })).toBe(
      `<b>SC rules on GST</b>\n\nThe Court held that the notice was invalid.\n\n<a href="https://www.taxscan.in/a">${READ_MORE}</a>`,
    );
  });

  it('cutAtWord: collapses whitespace, prefers a word boundary, handles tiny limits', () => {
    expect(cutAtWord('  a   b\n c ', 50)).toBe('a b c');
    expect(cutAtWord('alpha beta gamma delta', 12)).toBe('alpha beta…');
    expect(cutAtWord('abcdefghijklmnop', 8)).toBe('abcdefg…');
    expect(cutAtWord('abc', 0)).toBe('');
    expect(cutAtWord('abc', 1)).toBe('…');
  });
});

describe('the post: UTMs, the short line, the cover', () => {
  const cms = (o: Partial<CmsArticle> = {}) => async (): Promise<CmsArticle | null> => ({ keywords: [], courts: [], category: null, coverImageUrl: 'https://documents.taxscan.in/c.jpg', excerpt: 'The CMS excerpt.', ...o });
  const tags = (link: string) => Object.fromEntries([...new URL(link).searchParams].filter(([k]) => k.startsWith('utm_')));

  it('an article: the excerpt is the line, the cover is offered, UTMs taxscan-telegram / social / telegram-channel / <id>', async () => {
    const p = await buildTelegramPost({ title: 'Headline', url: 'https://www.taxscan.in/gst/some-slug-123456', body: 'the push body' }, cms());
    expect(p).toMatchObject({ kind: 'article', headline: 'Headline', line: 'The CMS excerpt.', coverImageUrl: 'https://documents.taxscan.in/c.jpg' });
    expect(tags(p!.link)).toEqual({ utm_source: 'taxscan-telegram', utm_medium: 'social', utm_campaign: 'telegram-channel', utm_content: '123456' });
  });

  it('an article without an id uses the slug; with no excerpt the push body is the line; an old UTM is replaced, not duplicated', async () => {
    const p = await buildTelegramPost({ title: 'H', url: 'https://www.taxscan.in/gst/some-slug?utm_source=izooto&x=1', body: 'push body here' }, cms({ excerpt: null }));
    expect(p!.line).toBe('push body here');
    expect(tags(p!.link)).toMatchObject({ utm_source: 'taxscan-telegram', utm_content: 'some-slug' });
    expect(new URL(p!.link).searchParams.getAll('utm_source')).toEqual(['taxscan-telegram']);
    expect(new URL(p!.link).searchParams.get('x')).toBe('1');
  });

  it('CMS down is fail-open: no excerpt, no cover, the push body is the line', async () => {
    const p = await buildTelegramPost({ title: 'H', url: 'https://www.taxscan.in/gst/a-1', body: 'body' }, async () => {
      throw new Error('cms down');
    });
    expect(p).toMatchObject({ line: 'body', coverImageUrl: null });
  });

  it('the line is at most 160 characters and dropped when it only repeats the headline', async () => {
    const long = await buildTelegramPost({ title: 'H', url: 'https://www.taxscan.in/gst/a-1', body: 'x'.repeat(50) + ' ' + 'word '.repeat(80) }, cms({ excerpt: null }));
    expect(long!.line.length).toBeLessThanOrEqual(160);
    const same = await buildTelegramPost({ title: 'Same Words', url: 'https://www.taxscan.in/gst/a-1', body: 'same   words' }, cms({ excerpt: null }));
    expect(same!.line).toBe('');
  });

  it('a course, a product and another page: the push body, no CMS call, own utm_content', async () => {
    const never = async (): Promise<CmsArticle | null> => {
      throw new Error('the CMS must not be asked for a non-article');
    };
    const course = await buildTelegramPost({ title: 'C', url: 'https://academy.taxscan.in/course/gst-master', body: 'Learn GST' }, never);
    const product = await buildTelegramPost({ title: 'P', url: 'https://shop.taxscan.in/products/gst-ebook', body: 'An e-book' }, never);
    const page = await buildTelegramPost({ title: 'Pg', url: 'https://www.taxscan.in/pricing', body: 'Plans' }, never);
    const home = await buildTelegramPost({ title: 'Hm', url: 'https://www.taxscan.in/', body: 'Hi' }, never);
    expect([course?.kind, product?.kind, page?.kind, home?.kind]).toEqual(['course', 'product', 'page', 'page']);
    expect([course, product, page, home].map((p) => tags(p!.link).utm_content)).toEqual(['gst-master', 'gst-ebook', 'pricing', 'home']);
    expect([course, product, page, home].map((p) => p!.coverImageUrl)).toEqual([null, null, null, null]);
    expect([course, product].map((p) => tags(p!.link).utm_source)).toEqual(['taxscan-telegram', 'taxscan-telegram']);
  });

  it('a URL off ALLOWED_PUSH_HOSTS makes no post', async () => {
    expect(await buildTelegramPost({ title: 'H', url: 'https://evil.example.com/gst/a-1', body: 'b' }, cms())).toBeNull();
    expect(await buildTelegramPost({ title: 'H', url: 'not a url', body: 'b' }, cms())).toBeNull();
  });

  it('withTelegramUtm sets the four tags; messageUrlOf links a public @name and a -100 id', () => {
    expect(tags(withTelegramUtm('https://www.taxscan.in/a', 'x'))).toEqual({ utm_source: 'taxscan-telegram', utm_medium: 'social', utm_campaign: 'telegram-channel', utm_content: 'x' });
    expect(messageUrlOf('@taxscan_in', 42)).toBe('https://t.me/taxscan_in/42');
    expect(messageUrlOf('-1001476232747', 42)).toBe('https://t.me/c/1476232747/42');
    expect(messageUrlOf('@taxscan_in', 1.5)).toBeNull();
  });
});

describe('the Bot API call: bodies, verdicts and what it never returns', () => {
  const reply = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const call = (f: typeof fetch) => callTelegram({ method: 'sendPhoto', token: TOKEN, body: { chat_id: '@c' } }, f);

  it('the request: POST to /bot<token>/<method>, JSON, the exact bodies', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const f = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ ok: true, result: { message_id: 77 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await callTelegram({ method: 'sendPhoto', token: TOKEN, body: photoBody('@taxscan_in', 'https://documents.taxscan.in/c.jpg', 'cap') }, f);
    expect(r).toEqual({ kind: 'posted', messageId: 77 });
    expect(seen!.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendPhoto`);
    expect(methodUrl(TOKEN, 'sendMessage')).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(seen!.init.method).toBe('POST');
    expect(JSON.parse(String(seen!.init.body))).toEqual({ chat_id: '@taxscan_in', photo: 'https://documents.taxscan.in/c.jpg', caption: 'cap', parse_mode: 'HTML' });
    expect(messageBody('-100123', 'txt', 'https://www.taxscan.in/a')).toEqual({
      chat_id: '-100123',
      text: 'txt',
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: false, url: 'https://www.taxscan.in/a', prefer_large_media: true },
    });
  });

  it('2xx is posted even without a body or an id (never re-post)', async () => {
    expect(await call((async () => new Response('', { status: 200 })) as unknown as typeof fetch)).toEqual({ kind: 'posted', messageId: null });
    expect(await call(reply(200, { ok: true, result: {} }) as unknown as typeof fetch)).toEqual({ kind: 'posted', messageId: null });
  });

  it.each([
    [429, { ok: false, error_code: 429, description: 'Too Many Requests: retry after 30', parameters: { retry_after: 30 } }, { kind: 'rate', retryAfterSec: 30, error: 'telegram_429' }],
    [500, { ok: false, error_code: 500, description: 'Internal Server Error' }, { kind: 'transient', error: 'telegram_500' }],
    [502, null, { kind: 'transient', error: 'telegram_502' }],
    [403, { ok: false, error_code: 403, description: 'Forbidden: bot was kicked from the channel chat' }, { kind: 'stop', error: 'telegram_403_bot_removed' }],
    [403, { ok: false, error_code: 403, description: 'Forbidden: something new' }, { kind: 'stop', error: 'telegram_403' }],
    [401, { ok: false, error_code: 401, description: 'Unauthorized' }, { kind: 'stop', error: 'telegram_401' }],
    [400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' }, { kind: 'stop', error: 'telegram_400_chat_not_found' }],
    [400, { ok: false, error_code: 400, description: 'Bad Request: not enough rights to send photos to the chat' }, { kind: 'stop', error: 'telegram_400_not_enough_rights' }],
    [400, { ok: false, error_code: 400, description: 'Bad Request: wrong file identifier/HTTP URL specified' }, { kind: 'failed', error: 'telegram_400_photo_refused' }],
    [400, { ok: false, error_code: 400, description: "Bad Request: can't parse entities: Unsupported start tag" }, { kind: 'failed', error: 'telegram_400_cannot_parse' }],
    [400, { ok: false, error_code: 400, description: 'Bad Request: something nobody has seen before' }, { kind: 'failed', error: 'telegram_400' }],
    [404, { ok: false, error_code: 404, description: 'Not Found' }, { kind: 'failed', error: 'telegram_404' }],
  ])('HTTP %i → %j', async (status, body, want) => {
    const r = await call(reply(status as number, body) as unknown as typeof fetch);
    expect(r).toMatchObject(want as object);
    // the provider's free text is NEVER carried: only the fixed code
    expect((r as { error: string }).error).toMatch(/^telegram_\d{3}(_[a-z_]+)?$/);
    expect(JSON.stringify(r)).not.toMatch(/Bad Request|Forbidden|kicked|Unauthorized|Not Found/);
  });

  it('retry_after is read, rounded up, capped, and absent when not given', () => {
    expect(classify(429, { error_code: 429, parameters: { retry_after: 12.2 } }).retryAfterSec).toBe(13);
    expect(classify(429, { error_code: 429, parameters: { retry_after: 999_999 } }).retryAfterSec).toBe(RETRY_AFTER_CAP_SEC);
    expect(classify(429, { error_code: 429 }).retryAfterSec).toBeNull();
    expect(classify(429, { error_code: 429, parameters: { retry_after: -4 } }).retryAfterSec).toBeNull();
  });

  it('7. a thrown fetch error whose message holds the URL and token returns a fixed code and nothing of it', async () => {
    const boom = (async () => {
      throw new Error(`request to https://api.telegram.org/bot${TOKEN}/sendPhoto failed, reason: connect ECONNRESET`);
    }) as unknown as typeof fetch;
    const r = await call(boom);
    expect(r).toEqual({ kind: 'transient', status: null, code: null, retryAfterSec: null, error: 'network_error' });
    expect(inspect(r, { depth: 9 })).not.toContain(TOKEN);
    expect(inspect(r, { depth: 9 })).not.toContain('AAHsecret');
    const timeout = (async () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }) as unknown as typeof fetch;
    expect(await call(timeout)).toMatchObject({ kind: 'transient', error: 'timeout' });
  });

  it('7. redactBotToken removes the exact token, any token-shaped value and a /bot…/ path piece', () => {
    const text = `GET https://api.telegram.org/bot${TOKEN}/getMe and ${TOKEN} and 987654321:ZZZsecretZZZsecretZZZsecret_1234 and /bot55555:abcdefghijklmnopqrstuvwxyz/x`;
    const out = redactBotToken(text, TOKEN);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toMatch(/\d{5,20}:[A-Za-z0-9_-]{20,}/);
    expect(out).not.toContain('AAHsecret');
    expect(out).not.toContain('ZZZsecret');
    expect(out).toContain('api.telegram.org'); // the rest of the text survives
  });

  it('checkTelegram: the channel title on success, a fixed class on failure, no token anywhere', async () => {
    let url = '';
    const ok = (async (u: string) => {
      url = u;
      return new Response(JSON.stringify({ ok: true, result: { id: -100, title: 'Taxscan', type: 'channel' } }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await checkTelegram({ token: TOKEN, channel: '@taxscan_in' }, ok)).toEqual({ kind: 'ok', title: 'Taxscan' });
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/getChat`);
    const gone = await checkTelegram({ token: TOKEN, channel: '@x_chan' }, reply(400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' }) as unknown as typeof fetch);
    expect(gone).toEqual({ kind: 'stop', status: 400, error: 'telegram_400_chat_not_found' });
    const down = await checkTelegram({ token: TOKEN, channel: '@x_chan' }, (async () => {
      throw new Error(`failed ${TOKEN}`);
    }) as unknown as typeof fetch);
    expect(JSON.stringify(down)).not.toContain(TOKEN);
  });
});

describe('7. the shared log redactor knows a bot URL even when the token is not in the environment', () => {
  it('redactText masks `/bot<digits>:<secret>/…` and still masks the exact token when given', async () => {
    const { redactText } = await import('../lib/redact');
    const msg = `fetch failed: POST https://api.telegram.org/bot${TOKEN}/sendPhoto ECONNRESET`;
    expect(redactText(msg)).toBe('fetch failed: POST https://api.telegram.org/bot[redacted]/sendPhoto ECONNRESET');
    expect(redactText(`token ${TOKEN} here`, [TOKEN])).not.toContain(TOKEN);
    expect(redactText('a normal sentence: bottle 12:30 is fine')).toBe('a normal sentence: bottle 12:30 is fine');
  });
});
