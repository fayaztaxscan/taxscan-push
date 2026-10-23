import { useAuth } from './useAuth';

export type ApiError = Error & {
  status?: number;
  body?: unknown;
  /**
   * A write whose result never reached us — the browser gave up waiting, the
   * connection dropped, or the proxy timed out. The server may well have done
   * it, so the UI must not invite a blind retry.
   */
  outcomeUnknown?: boolean;
};

/**
 * A human-readable message from a failed request: prefers the server's
 * validation issues / message over the generic "Request failed: 4xx".
 */
export function apiErrorMessage(e: unknown): string {
  const err = e as ApiError | undefined;
  const body = err?.body as
    | { message?: string; error?: string; issues?: Array<{ message?: string }> }
    | undefined;
  const issues = body?.issues?.map((i) => i.message).filter(Boolean);
  if (issues && issues.length > 0) return issues.join(' · ');
  return body?.message ?? body?.error ?? err?.message ?? 'Request failed';
}

// Per-attempt request timeout. A cold Railway worker or a flaky mobile
// connection would otherwise leave the UI stuck on "Loading…" forever; we
// fail fast with a clear message instead.
const TIMEOUT_MS = 15_000;
// Transient server states worth a retry — these are exactly what a cold-start
// or a mid-deploy window returns. 4xx (except none here) are NOT retried.
const RETRY_STATUSES = new Set([502, 503, 504]);
const MAX_RETRIES = 2; // up to 3 attempts total, idempotent (GET/HEAD) only

/**
 * Timeout for requests that push to every subscriber (Compose send, Queue and
 * Review "Push now"). The server sends to ~3,000 subscribers before it answers,
 * which can outlast the 15 s default. push.taxscan.in sits behind Cloudflare,
 * which cuts a request at 100 s (524), so waiting longer than ~90 s gains nothing.
 */
export const DISPATCH_TIMEOUT_MS = 90_000;

// Statuses that mean "a proxy gave up", not "the server refused": on a write the
// server may have completed the work. 524 is Cloudflare's origin timeout.
const OUTCOME_UNKNOWN_STATUSES = new Set([502, 503, 504, 524]);
const OUTCOME_UNKNOWN_MESSAGE =
  'No reply from the server in time — the change may still have gone through. Check before trying again.';

/** What a push screen shows when it can't tell whether the send went out. */
export const SEND_OUTCOME_UNKNOWN_MESSAGE =
  'No reply from the server in time — it may still be sending. Check Campaigns before trying again.';

export type RequestOptions = {
  /** Per-attempt timeout; defaults to 15 s. */
  timeoutMs?: number;
  /** Replaces the generic outcome-unknown text for this write. */
  unknownMessage?: string;
};

/** Options for every request that pushes to subscribers. */
export const PUSH_REQUEST: RequestOptions = {
  timeoutMs: DISPATCH_TIMEOUT_MS,
  unknownMessage: SEND_OUTCOME_UNKNOWN_MESSAGE,
};
const BACKOFF_MS = [500, 1500];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function useApi() {
  const { user } = useAuth();

  // Session died server-side (expired / revoked). Clear local state and send
  // the user to the login screen with a notice, instead of leaving a cryptic
  // "Unauthorized" banner on a data page they can no longer use.
  async function handleSessionExpired(): Promise<void> {
    user.value = null;
    const { router } = await import('../router');
    const current = router.currentRoute.value;
    if (current.name !== 'login') {
      await router.push({
        name: 'login',
        query: { next: current.fullPath, reason: 'expired' },
      });
    }
  }

  async function request<T = unknown>(
    path: string,
    init: RequestInit = {},
    opts: RequestOptions = {},
  ): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
    const unknownMessage = opts.unknownMessage ?? OUTCOME_UNKNOWN_MESSAGE;
    const method = (init.method ?? 'GET').toUpperCase();
    // Only reads are safe to auto-retry; never replay a POST/PATCH/DELETE.
    const idempotent = method === 'GET' || method === 'HEAD';
    const headers = new Headers(init.headers);
    if (!headers.has('Content-Type') && init.body !== undefined) {
      headers.set('Content-Type', 'application/json');
    }

    let attempt = 0;
    for (;;) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res: Response;
      try {
        res = await fetch(path, {
          ...init,
          headers,
          // Cookies are the source of truth — `credentials: 'include'` lets
          // the browser send tx_push_session on every API call.
          credentials: 'include',
          signal: controller.signal,
        });
      } catch (cause) {
        clearTimeout(timer);
        // Timeout (AbortError) or network failure (offline, DNS, dropped conn).
        const timedOut = cause instanceof DOMException && cause.name === 'AbortError';
        if (idempotent && attempt < MAX_RETRIES) {
          await sleep(BACKOFF_MS[attempt] ?? 1500);
          attempt += 1;
          continue;
        }
        // A write may have reached the server before the wait ended — never
        // tell the user to simply "try again" (a Compose retry used to push the
        // same message to everyone twice).
        const err: ApiError = new Error(
          !idempotent
            ? unknownMessage
            : timedOut
              ? 'The server took too long to respond. Please try again in a moment.'
              : 'Could not reach the server. Check your connection and try again.',
        );
        err.status = 0;
        if (!idempotent) err.outcomeUnknown = true;
        throw err;
      }
      clearTimeout(timer);

      if (res.status === 401) {
        await handleSessionExpired();
        const err: ApiError = new Error('Your session expired — please sign in again.');
        err.status = 401;
        throw err;
      }

      // Transient upstream error (cold start / deploy window): retry a read.
      if (RETRY_STATUSES.has(res.status) && idempotent && attempt < MAX_RETRIES) {
        await sleep(BACKOFF_MS[attempt] ?? 1500);
        attempt += 1;
        continue;
      }

      if (!res.ok) {
        const body = await res.json().catch(() => undefined);
        const unknown = !idempotent && OUTCOME_UNKNOWN_STATUSES.has(res.status);
        const err: ApiError = new Error(
          unknown ? unknownMessage : `Request failed: ${res.status}`,
        );
        err.status = res.status;
        // A proxy's error page carries no message of ours; drop it so
        // apiErrorMessage shows the outcome-unknown text instead.
        err.body = unknown ? undefined : body;
        if (unknown) err.outcomeUnknown = true;
        throw err;
      }
      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    }
  }

  return {
    get: <T = unknown>(path: string) => request<T>(path),
    post: <T = unknown>(path: string, body: unknown, opts?: RequestOptions) =>
      request<T>(path, { method: 'POST', body: JSON.stringify(body) }, opts),
    put: <T = unknown>(path: string, body: unknown) =>
      request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
    /** Raw file upload (the Ads screen's image): the bytes as the body, the name in X-Filename. */
    upload: <T = unknown>(path: string, file: File) =>
      request<T>(path, {
        method: 'POST',
        body: file,
        headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) },
      }),
    patch: <T = unknown>(path: string, body: unknown) =>
      request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
    del: <T = unknown>(path: string) => request<T>(path, { method: 'DELETE' }),
  };
}
