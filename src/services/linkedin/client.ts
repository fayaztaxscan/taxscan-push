import { env } from '../../lib/env';
import type { FetchLike } from './post';

/**
 * One call to the LinkedIn Posts API (`POST https://api.linkedin.com/rest/posts`). Plain `fetch`, no SDK.
 * The result is a verdict the worker can act on; the token and the request body never reach it (`error` is the HTTP
 * status plus LinkedIn's own short `message`, with the token scrubbed and the whole thing capped).
 *
 *   posted    — the post id (`x-restli-id` header, else body `id`)
 *   retry     — 429 / 5xx / network / timeout: try again later
 *   org_limit — 429 whose message says "Organization post creation limit reached" (found live 9 Nov, Shopscan): LinkedIn's daily create
 *               limit for THAT page. Retrying cannot help until the UTC day turns, so the worker holds the page (brief 2026-11-09-small-fixes)
 *   auth      — 401, or 403 (token / permission): stop posting for this page until the token is fixed
 *   duplicate — 422 DUPLICATE_POST: LinkedIn already has this exact post (every push posts, so an identical repeat can happen); never
 *               retried, never repeated without the picture, never a login stop
 *   failed    — anything else (a 400 / 422 / 409: retrying cannot help)
 */
export type LinkedInResult =
  | { kind: 'posted'; postId: string }
  | { kind: 'retry' | 'auth' | 'failed' | 'duplicate' | 'org_limit'; status: number | null; error: string };

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
  /**
   * An image URN for an IMAGE post (brief 2026-11-08-social-picture: the Compose picture, shown large). Set = the body carries
   * `content.media` instead of the article card, and the commentary is expected to hold the link itself (`commentaryWithLink`).
   */
  image?: string;
};

/** The image post's alt text: the push title, cut to this many characters. */
export const ALT_TEXT_MAX = 300;

/** The Posts API body: PUBLIC, MAIN_FEED, PUBLISHED, an article card from the link. */
export function postBody(r: Pick<LinkedInRequest, 'orgUrn' | 'commentary' | 'title' | 'link' | 'description' | 'thumbnail' | 'image'>): Record<string, unknown> {
  // Image post (Posts API "Images" content: `content.media.id` = an urn:li:image, `altText` optional). Otherwise today's card, unchanged.
  const content = r.image
    ? { media: { id: r.image, altText: r.title.replace(/\s+/g, ' ').trim().slice(0, ALT_TEXT_MAX) } }
    : { article: { source: r.link, title: r.title, ...(r.description ? { description: r.description } : {}), ...(r.thumbnail ? { thumbnail: r.thumbnail } : {}) } };
  return {
    author: r.orgUrn,
    commentary: r.commentary,
    visibility: 'PUBLIC',
    distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
    content,
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  };
}

/**
 * Is this LinkedIn's answer to a post it already has? HTTP 422 with `errorDetails.inputErrors[].code = "DUPLICATE_POST"` ("Duplicate
 * post is detected"), and a message ending "Content is a duplicate of urn:li:share:<id>". LinkedIn's reference pages do not list the
 * code; the shape is what the API returns in practice (a developer's captured response, 4 Nov 2026). Matched tolerantly: the code in
 * `inputErrors`, the code at the top level, or the message, but only ever on a 422 so no other error can look like a duplicate.
 */
export function isDuplicateAnswer(status: number, body: unknown): boolean {
  if (status !== 422 || !body || typeof body !== 'object') return false;
  const b = body as { message?: unknown; code?: unknown; errorDetails?: { inputErrors?: unknown } };
  if (b.code === 'DUPLICATE_POST') return true;
  const inputs = b.errorDetails?.inputErrors;
  if (Array.isArray(inputs) && inputs.some((e) => !!e && typeof e === 'object' && (e as { code?: unknown }).code === 'DUPLICATE_POST')) return true;
  return typeof b.message === 'string' && /content is a duplicate of/i.test(b.message);
}

/**
 * LinkedIn's per-organization daily create limit: HTTP 429 and a message that says so. ONLY a 429 with that message counts, so every
 * other 429 (a rate limit, the member quota) keeps the ordinary retry path.
 */
export function isOrgDailyLimitAnswer(status: number, body: unknown): boolean {
  if (status !== 429 || !body || typeof body !== 'object') return false;
  const m = (body as { message?: unknown }).message;
  return typeof m === 'string' && /organization post creation limit reached/i.test(m);
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
    let duplicate = false;
    let orgLimit = false;
    try {
      const j = (await res.json()) as { message?: unknown };
      if (typeof j.message === 'string') message = j.message;
      duplicate = isDuplicateAnswer(res.status, j);
      orgLimit = isOrgDailyLimitAnswer(res.status, j);
    } catch {
      // not JSON
    }
    const error = safeError(`HTTP ${res.status}${message ? `: ${message}` : ''}`, r.accessToken);
    if (duplicate) return { kind: 'duplicate', status: res.status, error };
    if (res.status === 401 || res.status === 403) return { kind: 'auth', status: res.status, error };
    if (orgLimit) return { kind: 'org_limit', status: res.status, error };
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

/* ------------------------------------------------------------------ */
/* Is the uploaded picture ready? (the upload is asynchronous)         */
/* ------------------------------------------------------------------ */

export const IMAGE_POLLS = 4;
export const IMAGE_POLL_GAP_MS = 1500;
const STATUS_TIMEOUT_MS = 10_000;

export type ImageReady = { ok: true } | { ok: false; reason: 'processing' | 'processing_failed' | 'status_network' | `status_${number}` };

/**
 * True when the status call itself failed in a way that says nothing about the picture: a 4xx other than 401 / 403 (the
 * poll's own request was refused) or a network error. The worker still attaches the image then and relies on the
 * drop-and-repeat if LinkedIn rejects the post. 401 / 403, 5xx, processing and processing_failed are not "unverified".
 */
export function isUnverifiedImage(reason: string): boolean {
  if (reason === 'status_network') return true;
  const m = /^status_(\d{3})$/.exec(reason);
  if (!m) return false;
  const n = Number(m[1]);
  return n >= 400 && n < 500 && n !== 401 && n !== 403;
}

/**
 * After the PUT the image is WAITING_UPLOAD / PROCESSING until LinkedIn has made it (AVAILABLE). Posting before that can be
 * rejected (a 4xx about the thumbnail), so look at `GET /rest/images/<urn>` (LinkedIn "Images API": the `status` field) up to
 * 4 times, 1.5 s apart (about 4.5 s of waiting). Anything but AVAILABLE is a verdict with a fixed reason word, never a body; the worker decides (see `isUnverifiedImage`).
 */
export async function waitForImage(
  r: { urn: string; accessToken: string },
  fetchImpl: FetchLike = fetch,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((res) => setTimeout(res, ms)),
): Promise<ImageReady> {
  if (!IMAGE_URN.test(r.urn)) return { ok: false, reason: 'status_network' };
  for (let i = 0; i < IMAGE_POLLS; i += 1) {
    if (i > 0) await sleep(IMAGE_POLL_GAP_MS);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), STATUS_TIMEOUT_MS);
    try {
      const res = await fetchImpl(`https://api.linkedin.com/rest/images/${encodeURIComponent(r.urn)}`, {
        method: 'GET',
        signal: ctrl.signal,
        headers: { Authorization: `Bearer ${r.accessToken}`, 'LinkedIn-Version': env.linkedin.apiVersion, 'X-Restli-Protocol-Version': '2.0.0' },
      });
      if (!res.ok) return { ok: false, reason: `status_${res.status}` };
      const j = (await res.json()) as { status?: unknown };
      if (j.status === 'AVAILABLE') return { ok: true };
      if (j.status === 'PROCESSING_FAILED') return { ok: false, reason: 'processing_failed' };
      // WAITING_UPLOAD / PROCESSING / anything unexpected: look again
    } catch (err) {
      void err; // a timeout and a network error are the same to the caller: no verdict on the picture
      return { ok: false, reason: 'status_network' };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, reason: 'processing' };
}
