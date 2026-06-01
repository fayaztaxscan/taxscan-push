/* Taxscan Web Push — service worker
 *
 * Registered by taxscan-push.js as `/sw.js?api=<API_BASE>`. The api param lets
 * the SW reach a cross-origin backend (e.g. api.taxscan.in) in Phase 2; if it
 * is absent we fall back to the SW's own origin.
 */

const API_BASE = (() => {
  try {
    return new URL(self.location.href).searchParams.get('api') || self.location.origin;
  } catch (_) {
    return self.location.origin;
  }
})();

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; ++i) output[i] = raw.charCodeAt(i);
  return output;
}

function postJSON(path, body) {
  return fetch(API_BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).catch(() => undefined);
}

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_) {
    payload = { title: 'Taxscan', body: event.data ? event.data.text() : '' };
  }

  const title = payload.title || 'Taxscan';
  const options = {
    body: payload.body || '',
    icon: payload.icon || '/icon-192.png',
    badge: payload.badge || '/icon-192.png',
    tag: payload.tag || payload.campaignId || undefined,
    renotify: false,
    data: {
      url: payload.url || '/',
      campaignId: payload.campaignId || null,
    },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = data.url || '/';

  event.waitUntil(
    (async () => {
      try {
        const sub = await self.registration.pushManager.getSubscription();
        await postJSON('/api/track', {
          type: 'CLICKED',
          endpoint: sub ? sub.endpoint : undefined,
          campaignId: data.campaignId || undefined,
        });
      } catch (_) {
        /* tracking is best-effort */
      }

      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clients) {
        if (client.url === url && 'focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })(),
  );
});

self.addEventListener('notificationclose', (event) => {
  const data = event.notification.data || {};
  event.waitUntil(
    (async () => {
      try {
        const sub = await self.registration.pushManager.getSubscription();
        await postJSON('/api/track', {
          type: 'DISMISSED',
          endpoint: sub ? sub.endpoint : undefined,
          campaignId: data.campaignId || undefined,
        });
      } catch (_) {
        /* ignore */
      }
    })(),
  );
});

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const cfg = await fetch(API_BASE + '/api/config').then((r) => r.json());
        if (!cfg || !cfg.vapidPublicKey) return;
        const sub = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(cfg.vapidPublicKey),
        });
        await postJSON('/api/subscribe', {
          subscription: sub.toJSON(),
          portal: 'taxscan',
          source: 'pushsubscriptionchange',
        });
      } catch (_) {
        /* ignore */
      }
    })(),
  );
});
