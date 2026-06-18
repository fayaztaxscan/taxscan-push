# NEXT_STEP.md — Where I am in Task 12

Snapshot for resuming work after a break. Update this file whenever the
status changes so a fresh Claude session can pick up cleanly.

---

## ⛔ 2026-06-16 — DECOMMISSION CANCELLED / recapture assumption corrected

**Do NOT decommission iZooto. The "7-day watch → cancel iZooto" plan below is VOID.**

Reason: web-push subscriptions are cryptographically bound to (origin + VAPID key).
iZooto's ~3M endpoints were minted with iZooto's VAPID keypair — we don't hold their
private key, so they can NEVER be sent to from this system. They cannot be migrated
or imported (`subscribersBySource.import = 0`, and `import-izooto.ts`'s own caveat:
import only works if iZooto used OUR VAPID key, which it didn't). The ONLY recovery
path is **recapture** (a returning browser re-subscribes under our VAPID key), which
is slow, lossy, and only works for users whose original grant was on the
`www.taxscan.in` origin (NOT an `*.izooto.com` origin).

Live metrics 2026-06-16: **activeSubscribers 1,987** (recapture 2,646 / soft-prompt 30
/ import 0); delivery 95.5% ✅; unsub 0.04% ✅; **CTR 0.66% ⚠️ (below the 4–6% target)**.
Recapture runs ~130–270/day and flat → it will plateau in the low tens of thousands at
best, NOT millions. So self-hosted is a parallel channel that grows, NOT a replacement
for iZooto. **Keep iZooto running indefinitely.**

Two unknowns that bound the recapture ceiling — get these before any further planning:
1. iZooto's REAL deliverable/active count (the "3M" is almost certainly cumulative
   all-time opt-ins, not reachable subscribers).
2. The origin iZooto subscribed under (`www.taxscan.in` vs an `*.izooto.com` subdomain).
   If the latter, recapture can't reach the bulk of the base at all.

Highest-leverage fixes (from the 2026-06-16 review): (a) the 20–28s Hocalwire
`loadScripts` delay (KNOWN_ISSUES #1) throttles recapture — render the SDK `<script>`
statically/`defer` in `<head>`; (b) clean the leaked `localhost:3000` dev/test
subscriber rows out of prod; (c) redesign send pacing (batch-window + editorial
priority + defer-not-drop) to lift the 0.66% CTR. The cooldown-DROP model currently
sends whichever article published FIRST in a 30-min window (not the most important)
and drops everyone else for that article.

---

## Today's status (last updated: 2026-06-09)

- ✅ **Pre-go-live security re-audit completed + 4 fixes shipped (2026-06-09).**
  Multi-agent audit of the post-Task-10d user-mgmt surface (auth, invites, audit
  immutability, CSRF, live-dispatch path). **No critical/high.** 24 confirmed
  findings; the 4 mediums were fixed before go-live: **M1** push click-URL
  allowlist now enforced on the RSS/sweeper dispatch path (was only on `/api/send`);
  **M2** `passwordResetRequired` now enforced server-side in `requireUser` (was
  SPA-only); **M3** login-lockout DoS removed (verify-password-first + generic 401);
  **M4** `bcrypt`→^6 clears the node-tar advisories (`npm audit` = 0). Full suite
  **198/198** green. Lows/infos deferred to a backlog — see `SECURITY.md`
  (2026-06-09 section). NOT yet committed/merged at time of writing.

- ✅ **Per-subscriber notification cooldown shipped (2026-06-08).** `MIN_GAP_MINUTES`
  (default 30; 0 disables) — a subscriber pushed within the window is held back for the next
  campaign, so a burst of articles in one poll tick can't fire several pushes back-to-back
  (the unsubscribe driver). Complements `FREQ_CAP_PER_DAY` (volume) with spacing. Lives in
  `filterByCap` (`src/lib/cap.ts`) → new `cooled` bucket, surfaced in the `/api/send` result
  + `CAMPAIGN_DISPATCHED` audit metadata. Merged to `main` (`4dc4af2`); `MIN_GAP_MINUTES=30`
  set on Railway. **No live effect until `SEND_MODE=live`** (capture_only = no auto-sends).
  NOTE: `breaking:true` does NOT bypass the cooldown (still subject to cap + cooldown) — one-
  line change if we ever want urgent sends to interrupt.
- ✅ **Admin SPA made mobile-responsive (2026-06-08).** The nav was a non-wrapping desktop row
  that overflowed phones. Now a hamburger menu on mobile (`NavBar.vue`; desktop unchanged via
  `display: contents`) + a shared `@media (max-width:720px)` block in `app.css` (wrapping
  toolbars, tighter padding, denser tables). Verified at 390px via headless Chromium. Merged
  to `main` (`61779c9`).
- ✅ **User-management Phase 8 (email invites) shipped & verified in production (2026-06-08).**
  Admin invites a teammate by email → single-use, 72 h, hashed token (separate `UserInvite`
  table) → recipient clicks `…/admin/accept-invite?token=…`, sets their own password, and is
  auto-logged-in. Resend/Revoke + a Pending-invites panel on the Users screen. Mail goes via
  ElasticEmail v4 transactional; if unconfigured/failed it degrades to a copyable link.
  Merged `develop → main` (`5689769`). Full suite green (193 tests). With Phase 8 done, the
  only remaining plan item is the always-optional cryptographically-chained audit upgrade.
  - **ElasticEmail prod config (set in Railway on the `taxscan-push` service):** `APP_BASE_URL`,
    `ELASTICEMAIL_API_KEY` (⚠️ **send-only key** — can't read account/logs/stats via API; use the
    ElasticEmail dashboard for delivery logs), `EMAIL_FROM=no-reply@taxscan.in`, `EMAIL_FROM_NAME`,
    `INVITE_TTL_HOURS=72`.
  - **Delivery gotcha (resolved):** first sends returned `emailSent:true` but didn't arrive —
    `emailSent:true` only means the API *accepted* the request. Delivery started once the
    ElasticEmail sending domain/account was verified. Yahoo is stricter than Gmail (enforces
    SPF+DKIM+DMARC) — confirm those stay green for `taxscan.in`.
- ✅ Backend deployed to Railway at `https://taxscan-push-production.up.railway.app`
- ✅ Admin SPA live at `/admin/`, login working
- ✅ Test-residue subscribers cleaned up
- ✅ ADMIN_TOKEN rotated (the one in chat history is dead — production has the new value)
- ✅ Vendor (Hocalwire) **shipped the 4-item brief cleanly** — iZooto fully removed from site templates, `/sw.js` at taxscan.in root, `TAXSCAN_PUSH_CONFIG` block + SDK reference in `<head>` of every page (spot-checked homepage + 3 article-section pages on 2026-06-06: all carry the block, 0 iZooto fingerprints).
- ✅ **Cutover blocker found and fixed (2026-06-06).** The SDK was failing to execute on live pages — root cause was helmet's default `Cross-Origin-Resource-Policy: same-origin` on Railway origin, which the browser enforced as `ERR_BLOCKED_BY_RESPONSE.NotSameOrigin` whenever Hocalwire's `Utils.loadScripts` injected the `<script>` into a `www.taxscan.in` page. Curl always worked (CORP is browser-only). Fixed by overriding to `cross-origin` on the two SDK routes (`src/app.ts`); regression-locked by `src/__tests__/asset-headers.test.ts`. Deployed in commit `daa0af6` (+merge `ea5eef1`).
- ✅ **Live verification PASSED** end-to-end via Claude in Chrome — see `CUTOVER_LIVE_VERIFY.md` for the full report. SDK loads, runs, registers `/sw.js?api=…` as ACTIVE on scope `/`, soft prompt + focus trap + 7-day dismiss all working, granted-permission recapture path proven (FCM endpoint, no iZooto).
- ✅ **Reliable SDK delivery shipped (2026-06-06).** Cache headers on the two assets (`/taxscan-push.js`: `max-age=300, stale-while-revalidate=86400`; `/sw.js`: `no-cache`) so returning visitors aren't blocked on a cold Railway worker. GitHub Actions warm-ping workflow live on main, hitting `/healthz` every 5 min. README has the full "Reliable SDK delivery" section.
- ✅ **UptimeRobot monitor configured** for `/healthz`, 5-min interval. The "TEST: Monitor is DOWN" mail received during setup was UptimeRobot's contact-verification test, not a real outage.

## 🚀 WENT LIVE 2026-06-09

- **`SEND_MODE=live` flipped on the Railway `taxscan-push` service (2026-06-09).** The RSS poller now dispatches new articles to the ~1,100 ACTIVE subscribers. All gates were cleared: security audit + M1–M4 fixes deployed, dashboard perf (DB→Singapore + cache), privacy policy published, GA UTM tagging live, recapture climbing for days. Baseline at flip: `totals.sent=81` (manual tests only), 1,100 active. Backlog of capture_only DRAFT campaigns does NOT re-send (GUID-deduped) — only new articles from the next poll onward. Watch: `totals.sent` rising, delivery ≥95%, CTR, unsub <0.5%, and the GA `taxscan-push / push_notifications` row.

## ▶️ ACTION — 7-day post-go-live health watch (opened 2026-06-09) — ⛔ SUPERSEDED 2026-06-16

> **VOID — see the "DECOMMISSION CANCELLED" block at the top of this file.** The exit
> condition of this watch was "7 green days → decommission iZooto." That conclusion is
> wrong: the ~3M iZooto base is not migratable and self-hosted (~2K) is not at parity.
> Keep iZooto. The health gates below are still fine to monitor as channel-health KPIs,
> but they do NOT gate any iZooto cancellation. Do not act on the exit condition.

**Do this each session until closed.** Pull live metrics and check the four
go-live health gates below. If all stay green for **7 consecutive days
(through ~2026-06-16)**, proceed to Step 6 (decommission iZooto). If any gate
goes red, investigate before decommissioning — do NOT cancel iZooto early.

**How to check** (or just ask Claude to probe `/api/metrics`):
```
curl -s --resolve taxscan-push-production.up.railway.app:443:69.46.46.113 \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  https://taxscan-push-production.up.railway.app/api/metrics
```

| Gate | Threshold | Baseline at first live send (2026-06-09 ~13:32) |
|------|-----------|--------------------------------------------------|
| Delivery rate | **≥ 95%** | 96.9% ✅ |
| Unsubscribe rate | **< 0.5%** | 0.09% ✅ |
| CTR | **~4–6%** (builds over hours/days) | too early at flip |
| Active subscribers | **stable or growing** | 1,057 after first-send prune; recapture climbing (1,123) |

Notes for whoever reads this next:
- A one-time `expired`/`failed` bump on the **first** live send is EXPECTED — it
  flushed ~75 dead endpoints accumulated during capture_only. Not a red flag;
  delivery should hold/improve as the base self-cleans.
- Old capture_only `DRAFT` campaigns are inert (GUID-deduped) — only new
  articles dispatch. Confirmed at go-live.
- GA: confirm the `taxscan-push / push_notifications` row is populating in
  Traffic acquisition (UTM tagging is live).

**Exit condition:** 7 green days → run Step 6 (Decommission iZooto) below, then
delete this ACTION block.

## What's NOT done yet

- ~~`SEND_MODE` capture_only~~ → now `live` (see above).
- ✅ **Privacy policy page updated on taxscan.in (2026-06-09).** This go-live precondition is now cleared.

### Deferred — decided to take up later (2026-06-09)

- **Known Issues #1–#4** are parked by decision. None block go-live. See `KNOWN_ISSUES.md` for the full writeups; the two worth re-surfacing around go-live:
  - **#1 Vendor follow-up:** Hocalwire wraps our SDK in their `Utils.loadScripts` async loader, which injects the `<script>` tag **20-28 s after navigation**. Visitors who bounce inside that window never load the SDK. Eventual ask: render `<script src="…taxscan-push.js" defer>` statically in `<head>` next to the `TAXSCAN_PUSH_CONFIG` block.
  - **#2 Ghost-subscriber hardening:** the SDK's `ensureSubscribedSilently` short-circuit (`public/taxscan-push.js` lines 137-150) can leave a "browser-side ghost" if a prior `POST /api/subscribe` failed and was never retried. Mitigation idea: a `GET /api/subscriber/exists?endpoint=…` probe. Measure via the recapture counter first.

## What runs by itself while I'm away

- RSS poller (every 5 min) — captures new articles as DRAFT campaigns.
- Sweeper (every 1 min) — nothing scheduled, no-op.
- Railway healthcheck — keeps the app warm.
- **GitHub Actions warm-ping workflow** (`*/5 * * * *` UTC) — hits `/healthz` to keep the Railway worker hot.
- **UptimeRobot monitor** (5-min interval) — independent second pinger of `/healthz`.

---

## When vendor confirms "shipped" — run this verification (Phase C from Task 12 runbook)

*(Already completed on 2026-06-06 — see `CUTOVER_LIVE_VERIFY.md` for the full report. Steps preserved below for reference if you re-verify after the vendor's loadScripts-delay follow-up lands.)*

**Use a clean Chrome Incognito window** for all five steps.

1. **Open https://www.taxscan.in/** → DevTools → Application → Service Workers
   - ✅ Pass: active SW at `https://www.taxscan.in/sw.js?api=https%3A%2F%2Ftaxscan-push-production.up.railway.app`
   - ❌ Fail: no SW, or iZooto SW still listed → screenshot to Claude

2. **DevTools → Network → filter "izooto" → reload**
   - ✅ Pass: zero matches
   - ❌ Fail: any `*.izooto.com` request → screenshot to Claude

3. **Click any article → scroll ~50% OR wait ~30s**
   - ✅ Pass: bottom-right banner "Get notified of new GST & Income Tax rulings?"
   - ❌ Fail: nothing after 60s → screenshot console to Claude

4. **Open admin dashboard in another tab, refresh every 10 min for first hour**
   - ✅ Pass: `recapture` count climbs (returning iZooto-granted users auto-migrate)
   - ❌ Fail: both `recapture` and `soft-prompt` stay at 0 for hours → paste metrics to Claude

5. **End-to-end smoke**
   - Accept the soft prompt + native prompt in the incognito window
   - Refresh admin → `Active subscribers` ↑1, `soft-prompt` ↑1
   - Admin → Compose → send a test (`target: all`, `breaking: true`) → notification arrives within seconds
   - Click it → URL opens, dashboard shows CLICKED

---

## When verification passes — go live

**Conditions to flip `SEND_MODE=live`:**
- ✅ All 5 verifications above passed (2026-06-06)
- ✅ Privacy policy page is published (done 2026-06-09)
- ✅ Pre-go-live security audit run + the 4 mediums fixed (2026-06-09; see `SECURITY.md`)
- ⏳ Security fixes committed to `develop` and merged/deployed to `main` (Railway)
- ⏳ `recapture` count has been climbing for 24-48 hours (the migration window) — verify before flipping

> **Capture keeps running after go-live.** `SEND_MODE` gates ONLY the RSS poller's
> dispatch (`src/services/poller.ts:150` — the single behavioral use; the other
> ref is just env parsing). Subscription capture — recapture, soft-prompt,
> `pushsubscriptionchange` — flows through `POST /api/subscribe`, which never reads
> `SEND_MODE`; it's driven by the browser SDK on every taxscan.in page load.
> Flipping to `live` therefore keeps capturing AND starts sending: each dispatch
> calls `resolveTargets` (`src/services/send.ts:80`) which queries ACTIVE
> subscribers at send time, so newly-recaptured users are automatically included
> in subsequent sends. (Recapture naturally tapers as the finite pool of
> iZooto-granted browsers migrates / once iZooto is decommissioned — not caused by
> the flip.)

**How to flip:**
- Railway dashboard → `taxscan-push` service → Variables tab → `SEND_MODE` → change `capture_only` → `live` → Save
- Wait ~30s for auto-redeploy
- Check admin → `totals.sent` should start rising as next RSS poll fires (~5 min)

**Don't flip during a publish burst** — pick a calm moment so queued articles don't fire all at once.

---

## Step 6 — Decommission iZooto (much later) — ⛔ DO NOT DO THIS (cancelled 2026-06-16)

> **Cancelled.** Decommissioning iZooto deletes its subscriber data and drops reach
> from ~3M to ~2K permanently, because the base cannot be migrated (origin+VAPID
> binding). Keep iZooto running as the primary channel. See the top-of-file block.
> The original (now-void) plan is preserved below for context only.

Wait minimum **7 days** after going live. Check:
- Active subscribers growing or stable
- Delivery rate green (≥95%)
- CTR green (≥4-6%)
- Unsubscribe rate green (<0.5%)

If all four are green for 7 consecutive days → log into iZooto, archive the property. Cancelling deletes iZooto's subscriber data — fine because our base is rebuilt.

---

## Key references for resumption

- **Domain**: `https://taxscan-push-production.up.railway.app`
- **Admin URL**: `/admin/` — per-user email + password login (cookie sessions). `ADMIN_PASSWORD`
  was retired in Phase 5. Bootstrap an admin with `npm run create-admin`; add teammates from the
  Users screen via "Create user" (temp password) or "Invite user" (emailed accept link).
- **Public DNS hack** (if domain doesn't resolve): `--resolve taxscan-push-production.up.railway.app:443:69.46.46.113` on any `curl`
- **Repo**: this directory, on branch `develop` (main + develop are in sync at last push)
- **README** in this repo has the full system documentation
- **SECURITY.md** has the audit + ongoing security checklist

## Bring these to a fresh Claude session

1. "I'm in Task 12, waiting on vendor. Here's NEXT_STEP.md content: [paste this file]"
2. Vendor reply (paste verbatim or screenshots)
3. Current dashboard metrics — fetch with:
   ```
   curl -s --resolve taxscan-push-production.up.railway.app:443:69.46.46.113 \
     -H "Authorization: Bearer <ADMIN_TOKEN>" \
     https://taxscan-push-production.up.railway.app/api/metrics
   ```

Claude will slot back in at the right step.
