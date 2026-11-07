import { isAllowedPushUrl } from '../../lib/urlAllowlist';
import { ARTICLE_READ_BYTES, metaContent } from '../digest/articleImage';
import { pageLinkOf, storeLinkOf } from './allPushes';

/**
 * The og tags of a course / shop-product page, for the LinkedIn card of a store post (brief 2026-11-04-academy-store-posts): the
 * card's title and description, and the picture. Done by the WORKER only, never on a request path, and FAIL-OPEN everywhere: any
 * problem here means the post goes out with the push's own title and body and, at worst, no picture.
 *
 * Safe by construction: https only, only the two store hosts that are also on ALLOWED_PUSH_HOSTS, no redirects (a redirect could
 * leave the allowlist), a 5 s limit for the whole fetch including the body, and only the START of the page is read (og tags live in
 * <head>; the read is cancelled past `STORE_PAGE_READ_BYTES`, like the digest's article pictures). The result says WHY it failed in
 * a fixed word, never a URL, a body or a header, so the reason is safe to log.
 *
 * The picture URL is chosen here, downloaded (and its host re-checked against the LinkedIn image allowlist) by the worker's
 * existing image step: `og:image:secure_url` first, then `og:image`, https only. Shopify serves `og:image` over http and the same
 * file over https in `og:image:secure_url`; an http-only page gets no picture.
 */

export const STORE_PAGE_TIMEOUT_MS = 5_000;
export const STORE_PAGE_READ_BYTES = ARTICLE_READ_BYTES;
const USER_AGENT = 'TaxscanPushSocial/1.0';

export type StorePageTags = {
  /** `og:title`, markup stripped, whitespace collapsed; null when absent. */
  title: string | null;
  /** `og:description`, same treatment; null when absent. */
  description: string | null;
  /** An absolute https picture URL (`og:image:secure_url`, else `og:image`), or null. NOT yet checked against the image allowlist. */
  imageUrl: string | null;
  /** Why there is no `imageUrl`: no image tag at all, only a non-https one, or an unusable value. null when there is one. */
  imageReason: 'no_tag' | 'not_https' | 'bad_url' | null;
};
export type StorePageFailure = 'page_host' | 'page_timeout' | 'page_redirect' | 'page_network' | `page_http_${number}`;
export type StorePageResult = { ok: true; tags: StorePageTags } | { ok: false; reason: StorePageFailure };
export type StorePageFetch = (url: string) => Promise<StorePageResult>;

const plain = (s: string | null): string | null => {
  if (!s) return null;
  const t = s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return t || null;
};

/** The og tags of an HTML page (only its first `STORE_PAGE_READ_BYTES` characters are looked at). Pure. */
export function parseStorePageTags(html: string, pageUrl: string): StorePageTags {
  let imageUrl: string | null = null;
  let imageReason: StorePageTags['imageReason'] = 'no_tag';
  for (const raw of [metaContent(html, ['og:image:secure_url']), metaContent(html, ['og:image'])]) {
    if (!raw) continue;
    imageReason = 'not_https';
    let abs: URL;
    try {
      abs = new URL(raw, pageUrl); // a relative or protocol-relative value resolves against the (https) page
    } catch {
      imageReason = 'bad_url';
      continue;
    }
    if (abs.protocol === 'https:') {
      imageUrl = abs.toString();
      imageReason = null;
      break;
    }
  }
  return { title: plain(metaContent(html, ['og:title'])), description: plain(metaContent(html, ['og:description'])), imageUrl, imageReason };
}

/** At most `max` bytes of the body, decoded as UTF-8; the rest of the stream is cancelled, never downloaded. */
async function readHead(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader?.();
  if (!reader) return (await res.text()).slice(0, max); // a body without a stream (only a test double has none)
  const decoder = new TextDecoder('utf-8');
  let out = '';
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = max - bytes;
    if (value.byteLength >= room) {
      out += decoder.decode(value.subarray(0, room));
      await reader.cancel().catch(() => undefined);
      break;
    }
    out += decoder.decode(value, { stream: true });
    bytes += value.byteLength;
  }
  return out;
}

/**
 * May this URL be fetched for a card? A course / product link (https only, by `storeLinkOf`), or, since brief
 * 2026-11-07-social-every-link, any OTHER page on a host NAMED in ALLOWED_PUSH_HOSTS (`pageLinkOf`), https only. An article, an off-list
 * host and a plain-http page are refused (`page_host`), so the fetch can never be pointed at a host nobody listed.
 */
function fetchable(pageUrl: string): boolean {
  if (storeLinkOf(pageUrl)) return true;
  return pageLinkOf(pageUrl) !== null && /^https:/i.test(String(pageUrl).trim());
}

/** ONE request for the page's head. Never throws. `pageUrl` must be a course / product link, or another page, on an allowed host. */
export async function fetchStorePage(pageUrl: string, f: typeof fetch = fetch): Promise<StorePageResult> {
  if (!fetchable(pageUrl) || !isAllowedPushUrl(pageUrl)) return { ok: false, reason: 'page_host' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), STORE_PAGE_TIMEOUT_MS);
  try {
    const res = await f(pageUrl, { redirect: 'error', signal: ctrl.signal, headers: { accept: 'text/html', 'user-agent': USER_AGENT } });
    if (res.status >= 300 && res.status < 400) return { ok: false, reason: 'page_redirect' };
    if (!res.ok) return { ok: false, reason: `page_http_${res.status}` };
    return { ok: true, tags: parseStorePageTags(await readHead(res, STORE_PAGE_READ_BYTES), pageUrl) };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return { ok: false, reason: 'page_timeout' };
    // `redirect: 'error'` makes fetch throw a TypeError on any redirect
    const msg = err instanceof Error ? `${err.message} ${(err as { cause?: { message?: string } }).cause?.message ?? ''}` : '';
    return { ok: false, reason: /redirect/i.test(msg) ? 'page_redirect' : 'page_network' };
  } finally {
    clearTimeout(timer);
  }
}
