import { useAuth } from './useAuth';

export type ApiError = Error & { status?: number; body?: unknown };

export function useApi() {
  const { token, logout } = useAuth();

  async function request<T = unknown>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('Content-Type', 'application/json');
    if (token.value) headers.set('Authorization', `Bearer ${token.value}`);
    const res = await fetch(path, { ...init, headers });
    if (res.status === 401) {
      logout();
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
  };
}
