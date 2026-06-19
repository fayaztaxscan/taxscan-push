# Project: Taxscan Web Push Platform

## What this is
A self-hosted web push notification service. Phase 1 target is taxscan.in only.
Architecture must stay portal-agnostic so academy.taxscan.in (WooCommerce) and
shop.taxscan.in (Shopify) can be added later without rework.

## Current state (updated 2026-06-19) — LIVE in production
Deployed on Railway; admin SPA at `push.taxscan.in/admin`. Live since 2026-06-09,
~2,200 active subscribers. **iZooto runs in parallel and stays** — its ~3M base is
cryptographically un-migratable (origin+VAPID bound); do NOT plan to decommission it.

**What's been built:**
- **Capture** — browser SDK on taxscan.in (soft prompt, topic opt-in, recapture of
  iZooto-granted browsers, `pushsubscriptionchange`).
- **RSS → editorial classifier** (`src/services/classify.ts`) — polls 5 section feeds
  (corporate / gst / income-tax / customs / jobs) PLUS the master feed (`RSS_FEED_NEWS`
  = taxscan.in/feed, all sections); stores each article's RSS `<category>` tags and routes
  by TITLE into QUALIFIED (SC / Bombay-priority HC / other HC / regulatory) · FALLBACK
  (ITAT/CESTAT/NCLAT/NCLT) · REVIEW (analytical + job/recruitment posts, editor-decided).
- **Editorial pacer** (`src/services/pacer.ts`) — 1 push per global 45-min slot, ≤20/day,
  best-first (today → authority tier → oldest-published-first), defer-not-drop; morning
  backfill from yesterday (behind `MORNING_BACKFILL_ENABLED`).
- **No-miss reconciler + retention** (`src/services/reconciler.ts`) — feeds expose only ~11
  items/poll, so a cron reconciles against taxscan's complete daily sitemap and captures any
  missed article (behind `RECONCILER_ENABLED`); DRAFTs unsent within `RETENTION_DAYS` are
  archived (EXPIRED status). Reports infer category from the title when no RSS tag.
- **Coverage reports** (`src/services/reports.ts` + `reportScheduler.ts`) — weekly + monthly
  Category×dates and Bench×dates heatmaps + insights (totals, vs-prev, gaps, quality split),
  counting EVERY captured article. In-app **Reports** screen (Download/Copy image for
  WhatsApp) + emailed Mon 08:00 IST / 1st 08:00 IST to app users + a report-only email list
  (`ReportRecipient`); INTERNAL — never to subscribers. Behind `REPORTS_ENABLED`.
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
`RECONCILER_ENABLED`=ON, `RETENTION_DAYS`=7. (`METRICS_CACHE_TTL_MS`=20s and
`REPORTS_CACHE_TTL_MS`=60s default in code; not set on Railway.)

**Open next steps:** (1) make keep-warm reliable — the GitHub `*/5` warm-ping actually fires
only every ~2–4.5 h, so the Railway worker can go cold (KNOWN_ISSUES #6); verify UptimeRobot or
move to an external pinger. (2) consider lengthening the 8h sliding session TTL (day-apart
logouts). See `NEXT_STEP.md`.

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
