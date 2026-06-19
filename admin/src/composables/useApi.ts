import { useAuth } from './useAuth';

export type ApiError = Error & { status?: number; body?: unknown };

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
  ): Promise<T> {
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
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
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
        const err: ApiError = new Error(
          timedOut
            ? 'The server took too long to respond. Please try again in a moment.'
            : 'Could not reach the server. Check your connection and try again.',
        );
        err.status = 0;
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
        const err: ApiError = new Error(`Request failed: ${res.status}`);
        err.status = res.status;
        err.body = body;
        throw err;
      }
      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    }
  }

  return {
    get: <T = unknown>(path: string) => request<T>(path),
    post: <T = unknown>(path: string, body: unknown) =>
      request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
    patch: <T = unknown>(path: string, body: unknown) =>
      request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
    del: <T = unknown>(path: string) => request<T>(path, { method: 'DELETE' }),
  };
}
