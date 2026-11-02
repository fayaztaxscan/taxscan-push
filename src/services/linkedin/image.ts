import type { FetchLike } from './post';

/**
 * The article's cover picture, fetched safely so it can be uploaded to LinkedIn
 * (brief 2026-11-02-linkedin-article-thumbnail). The Posts API does not scrape the link: a thumbnail appears only when the post
 * carries an image URN uploaded through the Images API.
 *
 * Safe by construction: https only, an exact-host allowlist, no redirects (a redirect could leave the allowlist), a 10 s limit
 * for the whole fetch including the body, at most 5 MB (the read is aborted past it), and only JPEG / PNG / GIF. The result
 * says WHY it failed in a fixed word, never a URL, a body or a header, so the reason is safe to log.
 */
export const IMAGE_HOSTS: ReadonlySet<string> = new Set(['documents.taxscan.in', 'www.taxscan.in', 'taxscan.in']);
export const IMAGE_TYPES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/gif']);
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const IMAGE_TIMEOUT_MS = 10_000;

export type CoverImage = { ok: true; bytes: Uint8Array; contentType: string } | { ok: false; reason: 'host' | 'redirect' | 'timeout' | 'network' | 'type' | 'size' | `http_${number}` };

/** True when the URL is https on an allowlisted host (no userinfo, no port). */
export function isAllowedImageUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.username === '' && u.password === '' && u.port === '' && IMAGE_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export async function fetchCoverImage(url: string, f: FetchLike = fetch): Promise<CoverImage> {
  if (!isAllowedImageUrl(url)) return { ok: false, reason: 'host' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), IMAGE_TIMEOUT_MS);
  try {
    const res = await f(url, { signal: ctrl.signal, redirect: 'error', headers: { accept: 'image/jpeg,image/png,image/gif' } });
    if (!res.ok) return { ok: false, reason: `http_${res.status}` };
    const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!IMAGE_TYPES.has(contentType)) return { ok: false, reason: 'type' };
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > IMAGE_MAX_BYTES) return { ok: false, reason: 'size' };
    // Read as a stream and stop at the cap, so an oversized (or lying) response is never held in memory.
    const reader = res.body?.getReader?.();
    if (reader) {
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > IMAGE_MAX_BYTES) {
          ctrl.abort();
          return { ok: false, reason: 'size' };
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(total);
      let at = 0;
      for (const c of chunks) {
        bytes.set(c, at);
        at += c.byteLength;
      }
      return total > 0 ? { ok: true, bytes, contentType } : { ok: false, reason: 'type' };
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > IMAGE_MAX_BYTES) return { ok: false, reason: 'size' };
    return buf.byteLength > 0 ? { ok: true, bytes: buf, contentType } : { ok: false, reason: 'type' };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return { ok: false, reason: 'timeout' };
    // `redirect: 'error'` makes fetch throw a TypeError on any redirect
    const msg = err instanceof Error ? `${err.message} ${(err as { cause?: { message?: string } }).cause?.message ?? ''}` : '';
    return { ok: false, reason: /redirect/i.test(msg) ? 'redirect' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}
