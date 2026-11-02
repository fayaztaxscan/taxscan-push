import { env } from '../../lib/env';
import type { FetchLike } from './post';

/**
 * One call to the LinkedIn Posts API (`POST https://api.linkedin.com/rest/posts`). Plain `fetch`, no SDK.
 * The result is a verdict the worker can act on; the token and the request body never reach it (`error` is the HTTP
 * status plus LinkedIn's own short `message`, with the token scrubbed and the whole thing capped).
 *
 *   posted — the post id (`x-restli-id` header, else body `id`)
 *   retry  — 429 / 5xx / network / timeout: try again later
 *   auth   — 401, or 403 (token / permission): stop posting for this page until the token is fixed
 *   failed — anything else (a 400 / 422 / 409: retrying cannot help)
 */
export type LinkedInResult =
  | { kind: 'posted'; postId: string }
  | { kind: 'retry' | 'auth' | 'failed'; status: number | null; error: string };

export const LINKEDIN_POSTS_URL = 'https://api.linkedin.com/rest/posts';
const TIMEOUT_MS = 15_000;
export const ERROR_MAX = 240;

export type LinkedInRequest = {
  orgUrn: string;
  accessToken: string;
  commentary: string;
  title: string;
  link: string;
  /** The link card's description (omitted when empty). */
  description?: string;
  /** An image URN from `uploadImage` for the card's thumbnail (omitted = a card without a picture). */
  thumbnail?: string;
};

/** The Posts API body: PUBLIC, MAIN_FEED, PUBLISHED, an article card from the link. */
export function postBody(r: Pick<LinkedInRequest, 'orgUrn' | 'commentary' | 'title' | 'link' | 'description' | 'thumbnail'>): Record<string, unknown> {
  return {
    author: r.orgUrn,
    commentary: r.commentary,
    visibility: 'PUBLIC',
    distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
    content: { article: { source: r.link, title: r.title, ...(r.description ? { description: r.description } : {}), ...(r.thumbnail ? { thumbnail: r.thumbnail } : {}) } },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  };
}

/** Short, token-free text for the `error` column. */
export function safeError(text: string, token: string): string {
  let t = text.replace(/\s+/g, ' ').trim();
  if (token) t = t.split(token).join('[token]');
  t = t.replace(/Bearer\s+\S+/gi, 'Bearer [token]');
  return t.length > ERROR_MAX ? `${t.slice(0, ERROR_MAX - 1)}…` : t;
}

export async function postToLinkedIn(r: LinkedInRequest, fetchImpl: FetchLike = fetch): Promise<LinkedInResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(LINKEDIN_POSTS_URL, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${r.accessToken}`,
        'Content-Type': 'application/json',
        'LinkedIn-Version': env.linkedin.apiVersion,
        'X-Restli-Protocol-Version': '2.0.0',
      },
      body: JSON.stringify(postBody(r)),
    });
    if (res.status === 201 || res.status === 200) {
      const header = res.headers.get('x-restli-id');
      let id = header && header.trim() ? header.trim() : '';
      if (!id) {
        try {
          const j = (await res.json()) as { id?: unknown };
          if (typeof j.id === 'string') id = j.id;
        } catch {
          // no body: the header was the only place
        }
      }
      // A 2xx with no id still means "posted": never re-post it. Keep a marker the screen can't link.
      return { kind: 'posted', postId: id || 'unknown' };
    }
    let message = '';
    try {
      const j = (await res.json()) as { message?: unknown };
      if (typeof j.message === 'string') message = j.message;
    } catch {
      // not JSON
    }
    const error = safeError(`HTTP ${res.status}${message ? `: ${message}` : ''}`, r.accessToken);
    if (res.status === 401 || res.status === 403) return { kind: 'auth', status: res.status, error };
    if (res.status === 429 || res.status >= 500) return { kind: 'retry', status: res.status, error };
    return { kind: 'failed', status: res.status, error };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return { kind: 'retry', status: null, error: aborted ? 'timeout' : 'network error' };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* The card's picture: the Images API                                  */
/* ------------------------------------------------------------------ */

export const LINKEDIN_IMAGES_INIT_URL = 'https://api.linkedin.com/rest/images?action=initializeUpload';
const UPLOAD_TIMEOUT_MS = 15_000;
const IMAGE_URN = /^urn:li:image:[A-Za-z0-9_-]+$/;
/** The upload URL carries our Bearer token, so it must be LinkedIn's own. */
const UPLOAD_HOST = /(^|\.)(linkedin\.com|licdn\.com)$/i;

/**
 * Uploads a picture so a post can use it as the link card's thumbnail (LinkedIn "Images API", checked 2 Nov 2026):
 *   1. POST /rest/images?action=initializeUpload  { initializeUploadRequest: { owner: <org URN> } }
 *      → value.uploadUrl, value.image (an urn:li:image:…)
 *   2. PUT the bytes to uploadUrl with the same Bearer token (a 200 / 201 answer).
 * Never throws and never echoes a body: the verdict is a fixed word.
 *   ok    — the image URN to put in `content.article.thumbnail`
 *   auth  — a 401 / 403 from initializeUpload: the token is bad for everything, handled like the post's own 401 / 403
 *   soft  — anything else (a picture problem is never a post failure); `reason` is safe to log
 */
export type UploadResult = { kind: 'ok'; urn: string } | { kind: 'auth'; status: number; error: string } | { kind: 'soft'; reason: string };

export async function uploadImage(r: { orgUrn: string; accessToken: string; bytes: Uint8Array; contentType: string }, fetchImpl: FetchLike = fetch): Promise<UploadResult> {
  const headers = (extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${r.accessToken}`, 'LinkedIn-Version': env.linkedin.apiVersion, 'X-Restli-Protocol-Version': '2.0.0', ...extra });
  let uploadUrl: string;
  let urn: string;
  const ctrl1 = new AbortController();
  const t1 = setTimeout(() => ctrl1.abort(), UPLOAD_TIMEOUT_MS);
  try {
    const res = await fetchImpl(LINKEDIN_IMAGES_INIT_URL, {
      method: 'POST',
      signal: ctrl1.signal,
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ initializeUploadRequest: { owner: r.orgUrn } }),
    });
    if (res.status === 401 || res.status === 403) return { kind: 'auth', status: res.status, error: safeError(`HTTP ${res.status} (image upload)`, r.accessToken) };
    if (!res.ok) return { kind: 'soft', reason: `init_http_${res.status}` };
    const j = (await res.json()) as { value?: { uploadUrl?: unknown; image?: unknown } };
    uploadUrl = typeof j.value?.uploadUrl === 'string' ? j.value.uploadUrl : '';
    urn = typeof j.value?.image === 'string' ? j.value.image : '';
  } catch (err) {
    return { kind: 'soft', reason: err instanceof Error && err.name === 'AbortError' ? 'init_timeout' : 'init_network' };
  } finally {
    clearTimeout(t1);
  }
  try {
    const u = new URL(uploadUrl);
    if (u.protocol !== 'https:' || !UPLOAD_HOST.test(u.hostname) || !IMAGE_URN.test(urn)) return { kind: 'soft', reason: 'init_bad_answer' };
  } catch {
    return { kind: 'soft', reason: 'init_bad_answer' };
  }
  const ctrl2 = new AbortController();
  const t2 = setTimeout(() => ctrl2.abort(), UPLOAD_TIMEOUT_MS);
  try {
    const res = await fetchImpl(uploadUrl, { method: 'PUT', signal: ctrl2.signal, headers: { Authorization: `Bearer ${r.accessToken}`, 'Content-Type': r.contentType }, body: Buffer.from(r.bytes) });
    if (res.status !== 200 && res.status !== 201) return { kind: 'soft', reason: `put_http_${res.status}` };
    return { kind: 'ok', urn };
  } catch (err) {
    return { kind: 'soft', reason: err instanceof Error && err.name === 'AbortError' ? 'put_timeout' : 'put_network' };
  } finally {
    clearTimeout(t2);
  }
}
