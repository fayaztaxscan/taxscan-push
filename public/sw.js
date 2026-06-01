/* =====================================================================
 * Taxscan Web Push — service worker (sw.js)
 * Serve this file from the ROOT of taxscan.in over HTTPS:
 *   https://www.taxscan.in/sw.js
 * (Your vendor installs it the same way iZooto's worker was installed.)
 *
 * Replace the two placeholders below at deploy time.
 * ===================================================================== */

const API_BASE = '__API_BASE__';            // e.g. 'https://push.taxscan.in'  (your backend)
const VAPID_PUBLIC_KEY = '__VAPID_PUBLIC_KEY__'; // your VAPID PUBLIC key (Strategy A: fresh key)

/* Activate the new worker immediately so cut-over is fast. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

/* ---------- Receive & display a push ---------- */
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    payload = { title: 'Taxscan', body: event.data ? event.data.text() : '' };
  }

  const title = payload.title || 'Taxscan';
  const options = {
    body: payload.body || '',
    icon: payload.icon || 'https://www.taxscan.in/images/logo.png',
    badge: payload.badge || 'https://www.taxscan.in/images/logo.png',
    image: payload.image || undefined,
    // `tag` collapses duplicates; use the campaign id so the same article never stacks.
    tag: payload.tag || payload.campaignId || undefined,
    renotify: !!payload.tag,
    requireInteraction: !!payload.breaking, // breaking news stays until tapped
    data: {
      url: payload.url || 'https://www.taxscan.in/',
      campaignId: payload.campaignId || null
    },
    actions: payload.actions || [{ action: 'open', title: 'Read' }]
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

/* ---------- Click: record it, then open/focus the article ---------- */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = data.url || 'https://www.taxscan.in/';

  event.waitUntil((async () => {
    try {
      const sub = await self.registration.pushManager.getSubscription();
      await fetch(API_BASE + '/api/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'CLICKED',
          endpoint: sub ? sub.endpoint : null,
          campaignId: data.campaignId
        })
      });
    } catch (e) { /* tracking is best-effort */ }

    // Focus an already-open tab on the same URL, else open a new one.
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientList) {
      if (client.url === url && 'focus' in client) return client.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});

/* ---------- Dismiss tracking (optional, useful for analytics) ---------- */
self.addEventListener('notificationclose', (event) => {
  const data = event.notification.data || {};
  event.waitUntil((async () => {
    try {
      const sub = await self.registration.pushManager.getSubscription();
      await fetch(API_BASE + '/api/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'DISMISSED',
          endpoint: sub ? sub.endpoint : null,
          campaignId: data.campaignId
        })
      });
    } catch (e) { /* ignore */ }
  })());
});

/* ---------- Re-subscribe automatically if the subscription expires ---------- */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    try {
      const sub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
      });
      await fetch(API_BASE + '/api/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub, portal: 'taxscan', source: 'resubscribe' })
      });
    } catch (e) { /* ignore */ }
  })());
});

/* ---------- helper ---------- */
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; ++i) output[i] = raw.charCodeAt(i);
  return output;
}
