/* Taxscan Web Push — client SDK
 *
 * Usage:
 *   <script>window.TAXSCAN_PUSH_CONFIG = { apiBase: 'https://push.taxscan.in' };</script>
 *   <script src="https://push.taxscan.in/taxscan-push.js" defer></script>
 *
 * If apiBase is not set, the SDK uses the script's current origin.
 */
(function () {
  'use strict';

  if (
    !('serviceWorker' in navigator) ||
    !('PushManager' in window) ||
    !('Notification' in window) ||
    typeof Notification.requestPermission !== 'function'
  ) {
    return;
  }

  var defaults = {
    apiBase: window.location.origin,
    swPath: '/sw.js',
    portal: 'taxscan',
    dismissDays: 7,
    scrollThreshold: 0.5,
    dwellMs: 30000,
    secondPageDelayMs: 2000,
    // Prompt v2 only: on a reader's FIRST page (most arrive from Google/Discover
    // on one article and leave), ask only after real engagement.
    landingScrollThreshold: 0.6,
    landingDwellMs: 45000,
    // When true, after registering our own SW we unregister any OTHER
    // service worker the page has (e.g. iZooto's). Leave false during the
    // parallel-run cutover phase so both push systems coexist; flip to true
    // when this system becomes the only sender. See README "Cutover from iZooto".
    cutoverMode: false,
  };
  var cfg = Object.assign({}, defaults, window.TAXSCAN_PUSH_CONFIG || {});
  if (!cfg.apiBase) cfg.apiBase = window.location.origin;

  // Display label -> slug used by the RSS pipeline and /api/send topic targets.
  // `defaultChecked: true` items are ticked when the prompt first renders;
  // "All news" is the default opt-in so new subscribers receive every campaign
  // until they refine. Topic-specific items override "All news" subscribers'
  // reach automatically since the backend folds 'all' into every topic dispatch.
  var TOPIC_OPTIONS = [
    { label: 'All news', slug: 'all', defaultChecked: true },
    { label: 'GST', slug: 'gst' },
    { label: 'Income Tax', slug: 'income-tax' },
    { label: 'Customs', slug: 'customs' },
    { label: 'Corporate', slug: 'corporate' },
  ];

  var registration = null;
  var vapidKey = null;
  var promptShown = false;
  // 'v1' = original prompt (topic chips, never on a first page); 'v2' = yes/no,
  // may appear on a first page after engagement. Chosen server-side
  // (SOFT_PROMPT_V2 → /api/config) so it can be switched without touching the site.
  var promptVariant = 'v1';
  var promptLanding = false;

  /* ---------------- helpers ---------------- */

  function post(path, body) {
    return fetch(cfg.apiBase + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).catch(function () {});
  }

  function track(type, extra) {
    return post('/api/track', Object.assign({ type: type }, extra || {}));
  }

  function deviceClass() {
    try {
      if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) return 'mobile';
    } catch (_) {}
    return (window.innerWidth || 1024) <= 720 ? 'mobile' : 'desktop';
  }

  // Every soft-prompt funnel event carries the same small context, so the
  // losing step can be split by phone/desktop, first page or not, and variant.
  function trackPrompt(type, extra) {
    var meta = Object.assign(
      { device: deviceClass(), landing: promptLanding, variant: promptVariant },
      extra || {},
    );
    return track(type, { meta: meta });
  }

  function urlBase64ToUint8Array(base64String) {
    var padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(base64);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; ++i) out[i] = raw.charCodeAt(i);
    return out;
  }

  function bytesEqual(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function loadDismissed() {
    try {
      var raw = localStorage.getItem('txn_push_dismissed');
      if (!raw) return null;
      var data = JSON.parse(raw);
      if (data && typeof data.until === 'number' && data.until > Date.now()) return data;
      localStorage.removeItem('txn_push_dismissed');
    } catch (_) {}
    return null;
  }

  function setDismissed() {
    try {
      localStorage.setItem(
        'txn_push_dismissed',
        JSON.stringify({ until: Date.now() + cfg.dismissDays * 86400000 }),
      );
    } catch (_) {}
  }

  function loadStoredTopics() {
    try {
      var raw = localStorage.getItem('txn_push_topics');
      if (!raw) return null;
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : null;
    } catch (_) {
      return null;
    }
  }

  function storeTopics(slugs) {
    try {
      localStorage.setItem('txn_push_topics', JSON.stringify(slugs));
    } catch (_) {}
  }

  function pageCount() {
    var n;
    try {
      n = parseInt(sessionStorage.getItem('txn_push_pages') || '0', 10);
    } catch (_) {
      n = 0;
    }
    n = isFinite(n) ? n + 1 : 1;
    try {
      sessionStorage.setItem('txn_push_pages', String(n));
    } catch (_) {}
    return n;
  }

  /* ---------------- iZooto migration / recapture ---------------- */

  async function ensureSubscribedSilently(source, topics) {
    var ourKey = urlBase64ToUint8Array(vapidKey);
    var existing = await registration.pushManager.getSubscription();

    if (existing) {
      var k = existing.options && existing.options.applicationServerKey;
      if (k && bytesEqual(new Uint8Array(k), ourKey)) {
        // Already ours — no recapture needed. Don't churn the endpoint.
        return existing;
      }
      try {
        await existing.unsubscribe();
      } catch (_) {}
    }

    var sub = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: ourKey,
    });
    // Default-topics rule: a subscriber must never end up receiving nothing.
    // - Explicit non-empty topics win.
    // - Otherwise fall back to anything previously stored locally.
    // - Otherwise default to ['all'] so iZooto migrants on the recapture path
    //   automatically land on every campaign until they refine.
    var storedTopics = loadStoredTopics();
    var finalTopics =
      topics && topics.length > 0
        ? topics
        : storedTopics && storedTopics.length > 0
          ? storedTopics
          : ['all'];
    await post('/api/subscribe', {
      subscription: sub.toJSON(),
      portal: cfg.portal,
      topics: finalTopics,
      userAgent: navigator.userAgent,
      source: source,
    });
    return sub;
  }

  /* ---------------- soft prompt UI ---------------- */

  function injectStyles() {
    if (document.getElementById('txnpush-styles')) return;
    var css = [
      '.txnpush{position:fixed;left:0;right:0;bottom:0;z-index:2147483000;display:flex;justify-content:center;',
      'padding:16px;pointer-events:none;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;}',
      '.txnpush-card{pointer-events:auto;width:100%;max-width:440px;background:#fff;color:#0b2545;border:1px solid #e1e4e8;',
      'border-radius:14px;box-shadow:0 12px 32px rgba(11,37,69,.18);padding:18px 18px 14px;position:relative;',
      'transform:translateY(120%);transition:transform .22s ease;}',
      '.txnpush.is-in .txnpush-card{transform:translateY(0);}',
      '.txnpush-x{position:absolute;top:6px;right:8px;border:0;background:transparent;font-size:22px;line-height:1;',
      'color:#9aa4b2;cursor:pointer;padding:6px 10px;}',
      '.txnpush-x:focus{outline:2px solid #0b2545;border-radius:6px;}',
      '.txnpush-head{font-size:16px;font-weight:700;margin:0 0 4px;padding-right:28px;}',
      '.txnpush-sub{font-size:13px;color:#475569;margin:0 0 12px;}',
      '.txnpush-topics{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 14px;}',
      '.txnpush-topic{display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border:1px solid #cbd5e1;',
      'background:#f8fafc;border-radius:999px;font-size:12px;color:#334155;cursor:pointer;}',
      '.txnpush-topic input{margin:0;}',
      '.txnpush-topic:focus-within{outline:2px solid #0b2545;}',
      '.txnpush-actions{display:flex;justify-content:flex-end;gap:10px;align-items:center;}',
      '.txnpush-no{border:0;background:transparent;color:#64748b;font-size:13px;cursor:pointer;padding:8px;}',
      '.txnpush-no:focus,.txnpush-yes:focus{outline:2px solid #0b2545;outline-offset:2px;}',
      '.txnpush-yes{border:0;background:#0b2545;color:#fff;font-size:13px;font-weight:600;border-radius:8px;',
      'padding:9px 16px;cursor:pointer;}',
      '.txnpush-yes:hover{background:#13315c;}',
      '@media (max-width:480px){.txnpush-card{max-width:none;}}',
    ].join('');
    var style = document.createElement('style');
    style.id = 'txnpush-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function showSoftPrompt(trigger) {
    if (promptShown) return;
    promptShown = true;
    var shownTrigger = trigger || 'manual';
    trackPrompt('PROMPT_SHOWN', { trigger: shownTrigger });
    injectStyles();
    var simple = promptVariant === 'v2';

    var titleId = 'txnpush-title-' + Date.now();
    var descId = 'txnpush-desc-' + Date.now();
    var selected = {};
    TOPIC_OPTIONS.forEach(function (t) {
      selected[t.slug] = !!t.defaultChecked;
    });

    var wrap = document.createElement('div');
    wrap.className = 'txnpush';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-labelledby', titleId);
    wrap.setAttribute('aria-describedby', descId);

    // v2 drops the topic chips: ~70% of subscribers kept the default "All news"
    // and most of the rest ticked "All news" plus topics, which changes nothing.
    var topicsHtml = simple ? '' : TOPIC_OPTIONS.map(function (t, i) {
      return (
        '<label class="txnpush-topic">' +
        '<input type="checkbox" data-slug="' +
        t.slug +
        '"' +
        (t.defaultChecked ? ' checked' : '') +
        ' aria-label="' +
        t.label +
        '" data-i="' +
        i +
        '">' +
        t.label +
        '</label>'
      );
    }).join('');

    wrap.innerHTML =
      '<div class="txnpush-card">' +
      '<button type="button" class="txnpush-x" aria-label="Dismiss">&times;</button>' +
      '<h2 class="txnpush-head" id="' +
      titleId +
      '">' +
      (simple
        ? 'Be first to know about new tax rulings'
        : 'Get notified of new GST &amp; Income Tax rulings?') +
      '</h2>' +
      '<p class="txnpush-sub" id="' +
      descId +
      '">' +
      // v2 copy approved 2026-10-15 (option A). Volume is stated because it is
      // real: ~21 pushes/day, none 23:00–07:00 (0 of 1,257 in the prior 60 days).
      (simple
        ? 'Supreme Court and High Court rulings as they’re published. About 20 a day, never at night.'
        : 'Pick the topics you care about. You can change this anytime.') +
      '</p>' +
      (simple
        ? ''
        : '<div class="txnpush-topics" role="group" aria-label="Notification topics">' +
          topicsHtml +
          '</div>') +
      '<div class="txnpush-actions">' +
      '<button type="button" class="txnpush-no">No thanks</button>' +
      '<button type="button" class="txnpush-yes">' +
      (simple ? 'Turn on alerts' : 'Allow notifications') +
      '</button>' +
      '</div>' +
      '</div>';

    document.body.appendChild(wrap);
    requestAnimationFrame(function () {
      wrap.classList.add('is-in');
    });

    var yesBtn = wrap.querySelector('.txnpush-yes');
    var noBtn = wrap.querySelector('.txnpush-no');
    var xBtn = wrap.querySelector('.txnpush-x');

    function close() {
      wrap.classList.remove('is-in');
      document.removeEventListener('keydown', onKey);
      setTimeout(function () {
        if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      }, 220);
    }

    // Product decision: Escape, × close, and No thanks ALL persist the 7-day
    // dismissed flag. Consistency over leniency — three "no" actions, one outcome.
    function dismiss(how) {
      trackPrompt('PROMPT_DECLINED', { trigger: shownTrigger, how: how });
      setDismissed();
      close();
    }

    function getFocusables() {
      var nodes = wrap.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      return Array.prototype.slice.call(nodes).filter(function (el) {
        return !el.disabled && el.offsetParent !== null;
      });
    }

    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        dismiss('escape');
        return;
      }
      if (e.key !== 'Tab') return;
      var focusables = getFocusables();
      if (focusables.length === 0) return;
      // Fully manage Tab inside the banner: always preventDefault and move focus
      // to the next/previous focusable. Relying on the browser's natural Tab to
      // stay inside the wrap leaks at boundaries in some Chrome builds.
      e.preventDefault();
      var active = document.activeElement;
      var idx = focusables.indexOf(active);
      if (idx === -1) {
        focusables[0].focus();
        return;
      }
      var nextIdx = e.shiftKey
        ? (idx - 1 + focusables.length) % focusables.length
        : (idx + 1) % focusables.length;
      focusables[nextIdx].focus();
    }

    xBtn.addEventListener('click', function () {
      dismiss('close');
    });
    noBtn.addEventListener('click', function () {
      dismiss('no');
    });
    document.addEventListener('keydown', onKey);

    wrap.querySelectorAll('input[type="checkbox"]').forEach(function (cb) {
      cb.addEventListener('change', function () {
        selected[cb.getAttribute('data-slug')] = cb.checked;
      });
    });

    yesBtn.addEventListener('click', async function () {
      var slugs = Object.keys(selected).filter(function (s) {
        return selected[s];
      });
      // If the user unchecks every box, default them to 'all' so they receive
      // something instead of nothing. Backend has the same safety net.
      if (slugs.length === 0) slugs = ['all'];
      storeTopics(slugs);
      close();
      trackPrompt('PROMPT_ALLOW_CLICKED', { trigger: shownTrigger });
      try {
        var perm = await Notification.requestPermission();
        if (perm === 'granted') {
          trackPrompt('PROMPT_ACCEPTED', { trigger: shownTrigger });
          await ensureSubscribedSilently('soft-prompt', slugs);
        } else {
          // 'denied' = blocked in the browser's own prompt; 'default' = closed
          // or ignored it (also what Chrome's quiet bell-icon prompt yields).
          trackPrompt(perm === 'denied' ? 'PROMPT_BLOCKED' : 'PROMPT_IGNORED', { trigger: shownTrigger });
          setDismissed();
        }
      } catch (_) {
        setDismissed();
      }
    });

    // Focus management.
    setTimeout(function () {
      yesBtn.focus();
    }, 0);
  }

  /* ---------------- engagement gating ---------------- */

  /**
   * When the prompt may appear, as data (pure — unit-tested). A later page of a
   * visit: 2 s after load, after 30 s, or at 50% scroll (both variants). A
   * first page: never in v1; in v2 only after real engagement — 60% scroll or
   * 45 s on the page.
   */
  function promptTriggers(isLanding, variant) {
    if (isLanding) {
      if (variant !== 'v2') return [];
      return [
        { kind: 'dwell', ms: cfg.landingDwellMs },
        { kind: 'scroll', ratio: cfg.landingScrollThreshold },
      ];
    }
    return [
      { kind: 'second-page', ms: cfg.secondPageDelayMs },
      { kind: 'dwell', ms: cfg.dwellMs },
      { kind: 'scroll', ratio: cfg.scrollThreshold },
    ];
  }

  function armSoftPrompt(isLanding) {
    if (loadDismissed()) return;
    if (Notification.permission !== 'default') return;
    promptLanding = isLanding;

    promptTriggers(isLanding, promptVariant).forEach(function (t) {
      if (t.kind === 'scroll') {
        var onScroll = function () {
          var h = document.documentElement;
          var max = h.scrollHeight - h.clientHeight;
          if (max <= 0) return;
          var ratio = (h.scrollTop || document.body.scrollTop || 0) / max;
          if (ratio >= t.ratio) {
            window.removeEventListener('scroll', onScroll);
            maybeShow('scroll');
          }
        };
        window.addEventListener('scroll', onScroll, { passive: true });
      } else {
        setTimeout(function () {
          maybeShow(t.kind);
        }, t.ms);
      }
    });
  }

  function maybeShow(trigger) {
    if (promptShown) return;
    if (loadDismissed()) return;
    if (Notification.permission !== 'default') return;
    showSoftPrompt(trigger);
  }

  /* ---------------- cutover: unregister iZooto's service worker ---------------- */

  // Pure predicate: does a service-worker scriptURL belong to iZooto?
  // Match by HOST (cdn.izooto.com or any *.izooto.com), then fall back to a
  // case-insensitive substring check on the raw URL for safety. This must NEVER
  // match the site's own PWA worker (e.g. https://www.taxscan.in/service-worker.js)
  // or our worker (cfg.swPath on the page origin).
  function isIzootoWorker(scriptURL) {
    if (!scriptURL || typeof scriptURL !== 'string') return false;
    try {
      var u = new URL(scriptURL);
      if (u.host === 'cdn.izooto.com') return true;
      if (/(^|\.)izooto\.com$/i.test(u.host)) return true;
    } catch (_) {
      /* relative URL or malformed — fall through to substring check */
    }
    return /izooto/i.test(scriptURL);
  }

  // When cutoverMode is on, walk every SW registration the page has and
  // unregister ONLY iZooto's worker (identified by host: cdn.izooto.com /
  // *.izooto.com, or substring 'izooto'). Never unregister on a "not ours"
  // basis — that would also kill the site's own PWA worker. Each registration
  // is inspected across its active/installing/waiting scriptURL; if any of
  // those is iZooto's, that registration is unregistered.
  async function maybeUnregisterForeignWorkers() {
    if (!cfg.cutoverMode) return;
    try {
      var regs = await navigator.serviceWorker.getRegistrations();
      for (var i = 0; i < regs.length; i++) {
        var reg = regs[i];
        var urls = [
          reg.active && reg.active.scriptURL,
          reg.installing && reg.installing.scriptURL,
          reg.waiting && reg.waiting.scriptURL,
        ];
        var matchedUrl = null;
        for (var j = 0; j < urls.length; j++) {
          if (isIzootoWorker(urls[j])) {
            matchedUrl = urls[j];
            break;
          }
        }
        if (!matchedUrl) continue;
        try {
          await reg.unregister();
          // eslint-disable-next-line no-console
          console.log('[taxscan-push] unregistered iZooto service worker:', matchedUrl);
        } catch (_) {
          /* best-effort */
        }
      }
    } catch (_) {
      /* getRegistrations failure: nothing to do */
    }
  }

  /* ---------------- boot ---------------- */

  async function init() {
    var visits = pageCount();
    var isLanding = visits === 1;

    try {
      registration = await navigator.serviceWorker.register(
        cfg.swPath + '?api=' + encodeURIComponent(cfg.apiBase),
      );
      await navigator.serviceWorker.ready;
    } catch (_) {
      return;
    }

    // After OUR worker is live, optionally unregister iZooto's (or any other).
    await maybeUnregisterForeignWorkers();

    try {
      var cfgRes = await fetch(cfg.apiBase + '/api/config');
      var serverCfg = await cfgRes.json();
      vapidKey = serverCfg.vapidPublicKey;
      promptVariant = serverCfg.promptVariant === 'v2' ? 'v2' : 'v1';
    } catch (_) {
      return;
    }
    if (!vapidKey) return;

    var perm = Notification.permission;
    if (perm === 'granted') {
      // iZooto migration / recapture path. No prompt.
      await ensureSubscribedSilently('recapture').catch(function () {});
    } else if (perm === 'default') {
      armSoftPrompt(isLanding);
    }
    // 'denied' -> respect the user's choice.
  }

  // Expose a tiny debug API for the demo page.
  window.TaxscanPush = {
    resetDismissed: function () {
      try {
        localStorage.removeItem('txn_push_dismissed');
      } catch (_) {}
    },
    resetPageCounter: function () {
      try {
        sessionStorage.removeItem('txn_push_pages');
      } catch (_) {}
    },
    showPromptNow: function () {
      promptShown = false;
      showSoftPrompt('manual');
    },
    getState: async function () {
      var perm = Notification.permission;
      var sub = registration ? await registration.pushManager.getSubscription() : null;
      return {
        permission: perm,
        registered: !!registration,
        endpoint: sub ? sub.endpoint : null,
        topics: loadStoredTopics() || [],
        dismissed: loadDismissed(),
        pagesThisSession: parseInt(sessionStorage.getItem('txn_push_pages') || '0', 10),
      };
    },
  };

  // Test hook: when window.__TAXSCAN_PUSH_TESTS_ENABLE__ is set BEFORE this
  // script runs, expose internals for unit tests and skip auto-init. Production
  // pages never set that flag, so this is inert at runtime.
  if (window.__TAXSCAN_PUSH_TESTS_ENABLE__) {
    window.__taxscanPushTest__ = {
      isIzootoWorker: isIzootoWorker,
      maybeUnregisterForeignWorkers: maybeUnregisterForeignWorkers,
      promptTriggers: promptTriggers,
      cfg: cfg,
    };
    return;
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    init();
  } else {
    window.addEventListener('DOMContentLoaded', init);
  }
})();
