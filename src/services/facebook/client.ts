import { env } from '../../lib/env';
import type { FetchLike } from '../linkedin/post';

/**
 * One call to the Facebook Graph API (`POST https://graph.facebook.com/<version>/<page-id>/feed`). Plain `fetch`, no SDK.
 * The access token travels ONLY in the form body (post) or the Authorization header (connection check), never in a URL.
 * The result is a verdict the worker can act on; the token and the request body never reach it (`error` is a short
 * "HTTP status, code, subcode, message" line with the token scrubbed and the whole thing capped).
 *
 *   posted    — the post id (`id`, `<pageid>_<postid>`)
 *   rate      — code 4 / 17 / 32 / 613, HTTP 429: slow down, retry later (+15, +60 min)
 *   transient — 5xx, network, timeout, code 1 / 2: retry soon (+1, +5, +15 min)
 *   auth      — code 190 (token), 10 / 200–299 (permission), HTTP 401 / 403: stop until the token is fixed
 *   policy    — code 368, or an answer that says spam / blocked / restricted, or an `error_user_title` on another 4xx:
 *               Facebook is protecting the page — stop and only an ADMIN may resume
 *   duplicate — code 506: Facebook says it is already posted, never retried
 *   failed    — any other 4xx: retrying cannot help
 */
export type FacebookFailKind = 'rate' | 'transient' | 'auth' | 'policy' | 'duplicate' | 'failed';
export type FacebookFailure = { kind: FacebookFailKind; status: number | null; code: number | null; subcode: number | null; error: string };
export type FacebookResult = { kind: 'posted'; postId: string } | FacebookFailure;

export const ERROR_MAX = 240;
const TIMEOUT_MS = 15_000;

export const feedUrl = (pageId: string): string => `https://graph.facebook.com/${env.facebook.graphVersion}/${pageId}/feed`;
export const photosUrl = (pageId: string): string => `https://graph.facebook.com/${env.facebook.graphVersion}/${pageId}/photos`;
export const pageUrl = (pageId: string): string => `https://graph.facebook.com/${env.facebook.graphVersion}/${pageId}?fields=name`;

/** Short, token-free text for the `error` column, a log or an email. */
export function safeError(text: string, token: string): string {
  let t = text.replace(/\s+/g, ' ').trim();
  if (token) t = t.split(token).join('[token]');
  t = t.replace(/Bearer\s+\S+/gi, 'Bearer [token]').replace(/access_token[=:"'\s]+[^\s&"']+/gi, 'access_token=[token]');
  return t.length > ERROR_MAX ? `${t.slice(0, ERROR_MAX - 1)}…` : t;
}

const RATE_CODES = new Set([4, 17, 32, 613]);
const TRANSIENT_CODES = new Set([1, 2]);
const POLICY_TEXT = /spam|blocked|restricted/i;

type GraphError = { message?: unknown; type?: unknown; code?: unknown; error_subcode?: unknown; error_user_title?: unknown };
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Graph's `error` object (or null) from a response body. */
async function graphError(res: Response): Promise<GraphError | null> {
  try {
    const j = (await res.json()) as { error?: unknown };
    return j && typeof j.error === 'object' && j.error ? (j.error as GraphError) : null;
  } catch {
    return null; // not JSON
  }
}

/** Pure: the verdict for a failed answer. Order matters: a policy block outranks an auth-looking status. */
export function classify(status: number, e: GraphError | null, token: string): FacebookFailure {
  const code = num(e?.code);
  const subcode = num(e?.error_subcode);
  const message = typeof e?.message === 'string' ? e.message : '';
  const type = typeof e?.type === 'string' ? e.type : '';
  const title = typeof e?.error_user_title === 'string' ? e.error_user_title.trim() : '';
  const parts = [`HTTP ${status}`, code !== null ? `code ${code}` : '', subcode !== null ? `subcode ${subcode}` : ''].filter(Boolean).join(' ');
  const error = safeError(`${parts}${message ? `: ${message}` : ''}`, token);
  const base = { status, code, subcode, error };
  const knownOther =
    code === 190 || code === 10 || (code !== null && code >= 200 && code <= 299) || status === 401 || status === 403 || status === 429 || status >= 500 ||
    (code !== null && (RATE_CODES.has(code) || TRANSIENT_CODES.has(code) || code === 506));
  if (code === 368 || POLICY_TEXT.test(type)) return { kind: 'policy', ...base };
  if (code === 190 || code === 10 || (code !== null && code >= 200 && code <= 299) || status === 401 || status === 403) return { kind: 'auth', ...base };
  if ((code !== null && RATE_CODES.has(code)) || status === 429) return { kind: 'rate', ...base };
  if (code === 506) return { kind: 'duplicate', ...base };
  if (status >= 500 || (code !== null && TRANSIENT_CODES.has(code))) return { kind: 'transient', ...base };
  if (title && status >= 400 && status < 500 && !knownOther) return { kind: 'policy', ...base };
  return { kind: 'failed', ...base };
}

/**
 * `photoUrl` set (brief 2026-11-08-social-picture: the Compose picture's public URL) = a PHOTO post: `POST /<page-id>/photos` with
 * `url` + `caption` (the caller puts the tagged link in the message, `captionWithLink`). Unset = today's `/feed` link post, unchanged.
 */
export type FacebookRequest = { pageId: string; accessToken: string; message: string; link: string; photoUrl?: string };

/** The form body of a post: `message`, `link`, `access_token`; of a photo post: `url`, `caption`, `access_token`. */
export function postForm(r: FacebookRequest): string {
  if (r.photoUrl) return new URLSearchParams({ url: r.photoUrl, caption: r.message, access_token: r.accessToken }).toString();
  return new URLSearchParams({ message: r.message, link: r.link, access_token: r.accessToken }).toString();
}

export async function postToFacebook(r: FacebookRequest, fetchImpl: FetchLike = fetch): Promise<FacebookResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(r.photoUrl ? photosUrl(r.pageId) : feedUrl(r.pageId), {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: postForm(r),
    });
    if (res.status >= 200 && res.status < 300) {
      let id = '';
      let photoJson: unknown = null;
      try {
        const j = (await res.json()) as { id?: unknown };
        if (typeof j.id === 'string') id = j.id;
        if (r.photoUrl) photoJson = j;
      } catch {
        // no body
      }
      // A 2xx with no id still means "posted": never re-post it. Keep a marker the screen can't link. (A photo answers
      // { id, post_id }: `post_id` is the feed post, `id` the photo; prefer the post.)
      return { kind: 'posted', postId: postIdOf(photoJson) || id || 'unknown' };
    }
    return classify(res.status, await graphError(res), r.accessToken);
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return { kind: 'transient', status: null, code: null, subcode: null, error: aborted ? 'timeout' : 'network error' };
  } finally {
    clearTimeout(timer);
  }
}

/** A photo answer's `post_id` (the feed post), or ''. */
function postIdOf(j: unknown): string {
  return j && typeof j === 'object' && typeof (j as { post_id?: unknown }).post_id === 'string' ? (j as { post_id: string }).post_id : '';
}

/** The connection check's verdict: a page name, or an error class (never a body). */
export type ConnectionResult = { kind: 'ok'; name: string } | { kind: FacebookFailKind; status: number | null; code: number | null; error: string };

/** `GET /<version>/<page-id>?fields=name` with the token in the Authorization header. Posts nothing. */
export async function checkConnection(r: { pageId: string; accessToken: string }, fetchImpl: FetchLike = fetch): Promise<ConnectionResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(pageUrl(r.pageId), { method: 'GET', signal: ctrl.signal, headers: { Authorization: `Bearer ${r.accessToken}` } });
    if (res.ok) {
      try {
        const j = (await res.json()) as { name?: unknown };
        if (typeof j.name === 'string' && j.name.trim()) return { kind: 'ok', name: j.name.trim().slice(0, 120) };
      } catch {
        // fall through
      }
      return { kind: 'failed', status: res.status, code: null, error: 'Facebook answered without a page name' };
    }
    const c = classify(res.status, await graphError(res), r.accessToken);
    return { kind: c.kind, status: c.status, code: c.code, error: c.error };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return { kind: 'transient', status: null, code: null, error: aborted ? 'timeout' : 'network error' };
  } finally {
    clearTimeout(timer);
  }
}
