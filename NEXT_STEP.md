# NEXT_STEP.md — Where I am in Task 12

Snapshot for resuming work after a break. Update this file whenever the
status changes so a fresh Claude session can pick up cleanly.

---

## ▶️ NEXT STEPS / open items (as of 2026-06-19)

-2. **✅ SHIPPED 2026-07-10 — custom date-range reports (Reports → "Custom" tab).** Editors can
   now pick any From/To window of up to **30 days** (both ends inclusive, IST; "To" may be
   today for a so-far-today look) and see the same Category×dates + Bench×dates report.
   Backend: `customReportWindow()` in `reports.ts` validates the range (format, calendar
   validity, order, future, 30-day max) and the route accepts
   `GET /api/reports?period=custom&from=YYYY-MM-DD&to=YYYY-MM-DD` (400 with a human message
   on a bad range); the vs-previous insight compares against the equally-long window
   immediately before. Report cache is now keyed by window (custom ranges cache separately;
   expired entries pruned). SPA: third "Custom" segment with two date pickers + Apply,
   prefilled to the last 7 days, client-side inline validation mirroring the server's;
   "Email me a test" stays Weekly/Monthly-only (scheduled emails unchanged). Verified
   headless end-to-end (API + built SPA via Playwright). Suite 298/298.

-1. **✅ SHIPPED 2026-07-07 — richer report category rows (PR #28, `5661672`).** Data till date
   showed (a) taxscan's feed emits ONE comma-joined `<category>` string, so the un-aliased
   guides section appeared as a raw `Other Taxations,Top Stories` row (18 in June, 8 last
   week) — now aliased to a clean **Other Taxations** row (tag wins over title inference, so
   TDS/ITR-titled guides move here from Income Tax); and (b) **Uncategorized was ~10% of the
   week** (24/248; steady 3–7/day) — tag-less reconciler captures whose titles carry no tax
   keyword. New title rules: **Audit/Profession** (tax audit/ICAI/CA-firm pieces), **JobScan**
   (vacancy/recruitment), and activation of the five dormant alias labels (**Benami/PMLA,
   FEMA, International Tax/TP, Labour Law, Round-Ups/Digests**) that taxscan's tags never
   emit. Ordering: content forms → specialist subjects → broad tax → profession vocab last
   ("GST audit" stays GST). Report-only (categories computed at report time; history
   reclassifies automatically). Verified on the live sitemap (75 titles): Uncategorized 2→0.
   Suite 294/294.

0. **✅ SHIPPED & VERIFIED LIVE 2026-06-23 — coverage reports count each article ONCE
   (PR #26, `4432cd5`, merged to `main` + deployed).** The reports counted every Campaign row,
   so the morning backfill (which clones yesterday's article into a fresh row keeping the
   original `createdAt`) and manual re-pushes **double-counted** articles — confirmed live (20
   duplicate-title `auto`/`SENT` pairs with identical-ms `createdAt`). Fix in
   `src/services/reports.ts`: `buildReport` now dedupes to **one row per unique article URL**
   (keeps the richest-classified row — the clone drops `categories`, so the original's RSS
   category survives — and buckets on the earliest capture instant); `prevTotal` is a distinct-URL
   count too. **academy/shop storefront pushes excluded** (non-articles, by URL host). Counting
   stays by **capture date** (`createdAt`), not push date. **Production verification:** weekly
   `total` dropped **224 → 193** (31 re-sends/storefront collapsed), heatmap grand-totals both
   match 193 (dedup flows through the heatmaps), `prevTotal` legitimately unchanged at 159 (the
   06-09→06-15 week predates the 06-18 backfill, so no clones to collapse). No DB migration, no
   env-var change, internal-only — zero subscriber impact. Suite 290/290.

1. **✅ DONE 2026-06-19 — responsive-design audit across all admin pages (was TOP priority).**
   Audited all 6 pages (Dashboard/Compose/Review/Queue/Campaigns/Reports) headless via
   Playwright (real built SPA, mocked `/api/**`) at **390 / 768 / 1024 / 1100px**, asserting
   zero page horizontal overflow. **Two real bugs found + fixed (merged to `main` + live):**
   - **Reports** (commit `ad7f001`): `.insights` was `repeat(4,1fr)` → the 4th card (`32·45·4`
     unbreakable middot string) clipped off the right edge on phones; and the two heat tables
     overflowed the document (no scroll container, unlike `.card`). Fix: insights wrap via
     `auto-fit minmax(150px,1fr)` (2-up phone / 4-up tablet+); each heat table now lives in a
     `.heat-scroll` wrapper. The WhatsApp PNG is preserved — `renderPng()` adds an `.exporting`
     class that drops the scroll clip and captures at full content width (desktop output byte-
     identical; mobile export now complete).
   - **Nav bar, ALL pages** (commit `ee69b0f`): the hamburger only engaged at ≤720px, so the
     full desktop nav row (8 links + account + utils, intrinsic ~1100px) **overflowed the whole
     721–1100px tablet band by ~315px** (iPad portrait 768 + landscape 1024). Fix: raised the
     hamburger breakpoint to **≤1024px** (split the nav-collapse rules into their own media
     query; content tweaks stay at 720/480) + `flex-wrap` on `.nav` as a safety net for the
     1025–1100 sliver. After: 0 overflow at every width on every page.
   - Everything else (Campaigns 10-col table, Queue, Review pipeline strip, Compose flags,
     Dashboard metric grid) was already clean — dense tables scroll inside their `.card`
     (`overflow-x:auto`); no changes needed.
   Re-run harness: `admin/` Playwright + `chromium` from `@playwright/test`, fixtures in
   `/tmp/fix-*.json` pulled from prod via ADMIN_TOKEN in repo `.env`.
2. **✅ DONE 2026-06-19 — reconciler CONFIRMED closing the gap (was: verify it had).** Method:
   fetched `news-sitemap-daily.xml` (rolling ~2-day window: 30 on 06-17, 34 on 06-18, 2 on
   06-19 = 66 entries) and cross-checked every `<news:title>` against the captured campaign
   titles from `GET /api/campaigns?limit=200`. Result: **65/66 captured**; the only gap was a
   06-19 article published minutes earlier, pending the next `*/20` reconcile cycle (normal
   lag, not a miss). The 06-18 captured count had risen **43 → 54** since the evening the
   verification poll was stopped — i.e. the reconciler kept ingesting; we now hold MORE for the
   18th (54) than the rolling sitemap still exposes (34). `totals.expired=1170` confirms
   retention is live too. **Gotcha for re-runs:** sitemap `<news:title>` is CDATA-wrapped and
   the report buckets by *capture date* (createdAt) while the sitemap groups by *publish date*,
   so per-day counts won't line up exactly — match by title (CDATA-stripped, normalized), not
   by per-day totals. No action needed; reconciler + retention working as designed.
3. **✅ DONE 2026-06-19 — "Refresh fails / site won't load" investigated + fixed (Dashboard +
   Reports), plus the Dashboard & Campaigns "missing records" bug.** All merged to `main` + live.
   Three fixes:
   - **Refresh resilience** (commit `69bd496`) — the shared `useApi` fetch had no timeout, no
     retry, and surfaced an expired session as a cryptic banner. Now: 15s per-attempt timeout
     (AbortController), up to 2 backoff retries on network err / 502 / 503 / 504 (GET/HEAD only),
     and 401 → redirect to `/login?reason=expired` with a "session expired" notice. Applies to
     Refresh on **every** page (identical `load()` pattern everywhere).
   - **`/api/reports` cache** (commit `69bd496`) — `getReport` wraps `buildReport` with a 60s
     in-process cache (`REPORTS_CACHE_TTL_MS`, 0 under test), mirroring `/api/metrics`.
   - **"Recent campaigns" / Campaigns list missing records** (commits `884f23c` Dashboard,
     `783a039` Campaigns) — both were sourced from the newest-N **by capture time** but shown
     **by push time**, so a campaign pushed recently yet captured earlier (pacer sends
     oldest-first; backfill + manual Push-now replay old drafts) silently vanished. *Confirmed
     live:* 3 of the 5 most-recently-pushed campaigns were absent from prod `/api/metrics`. Fix:
     union in the most-recently-pushed campaigns via a SENT-event `groupBy` (dashboard last 7d
     take 10; list last 14d take 50, carrying the "Show only mine" filter). Regression test
     `metricsRecentCampaigns.test.ts`. Backend 288/288.
4. **✅ RESOLVED 2026-06-19 — keep-warm is reliable (cold-worker theory refuted).** UptimeRobot
   monitor on `…up.railway.app/healthz` confirmed active (screenshot): **5-min checks, 100%
   uptime over 7 & 30 days, 0 incidents, 12-day up-streak, ~290ms flat**. So the worker does NOT
   go cold — the throttled GitHub `*/5` ping is redundant (KNOWN_ISSUES #6 downgraded to a
   non-issue). The 2026-06-19 "Refresh failed" reports were therefore NOT a server outage; the
   prime remaining cause is the 8h session TTL (item 5).
5. **✅ DONE 2026-06-19 — session TTL raised 8h → 7 days (sliding).** `src/lib/sessions.ts
   SESSION_TTL_HOURS = 24 * 7`; stops the day-apart logouts that caused the "Refresh failed"
   reports. Active editors now stay signed in across the work week (sliding: each request resets
   the 7-day clock); the graceful 401→login handles the eventual idle expiry. Tests TTL-agnostic
   (assert via the constant); full suite 288/288.
6. **✅ CLOSED 2026-07-10 — morning backfill watch.** Enabled since 2026-06-18 with no churn
   signal: live unsubscribe rate **0.016%** (threshold <0.5%), delivery 99.4%, active
   subscribers grew ~2,200 → **2,436**. Re-sending prior-day content is not driving unsubs.
7. **✅ CLOSED 2026-07-10 — report emails confirmed landing.** The automated weekly
   **Monday 07:00 IST** email (first run 2026-07-06 at the new time, PR #27) arrived as
   expected; monthly 1st-07:00 uses the same scheduler path. Category heatmap has matured
   (title inference covers tag-less rows since PR #28).
8. **✅ CLOSED 2026-07-10 — retention at 3 days is working as designed.** `totals.expired`
   = 3,578 and climbing daily; no reports of editor-pending REVIEW items aging out before
   review. If that ever changes, the agreed remedy is exempting REVIEW from
   `expireStaleDrafts` rather than raising the global window.
9. **✅ MOOT 2026-07-10 — the two `[system] … URL check — ignore` campaigns** (empty portal,
   0 recipients, from the 2026-06-18 live academy/shop allowlist verification) are no longer
   reachable through the UI: the Campaigns API caps at the newest 200 rows and ~3 weeks of
   captures (~30–50/day) have pushed them out of the window; the default Pushed-desc sort
   sinks never-pushed rows anyway. Rows still exist in Postgres but deleting them would need
   a direct prod-DB query — decided not worth touching prod data. No metrics/report impact
   (0 events; academy/shop URLs are excluded from reports since PR #26).
10. **▶ IN PROGRESS 2026-07-11 — per-article read counts via GA4: Phase B SHIPPED (sync
   engine), Phase C (UI) next.** The user created the GCP service account
   (`taxscan-push-reads@taxscan-push-ga.iam.gserviceaccount.com`, Viewer on GA4 property
   258445828) and handed over the key JSON (repo root `ga-service-account.json`, gitignored
   via `*service-account*.json` — NEVER commit). A live probe proved access end-to-end:
   4,604 pages with views in 3 days; push attribution flowing (209 pages with
   `sessionSource=taxscan-push` views). **Phase B (this PR):** additive `ArticleReadStat`
   table (portal, pagePath, date, totalViews, pushViews, fetchedAt; unique per
   portal+path+date) + `src/services/gaReads.ts` — flag-gated (`GA_READS_ENABLED`) ~2h cron
   (`GA_READS_CRON=15 */2 * * *`) making ONE batched GA4 Data API call (pageviews by
   date×pagePath, unfiltered + filtered to our push UTM) over a rolling 3-day window
   (`GA_READS_LOOKBACK_DAYS`), replacing each returned date's rows wholesale in one
   transaction. Request path NEVER calls GA (GA failure = counts go stale, nothing breaks).
   Auth = plain service-account JWT (node:crypto) against the REST endpoint — deliberately
   NO `@google-analytics/data` dep, keeping `package-lock.json` untouched (Railway build-cache
   footgun). Creds: `GA_SERVICE_ACCOUNT_JSON` inline (Railway) or `GA_SERVICE_ACCOUNT_FILE`
   (local). Also runs one pass ~15s after boot so enabling is instantly verifiable.
   **To enable on Railway:** set `GA_SERVICE_ACCOUNT_JSON` (paste the key file's content) +
   `GA_READS_ENABLED=true`, then watch the deploy log for `[ga-reads] synced rows=…`.
   **Phase C part 1 — READS REPORT SHIPPED 2026-07-11 (same day):** Reports → **Reads** tab
   showing bench×window and category×window read heatmaps over trailing 1w/1m/3m/6m/12m
   windows — all-traffic GA pageviews on article pages (slug ends in the numeric id),
   classified from the headline with the coverage report's own rules, cells = reads + share
   of that window (blue intensity, sqrt-spread). Built daily 05:45 IST
   (`GA_READS_REPORT_CRON`) by `src/services/readsReport.ts` → `GaReadsReport` cache row
   (per portal); stale-aware boot pass (>12h). `GET /api/reports/reads` serves the cache and
   NEVER calls GA. Download/Copy image work; "Email me a test" stays Weekly/Monthly-only.
   Verified headless (390/1280px, zero overflow, real GA fixture). **Phase C remaining:**
   Reads / via-Push columns on Campaigns (join `ArticleReadStat` by URL path), per-category
   reads + top-10 most-read in the emailed weekly report.
   *(Original pause note, for context:)*
   Decision made: Google Analytics, NOT Hocalwire — probed taxscan's Hocalwire Public API live
   (s-id in `.env`: `HOCALWIRE_API_BASE`/`HOCALWIRE_S_ID`, gitignored): `getNewsDynamicProps`
   returns only editorial metadata (citation/coram/PDF — no view counts), `most_read` is empty,
   `buzz_count`=0. GA also survives the possible Hocalwire exit (join key = article URL, ours).
   GA4 property ID: **258445828**; push UTM (`taxscan-push / push_notifications`) already live.
   Agreed design: `GA_READS_ENABLED` flag, ~2h cron sync → ONE batched GA4 Data API call
   (pagePath × session source, rolling 3-day re-fetch) → additive `ArticleReadStat` table;
   request path never calls GA (zero perf impact; stale-tolerant). To resume: user creates a
   GCP service account (enable Google Analytics Data API, JSON key, Viewer on the property),
   then Phase B PR (migration + sync, flag off) and Phase C PR (Reads columns on Campaigns,
   per-category reads + top-10 most-read in reports).

> **All merged & live (as of 2026-06-23):** the reconciler verification doc, the responsive
> fixes (`ad7f001`, `ee69b0f`), refresh resilience + reports cache (`69bd496`), the missing-records
> fixes (`884f23c`, `783a039`), and the unique-article report counting (PR #26, `4432cd5`) are all
> on `main` and deployed. `develop` and `main` are in sync.

---

## What this system is + what's built (capability overview)

**What it is:** a self-hosted web-push notification platform for taxscan.in (a GST/Income-Tax
legal-news site), replacing/paralleling the third-party iZooto. Backend = Node 20 + TypeScript +
Express + Prisma/PostgreSQL on Railway; admin SPA = Vue 3 at `push.taxscan.in/admin`; push via the
`web-push` library (VAPID); RSS polling via `node-cron`. Architecture is portal-tagged so
academy/shop can plug in later. **Live in production since 2026-06-09; ~2,200 active subscribers.**

**What's been built:**
- **Capture** — browser SDK on taxscan.in (soft prompt, topic opt-in, recapture of iZooto-granted
  browsers, `pushsubscriptionchange`); every subscriber tagged with a `portal` + topics.
- **RSS → editorial classifier** (`classify.ts`) — polls 5 section feeds (corporate / gst /
  income-tax / customs / jobs) + the master feed (`RSS_FEED_NEWS` = taxscan.in/feed, all sections);
  stores each article's RSS `<category>` tags; classifies by TITLE into QUALIFIED (SC / priority
  HC = Bombay / other HC / regulatory) · FALLBACK (ITAT/CESTAT/NCLAT/NCLT) · REVIEW (analytical +
  job/recruitment posts).
- **No-miss reconciler + retention** (`reconciler.ts`) — a cron reconciles against taxscan's
  complete daily sitemap and captures any article the feeds missed (feeds show only ~11/poll);
  DRAFTs unsent within `RETENTION_DAYS` are archived (EXPIRED status) to bound the backlog.
  Reports infer category from the title when no RSS tag, so coverage stays accurate.
- **Editorial pacer** (`pacer.ts`) — 1 push per global 45-min slot, paced by quiet hours
  (23:00–07:00 IST) + spacing (~21/day; `DAILY_SEND_CEILING` disabled at 999 in prod as of
  2026-07-03, was 20), best-first (today → authority tier → oldest-published-first),
  defer-not-drop; morning backfill from yesterday (flagged off). Runs at cap=Infinity — the
  per-subscriber `FREQ_CAP_PER_DAY` (prod 30, was 4) gates only manual non-force `/api/send`.
- **Review queue** (`/review`) + **Send queue** (`/queue`) with **Push now**; a Captured → Review →
  Queue → Sent pipeline strip ties them together.
- **Manual Compose** — All/topic targeting, Breaking + Force, schedule-for-later, taxscan/academy/shop
  click URLs, and **Test on this device** (isolated preview to your own browser).
- **Dashboard** (health metrics + recent campaigns by push time), **Campaigns** (full sortable
  history, captured-vs-pushed times, **Source = Manual/Automatic** — Push-now is attributed to the
  editor), **Activity** (append-only audit), **Users** (RBAC, email invites, temp passwords).
- **Coverage reports** (`reports.ts` + `reportScheduler.ts`) — weekly + monthly Category×dates and
  Bench×dates heatmaps + insights (totals, vs-prev, gaps, quality split), counting every UNIQUE captured
  article by capture date (re-sends collapse by URL; academy/shop storefront pushes excluded).
  In-app **Reports** screen (Download/Copy image for WhatsApp) + emailed Mon 07:00 / 1st
  07:00 IST to app users + a report-only email list; INTERNAL (never to subscribers).
- **Admin user guide** — in-app `/guide` reader + downloadable PDF (`npm run build:guide`).
- **Security** — cookie-session auth + `ADMIN_TOKEN` (cron/curl), DB-level append-only audit log,
  push-URL allowlist, rate limits, helmet.
- **iZooto** — KEPT (its ~3M base is cryptographically un-migratable; self-hosted is a parallel,
  growing channel).

Deeper detail lives in `SEND_PACING_PLAN.md`, `KNOWN_ISSUES.md`, `README.md`, `SECURITY.md`, and the
auto-memory (which loads into every Claude session in this folder). History continues below.

---

## ✅ 2026-06-18 (latest) — Coverage Report feature SHIPPED & LIVE (PRs #15–#17)

Automates the manual weekly/monthly heatmap reports the team built by hand.
- **Phase 1 / ingestion (PR #15):** poll the master feed (`RSS_FEED_NEWS` on Railway) + store each
  article's RSS `<category>` tags (`Campaign.categories`, additive migration). Topic now derived from
  categories with feed fallback. Fewer missed pushes + complete report data. (`categories` only fills
  from 2026-06-18 onward, so the **category heatmap matures over ~a week**; the **bench heatmap is
  accurate immediately** since it's title-derived.)
- **Reports engine (PR #16):** `reports.ts` — Category×dates + Bench×dates heatmaps (`detectBench`
  reads specific HCs/tribunals/AAR from titles), insights (totals, vs-prev, gaps, quality split),
  counts EVERY captured article. `GET /api/reports?period=weekly|monthly`. In-app **Reports** screen
  with **Download/Copy image** (html-to-image) for WhatsApp.
- **Email delivery (PR #17):** `reportScheduler.ts` cron — **Mon 08:00 IST weekly + 1st 08:00 IST
  monthly** → all active app users + a report-only email list (`ReportRecipient`, admin CRUD on the
  Reports page), deduped. INTERNAL — never to push subscribers. `POST /api/reports/test-email` +
  "Email me a test" button to preview. Behind `REPORTS_ENABLED` (now ON; email is configured).
- Two additive migrations (`categories`, `report_recipients`). Suite 282/282.

**Action for the team:** click **"Email me a test"** on the Reports page to verify the email before
the first Monday run; add any report-only recipients there.

---

## ✅ 2026-06-18 (later) — more shipped & LIVE (PRs #10–#14)

All merged to `main`, deployed + verified in production. Suite 274/274. `develop` = `main`.
- **Academy & shop push links** (PR #11) — `ALLOWED_PUSH_HOSTS` widened (Railway + code default) to
  include `academy.taxscan.in` + `shop.taxscan.in`, so editors can push course/product URLs.
- **Clear send errors** (PR #11) — `/api/send` URL rejection now returns a human message listing the
  allowed sites; the SPA surfaces it (`apiErrorMessage`) instead of "Request failed: 400".
- **Test on this device** (PR #12) — replaces the old test-segment flow (which would've blasted the
  whole base, since ~all subscribers are "All news"). Admin enables push on their OWN browser and
  previews to only that device. `POST /api/send/test-device`, `admin/.../useTestDevice.ts`.
- **Dashboard recent campaigns by PUSH time** (PR #13) — was capture time; Captured column dropped there.
- **Morning backfill SHIPPED — FLAG OFF** (PR #10) — fills empty morning slots from yesterday (re-send
  SC → Bombay HC → other HC, else unsent other-category, else best-clicked), mornings-only until fresh
  arrives, once-each-then-rotate. `MORNING_BACKFILL_ENABLED` (default off) + `MORNING_BACKFILL_UNTIL`
  (12:00). **To enable: set `MORNING_BACKFILL_ENABLED=true` on Railway; watch unsub (re-sends prior-day content).**
- **Guide refreshed** (PR #14) for all of the above.

**Key finding:** ~all subscribers carry only the **"All news"** topic, so any topic/"test" send folds
into the full base — there is no small audience except the isolated on-device test. (Two harmless
`[system] … URL check — ignore` campaigns from a live academy/shop verification sit in the Campaigns
list, empty portal, 0 recipients.)

---

## ✅ 2026-06-18 — Editorial UX batch SHIPPED & LIVE (verified on Railway)

The editorial send-pacing pipeline is **confirmed live and working** — this supersedes any
"rollout pending" framing further down. Today's batch is merged to `main` and deployed
(PRs #5 `6b54cab`, #6 `a3a47fe`), 257/257 tests, **no DB migration, no new env vars**, all
behind the existing `PACER_ENABLED`/`RSS_EDITORIAL_FILTER` flags:

- **Send order = oldest-published-first** within the same day + authority tier (was
  newest-first), so a same-day cluster of qualified rulings goes out in publish order.
  Today-before-backlog and SC→HC→regulatory precedence unchanged. (`pacer.ts` `rankQualified`.)
- **Priority high courts** — Bombay HC auto-jumps ahead of other High Courts (just below the
  Supreme Court). Config list `PRIORITY_HIGH_COURTS` in `classify.ts` — add Delhi etc. to extend.
  Tiers: 1 SC · 2 priority HC · 3 other HC · 4 regulatory/approved.
- **Queue screen** (`/queue`) — pending qualified/fallback articles in send order, each with
  **Push now** (full-reach force). `GET /api/queue`, `POST /api/queue/:id/push`.
- **"Pushed" time** everywhere campaigns show (Dashboard, Campaigns, detail) — distinct from
  "Captured" (capture time). `CampaignStat.sentAt` = earliest SENT event.
- **Campaigns table = clickable sortable columns** (Captured / Pushed / Sent / CTR / …;
  default Pushed desc). The Queue screen stays the pure upcoming-in-send-order view.
- **Guide** menu now opens an in-app HTML reader (`/guide`) with a Download-PDF option
  (`GET /api/guide.html`; `/api/guide?download`). Was: opened the PDF directly.
- **Campaigns table**: clickable sortable columns (Captured / Pushed / Sent / CTR / …), and a
  fix for the last column (Delivery) being clipped (wider `.page-wide` + compact dates).
- **Review & Queue clarity**: a `Captured → Review → Queue → Sent` pipeline strip on both
  screens (current stage highlighted) + cross-referencing descriptions, so their roles are obvious.
- **Job / recruitment posts → Review.** Job-scan titles (vacancy/hiring/recruitment/walk-in/
  internship/job opening) classify to REVIEW *before* the authority rules, so even "ICAI
  Recruitment" never auto-sends — an editor decides. ("Job Work under GST" is NOT a job post.)
  The **job-scan feed is wired** (`RSS_FEED_JOBS=https://www.taxscan.in/job-scan/feed` on
  Railway; poller now watches **5 feeds**), and job posts **target ALL subscribers** (no "jobs"
  topic exists). Verified live ~15:10 — vacancies now land in the Review queue. NOTE: enabling a
  brand-new feed captures its whole current list on the first poll (all REVIEW drafts — expected).
- Tracked the previously-untracked root state docs (+ `docs/archive/`), added a manual-push
  "leave Target on **All subscribers**" checklist to the admin guide, and an
  `npm run build:guide` script (Chrome headless HTML→PDF).

**Verified live ~14:00 IST:** pacer firing ~1 push / ~46 min (11 by 14:00, < 20/day ceiling);
Bombay HC sent ahead of Karnataka HC (priority working); active **2,213**, delivery **97.5%**,
unsub **0.03%**, recapture **3,076**, CTR **~0.64%**. `develop` and `main` are IN SYNC.

**Editor notes:** manual force-pushes (e.g. ICAI results) reset the 45-min spacing clock and
count toward the 20/day ceiling. Capture time ≠ push time — sort Campaigns by **Pushed** to
see real send activity. iZooto stays (see below — base not migratable).

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
