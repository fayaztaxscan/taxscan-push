# Browser Test Report — Task 7 (web push)

**Date / browser / OS:** 2026-06-01 · Google Chrome (driven via Claude in Chrome) · macOS (Intel)

This report covers two runs: an initial run that uncovered three issues, and a re-test run after code fixes that re-verifies the affected paths and also exercises the previously-skipped recapture branch.

## Initial run

| # | Check | Result (pass/fail) | Notes |
|---|-------|--------------------|-------|
| 1 | Demo page loads | **pass** | `http://localhost:3000/` rendered "Taxscan Web Push — local demo" heading, full debug button row (`Refresh state` / `Clear dismissed cookie` / `Simulate 2nd page` / `Show prompt now` / `Unsubscribe`), and initial state JSON `permission: "default", swRegistered: true, endpoint: null, topics: [], dismissed: null, pagesThisSession: 1`. SW registered on load. |
| 2 | Soft prompt renders / Esc dismisses / keyboard reachable | **pass (with concern)** | "Show prompt now" surfaced the banner with 4 pre-checked topics (GST/Income Tax/Customs/Corporate), No-thanks link, Allow-notifications primary button (visible focus ring — keyboard reachable ✓). Escape dismissed ✓. Banner re-opened on a second "Show prompt now" click ✓. Concern: **Tab from "Allow notifications" escaped to "Refresh state" on the page AND closed the banner.** See Anomaly §2. |
| 3 | Native permission granted (manual) | **pass** | User clicked Allow on the OS-level Chrome prompt. After Refresh state: `permission: "granted"`, endpoint set, topics `["gst","income-tax","customs","corporate"]`. |
| 4 | Subscriber row ACTIVE, source=prompt, topics set | **partial pass** | Subscriber `cmpv5a5we0004yt3hbqiimvs8`: portal=`taxscan`, **status=ACTIVE** ✓, topics=`gst, income-tax, customs, corporate` ✓, real FCM endpoint, real p256dh & auth, userAgent set. **No `source` column on Subscriber model.** The source is on the SUBSCRIBED Event's `meta` (see row 5). |
| 5 | SUBSCRIBED event linked | **pass** | Event `cmpv5a6qv0006yt3hmrqpr0pd` — type=SUBSCRIBED, subscriberId matches new subscriber, **meta=`{"source":"soft-prompt"}`**. (PROMPT_ACCEPTED event recorded one tick earlier — instrumentation healthy.) Minor: value is `"soft-prompt"` not `"prompt"` as the test plan worded. |
| 6 | Notification appeared on send (manual) | **pass (after fixing 3 issues)** | After resolving auth/validation/seed-subscriber issues and enabling macOS Chrome notifications, `POST /api/send` returned `{"campaignId":"cmpv67j7o000jyt3hfj3nahnt","sent":1,"capped":0,"expiredPruned":0,"failed":0,"status":"SENT"}` and Chrome displayed the OS banner. |
| 7 | CLICKED event recorded after click | **pass** | CLICKED Event `cmpv67nwg000nyt3hw40ywbl7` — campaignId matches latest SENT, subscriberId matches new subscriber, campaign + subscriber relations both set. createdAt 01/06/2026 12:14 PM. |
| 8 | Recapture branch (foreign-key sub → unsub+resub) didn't throw | **not tested (deferred to re-test)** | See Re-test run table below. |

## Re-test run (after fixes)

| # | Check | Result (pass/fail) | Notes |
|---|-------|--------------------|-------|
| A | `target: {"type":"all"}` no longer crashes dispatch on bad subscribers | **pass** | With the 3 junk seed subscribers still present and ACTIVE, firing target=all delivered the notification to the real subscriber (Event `cmpv7c0ni0004ytme88cl…` SENT, campaign `cmpv7bxur0002ytmems2p…`), CLICKED event recorded after user clicked the notification (`cmpv7c3y90006ytme7btq…`), and **no 500 / unhandled error**. The 3 junk subscribers were silently captured as failed outcomes inside the worker. Code fix verified in `src/lib/push.ts` lines 81-86 (catch-all in `sendToSubscriber`) and `src/services/send.ts` lines 115-127 (belt-and-braces try/catch around the worker callback). |
| B | Soft-prompt banner focus trap | **partial pass — improvement, but still leaks** | Focus now cycles through the banner's elements in order — GST → Income Tax → Customs → Corporate → No thanks → Allow notifications → × close — and the **banner stays open when focus leaves** (improvement over the previous behaviour which closed the banner on the very first Tab). However there is **no true wrap**: after Tab past the close ×, focus escapes to "Refresh state" on the page. Escape still dismisses ✓. See Anomaly §2-revised. |
| C | Recapture: unsubscribe → resubscribe | **pass — no throw, with one design note** | Clicked **Unsubscribe** → state JSON showed `endpoint: null`, banner auto-reappeared, **UNSUBSCRIBED** Event `cmpv7cctc0008ytmey22m…` recorded against the old subscriber `cmpv5a5we0004yt3hbqii…`. Clicked **Allow notifications** on the re-appeared banner → state showed a new endpoint `aEq0fWkx-4gx1MN5aCY4ZCq_lrFmwFPm_hkGIXOE`, a **brand-new Subscriber row** `cmpv7ic23000fytmesifw…` was inserted (Subscriber count went 4 → 5), and a new **SUBSCRIBED** Event `cmpv7ictp000hytmey1yk…` was linked to the new subscriber with `meta={"source":"soft-prompt"}`. **No foreign-key error, no throw.** Design note in Anomaly §5. |

---

## Failures / anomalies

**§1. `target: {"type":"all"}` crashes the entire dispatch on bad seed subscribers — FIXED.** *(Initial run — fixed in code.)*

Originally, three seed Subscriber rows with placeholder `p256dh="PKEY"`, `auth="AKEY"`, `status=ACTIVE` caused the web-push library to throw synchronously inside `encryption-helper.js`, which escaped through `sendToSubscriber → workerPool → executeCampaign → dispatchCampaign` and surfaced as `500 {"error":"internal_error"}`. A single bad subscriber took down the whole dispatch.

Stack trace from `npm run dev` (printed twice):

```
unhandled error: Error: The subscription p256dh value should be 65 bytes long.
  at Object.encrypt (.../node_modules/web-push/src/encryption-helper.js:16:11)
  at WebPushLib.generateRequestDetails (.../web-push-lib.js:244:10)
  at WebPushLib.sendNotification (.../web-push-lib.js:341:29)
  at sendToSubscriber (.../src/lib/push.ts:50:46)
  at .../src/services/send.ts:112:67
  at .../src/services/send.ts:77:26
  at workerPool (.../src/services/send.ts:73:25)
  at executeCampaign (.../src/services/send.ts:112:28)
  at dispatchCampaign (.../src/services/send.ts:187:18)
```

**Resolution applied:**
- `src/lib/push.ts` (lines 81-86): catch-all for non-WebPushError throws inside `sendToSubscriber`, returns a failed outcome instead of propagating.
- `src/services/send.ts` (lines 115-127): try/catch wraps the worker callback itself, defence in depth.

**Re-test result:** confirmed in row A — target=all now succeeds, real subscriber receives the notification, junk subscribers fail silently, no 500. *Recommendation still open: mark the 3 seed rows as `EXPIRED` (or replace their placeholder keys) so they don't keep producing failed-outcome noise on every dispatch.*

**§2-revised. Soft-prompt banner has a partial focus trap, not a full one.** *(Initial: focus escaped immediately AND closed banner. Now: focus cycles through banner elements first, banner stays open, but Tab eventually still escapes.)*

Current behaviour confirmed in re-test row B:

- Focus enters the banner (e.g. clicking a checkbox) → Tab moves focus through GST, Income Tax, Customs, Corporate, No thanks, Allow notifications, ×. **All 7 stops are inside the banner.**
- After the × close button, Tab moves focus out to "Refresh state" on the page (the first focusable element in document order).
- The **banner remains open** when focus leaves — a real improvement over the original behaviour.

So this is materially better than before, but not yet a true focus trap. For full ARIA modal compliance, Tab past the last banner element should wrap back to the first (and Shift+Tab from the first should wrap to the last).

**Side observation:** Escape now dismisses the banner without persisting a `dismissed` value in state JSON (same as before). If "No thanks" persists a dismissal, Escape should arguably too — worth confirming intent.

**§3. Test-plan vs. schema / UI mismatches.** *(Docs / minor — unchanged.)*

- Test plan said "force the prompt" button; actual label is **"Show prompt now"**.
- Test plan expected `source: "prompt"` on Subscriber; the Subscriber model has no `source` column, and the value (stored on `Event.meta` for SUBSCRIBED events) is **`"soft-prompt"`** — more precise but a mismatch with the plan wording.

**§4. macOS-level Chrome notification permission was off initially.** *(Environment — not a code bug.)*

First dispatch was accepted by FCM (`sent: 1`) and recorded a SENT Event, but no banner appeared on screen until **System Settings → Notifications → Google Chrome → Allow notifications** was turned on. Worth a single line in the README's local-dev section for macOS testers.

**§5. NEW — Recapture inserts a new Subscriber row rather than upserting the old one.** *(Design note from re-test row C.)*

Observed: Unsubscribe → UNSUBSCRIBED Event recorded against the old Subscriber row (id `cmpv5a5we0004yt3hbqii…`), but the old row **was not deleted or status-flipped** — it remains in the table with its now-stale endpoint. Resubscribe then **inserted a fresh Subscriber row** (id `cmpv7ic23000fytmesifw…`) with a new endpoint/p256dh/auth, and the new SUBSCRIBED Event is linked to the new row.

Functionally this is fine — no throws, no FK errors, the recapture path is clean — but two practical consequences:

1. **Stale row accumulation:** Each unsub/resub cycle from the same browser leaves a stale subscriber behind. On a `target=all` dispatch the stale rows will fail (their FCM endpoints are dead) — currently safe because of §1's fix (they're captured as failed outcomes), but they're effectively dead weight and inflate row counts / log noise.
2. **Old row's `status` after unsubscribe:** the UNSUBSCRIBED event is recorded, but the Subscriber row's `status` field doesn't appear to be flipped to EXPIRED/UNSUBSCRIBED (it still showed `status=ACTIVE` in the row detail). Worth confirming whether the unsubscribe handler is intended to also update the row's status.

**Recommendation:** either (a) have the resubscribe flow `upsert` against a stable browser fingerprint / deviceId so stale rows are reused, or (b) mark the old row as EXPIRED on unsubscribe so subsequent dispatches naturally skip it.

---

## Console or network errors observed

**Server (`npm run dev`) terminal (initial run):**

- `unhandled error: Error: The subscription p256dh value should be 65 bytes long.` — printed twice during the failed target=all dispatch. See §1.

**Server terminal (re-test run):** no unhandled errors. The successful target=all dispatch is expected to have logged `console.warn` lines of the form `push failed for subscriber <id>: <statusCode> <error>` for each junk subscriber (3 warnings) per `src/services/send.ts` line 145-147 — these are warnings, not unhandled errors, and don't affect the response.

**HTTP responses encountered during `/api/send` debugging (all attributable to the curl payload, fixed in order):**

| Attempt | Response | Cause |
|---|---|---|
| 1 | `401 {"error":"unauthorized"}` | Curl used literal `<token>` placeholder instead of `$ADMIN_TOKEN`. |
| 2 | `400 {"error":"invalid_request","issues":[{"path":["portal"], "message":"expected string, received undefined"}]}` | `portal` field missing from JSON body — `SendSchema` requires `portal: z.string().min(1)`. |
| 3 | `500 {"error":"internal_error"}` | The p256dh-65-bytes crash on seed subscribers (see §1). |
| 4 (post-fix) | `200 {"campaignId":"…","sent":1,…,"status":"SENT"}` | Succeeded after switching target to topics-filter, then verified again on `target:all` after the code fix landed. |

**Browser DevTools:** not actively monitored. No visible page-side errors during interaction. Re-run with DevTools open if you want a console capture.

---

## Verdict: **needs minor fixes (not blocking)**

End-to-end happy path is fully working and the previous blocker (§1) is genuinely fixed. Remaining items are quality/UX rather than functional:

- **Verified fixed:** §1 — dispatch survives malformed subscribers, real subscribers still get delivered, click attribution works. Safe to ship target=all behaviour.
- **Materially improved (still partial):** §2 — focus now stays in the banner for the first cycle and the banner doesn't close on Tab. Recommend completing the trap so Tab/Shift+Tab fully wrap; cheap accessibility win.
- **New finding (not blocking):** §5 — recapture creates a new row rather than upserting. Works, but consider stable-id upsert and/or status flip on unsubscribe to prevent row accumulation.
- **Docs only:** §3 — reconcile test-plan wording with the actual UI/schema.
- **Environment hint:** §4 — README note for macOS testers.

Recommended next sequence: (1) clean up seed/stale rows (§1 follow-up + §5 status-flip), (2) finish the focus trap (§2), (3) update test plan wording (§3).
