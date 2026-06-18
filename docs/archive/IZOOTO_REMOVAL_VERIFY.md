# iZooto Removal Verification — taxscan.in

**Date / browser:** 2026-06-02 (re-test after Hocalwire vendor removal) · Google Chrome (driven via Claude in Chrome). Fresh tab, no-cache reload, network capture armed before the document reload.

## Verdict

**Confirmed removed.** Every iZooto fingerprint that was present in `IZOOTO_STATE_CHECK_INCOGNITO.md` is now absent from `https://www.taxscan.in/`. No external `cdn.izooto.com` scripts load, no `_izq` / `_izooto` globals are created, no inline snippet mentions `izooto`, no iZooto-style overlay is rendered, no requests hit any `*.izooto.com` host, and no second service worker registers. The only remaining service worker is the site's own PWA worker, which is unchanged and not iZooto-related.

## Side-by-side delta vs. previous run

| Probe | Before (`IZOOTO_STATE_CHECK_INCOGNITO.md`) | After (this run) | Delta |
|---|---|---|---|
| External `<script>` srcs containing `izooto` | **3** (all on `cdn.izooto.com`) | **0** | ✅ removed |
| Hosts seen for iZooto scripts | `cdn.izooto.com` | (none) | ✅ removed |
| Network requests to `*.izooto.com` | **7** (cdn.izooto.com, nh.izooto.com, nhwimp.izooto.com — including the "blocked visitor" tracking pixel) | **0** | ✅ removed |
| `typeof window._izq` | `"object"` (Array, length 0) | `"undefined"` | ✅ removed |
| `typeof window._izooto` | object | `"undefined"` | ✅ removed |
| Other iZooto globals | `izootoEmailSubcriptionCallBack`, `izootoEmailEventsCallback` | (none) | ✅ removed |
| `Object.keys(window).filter(/izoo|^_iz/i)` | 4 keys | **0 keys** | ✅ removed |
| Inline `<script>` text mentions `izoo` | **yes** (≈350-char bootstrap snippet) | **no** | ✅ removed — snippet pulled from template |
| iZooto-style overlay element on page (`[id*=izooto], [class*=izooto], [id*=push-overlay], [class*=push-overlay]`) | **present** | **not present** | ✅ removed |
| Total scripts on page | 30 | 28 | scripts dropped (consistent with iZooto + dependencies gone) |
| Service worker registrations | 1 (`https://www.taxscan.in/service-worker.js`) | 1 (`https://www.taxscan.in/service-worker.js`) | unchanged — site PWA correctly preserved |
| Site PWA worker scriptHost | `www.taxscan.in` | `www.taxscan.in` | unchanged ✅ |
| `Notification.permission` | `"denied"` | `"denied"` | unchanged (profile state, not iZooto-related) |
| Push subscription present | no | no | unchanged |

## Detailed snapshot of the current state

**Permission state at start:** `"denied"` (unchanged in this profile — doesn't matter for the removal verdict, because the previous report proved the iZooto SDK had been loading regardless of permission).

**Service worker registrations:** exactly one.

| Scope | Active scriptURL |
|---|---|
| `https://www.taxscan.in/` (root) | `https://www.taxscan.in/service-worker.js` |

**iZooto SDK in the page:**

| Probe | Value |
|---|---|
| Scripts whose src matches `izooto` | `0` |
| Distinct iZooto script hosts | `[]` |
| Inline scripts mentioning `izoo` | `false` |
| `typeof window._izq` | `"undefined"` |
| `typeof window._izooto` | `"undefined"` |
| `typeof window.izooto` | `"undefined"` |
| `Object.keys(window).filter(/izoo|^_iz/i)` | `[]` |
| iZooto-flavoured overlay element on page | not found |

**Network requests to `*.izooto.com` after no-cache reload:** **none** (filtered for `izooto`, 0 matches).

**Push subscription:** none (`pushManager.getSubscription() === null`).

## What this means in practice

- **Fresh visitors no longer pick up iZooto.** The bootstrap snippet is gone from the HTML, so even a default-permission visitor (the worst-case scenario from the previous report) won't fetch the SDK, won't register an iZooto service worker, won't surface the iZooto soft prompt, and won't ping `nhwimp.izooto.com` or trigger the `blockedvis` tracking pixel. That was the core requirement.
- **The site's own PWA service worker is intact.** Only one SW is registered: `https://www.taxscan.in/service-worker.js`. Confirms the vendor's change was surgical — they removed the iZooto snippet without disturbing the legitimate PWA worker. That validates the same principle we baked into the `cutoverMode` fix in `public/taxscan-push.js` (only touch iZooto, never the site's own SW).
- **Existing iZooto subscribers (other devices/profiles where Allow was already clicked previously) are not affected by this template change.** Their browser still has the iZooto SW registered and they will keep receiving any messages iZooto pushes to them until either (a) iZooto stops sending, (b) their SW is unregistered (by your `cutoverMode` SDK once it visits the site), or (c) their browser cleans up the SW. The template removal stops new acquisitions; it does not retroactively unsubscribe historical subscribers.
- **No clean-up needed on the site side.** No leftover iZooto assets to serve, no inline references — the next time we visit this is the new baseline.

## Caveats / what was NOT in scope of this verification

- This is a single-page snapshot of the homepage `https://www.taxscan.in/`. If the iZooto snippet was injected via a shared template the change should be global, but we didn't sample multiple article pages (e.g. `/income-tax/...`, `/corporate-laws/...`) to confirm. If you want certainty across page types, ping me and I'll spot-check a few more URLs the same way — should take a minute.
- We did not test "would a brand-new visitor with `Notification.permission === "default"` and a fully cold cache trigger anything iZooto?" The honest answer based on this evidence is "no, because the snippet is gone from the HTML and the SDK script never gets requested," but a true clean-profile check would still be the strongest possible signal. The network log here is itself strong evidence — if the snippet were still there, we'd see at minimum the `cdn.izooto.com/scripts/<hash>.js?v=5` per-site bootstrap fetch regardless of permission state, and we don't.
- We have not yet verified what your existing iZooto subscribers' devices do over time — that's a function of your `cutoverMode` flip + the per-browser SW cleanup, separate from the vendor's template change. The `public/taxscan-push.js` cutover code is what handles that side, and is unit-tested in `src/__tests__/cutover.test.ts`.

## Recommended next steps (small list)

1. **Spot-check 2–3 article pages** if you want belt-and-braces confirmation that the snippet removal is template-wide and not just on the homepage. I can do this in a couple of minutes.
2. **Flip `TAXSCAN_PUSH_CONFIG.cutoverMode` to `true`** in production whenever you're comfortable. With the new code (iZooto-only matching) this is now safe — it will unregister any leftover iZooto SW on existing-visitor devices without touching the site's PWA worker or your own push worker.
3. **Optional:** ask Hocalwire to confirm the change is on every template, not just the homepage one — saves you running the spot-check.
