# Session continuity — taxscan-push push notification work

> **Purpose:** capture where the current Claude/Cowork session left off, so a new session (after restart) can pick up without re-doing the earlier passes. Tell the new Claude session: *"Read SESSION_CONTINUITY.md in this project and resume the pending work."*

## Date of last session
2026-06-02 (afternoon, before restart)

## What's already done — files saved in this project

| File | What it contains | Status |
|---|---|---|
| `BROWSER_TEST_REPORT.md` | End-to-end browser test of the local web-push system (steps 1–7 plus a re-test pass after fixes). Verdict: *needs minor fixes (not blocking)*. | ✅ done |
| `FEED_INVESTIGATION.md` | Investigation of per-section RSS feeds on taxscan.in. Verdict: **per-section feeds EXIST** at `/<section>/feed`; each item carries a `<category>` tag. Recommendation: switch poller to one source per topic. | ✅ done |
| `IZOOTO_STATE_CHECK.md` | iZooto state check on taxscan.in run in the **default Chrome profile** (which already had `Notification.permission = "denied"` for taxscan.in). Verdict: State A (partial) — bootstrap snippet still embedded in page HTML, but SDK was dormant because permission was denied. | ✅ done |

## What's pending

### iZooto state check in a **clean / incognito** session (default permission)

The previous iZooto check was performed in a Chrome profile where `Notification.permission` had already been set to `"denied"` for taxscan.in, which gates the iZooto SDK from actually loading. The follow-up is to re-run the check in a fresh session where permission is `"default"`, so we can confirm whether the bootstrap snippet does in fact register the iZooto service worker and load `cdn.izooto.com` for a brand-new visitor.

**Status:** not done — was about to start when this session ran out of time on the incognito setup.

**Deliverable to write when complete:** `IZOOTO_STATE_CHECK_INCOGNITO.md` (in this same project folder), using the template at the bottom of this document.

## Steps for the new Claude session (after restart)

When you start a fresh Cowork session, paste **everything below the line** into Claude as the resume prompt.

---

You are continuing work on the taxscan-push project. Earlier work in this folder produced `BROWSER_TEST_REPORT.md`, `FEED_INVESTIGATION.md`, and `IZOOTO_STATE_CHECK.md`. I now need the follow-up iZooto check in a clean Chrome session. **This is read-only inspection — do NOT click Allow or Block on any notification prompt, do not log in, do not change anything. If a soft prompt or permission prompt appears, leave it untouched and just observe.**

### Setup (manual step before Claude runs anything)

Before asking Claude to run the checks, the user (me) must:

1. Open a new **Chrome Incognito** window (Cmd+Shift+N on macOS). The Claude in Chrome extension must be allowed in incognito mode — check `chrome://extensions` → Claude → Details → "Allow in Incognito" is on. If it's off, turn it on first.
2. **Verify the new tab is shared with Claude** (Claude in Chrome panel should show the incognito tab as available).
3. Tell Claude *"go"* — Claude should then navigate that tab to `https://www.taxscan.in/`, wait ~15–20 seconds, scroll once to allow deferred loads, and proceed with the checks below.

If the extension can't operate in incognito on this machine, an alternative is a fresh Chrome profile with no history for taxscan.in, OR clearing all site data + notification permission for taxscan.in in the current profile (`chrome://settings/content/all` → search taxscan.in → "Delete data"). Whichever path you take, the precondition is `Notification.permission === "default"` before Claude starts the checks.

### Check 0 — Permission state

```js
Notification.permission
```

Confirm it's `"default"`. If `"granted"` or `"denied"`, note that and continue.

### Check 1 — Service worker registrations

```js
navigator.serviceWorker.getRegistrations().then(rs =>
  rs.forEach(r => console.log('SCOPE:', r.scope, '| SCRIPT:', r.active && r.active.scriptURL))
);
```

Report the **exact `scriptURL`** of every registered worker. The hypothesis being tested is that, in addition to the site's own `https://www.taxscan.in/service-worker.js`, a second worker now appears whose scriptURL is on `cdn.izooto.com` or otherwise iZooto-flavoured. Copy that scriptURL verbatim — that's the key piece of evidence.

### Check 2 — iZooto SDK actually loaded

```js
Array.from(document.scripts).map(s => s.src).filter(s => /izooto/i.test(s));
typeof window._izq;
typeof window.izooto;
```

Compared to the denied-permission run (where `izootoScripts.length === 0`), this run should now have at least one external script src from `cdn.izooto.com` if the bootstrap snippet is truly active for default-permission visitors.

### Check 3 — Network requests to *.izooto.com

With network capture active **before** the reload, list every request to `cdn.izooto.com`, `app.izooto.com`, `push.izooto.com`, or any other `*.izooto.com` host the page made. If the network capture isn't accessible, say so plainly.

### Check 4 — Push subscription present?

```js
navigator.serviceWorker.ready.then(reg => reg.pushManager.getSubscription().then(s =>
  console.log('SUBSCRIPTION:', s ? s.endpoint : 'none')
)).catch(e => console.log('err', e.message));
```

This usually reports `'none'` until the user clicks Allow — observe whatever is there.

### Then write `IZOOTO_STATE_CHECK_INCOGNITO.md` using this template

```
# iZooto State Check (Incognito / default permission) — taxscan.in
Date / browser:

## Permission state at start
## Verdict
(one of: "Confirmed State A — iZooto SDK loads and registers a service worker for fresh visitors" / "iZooto snippet present but does NOT register a worker even at default permission" / "Inconclusive — explain")

## iZooto service worker scriptURL (EXACT string, if any)
## Check 1 — all SW registrations (scope + scriptURL)
## Check 2 — iZooto SDK loaded? (script srcs, _izq, izooto globals)
## Check 3 — network requests to *.izooto.com
## Check 4 — push subscription present?
## Notes / anything ambiguous
```

### Important constraints (carry over from earlier session)

- **Do not click Allow or Block** on the native notification prompt or the soft prompt.
- **Do not log in.**
- This is purely observational.
- The Claude in Chrome JavaScript executor sometimes blocks results containing URL/query-string data with `[BLOCKED: Cookie/query string data]`. If that happens, sanitise the output: stash the result in a `window.__var__` first, then return a summary object with redacted/normalised fields (e.g. strip query strings, mask hostnames, keep only flags/lengths/path basenames).

## Context worth carrying forward

A few things observed in earlier sessions that you may want to know:

- The taxscan.in site's own PWA service worker is at `https://www.taxscan.in/service-worker.js`, root scope. That's the legitimate one — not what we're investigating.
- The `_izq` global is the strongest fingerprint that iZooto's bootstrap snippet is still embedded.
- The previous-session check found that `cdn.izooto.com` is referenced in an inline `<script>` of ~350 chars on the page. That snippet **was present** even at denied permission; the only thing that's gated is whether the heavy SDK is then injected.
- Tests on the local web-push system (`localhost:3000` + Prisma Studio on `localhost:5555`) are complete; this iZooto follow-up is the only remaining open item from the earlier passes.

That's the full handover. Once the new Claude session writes `IZOOTO_STATE_CHECK_INCOGNITO.md`, the loop is closed.
