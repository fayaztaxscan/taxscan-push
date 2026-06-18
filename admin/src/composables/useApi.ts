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

export function useApi() {
  const { user } = useAuth();

  async function request<T = unknown>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const headers = new Headers(init.headers);
    if (!headers.has('Content-Type') && init.body !== undefined) {
      headers.set('Content-Type', 'application/json');
    }
    const res = await fetch(path, {
      ...init,
      headers,
      // Cookies are the source of truth — `credentials: 'include'` lets
      // the browser send tx_push_session on every API call.
      credentials: 'include',
    });
    if (res.status === 401) {
      // Session vanished server-side (expired / revoked). Clear local
      // state so the router guard bounces to /login on next navigation.
      user.value = null;
      const err: ApiError = new Error('Unauthorized — please log in again');
      err.status = 401;
      throw err;
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

  return {
    get: <T = unknown>(path: string) => request<T>(path),
    post: <T = unknown>(path: string, body: unknown) =>
      request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
    patch: <T = unknown>(path: string, body: unknown) =>
      request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
    del: <T = unknown>(path: string) => request<T>(path, { method: 'DELETE' }),
  };
}
