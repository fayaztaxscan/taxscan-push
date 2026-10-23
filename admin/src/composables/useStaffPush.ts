import { ref } from 'vue';
import { apiErrorMessage, useApi } from './useApi';

/**
 * "Notify me on this device" (digest task 14): this browser's own staff push
 * subscription, through the staff worker /admin/sw-staff.js (scope /admin/).
 * Separate from "Test on this device" (/sw.js, scope /) and from readers.
 *
 * The native permission prompt is asked for ONLY inside `enable()`, which the
 * screen calls from the button tap — that tap is the soft prompt.
 */

export type StaffPushState = 'checking' | 'unsupported' | 'ios-home-screen' | 'blocked' | 'off' | 'on';

const STAFF_SW = '/admin/sw-staff.js';
const STAFF_SCOPE = '/admin/';

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

/** iPhone / iPad (iPadOS reports itself as a Mac with a touch screen). */
export function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/** Opened from the Home Screen (iOS web push works only there). */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches === true;
}

function pushSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/** The staff worker's registration (exact scope — /sw.js at scope / also "matches" /admin/). */
async function staffRegistration(): Promise<ServiceWorkerRegistration | null> {
  const want = new URL(STAFF_SCOPE, location.origin).href;
  const regs = await navigator.serviceWorker.getRegistrations();
  return regs.find((r) => r.scope === want) ?? null;
}

/** Resolves once the registration has an active worker (pushManager.subscribe needs one). */
export async function waitActive(reg: ServiceWorkerRegistration): Promise<void> {
  if (reg.active) return;
  const sw = reg.installing ?? reg.waiting;
  if (!sw) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      if (sw.state === 'activated' || sw.state === 'redundant') {
        sw.removeEventListener('statechange', done);
        resolve();
      }
    };
    sw.addEventListener('statechange', done);
    done();
  });
}

type Status = { sending: boolean; digestEnabled: boolean; staffPushEnabled: boolean; vapidPublicKey: string; devices: number };

export function useStaffPush() {
  const api = useApi();
  const state = ref<StaffPushState>('checking');
  const busy = ref(false);
  const error = ref<string | null>(null);
  const notice = ref<string | null>(null);
  const status = ref<Status | null>(null);

  async function currentSubscription(): Promise<PushSubscription | null> {
    const reg = await staffRegistration();
    return reg ? reg.pushManager.getSubscription() : null;
  }

  async function refresh(): Promise<void> {
    error.value = null;
    try {
      status.value = await api.get<Status>('/api/staff-push/status');
    } catch {
      status.value = null;
    }
    if (isIos() && !isStandalone()) {
      state.value = 'ios-home-screen';
      return;
    }
    if (!pushSupported()) {
      state.value = 'unsupported';
      return;
    }
    if (Notification.permission === 'denied') {
      state.value = 'blocked';
      return;
    }
    try {
      const sub = Notification.permission === 'granted' ? await currentSubscription() : null;
      if (!sub) {
        state.value = 'off';
        return;
      }
      // On only if the server still has it (an admin may have removed this device).
      const r = await api.post<{ on: boolean }>('/api/staff-push/devices/check', { endpoint: sub.endpoint });
      state.value = r.on ? 'on' : 'off';
    } catch {
      state.value = 'off';
    }
  }

  /** Called from the button tap only: the browser's own prompt appears here. */
  async function enable(): Promise<void> {
    error.value = null;
    notice.value = null;
    busy.value = true;
    try {
      // First, inside the tap: Safari asks only from a user gesture.
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        state.value = perm === 'denied' ? 'blocked' : 'off';
        if (perm !== 'denied') error.value = 'Notifications were not allowed. Tap the button again and choose Allow.';
        return;
      }
      const reg = await navigator.serviceWorker.register(STAFF_SW, { scope: STAFF_SCOPE });
      await waitActive(reg);
      const key = status.value?.vapidPublicKey || (await api.get<Status>('/api/staff-push/status')).vapidPublicKey;
      const appKey = urlBase64ToUint8Array(key);
      let sub = await reg.pushManager.getSubscription();
      if (sub) {
        // A subscription made for another key can't receive our pushes: start again.
        const have = sub.options?.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
        if (!have || have.length !== appKey.length || have.some((b, i) => b !== appKey[i])) {
          await sub.unsubscribe();
          sub = null;
        }
      }
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey });
      const json = sub.toJSON();
      await api.post('/api/staff-push/devices', { subscription: { endpoint: json.endpoint, keys: json.keys } });
      state.value = 'on';
      notice.value = 'Notifications are on for this device.';
      try {
        status.value = await api.get<Status>('/api/staff-push/status');
      } catch {
        /* the state above stands */
      }
    } catch (e) {
      error.value = apiErrorMessage(e);
    } finally {
      busy.value = false;
    }
  }

  async function disable(): Promise<void> {
    error.value = null;
    notice.value = null;
    busy.value = true;
    try {
      const sub = await currentSubscription();
      if (sub) {
        await api.post('/api/staff-push/devices/remove', { endpoint: sub.endpoint });
        await sub.unsubscribe().catch(() => false);
      }
      state.value = 'off';
      notice.value = 'Notifications are off for this device.';
    } catch (e) {
      error.value = apiErrorMessage(e);
    } finally {
      busy.value = false;
    }
  }

  async function sendTest(): Promise<void> {
    error.value = null;
    notice.value = null;
    busy.value = true;
    try {
      const sub = await currentSubscription();
      if (!sub) {
        state.value = 'off';
        return;
      }
      await api.post('/api/staff-push/devices/test', { endpoint: sub.endpoint });
      notice.value = 'Test sent. It should appear on this device in a few seconds.';
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 404 || status === 410) state.value = 'off';
      error.value = apiErrorMessage(e);
    } finally {
      busy.value = false;
    }
  }

  return { state, busy, error, notice, status, refresh, enable, disable, sendTest };
}
