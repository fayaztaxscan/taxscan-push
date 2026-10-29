/* Taxscan Push — STAFF notification worker (digest task 14)
 *
 * Registered only by the admin SPA on push.taxscan.in, as /admin/sw-staff.js with
 * scope /admin/, when a staff member taps "Notify me on this device". It shows the
 * digest's approval notifications and opens the Digests screen when tapped.
 *
 * It is NOT the reader worker: public/sw.js (copied onto www.taxscan.in by the
 * CMS) is untouched, and readers never load this file. No click tracking, no
 * fetch handler (the admin's requests are never intercepted). Its own scope means
 * its push subscription is separate from the "Test on this device" one (/sw.js,
 * scope /).
 */

const ADMIN_PREFIX = self.location.origin + '/admin/';
const DIGESTS_URL = ADMIN_PREFIX + 'digests';
const ICON = self.location.origin + '/brand/taxscan-icon-192.png';
// The status-bar badge: the white "T" (the colour logo is a solid blob at 24 px).
const BADGE = self.location.origin + '/brand/taxscan-badge-96.png';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

/**
 * Only ever opens a page of THIS admin: the link's /admin/… path on the worker's own
 * origin (the server may name another host for the same app, e.g. APP_BASE_URL);
 * anything else falls back to the Digests screen.
 */
function safeAdminUrl(url) {
  try {
    const u = new URL(url, self.location.origin);
    return u.pathname.startsWith('/admin/') ? self.location.origin + u.pathname + u.search : DIGESTS_URL;
  } catch (_) {
    return DIGESTS_URL;
  }
}

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_) {
    payload = { title: 'Taxscan digest', body: event.data ? event.data.text() : '' };
  }
  const tag = payload.tag || 'taxscan-digest';
  const options = {
    body: payload.body || '',
    icon: payload.icon || ICON,
    badge: payload.badge || BADGE,
    // One tag per run date: the 08:30 reminder replaces the 06:30 notification…
    tag,
    // …and still alerts the person again.
    renotify: payload.renotify !== false,
    data: { url: safeAdminUrl(payload.url || DIGESTS_URL) },
  };
  event.waitUntil(self.registration.showNotification(payload.title || 'Taxscan digest', options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = safeAdminUrl((event.notification.data || {}).url || DIGESTS_URL);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      // An admin tab already open: bring it forward, then take it to the Digests screen.
      const tab = windows.find((c) => c.url.startsWith(ADMIN_PREFIX));
      if (tab) {
        const focused = 'focus' in tab ? await tab.focus() : tab;
        if (tab.url !== url && 'navigate' in tab) {
          try {
            await tab.navigate(url);
          } catch (_) {
            /* not controlled by this worker yet: it is focused, which is enough */
          }
        }
        return focused;
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
      return undefined;
    })(),
  );
});

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; ++i) out[i] = raw.charCodeAt(i);
  return out;
}

// The browser rotated this device's subscription: subscribe again and tell the
// server (with the old endpoint, so the stale row goes). Needs the staff member's
// session cookie; without one the old row is pruned at the next send (404/410).
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const status = await fetch(self.location.origin + '/api/staff-push/status', { credentials: 'same-origin' }).then((r) =>
          r.ok ? r.json() : null,
        );
        if (!status || !status.vapidPublicKey) return;
        const sub = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(status.vapidPublicKey),
        });
        const old = event.oldSubscription ? event.oldSubscription.endpoint : undefined;
        await fetch(self.location.origin + '/api/staff-push/devices', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subscription: sub.toJSON(), ...(old ? { replacesEndpoint: old } : {}) }),
        });
      } catch (_) {
        /* best effort */
      }
    })(),
  );
});
