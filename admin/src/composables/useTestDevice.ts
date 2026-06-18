import { ref } from 'vue';
import { apiErrorMessage, useApi } from './useApi';

/** VAPID public key (URL-safe base64) → Uint8Array for pushManager.subscribe. */
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

export type TestDevicePayload = { title: string; body: string; url: string; icon?: string };

/**
 * "Test on this device" — subscribes the current admin's own browser to push
 * and previews a composed notification to ONLY that device (POST
 * /api/send/test-device). Nothing reaches real subscribers.
 */
export function useTestDevice() {
  const api = useApi();
  const supported =
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window;

  const permission = ref<NotificationPermission>(supported ? Notification.permission : 'denied');
  const ready = ref(false);
  const busy = ref(false);
  const error = ref<string | null>(null);
  let subscription: PushSubscriptionJSON | null = null;

  function hasKeys(s: PushSubscriptionJSON | null): boolean {
    return Boolean(s?.endpoint && s.keys?.p256dh && s.keys?.auth);
  }

  async function refresh(): Promise<void> {
    if (!supported) return;
    permission.value = Notification.permission;
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      subscription = sub ? sub.toJSON() : null;
      ready.value = hasKeys(subscription) && permission.value === 'granted';
    } catch {
      /* treat as not set up */
    }
  }

  async function enable(): Promise<void> {
    error.value = null;
    busy.value = true;
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      const perm = await Notification.requestPermission();
      permission.value = perm;
      if (perm !== 'granted') {
        error.value =
          'Notifications are blocked for this site. Allow them in your browser settings, then try again.';
        return;
      }
      const cfg = await fetch('/api/config', { credentials: 'include' }).then((r) => r.json());
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(cfg.vapidPublicKey),
      });
      subscription = sub.toJSON();
      ready.value = hasKeys(subscription);
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      busy.value = false;
    }
  }

  async function sendTest(payload: TestDevicePayload): Promise<void> {
    error.value = null;
    if (!hasKeys(subscription)) await refresh();
    if (!hasKeys(subscription)) {
      error.value = 'Enable test notifications on this device first.';
      throw new Error(error.value);
    }
    busy.value = true;
    try {
      await api.post('/api/send/test-device', {
        subscription: { endpoint: subscription!.endpoint, keys: subscription!.keys },
        ...payload,
      });
    } catch (e) {
      error.value = apiErrorMessage(e);
      throw e;
    } finally {
      busy.value = false;
    }
  }

  return { supported, permission, ready, busy, error, refresh, enable, sendTest };
}
