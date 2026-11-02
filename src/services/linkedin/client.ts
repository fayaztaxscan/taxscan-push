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

export type LinkedInRequest = { orgUrn: string; accessToken: string; commentary: string; title: string; link: string };

/** The Posts API body: PUBLIC, MAIN_FEED, PUBLISHED, an article card from the link. */
export function postBody(r: Pick<LinkedInRequest, 'orgUrn' | 'commentary' | 'title' | 'link'>): Record<string, unknown> {
  return {
    author: r.orgUrn,
    commentary: r.commentary,
    visibility: 'PUBLIC',
    distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
    content: { article: { source: r.link, title: r.title } },
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
