import { computed, ref } from 'vue';

export type UserSummary = {
  id: string;
  email: string;
  role: 'ADMIN' | 'PUBLISHER';
  passwordResetRequired: boolean;
  lastLoginAt: string | null;
};

export class AuthError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// Module-scope refs — every component that calls useAuth() shares the
// same reactive user state, no provide/inject plumbing needed.
const user = ref<UserSummary | null>(null);
// `ready` flips to true once the first GET /api/auth/me round trip has
// finished. The router guard awaits this on the initial navigation so it
// doesn't redirect to /login on a hard refresh while the cookie is still
// being validated.
const ready = ref(false);
let inFlightCheck: Promise<void> | null = null;

export function useAuth() {
  const isAuthed = computed(() => !!user.value);

  async function checkSession(): Promise<void> {
    if (inFlightCheck) return inFlightCheck;
    inFlightCheck = (async () => {
      try {
        const res = await fetch('/api/auth/me', { credentials: 'include' });
        if (res.ok) {
          user.value = (await res.json()) as UserSummary;
        } else {
          user.value = null;
        }
      } catch {
        user.value = null;
      } finally {
        ready.value = true;
        inFlightCheck = null;
      }
    })();
    return inFlightCheck;
  }

  async function login(email: string, password: string): Promise<void> {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (res.status === 401) {
      throw new AuthError(401, 'Incorrect email or password');
    }
    if (res.status === 423) {
      throw new AuthError(423, 'Too many attempts. Try again in 15 minutes.');
    }
    if (res.status === 429) {
      throw new AuthError(429, 'Too many login attempts from this device. Try again shortly.');
    }
    if (!res.ok) {
      throw new AuthError(res.status, 'Login failed. Please try again.');
    }
    const data = await res.json();
    user.value = data.user as UserSummary;
    ready.value = true;
  }

  async function logout(): Promise<void> {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
      });
    } catch {
      // best-effort; clearing local state below is what matters
    }
    user.value = null;
  }

  async function changePassword(
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const res = await fetch('/api/auth/change-password', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    if (res.status === 401) {
      throw new AuthError(401, 'Current password is incorrect');
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const message =
        (body && typeof body === 'object' && 'message' in body && typeof body.message === 'string')
          ? body.message
          : 'Password change failed';
      throw new AuthError(res.status, message);
    }
    if (user.value) {
      user.value.passwordResetRequired = false;
    }
  }

  return { user, isAuthed, ready, checkSession, login, logout, changePassword };
}
