# iZooto State Check — taxscan.in

**Date / browser:** 2026-06-02 · Google Chrome (driven via Claude in Chrome), default profile, on the live site `https://www.taxscan.in/`.

## Verdict

**State A (partial) — the iZooto bootstrap snippet is still present in the page, but the SDK is effectively dormant and no iZooto service worker is registered on this domain.** This is between a clean removal (State B) and a fully active install: the legacy snippet remains in the HTML and continues to initialise `window._izq` on every page load, but the CDN-hosted SDK didn't actually load in this session, no iZooto assets are served from `taxscan.in`, and no network requests to `izooto.com` domains were observed. See "Notes / anything ambiguous" for the caveat that changes how you interpret this.

## Check 1 — Service worker registrations

`navigator.serviceWorker.getRegistrations()` returned **1 registration**:

| Scope | Active scriptURL (host : path) |
|---|---|
| `https://www.taxscan.in/` (root) | `www.taxscan.in` : `/service-worker.js` |

This is the **site's own PWA service worker**, not iZooto's. iZooto's service worker is conventionally named something like `/izooto-sw.js` or registered from a script at `/_izooto_sw_loader_v2.js`; **neither is registered.** No installing/waiting workers either.

## Check 2 — iZooto SDK on page

| Probe | Result |
|---|---|
| `window._izq` (iZooto push queue) | **present** — `typeof === "object"`, `Array.isArray(_izq) === true`, length 1, first entry is an object (the bootstrap's initial enqueued command) |
| `window.izooto` | undefined |
| `window.izt` | undefined |
| Other globals matching `/izoo|^_iz|^iz[A-Z_]/i` | only `_izq` (the other match was my own test variable) |
| Number of `<script src="…">` containing `izooto` | **0** — no external iZooto script loaded in this session |
| Inline `<script>` tags containing the string `izoo` | **1 inline script (≈350 chars)** that mentions `izooto` and references the token **`cdn.izooto.com`** |
| Inline snippet also mentions | `izooto`, `cdn.izooto.com`. Does NOT contain `serviceWorker`, `subscribe`, `manifest`, or `app.izooto` references |

Interpretation: the **classic iZooto bootstrap snippet is still embedded** in the page HTML (initialises `_izq` and refers to `cdn.izooto.com`), but in this load the heavier SDK script from `cdn.izooto.com` did not get injected into the document and did not load. The most likely reason is that this Chrome profile already has `Notification.permission === "denied"` for `taxscan.in`, and the snippet (or some site-level wrapper around it) skips the SDK fetch when permission is already denied.

## Check 3 — iZooto files on domain

In-page `fetch()` from the live taxscan.in origin (so cookies/CORS aren't a factor):

| Probe (same-origin GET) | Status | Content-Type guess | Mentions "izoo"? |
|---|---|---|---|
| `/izooto-sw.js` | **404** (HTML 404 page) | HTML | no |
| `/_izooto_sw_loader_v2.js` | **404** (HTML 404 page) | HTML | no |
| `/izooto-manifest.json` | **404** (HTML 404 page) | HTML | no |
| `/manifest.json` | **200** | JSON | no — the site's own PWA manifest, no iZooto references |
| `/sw.js` | **404** | HTML | no |

So **no iZooto files are hosted under `taxscan.in`**. The only PWA-related assets on the domain are the site's own `/service-worker.js` and `/manifest.json`, and neither references iZooto.

## Check 4 — Network requests to iZooto domains

Filtered the tab's network log for `izooto` after a fresh page reload (network capture was confirmed active before reload):

> **No requests matching `izooto` found for this tab.**

So during this load, the browser did not fetch anything from `cdn.izooto.com`, `app.izooto.com`, `push.izooto.com`, or any other `*.izooto.com` host. The snippet kicked off `_izq` but did not progress to actually loading the SDK over the network.

## Notes / anything ambiguous

A few important caveats so you read the verdict accurately:

**This profile's `Notification.permission` was `"denied"` for taxscan.in.** That very likely changes what gets loaded. The iZooto bootstrap snippet, like most consent-gated SDKs, typically short-circuits when permission is already denied — it won't bother fetching the heavy CDN SDK or registering its service worker if it can't display notifications anyway. **In a fresh browser profile where permission is "default", the SDK would probably fully load, register its service worker, and start making network calls to `*.izooto.com`.** So Checks 2 (no external script) and 4 (no network calls) reflect a *denied* state, not necessarily proof that iZooto is gone for everyone.

**What's unambiguous and would hold across any visitor:**

- The **iZooto inline snippet is still embedded in the HTML** (referenced `cdn.izooto.com`, initialises `_izq`). This is independent of permission state.
- **No iZooto service worker is registered** for *this* Chrome profile — but if the SDK loaded in a new profile, it almost certainly would register one when subscribing.
- **No iZooto assets self-hosted on the domain.** Whatever runs would run from `cdn.izooto.com`, not from `taxscan.in`.

**Practical recommendation:** to fully remove iZooto, the inline snippet (the one inserting `_izq` and pointing at `cdn.izooto.com`) needs to be deleted from the site template. Until it is, every visitor whose `Notification.permission` is `default` is still triggering the iZooto SDK load + SW registration in the background, even though your taxscan-push system is the new owner of push.

To verify the inline snippet's behaviour for a default-permission visitor: open `https://www.taxscan.in/` in a clean Chrome profile (or a new incognito window after clearing site data), then re-run Checks 1, 2 and 4 — I expect (a) a second SW registration whose scriptURL is on `cdn.izooto.com` to appear, (b) `Array.from(document.scripts).map(s=>s.src).filter(s=>/izooto/.test(s))` to return at least one entry, and (c) network requests to `*.izooto.com` to show up.
