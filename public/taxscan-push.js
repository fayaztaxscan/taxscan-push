/* =====================================================================
 * Taxscan Web Push — client SDK (taxscan-push.js)
 *
 * Load this on every page of taxscan.in via the CMS header script slot
 * (the same slot the iZooto snippet uses). Set config BEFORE this file:
 *
 *   <script>
 *     window.TAXSCAN_PUSH_CONFIG = { apiBase: 'https://push.taxscan.in' };
 *   </script>
 *   <script src="https://push.taxscan.in/taxscan-push.js" defer></script>
 *
 * What it does:
 *   - Registers /sw.js.
 *   - If permission is already GRANTED (your existing iZooto subscribers),
 *     it re-subscribes them SILENTLY under your keys — this is the migration.
 *   - If permission is DEFAULT, it shows a branded soft prompt on engagement,
 *     and only triggers the native browser prompt if the user opts in.
 * ===================================================================== */
(function () {
  'use strict';

  var cfg = Object.assign({
    apiBase: '',                       // REQUIRED
    swPath: '/sw.js',
    portal: 'taxscan',
    dismissDays: 14,                   // "Not now" snooze
    scrollThreshold: 0.5,              // show after 50% scroll
    dwellMs: 30000,                    // or after 30s on page
    requireSecondVisit: true,          // and only from the 2nd visit onward
    topics: ['GST', 'Income Tax', 'Customs', 'Corporate']
  }, window.TAXSCAN_PUSH_CONFIG || {});

  // Capability + config guards.
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;
  if (!cfg.apiBase) { console.warn('[taxscan-push] apiBase not configured'); return; }

  var vapidKey = null;
  var registration = null;

  /* ---------------- small helpers ---------------- */
  function post(path, body) {
    return fetch(cfg.apiBase + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).catch(function () {});
  }
  function track(type, extra) { return post('/api/track', Object.assign({ type: type, portal: cfg.portal }, extra || {})); }

  function getCookie(name) {
    return document.cookie.split('; ').reduce(function (acc, c) {
      var parts = c.split('=');
      return parts[0] === name ? decodeURIComponent(parts.slice(1).join('=')) : acc;
    }, '');
  }
  function setCookie(name, value, days) {
    var d = new Date();
    d.setTime(d.getTime() + days * 86400000);
    document.cookie = name + '=' + encodeURIComponent(value) + ';expires=' + d.toUTCString() + ';path=/;SameSite=Lax';
  }
  function getTopics() {
    try { return JSON.parse(localStorage.getItem('txn_push_topics') || 'null') || cfg.topics.slice(); }
    catch (e) { return cfg.topics.slice(); }
  }
  function urlBase64ToUint8Array(base64String) {
    var padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(base64);
    var output = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; ++i) output[i] = raw.charCodeAt(i);
    return output;
  }

  /* ---------------- core flow ---------------- */
  async function init() {
    try { registration = await navigator.serviceWorker.register(cfg.swPath); }
    catch (e) { return; }

    try {
      var res = await fetch(cfg.apiBase + '/api/config');
      vapidKey = (await res.json()).vapidPublicKey;
    } catch (e) { return; }
    if (!vapidKey) return;

    var perm = Notification.permission;
    if (perm === 'granted') {
      // Existing subscribers — including migrated iZooto users — captured silently, no prompt.
      await ensureSubscribed('recapture');
    } else if (perm === 'default') {
      armSoftPrompt();
    }
    // 'denied' -> respect the user's choice, do nothing.
  }

  async function ensureSubscribed(source) {
    try {
      var sub = await registration.pushManager.getSubscription();
      if (!sub) {
        sub = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidKey)
        });
      }
      await post('/api/subscribe', {
        subscription: sub,
        portal: cfg.portal,
        topics: getTopics(),
        userAgent: navigator.userAgent,
        source: source
      });
      return sub;
    } catch (e) { return null; }
  }

  /* ---------------- engagement gating ---------------- */
  function armSoftPrompt() {
    if (getCookie('txn_push_dismissed')) return;

    var visits = parseInt(getCookie('txn_push_visits') || '0', 10) + 1;
    setCookie('txn_push_visits', String(visits), 365);
    var visitOk = cfg.requireSecondVisit ? visits >= 2 : true;

    var fired = false;
    function fire() {
      if (fired) return;
      fired = true;
      window.removeEventListener('scroll', onScroll);
      if (visitOk) showSoftPrompt();
    }
    function onScroll() {
      var h = document.documentElement;
      var max = (h.scrollHeight - h.clientHeight) || 1;
      var ratio = (h.scrollTop || document.body.scrollTop) / max;
      if (ratio >= cfg.scrollThreshold) fire();
    }
    setTimeout(fire, cfg.dwellMs);
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  /* ---------------- soft prompt UI ---------------- */
  function showSoftPrompt() {
    track('PROMPT_SHOWN');
    injectStyles();

    var selected = {};
    getTopics().forEach(function (t) { selected[t] = true; });

    var wrap = document.createElement('div');
    wrap.className = 'txnpush';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-label', 'Notification opt-in');

    var chips = cfg.topics.map(function (t) {
      return '<button type="button" class="txnpush-chip is-on" data-topic="' + t + '" aria-pressed="true">' + t + '</button>';
    }).join('');

    wrap.innerHTML =
      '<div class="txnpush-card">' +
        '<button type="button" class="txnpush-x" aria-label="Dismiss">&times;</button>' +
        '<div class="txnpush-head">Get instant alerts on new rulings</div>' +
        '<div class="txnpush-sub">Judgments, circulars &amp; updates the moment we publish. Pick your topics:</div>' +
        '<div class="txnpush-chips">' + chips + '</div>' +
        '<div class="txnpush-actions">' +
          '<button type="button" class="txnpush-no">Not now</button>' +
          '<button type="button" class="txnpush-yes">Allow notifications</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(wrap);
    requestAnimationFrame(function () { wrap.classList.add('is-in'); });

    function close() { wrap.classList.remove('is-in'); setTimeout(function () { wrap.remove(); }, 200); }
    function dismiss() { setCookie('txn_push_dismissed', '1', cfg.dismissDays); close(); }

    wrap.querySelector('.txnpush-x').addEventListener('click', dismiss);
    wrap.querySelector('.txnpush-no').addEventListener('click', dismiss);
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { dismiss(); document.removeEventListener('keydown', esc); }
    });

    Array.prototype.forEach.call(wrap.querySelectorAll('.txnpush-chip'), function (chip) {
      chip.addEventListener('click', function () {
        var t = chip.getAttribute('data-topic');
        selected[t] = !selected[t];
        chip.classList.toggle('is-on', selected[t]);
        chip.setAttribute('aria-pressed', String(selected[t]));
      });
    });

    wrap.querySelector('.txnpush-yes').addEventListener('click', async function () {
      var topics = Object.keys(selected).filter(function (t) { return selected[t]; });
      try { localStorage.setItem('txn_push_topics', JSON.stringify(topics)); } catch (e) {}
      close();
      var p = await Notification.requestPermission(); // the real browser prompt
      if (p === 'granted') {
        track('PROMPT_ACCEPTED');
        await ensureSubscribed('prompt');
      }
      // If blocked, we never ask again (browser enforces this) — handled by permission state on next visit.
    });

    // Focus management for accessibility.
    wrap.querySelector('.txnpush-yes').focus();
  }

  function injectStyles() {
    if (document.getElementById('txnpush-styles')) return;
    var css =
      '.txnpush{position:fixed;left:0;right:0;bottom:0;z-index:2147483000;display:flex;justify-content:center;' +
        'padding:16px;pointer-events:none;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;}' +
      '.txnpush-card{pointer-events:auto;width:100%;max-width:440px;background:#fff;color:#0b2545;border:1px solid #e1e4e8;' +
        'border-radius:14px;box-shadow:0 12px 32px rgba(11,37,69,.18);padding:18px 18px 14px;position:relative;' +
        'transform:translateY(120%);transition:transform .22s ease;}' +
      '.txnpush.is-in .txnpush-card{transform:translateY(0);}' +
      '.txnpush-x{position:absolute;top:8px;right:10px;border:0;background:transparent;font-size:22px;line-height:1;' +
        'color:#9aa4b2;cursor:pointer;}' +
      '.txnpush-head{font-size:16px;font-weight:700;margin-bottom:4px;}' +
      '.txnpush-sub{font-size:13px;color:#475569;margin-bottom:12px;}' +
      '.txnpush-chips{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px;}' +
      '.txnpush-chip{border:1px solid #cbd5e1;background:#f8fafc;color:#334155;border-radius:999px;padding:5px 12px;' +
        'font-size:12px;cursor:pointer;}' +
      '.txnpush-chip.is-on{background:#0b2545;border-color:#0b2545;color:#fff;}' +
      '.txnpush-actions{display:flex;justify-content:flex-end;gap:10px;align-items:center;}' +
      '.txnpush-no{border:0;background:transparent;color:#64748b;font-size:13px;cursor:pointer;padding:8px;}' +
      '.txnpush-yes{border:0;background:#0b2545;color:#fff;font-size:13px;font-weight:600;border-radius:8px;' +
        'padding:9px 16px;cursor:pointer;}' +
      '.txnpush-yes:hover{background:#13315c;}' +
      '@media (max-width:480px){.txnpush-card{max-width:none;}}';
    var style = document.createElement('style');
    style.id = 'txnpush-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  /* ---------------- boot ---------------- */
  if (document.readyState === 'complete' || document.readyState === 'interactive') init();
  else window.addEventListener('DOMContentLoaded', init);
})();
