# iZooto State Check (Incognito / default permission) — taxscan.in

**Date / browser:** 2026-06-02 · Google Chrome (driven via Claude in Chrome). Run was performed in a fresh tab after the user reset Chrome's notification permission for taxscan.in — see "Permission state at start" for an important caveat about how Chrome reported permission afterward.

## Permission state at start

`Notification.permission === "denied"`.

⚠️ **Caveat:** the intent of this run was a clean **default** permission, and the user did reset the notification permission for taxscan.in in Chrome settings before the run. However the reset did not propagate to the live page state — JavaScript still reports `Notification.permission` as `"denied"` in this tab. (Chrome sometimes requires fully closing all tabs/windows for the origin, or a profile restart, before a reset takes effect on the JS-visible permission.)

This caveat **does not change the verdict** — the network log and SDK globals (below) prove that the iZooto SDK runs on every page load regardless of permission state. The only path that's actually gated by permission is the service-worker registration + push subscription (which is what a default→granted visitor would unlock). For a truly default-permission visitor, the same SDK loads, plus very likely the SW registration would also fire on first click of Allow.

## Verdict

**Confirmed State A — iZooto SDK loads and runs on every page visit for taxscan.in.** Independent confirmation by *three* fingerprints in the same run:

1. **3 external `<script>` srcs from `cdn.izooto.com`** are present in the document.
2. **7 network requests to `*.izooto.com`** (including a tracking pixel that explicitly identifies the visitor as "blocked").
3. **Multiple iZooto globals** initialised on `window`: `_izq`, `_izooto`, `izootoEmailSubcriptionCallBack`, `izootoEmailEventsCallback`.

The earlier denied-permission run reported "no iZooto SDK loaded" — that was a **timing artifact**: the SDK scripts load deferred/async after initial paint, and the earlier check ran before they finished. With a longer wait + a scroll this run captured the full load.

The **only** iZooto fingerprint missing in this run is the iZooto service worker registration — but that's because permission is denied (no SW = no subscription = no push). On a fresh profile where the visitor reaches the "Allow" click, iZooto would register its own SW (probably `cdn.izooto.com/<hash>/sw.js` or similar — see "Notes" for where to look) and create a push subscription against its FCM key.

## iZooto service worker scriptURL (EXACT string, if any)

**None registered in this run** — only the site's own service worker is registered:
`https://www.taxscan.in/service-worker.js`

(Reason it isn't registered yet: `Notification.permission === "denied"`. The iZooto SDK skips SW registration when permission is denied. For an Allow-clicking visitor, iZooto would register its own SW from `cdn.izooto.com` at that moment.)

## Check 1 — all SW registrations (scope + scriptURL)

| Scope | Active scriptURL |
|---|---|
| `https://www.taxscan.in/` (root) | `https://www.taxscan.in/service-worker.js` (the site's own PWA worker — single path segment, host matches page) |

Only this one. No iZooto worker, no other workers.

## Check 2 — iZooto SDK loaded? (script srcs, _izq, izooto globals)

| Probe | Result |
|---|---|
| `Array.from(document.scripts).map(s=>s.src).filter(s=>/izooto/i.test(s)).length` | **3** |
| Hosts of those iZooto scripts | `cdn.izooto.com` (all three) |
| `typeof window._izq` | `"object"` — `Array.isArray(_izq) === true`, `length === 0` (queue has been drained by the SDK) |
| `typeof window.izooto` | `"undefined"` — but see globals list below; the SDK uses `_izooto` (underscored) on this site, not `izooto` |
| Window globals matching `/izoo|^_iz/i` | **4 found:** `_izq`, `_izooto`, `izootoEmailSubcriptionCallBack`, `izootoEmailEventsCallback` |
| Soft prompt / overlay element on page | **present** (matched `[id*=izooto], [class*=izooto], [id*=push-overlay], [class*=push-overlay]`) |
| Total scripts on page | 30 |

The presence of `_izooto`, `izootoEmailSubcriptionCallBack`, and `izootoEmailEventsCallback` is unambiguous — those are the iZooto SDK's loaded globals, not the bootstrap queue. The SDK ran to completion.

## Check 3 — network requests to *.izooto.com

7 requests captured during this run:

| # | URL | Method | Status |
|---|---|---|---|
| 1 | `https://cdn.izooto.com/scripts/7c4116fe67b7040de57d9981f16164fa57cb9125.js?v=5` | GET | 200 |
| 2 | `https://cdn.izooto.com/scripts/sdk/izooto.js` | GET | 200 |
| 3 | `https://cdn.izooto.com/scripts/sdk/izextf.js` | GET | 200 |
| 4 | `https://cdn.izooto.com/newshub/widgets/2/v1.1.html` | GET | 200 |
| 5 | `https://cdn.izooto.com/webpush/blockedvis/2.gif` | GET | 200 |
| 6 | `https://nh.izooto.com/nh/7c4116fe67b7040de57d9981f16164fa57cb9125/latest.json` | GET | 200 |
| 7 | `https://nhwimp.izooto.com/nhwimp` | POST | 200 |

Worth highlighting:

- **The 40-hex hash `7c4116fe67b7040de57d9981f16164fa57cb9125`** is taxscan.in's iZooto site/property identifier (it appears in both the per-site bootstrap script URL and the newshub config URL). That's what links this install to a specific iZooto account.
- **`webpush/blockedvis/2.gif` is a tracking pixel for "blocked visitors"** — iZooto knows this visitor previously blocked notifications and is *still* logging the impression. So even denied-permission visitors are tagged + counted by iZooto on every page view.
- **`nhwimp.izooto.com/nhwimp` POST** is a "newshub widget impression" ping — visitor activity is being reported to iZooto.

In short, iZooto isn't just sitting dormant — it's actively serving widgets, fetching config, and sending tracking pings on every page load.

## Check 4 — push subscription present?

`navigator.serviceWorker.ready` → `pushManager.getSubscription()` → **no subscription** (`null`).

This is expected at denied permission. (At default permission and pre-Allow it would also be `null`; only after an Allow click would a real subscription endpoint appear.)

## Notes / anything ambiguous

A few things worth carrying forward into your decision:

**Reconciling with the prior session's report (`IZOOTO_STATE_CHECK.md`).** That run reported "no external iZooto script loaded in this session" with `izootoScriptCount === 0`. This run shows 3 scripts and 7 network requests. The difference is **timing, not permission state** — the earlier check ran very soon after navigation, before deferred loads completed. Both runs had `Notification.permission === "denied"`. So the corrected reading of both reports together is: the SDK loads on every visit regardless of permission, and the earlier "dormant" framing was over-optimistic.

**What's left to verify only on a true default-permission visitor.** Even with this run we can't directly observe the SW-registration step, because permission is denied. If you need direct evidence that iZooto registers its SW when a fresh visitor reaches the Allow button, run this same check in a profile where (a) `Notification.permission === "default"` and (b) you actually let yourself click Allow on the OS-level prompt. Then `getRegistrations()` should return a second worker with a scriptURL on `cdn.izooto.com`. I deliberately did not click Allow per the brief.

**The iZooto site ID is on display in the requests.** `7c4116fe67b7040de57d9981f16164fa57cb9125`. That's the value you would use if you needed to talk to iZooto support to disable/wipe this property, or to identify exactly which iZooto subscription list contains taxscan.in subscribers.

**Removal implication (unchanged from the previous report).** As long as the inline bootstrap snippet on the page references `cdn.izooto.com`, every visitor — regardless of permission state — fetches 3 SDK scripts and triggers tracking pings to iZooto. To actually decommission iZooto, the snippet has to come out of the site template. Until then, your new taxscan-push system runs in parallel with iZooto on every page view.
