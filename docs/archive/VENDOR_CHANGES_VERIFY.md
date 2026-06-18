# Vendor Changes Verification — taxscan.in

**Date / browser:** 2026-06-02 · Google Chrome (driven via Claude in Chrome). All checks done in a fresh tab against `https://www.taxscan.in/`. Tested against the four-item spec sent to Hocalwire.

## TL;DR

**Three of the four changes shipped correctly. One has shipped *structurally* but is not functioning, which blocks the whole migration.**

| # | Vendor change | Verdict |
|---|---|---|
| 1 | Upload `sw.js` to taxscan.in root | ✅ **Done** |
| 2 | Add `TAXSCAN_PUSH_CONFIG` + SDK `<script>` tags to `<head>` of every page | ⚠️ **Tags present, SDK is not executing** (functionally broken) |
| 3 | Remove every iZooto script reference | ✅ **Done** |
| 4 | Remove iZooto's service worker file from server | ✅ **Done** (inferred — known iZooto SW paths return 404) |
| Acceptance test 1: SW at `/sw.js?api=...` registered | ❌ **Fails** — only the site's existing `/service-worker.js` is registered |
| Acceptance test 2: No iZooto SW listed | ✅ **Passes** |
| Acceptance test 3: Zero network requests to `*.izooto.com` on reload | ✅ **Passes** (0 requests) |
| Acceptance test 4: Soft prompt appears after engagement | ❌ **Fails** (depends on the SDK running, which it isn't) |

The state right now is: iZooto is gone, but our new system is also not yet operational. Until the SDK script actually executes on every visit, no new subscribers are being captured and no existing iZooto subscribers are being migrated.

## Detailed findings

### Change 1 — `sw.js` at the document root: ✅ Done

`fetch('/sw.js', { cache: 'no-store' })` from the page context returned `200 OK` with `Content-Type: application/javascript`. The body is JavaScript (not an HTML 404 page), is ~3 KB, and contains the `API_BASE` marker we expect at the top of our service-worker file. Path is exactly `https://www.taxscan.in/sw.js` (root, not nested). Previous probes showed this URL as `404` while iZooto was active; that has been corrected.

### Change 2 — Inline config block + SDK `<script>` tag: ⚠️ Structurally present, functionally broken

What's in the page is fine on paper:

- The inline `<script>` block sets `window.TAXSCAN_PUSH_CONFIG = { apiBase: 'https://taxscan-push-production.up.railway.app', cutoverMode: true }`. After parsing, `typeof window.TAXSCAN_PUSH_CONFIG === 'object'`, `apiBase` host = `taxscan-push-production.up.railway.app`, `cutoverMode === true`.
- The SDK `<script>` tag is in `<head>`, with `defer`, `type="text/javascript"`, src pointing at the Railway domain. Attributes observed: `type, defer, src, data-key`. The vendor added a `?v=` cache-bust query and a `data-key` attribute; neither should block execution.

The problem is what *doesn't* happen as a result:

- **`window.TaxscanPush` is `undefined`** after the page fully loads (and after several extra seconds of waiting). The SDK's IIFE never reaches its `window.TaxscanPush = { … }` assignment, which means the SDK never ran past its very first statement.
- The SDK file is itself healthy. I proved this two ways:
  1. `fetch('https://taxscan-push-production.up.railway.app/taxscan-push.js')` returned `200`, body length 18,430 bytes, content includes the `TaxscanPush` and `cutoverMode` markers.
  2. After fetching the source and calling `new Function(code)()` (executing it manually in the page), `typeof window.TaxscanPush` becomes `'object'`, the SDK registers `/sw.js?api=…` correctly, and `TaxscanPush.getState()` returns `{ permission: 'denied', registered: true, … }`.
- When I tried to *replicate* the page's load by injecting a fresh `<script src=".../taxscan-push.js">` via `document.createElement('script')` + `appendChild`, the **`onerror` event fired** (and `onload` did not), even though `fetch` of the same URL had just worked moments earlier.
- The page has **no script-blocking CSP**: the only `Content-Security-Policy` HTTP header on the response is `frame-ancestors …` (no `script-src`, no `default-src`). So CSP is not the cause.
- There is no `nomodule`, `integrity`, or `crossorigin` attribute on the SDK tag, and the `type` is `text/javascript`. So it's not being treated as a non-executing placeholder by a consent manager.

The most plausible root cause is **a transient/cold-start failure of the Railway hosting**: the first request from a fresh page load times out or errors at the network layer, and the page's own `<script>` tag is unable to load the file even though a later `fetch()` (after Railway has warmed up) succeeds. That would also explain why my dynamic re-injection failed seconds later: the browser may have cached the network failure for that resource, and Railway's response was still flaky. This is consistent with Railway's known behaviour on free / cold tiers and with deployments that have low traffic to specific assets.

Whatever the precise cause, the observable effect on real visitors is the same: **the SDK does not run, so /sw.js is never registered, no prompt is shown, no subscriber is captured, and no iZooto SW cleanup happens.**

### Change 3 — iZooto script removed: ✅ Done

Confirmed against the iZooto-active baseline from `IZOOTO_STATE_CHECK_INCOGNITO.md`:

- Scripts whose `src` matches `/izooto/i`: **0** (was 3).
- `window._izq`, `window._izooto`, `window.izootoEmailSubcriptionCallBack`, `window.izootoEmailEventsCallback`: **all undefined** (4 → 0).
- Inline scripts containing the substring `izoo`: **0** (was 1; the ~350-char bootstrap snippet is gone).
- Network requests to `*.izooto.com` on a fresh load: **0** (was 7, including the `blockedvis` tracking pixel and the `nhwimp.izooto.com` impression ping).
- iZooto-style overlay elements (`[id*=izooto], [class*=izooto], [id*=push-overlay], [class*=push-overlay]`): **none present**.

This is the clean cutover we asked for on this change. Sample is one page (the homepage); to be belt-and-braces, you might want to confirm a couple of article pages, but the change is presumably template-wide.

### Change 4 — iZooto service-worker file removed: ✅ Done (inferred)

`fetch('/izooto-sw.js')` returns `404` from the page context. The other common iZooto SW paths (`/izootoServiceWorker.js`, etc.) were already 404 prior to the change (iZooto appears to have hosted its SW on its own CDN rather than on taxscan.in), so there's nothing to verify removal of for those — they were never there. The acceptance criterion "deleting the file is the matching server-side cleanup" is satisfied: nothing iZooto-named is served from taxscan.in's root.

### Acceptance test 1 — `/sw.js?api=…` registered: ❌ Fails (consequence of Change 2 not running)

On a fresh load, the only registration returned by `navigator.serviceWorker.getRegistrations()` is:

| Scope | Active scriptURL |
|---|---|
| `https://www.taxscan.in/` | `https://www.taxscan.in/service-worker.js` |

This is the **site's own pre-existing PWA service worker** (single path segment, host matches the page, no `?api=` query). It is not ours, and not iZooto's. Our SDK's expected registration of `/sw.js?api=https%3A%2F%2Ftaxscan-push-production.up.railway.app` does **not** appear.

I confirmed this is purely because the SDK doesn't run. When I manually executed the SDK source via `new Function(code)()`, registration completed successfully, and the registration list collapsed to exactly one entry: `/sw.js` with the correct `?api=` query string. So `cutoverMode` works as expected once the SDK actually executes — it correctly takes over scope `/` from the prior `/service-worker.js` registration without disturbing anything else.

### Acceptance test 2 — No iZooto SW: ✅ Passes

There are no `cdn.izooto.com` or `*izooto*` worker registrations. (There never were on the SW level even when iZooto was active in this test profile, because permission had been denied here — see `IZOOTO_STATE_CHECK.md` for the discussion.)

### Acceptance test 3 — Zero `*.izooto.com` network requests: ✅ Passes

Network tracking armed before a clean reload. After full page load + scroll + ~20s wait: **0 requests** to any `*.izooto.com` host. The earlier baseline was 7 requests (across `cdn.izooto.com`, `nh.izooto.com`, `nhwimp.izooto.com`).

### Acceptance test 4 — Soft prompt appears: ❌ Fails (consequence of Change 2 not running)

No prompt appeared during the session. This is the expected downstream effect of the SDK not executing — the SDK is what arms the engagement triggers (scroll-50% / dwell-30s / second-page) and renders the prompt. Even with the inline config and the script tag in `<head>`, no JavaScript ran to listen for those triggers.

## What this means and what to fix

The vendor work removed iZooto cleanly **and** wired up the structural pieces of our system (file at `/sw.js`, config block, script tag, `cutoverMode: true`). That part is correct and should not be undone. But because the page's `<script src=".../taxscan-push.js">` is failing to execute, the migration the system is supposed to perform is **not happening yet**, for any visitor: no new opt-ins, no recapture of iZooto-permission-granted readers, no `cutoverMode` cleanup of iZooto's leftover service worker on returning devices.

In practice, **the site is currently worse off than before the change** for already-subscribed iZooto users: iZooto's tracking is gone (good), but the new system isn't claiming them yet either. Readers who had previously clicked Allow for iZooto are now in a quiet hole — their device still has the iZooto SW registered, iZooto's not sending, and we're not sending either.

Two things to try, in order:

**1. Confirm the SDK can reliably load from Railway.** Open `https://taxscan-push-production.up.railway.app/taxscan-push.js` directly in a fresh browser tab a couple of times in quick succession — does the file come back instantly every time, or does the first hit after a quiet period take 30+ seconds (or fail outright)? If it's intermittent, Railway is the likely culprit. Either:
   - **Move the SDK behind a CDN** (Cloudflare in front of Railway, or just put `taxscan-push.js` on a CDN like jsDelivr if you publish it from a public repo). Browsers will then load it as reliably as any other static asset.
   - **Switch Railway to a tier that doesn't cold-start**, if you're on a free/hobby tier where idle sleep is in play.
   - As a last resort, **let the vendor host the SDK file** (against your original preference). The trade-off is real, but a working stale SDK beats a broken fresh one. We can mitigate the update problem by versioning the file and having the vendor swap it on each release.

**2. Once the load is reliable, re-run this same set of checks** to confirm the SDK actually executes, `window.TaxscanPush` becomes defined, the `/sw.js?api=…` registration appears, and the soft prompt is reachable. The structural changes (Changes 1, 3, 4 plus the script tags from Change 2) do not need to be redone.

## What you can tell the vendor

The vendor did exactly what was asked. The hosting problem is on our side, not theirs. The four template-level changes look correct, and you can confirm them as accepted. The follow-up — making the Railway-hosted SDK load reliably for every visitor — is something we (not Hocalwire) need to resolve before declaring the migration complete.
