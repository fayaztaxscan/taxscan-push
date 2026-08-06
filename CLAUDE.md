# Project: Taxscan Web Push Platform

## What this is
A self-hosted web push notification service. Phase 1 target is taxscan.in only.
Architecture must stay portal-agnostic so academy.taxscan.in (WooCommerce) and
shop.taxscan.in (Shopify) can be added later without rework.

## Current state (updated 2026-08-06) — LIVE in production
Deployed on Railway; admin SPA at `push.taxscan.in/admin`. Live since 2026-06-09,
~2,400 active subscribers (delivery ~99%, unsub ~0.02%). **iZooto runs in parallel and
stays** — its ~3M base is cryptographically un-migratable (origin+VAPID bound); do NOT
plan to decommission it.

**What's been built:**
- **Capture** — browser SDK on taxscan.in (soft prompt, topic opt-in, recapture of
  iZooto-granted browsers, `pushsubscriptionchange`).
- **RSS → editorial classifier** (`src/services/classify.ts`) — polls 5 section feeds
  (corporate / gst / income-tax / customs / jobs) PLUS the master feed (`RSS_FEED_NEWS`
  = taxscan.in/feed, all sections); stores each article's RSS `<category>` tags and routes
  by TITLE into QUALIFIED (SC / Bombay-priority HC / other HC / regulatory) · FALLBACK
  (ITAT/CESTAT/NCLAT/NCLT) · REVIEW (analytical + job/recruitment posts, editor-decided).
- **Editorial pacer** (`src/services/pacer.ts`) — 1 push per global 45-min slot, paced by
  quiet hours (23:00–07:00 IST) + spacing (~21/day max; the `DAILY_SEND_CEILING` hard cap is
  now disabled at 999 in prod — it was 20 but redundant), best-first (today → authority tier →
  oldest-published-first), defer-not-drop; morning backfill from yesterday (behind
  `MORNING_BACKFILL_ENABLED`). Runs at cap=Infinity, so the per-subscriber `FREQ_CAP_PER_DAY`
  gates ONLY manual non-force `/api/send` (prod=30, raised from 4 on 2026-07-03).
- **No-miss reconciler + retention** (`src/services/reconciler.ts`) — feeds expose only ~11
  items/poll, so a cron reconciles against taxscan's complete daily sitemap and captures any
  missed article (behind `RECONCILER_ENABLED`); DRAFTs unsent within `RETENTION_DAYS` are
  archived (EXPIRED status). Reports infer category from the title when no RSS tag.
- **Coverage reports** (`src/services/reports.ts` + `reportScheduler.ts`) — weekly + monthly
  Category×dates and Bench×dates heatmaps + insights (totals, vs-prev, gaps, quality split),
  counting every UNIQUE captured taxscan.in article by capture date (re-sends — e.g. the
  morning backfill clone or a manual re-push — collapse by URL; academy/shop storefront
  pushes are excluded as non-articles). Category rows (2026-07-07, PR #28): taxscan's feed
  emits ONE comma-joined tag string, aliased to clean rows incl. "Other Taxations" (guides);
  title inference covers tag-less reconciler captures — Audit/Profession, JobScan, and the
  once-dormant Benami/PMLA / FEMA / International Tax/TP / Labour Law / Round-Ups/Digests.
  In-app **Reports** screen (Weekly / Monthly / **Custom** — any date range up to 30 days via
  `?period=custom&from&to`, validated server-side; Download/Copy image for
  WhatsApp) + emailed Mon 07:00 IST / 1st 07:00 IST to app users + a report-only email list
  (`ReportRecipient`); INTERNAL — never to subscribers. Behind `REPORTS_ENABLED`.
- **GA4 read tracking (PRs #33–#36, 2026-07-11, all LIVE)** — per-article pageview counts
  from the GA4 Data API (property 258445828), behind `GA_READS_ENABLED`. Four pieces, one
  invariant: **the request path NEVER calls GA** — crons mirror GA into Postgres, requests
  read Postgres, a GA outage only staleness. (1) `src/services/gaReads.ts`: ~2h cron →
  `ArticleReadStat` (portal, pagePath, date, totalViews + push-attributed pushViews; rolling
  `GA_READS_LOOKBACK_DAYS=3`, one-time 30-day backfill done). Zero-dep auth: service-account
  JWT via node:crypto (deliberately no `@google-analytics/data` — keeps package-lock
  untouched). Creds = `GA_SERVICE_ACCOUNT_JSON` on Railway / gitignored
  `ga-service-account.json` locally — NEVER commit. (2) **Reports → Reads tab**: bench×window
  + category×window read heatmaps over trailing 1w/1m/3m/6m/12m windows (headlines classified
  with the coverage report's own rules), built daily 05:45 IST by `readsReport.ts` into the
  `GaReadsReport` cache row, served by `GET /api/reports/reads`. (3) **Campaigns**: sortable
  Reads + via-Push columns (`listCampaigns` sums `ArticleReadStat` by taxscan URL path;
  "—" = no data ≠ 0). (4) **Coverage email**: "How it was read" section (reads by category +
  top-10 most-read; failure never blocks the email).
- **Admin SPA** — Compose (All/topic targeting, Breaking/Force, schedule, taxscan/academy/
  shop click URLs, **Test on this device** isolated preview), **Review queue**, **Send queue**
  (Push-now), **Dashboard**, **Campaigns** (sortable; captured vs pushed time; Source =
  Manual/Automatic — Push-now sets `createdByUserId`), **Reports**,
  **Activity** (audit), **Users** (RBAC + email invites), in-app **Guide** (+ downloadable PDF).
  Responsive phone→tablet→desktop (nav collapses to a hamburger ≤1024px). "Recent campaigns"
  (Dashboard) and the Campaigns list union in recently-PUSHED items so they aren't dropped by
  the capture-time window.
- **Resilient data fetch** — the shared `useApi` adds a 15s timeout + retry (network/502/503/504,
  GET-only) and routes a 401 to `/login?reason=expired`, so a cold worker / flaky connection no
  longer leaves Refresh stuck or "failed to load". `/api/metrics` (20s) and `/api/reports` (60s)
  are short-TTL cached.
- **Security** — cookie-session auth + `ADMIN_TOKEN` (cron/curl), DB-level append-only audit
  log, push-URL allowlist (`ALLOWED_PUSH_HOSTS`, incl. academy/shop), rate limits, helmet.

**Live flags (Railway):** `SEND_MODE=live`, `RSS_EDITORIAL_FILTER`/`PACER_ENABLED`=ON,
`RSS_FEED_NEWS`=master feed, `REPORTS_ENABLED`=ON, `MORNING_BACKFILL_ENABLED`=ON,
`RECONCILER_ENABLED`=ON, `RETENTION_DAYS`=3, `DAILY_SEND_CEILING`=999 (ceiling disabled;
quiet-hours+spacing pace the pacer), `FREQ_CAP_PER_DAY`=30 (was 4; manual non-force path only),
`MIN_GAP_MINUTES`=0, `GA_READS_ENABLED`=ON + `GA_SERVICE_ACCOUNT_JSON` +
`GA_READS_LOOKBACK_DAYS`=3. (`METRICS_CACHE_TTL_MS`=20s and
`REPORTS_CACHE_TTL_MS`=60s default in code; not set on Railway.)

**Surfaces rebuilt for stakeholders — BUILT + TESTED 2026-08-06, awaiting deploy (on `develop`).**
Three asks: data from 01-Jan-2026, a custom date filter, month-to-month comparison. **The backfill is
already IN PRODUCTION** (data only): `ArticleSurfaceStat` 3,744 → **31,832 rows**, 2026-01-01 →
2026-08-06, via the new committed `scripts/backfill-surfaces.ts` (month-by-month, idempotent,
replaces the raise-the-lookback env dance). **Discover clicks fell 954,691 (Jan) → 138,837 (Jul),
−85% in seven months** — an SEO/editorial conversation, not a bug. The tab's columns are now
**calendar months** (cumulative trailing windows structurally hid that trend), capped at 18, with the
current month flagged partial; `?from&to` gives a custom range against the equally-long span before
it (400-day cap, validated by `customSurfacesWindow`); each row carries a trend sparkline before its
numbers and a Δ against the last complete month. `syncSearchSurfaces` gained explicit
`startDate`/`endDate` — **its `now` also signs the service-account JWT, so back-dating it to fetch
history gets the token rejected**. The payload now states `compare: {current, base}` because the two
modes order columns differently and the client's own inference silently INVERTED every range delta.
Guide → v1.3. Suite **382**.

**Open next steps: NO code items open once the above deploys. Dead-link guards
SHIPPED + LIVE 2026-07-28 (PR #42, both flags ON). One item still sits with the user: send the
editorial note.**

**Session cookie expiry — SHIPPED + LIVE 2026-08-06 (PR #50, merge `42db65d`).** Editors were being
logged out ~daily despite the 7-day sliding session, because of the COOKIE, not the session row:
(1) `SESSION_COOKIE_MAX_AGE_MS` stayed at 8h when `SESSION_TTL_HOURS` went 8h → 7 days (2026-06-19),
so the browser dropped the cookie first and the slide was unreachable — now derived from
`SESSION_TTL_HOURS`; (2) the cookie was written only at login, so it never actually slid —
`requireUser` now re-issues it (**same token, only the expiry moves**) as soon as the session
validates, before the role/reset checks, so cookie and DB expiry are always the same instant. The
cookie helpers live in `src/lib/auth.ts` as the SINGLE definition (`clearCookie` only matches
attributes it was written with), and `clearSessionCookie` strips the slide header logout would
otherwise race with. Backend-only: no schema/env/flag change. **Not retroactive** — old 8h cookies
can't be amended remotely, so each editor gets one more early logout and picks it up at next login.
**Can't be verified from outside** (Set-Cookie only appears on a successful login); check via
DevTools → Cookies → `tx_push_session` → Expires ~7 days. Suite **371**.

**Google Discover / News tracking — SHIPPED + LIVE 2026-08-05 (PRs #46/#47).** Discover turned out
to be taxscan.in's biggest Google channel: **109,125 clicks/28d (84%) vs Search 19,752 (15%) and
Google News 1,075 (0.8%)** — 5.5× Search, and invisible in GA4 by construction (a Discover click
carries a plain google.com referrer, so GA4 files it as `google / organic`; the Google app strips
the referrer into `(direct)`). Search Console's `type` parameter is the only authoritative split.
`ArticleSurfaceStat` + `searchSurfaces.ts` (flag-gated ~6h cron, same never-call-Google-on-the-
request-path invariant as GA reads) feed a fifth **Surfaces** tab on Reports: Discover/News clicks
by category and bench over trailing windows + most-surfaced articles. Deliberately NOT columns on
Campaigns — Search Console has no data at all for the newest 2-3 days, so fresh rows would always
read as no-data. Flags: `SEARCH_CONSOLE_ENABLED`=ON, `SEARCH_CONSOLE_SITE_URL`=`https://www.taxscan.in/`
(URL-prefix property), `SEARCH_CONSOLE_LOOKBACK_DAYS`=7. **⚠️ OPEN: a one-off history backfill** —
the rolling 7-day lookback means every window currently shows the same ~8 days; raise the lookback,
run one sync, put it back (see `NEXT_STEP.md` item -6). The panel is honest about this meanwhile
via `dataFrom`. **Superseded 2026-08-06 — the backfill is done and the tab is month-based; see the
Surfaces-rebuild note above.**
A tapped notification hit taxscan's 404: the desk published one story twice (two ids/slugs), GUID
dedupe can't see a re-post so the second copy pushed as fresh news, then the desk deleted one of the
two posts. Not a URL bug on our side — and note taxscan resolves articles by the **trailing id and
301s any slug**, so only an actual deletion can break a pushed link. GA4 measured 2 dead pushes in
14 days (~1.5% of ~129), each to ~2,550 subs. Shipped behind two flags (suite 338/338):
`DUPLICATE_TITLE_GUARD_ENABLED` (repeat headline within `DUPLICATE_TITLE_WINDOW_HOURS`=72 → REVIEW,
defer-not-drop) and `LINK_CHECK_ENABLED` (pacer HEADs the URL pre-dispatch, archives a deleted
article as EXPIRED, reason `dead_link`; **fail-open** — only 404/410 count). **Both flags set true
on Railway 2026-07-28 13:23 UTC; verified live** — poll lines now log `duplicates=` (a field that
exists only in the new build). **Residual gap needs editorial, not code:** a notification already
delivered can't be edited, so taxscan must **301-redirect removed duplicates to the survivor**
(note drafted at `docs/NOTE-TO-EDITORIAL-deleted-articles.md` — user to send). See `NEXT_STEP.md`
item -4.

**Prior board state: clean as of 2026-07-15.** Last item (report-logic corrections)
SHIPPED to `main` this date; editorial confirmed and **FEMA is kept as a separate row** (user's
decision). The user delivered the corrections as **column G of `docs/News-vs-Articles-Study.xlsx`**
(71 keyword→category rules). Decisions: strong **title keyword wins over generic RSS tags**;
**broad keywords constrained to safe phrasings**; do **BOTH** the category remapping AND the
News/Articles/Job split. Merged develop→main (**PR #39** `b0d08b5`, suite 324/324) — report-only
in `src/services/reports.ts` (title-first `reportCategory`, widened safe keyword sets,
`\bGST\b`→GSTR/GSTN/IGST fix, U+2011-hyphen fix, DRT/DRAT benches + PCESTAT, `detectContentType`
splitting Uncategorized→Other News/Articles–General and Unspecified→No bench – News/Articles/Job
posts; `readsReport` uses the new row-key helpers). **Coverage 59/71** (12 held back = broad-word
collisions, uncaught by design; default safely). Fixtures committed as regression oracles. Editorial
PDF at `docs/News-vs-Articles-Report-Corrections.{html,pdf}` (untracked) — circulated + confirmed.
**Post-ship (PR #40 `98d9f95`):** validated old-vs-new over a live prod week (6–12 Jul, 225 unique)
and fixed a false positive — Benami/PMLA keyword now matches **`unexplained asset(s)` only** (s.68/69
"unexplained cash credit/income/investment" are Income-Tax, NOT PMLA). **VERIFIED LIVE 2026-07-15:**
`/api/reports?period=weekly` returns the new rows (No bench – News/Articles/Job posts, Other News);
Uncategorized/Unspecified gone. History reclassifies automatically (computed at report time).
Groundwork done 2026-07-13 (News-vs-Articles study): full prod dump
(1,137 unique articles, 1 Jun–13 Jul) shows the report's residual rows (240 items) split
**News 115 / Articles (knowledge content) 91 / Job posts 34** — Uncategorized is 87%
adjacent-law court news (SARFAESI/DRT/NI Act/PC Act titles with no tax keyword); Unspecified
is 44% Articles + 39% dept news + 17% job posts. A draft title-grammar `detectContentType`
classifier (~97% vs manual read of all 240) + labeled ground truth + shareables live in
`docs/News-vs-Articles-{draft-classifier.ts,study-data.json,Study.{html,pdf,xlsx}}` (untracked
by design). Proposal on the table: split both residual rows by content type + add DRT/DRAT
benches (report-only; history reclassifies). Details in memory `news-vs-articles-study` +
NEXT_STEP.md item -3. GA4 reads (item 10) closed 2026-07-11 with all four pieces live.
Closed for the record: keep-warm is fine (UptimeRobot 5-min pings, 100% uptime —
the flaky GitHub `*/5` ping is redundant); session TTL raised 8h → 7-day sliding (2026-06-19 —
but the COOKIE capped it at 8h until PR #50 on 2026-08-06, see above; that is why editors kept
being logged out);
watch items (backfill unsub 0.016%, report emails landing, retention-3d working) all verified
healthy 2026-07-10; Compose "Force" stays default-OFF by explicit user decision — don't
re-propose. First scheduled email with the reads section went out Mon 2026-07-13 07:00 IST —
confirm with the user it landed well. See `NEXT_STEP.md`.

**Read for detail:** `NEXT_STEP.md` (running state board + capability overview),
`SEND_PACING_PLAN.md`, `KNOWN_ISSUES.md`, `README.md`, `SECURITY.md`. Keep this section +
`NEXT_STEP.md` current when shipping.

## Stack (do not change without asking)
- Backend: Node.js (18+) + TypeScript + Express
- DB: PostgreSQL via Prisma ORM, hosted on Railway (see section 0.6)
- Push: the `web-push` library (VAPID)
- Scheduling: `node-cron` for RSS polling (NO Redis/BullMQ in Phase 1 — keep it simple)
- RSS: `rss-parser`
- Admin UI: Vue 3 + Vite (small SPA that calls the API)

## Hard rules
- HTTPS everywhere in production; localhost is fine for dev (browsers treat it as secure).
- Every subscription is tagged with a `portal` field ("taxscan" for now).
- Never trigger the native browser permission prompt directly — always a soft prompt first.
- Prune dead subscriptions on 404/410 from the push service.
- Dedupe RSS items by GUID so an article is never sent twice.
- Secrets (VAPID keys, DB URL, admin password) live in .env, never committed.

## Workflow
- All work happens on the `develop` branch. NEVER commit directly to `main`.
- Ship by opening a PR `develop` → `main` (`gh`) and merging it; Railway auto-deploys `main`.
  Behaviour-changing features land behind a flag (default off) and are enabled deliberately.
- Work one numbered task at a time. After each, run the acceptance check, then stop and summarize.
- Commit to `develop` after each task with a clear message (e.g. "Task 3: VAPID config").
- Write tests as you go. Keep functions small and documented.
