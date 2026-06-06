# Project: Taxscan Web Push Platform

## What this is
A self-hosted web push notification service. Phase 1 target is taxscan.in only.
Architecture must stay portal-agnostic so academy.taxscan.in (WooCommerce) and
shop.taxscan.in (Shopify) can be added later without rework.

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
- Work one numbered task at a time. After each, run the acceptance check, then stop and summarize.
- Commit to `develop` after each task with a clear message (e.g. "Task 3: VAPID config").
- Write tests as you go. Keep functions small and documented.
