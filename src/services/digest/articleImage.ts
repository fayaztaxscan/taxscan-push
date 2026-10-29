import { isAllowedPushUrl } from '../../lib/urlAllowlist';

/**
 * The picture beside each story (owner, 29 Oct 2026; brief 2026-10-29-digest-lookalike).
 * taxscan's RSS carries no images, but every article page has `og:image`. At BUILD time
 * (when the items are frozen) `fetchArticleImages()` reads each frozen item's article page
 * and keeps the `og:image` URL — only the URL: the image itself is never fetched here.
 *
 * FAIL-OPEN, everywhere: no image, a timeout, a non-2xx, a redirect, an http page, a host
 * that is not allowed, an image URL that is not exactly `https://documents.taxscan.in/….jpg|jpeg|png`
 * → `null` and that story renders text-only, as before. The build never fails or waits longer
 * than `totalMs` because of a picture, and nothing here throws or logs a URL.
 *
 * Original JPEG/PNG only (no `/_img` resizer: it always answers WebP, which Outlook for
 * Windows and some other clients cannot show).
 */

/** The only host a story picture may come from. */
export const ARTICLE_IMAGE_HOST = 'documents.taxscan.in';
/** One page fetch. */
export const ARTICLE_FETCH_TIMEOUT_MS = 5_000;
/** The whole picture step, however many stories there are. */
export const ARTICLE_STEP_CAP_MS = 30_000;
/** At most this many pages at once. */
export const ARTICLE_FETCH_CONCURRENCY = 4;
/** Only the start of a page is read: og:image lives in <head>. */
export const ARTICLE_READ_BYTES = 256 * 1024;

/** `https://documents.taxscan.in/….jpg|.jpeg|.png`, no port, no userinfo. Anything else is not a story picture. */
export function isAllowedArticleImage(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== ARTICLE_IMAGE_HOST) return false;
    if (u.port !== '' || u.username !== '' || u.password !== '') return false;
    return /\.(jpe?g|png)$/i.test(u.pathname);
  } catch {
    return false;
  }
}

function decodeEntities(v: string): string {
  return v
    .replace(/&#x([0-9a-f]+);?/gi, (_m, h: string) => String.fromCodePoint(Math.min(parseInt(h, 16), 0x10ffff)))
    .replace(/&#(\d+);?/g, (_m, d: string) => String.fromCodePoint(Math.min(parseInt(d, 10), 0x10ffff)))
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
}

/** The `og:image` URL of an HTML page, if it has exactly a usable one (either attribute order). */
export function parseOgImage(html: string): string | null {
  const head = html.slice(0, ARTICLE_READ_BYTES);
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const prop = /\b(?:property|name)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const p = (prop?.[1] ?? prop?.[2] ?? prop?.[3] ?? '').trim().toLowerCase();
    if (p !== 'og:image' && p !== 'og:image:url') continue;
    const c = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const v = decodeEntities((c?.[1] ?? c?.[2] ?? c?.[3] ?? '').trim());
    if (v) return v;
  }
  return null;
}

export type FetchLike = (url: string, init: { redirect: 'error'; signal: AbortSignal; headers: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

export type ArticleImageDeps = {
  fetchFn?: FetchLike;
  timeoutMs?: number;
  totalMs?: number;
  concurrency?: number;
};

/** One article page → its picture URL, or null. Never throws. */
export async function fetchArticleImage(pageUrl: string, deps: ArticleImageDeps = {}, outer?: AbortSignal): Promise<string | null> {
  try {
    const u = new URL(pageUrl);
    // https only, and only a host push itself may link to.
    if (u.protocol !== 'https:' || u.port !== '' || u.username !== '' || u.password !== '' || !isAllowedPushUrl(pageUrl)) return null;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), deps.timeoutMs ?? ARTICLE_FETCH_TIMEOUT_MS);
    const onOuter = () => ac.abort();
    outer?.addEventListener('abort', onOuter);
    try {
      if (outer?.aborted) return null;
      const f: FetchLike = deps.fetchFn ?? ((url, init) => fetch(url, init));
      const res = await f(pageUrl, { redirect: 'error', signal: ac.signal, headers: { Accept: 'text/html', 'User-Agent': 'TaxscanDigestBuilder/1.0' } });
      if (!res.ok) return null;
      const image = parseOgImage(await res.text());
      return isAllowedArticleImage(image) ? image : null;
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onOuter);
    }
  } catch {
    return null;
  }
}

/**
 * The pictures for these article URLs: ≤ 4 pages at a time, each ≤ 5 s, the whole step ≤ 30 s
 * (pages not finished by then count as "no picture"). Never throws; every URL has an entry.
 */
export async function fetchArticleImages(urls: readonly string[], deps: ArticleImageDeps = {}): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const unique = [...new Set(urls)];
  for (const u of unique) out.set(u, null);
  const cap = new AbortController();
  const capTimer = setTimeout(() => cap.abort(), deps.totalMs ?? ARTICLE_STEP_CAP_MS);
  let next = 0;
  const worker = async () => {
    for (;;) {
      if (cap.signal.aborted) return;
      const i = next++;
      if (i >= unique.length) return;
      const url = unique[i];
      const image = await fetchArticleImage(url, deps, cap.signal);
      // A page that finished after the cap does not count (its answer is late).
      if (!cap.signal.aborted) out.set(url, image);
    }
  };
  try {
    await Promise.race([
      Promise.all(Array.from({ length: Math.max(1, Math.min(deps.concurrency ?? ARTICLE_FETCH_CONCURRENCY, unique.length)) }, worker)),
      new Promise<void>((resolve) => cap.signal.addEventListener('abort', () => resolve())),
    ]);
  } finally {
    clearTimeout(capTimer);
    cap.abort(); // anything still running is cancelled
  }
  return out;
}
