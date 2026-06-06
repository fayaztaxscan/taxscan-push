# taxscan-push

Self-hosted web push notification service for taxscan.in (Phase 1).

## Stack

- Node.js 18+ / TypeScript / Express
- PostgreSQL via Prisma (Railway-hosted)
- `web-push` (VAPID) for delivery
- `node-cron` + `rss-parser` for the RSS poller
- Vue 3 + Vite for the admin SPA

## Setup

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL and VAPID keys
npm run db:migrate
npm run dev
```

The server listens on `PORT` (default `3000`). Health check: `GET /healthz`.

### Tests touch the configured DATABASE_URL

Integration tests write and read real rows via Prisma against whatever `DATABASE_URL` your `.env`
points at. **Never run `npm test` with `DATABASE_URL` pointing at production.** The Task 10d
security audit found three jest-fixture subscribers (`portal: test-sec`) that had leaked into the
live Railway DB exactly that way. If it happens again, `npm run db:cleanup-test-portals` clears any
`portal=test-*` rows + their events.

When you bring on a second contributor (or wire up CI), revisit this — a separate test DB or a
transactional test harness is the right Phase 2 fix.

### Local-dev notification gotcha (macOS Chrome)

On macOS, browser-pushed notifications only render on screen if Chrome itself is allowed to send
notifications at the OS level. Open **System Settings → Notifications → Google Chrome** and turn
notifications on. If this is off, the push reaches the browser and the SW runs, but nothing visible
appears and you'll wonder why. Same applies to Brave / Edge / Arc.

### One-off cleanup of malformed subscribers

If garbage subscriptions (curl-smoke seeds, hand-typed test rows) sit in the table with bogus keys,
`web-push` will throw synchronously when trying to send to them. Run this once to flip them to
EXPIRED:

```bash
npm run db:cleanup-bad-keys
```

It scans `ACTIVE` rows whose `p256dh` doesn't decode to 65 bytes or whose `auth` isn't 16 bytes and
flips them. Going forward `/api/subscribe` rejects malformed keys with 400, so this should be a
one-shot.

## VAPID keys

Web push requires a VAPID key pair. Generate one:

```bash
npm run gen:vapid
```

Copy the printed values into `.env`:

```
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:admin@taxscan.in
```

- `VAPID_PUBLIC_KEY` is shared with browsers when they subscribe.
- `VAPID_PRIVATE_KEY` signs each push request — keep it secret.
- `VAPID_SUBJECT` must be a valid `mailto:` (or `https:`) URL the push service can contact.

Rotating the key pair invalidates every existing subscription, so generate once per environment.

## Browser SDK

`public/taxscan-push.js` is the client SDK; `public/sw.js` is the service worker; `public/index.html`
is a local demo. The Express app serves `public/` at the root, so `npm run dev` lets you open
`http://localhost:3000/` and exercise the whole flow.

### How to embed on taxscan.in

```html
<script>
  window.TAXSCAN_PUSH_CONFIG = { apiBase: 'https://push.taxscan.in' };
</script>
<script src="https://push.taxscan.in/taxscan-push.js" defer></script>
```

If `apiBase` is omitted the SDK falls back to the current origin. The SW reads the same value from
its own URL query (`/sw.js?api=…`) so a cross-origin backend works without code changes.

### Soft-prompt rules

- **Never on landing.** The first page in a session is suppressed regardless of scroll or dwell.
- On the 2nd+ page, the prompt shows after the earliest of: 50% scroll, 30s dwell, or a 2s grace
  delay (the "viewed a 2nd page" signal).
- Dismissing the prompt sets a 7-day `localStorage` flag. **All three "no" actions are equivalent:**
  the × close button, the "No thanks" button, and the Escape key each call the same dismiss path
  and each persist the 7-day flag. We chose consistency over leniency on Escape — a keyboard user
  hitting Esc and a mouse user clicking × should land in the same state. There's no session-only
  close path; the only way to re-show within the 7-day window is the demo "Clear dismissed cookie"
  button (`window.TaxscanPush.resetDismissed()` in the field).
- **Focus trap:** while the banner is open, Tab and Shift+Tab cycle through its focusable elements
  (close ×, the four topic checkboxes, No thanks, Allow notifications) with wrap-around at both
  ends. Tab management is fully manual — Chrome's natural Tab leaks out of the banner at the close
  button on some builds.

### Topic slugs

Soft-prompt labels map to slugs: **GST → `gst`**, **Income Tax → `income-tax`**, **Customs → `customs`**,
**Corporate → `corporate`**. These match `slugify` in the RSS poller, so subscribers and campaigns
line up.

### iZooto migration / recapture

On every load, if `Notification.permission === 'granted'` the SDK silently brings the user under our
VAPID key:

1. Read the existing subscription (if any) and compare its `applicationServerKey` byte-for-byte to
   ours.
2. If it matches, do nothing.
3. Otherwise unsubscribe and resubscribe with our key, then `POST /api/subscribe` with
   `source:"recapture"`. The resulting `SUBSCRIBED` event carries `meta:{source:"recapture"}`.

Older browsers that don't expose `applicationServerKey` fall into the resubscribe path — one-time
endpoint churn, but it guarantees we can deliver.

### Notification icon

The dispatch path (`src/services/send.ts`) defaults every push payload's `icon` and `badge` to
`https://www.taxscan.in/images/icons/icon-192x192.png` — the existing PWA brand icon already on
taxscan.in, declared in its `manifest.json`. To override per campaign, set the admin Compose UI's
"Icon URL" field (or pass `icon` on `POST /api/send`); explicit values are passed through
untouched. Phase 2 (academy / shop portals) should make the default per-portal — env-var map
keyed by portal slug or a column on a new `Portal` model; the constant's call site in `send.ts`
names the refactor point.

The SW also reads `payload.icon` first and `payload.badge` second; the legacy `/icon-192.png`
fallback in `public/sw.js` is now dead code (every dispatched payload carries the brand URL
explicitly) and can be removed in a future SW update if the vendor re-uploads.

## Reliable SDK delivery

The Hocalwire-rendered `<script src="…/taxscan-push.js" defer>` on every taxscan.in page is the
single point of failure for the whole opt-in funnel: if that asset doesn't load, no prompt shows,
no recapture runs, and no iZooto cleanup happens. `VENDOR_CHANGES_VERIFY.md` traced a real
incident to that asset failing at page time even though `fetch()` of the same URL succeeded
seconds later — consistent with Railway's free/hobby tier cold-starting under low traffic.

Two complementary mitigations, in increasing order of cost:

### (a) Keep the backend warm

Point a free uptime monitor at the unauthenticated `/healthz` endpoint at a 5-minute interval:

```
GET https://taxscan-push-production.up.railway.app/healthz
```

The endpoint does no DB work and returns `Cache-Control: no-store`, so every ping reaches the
live worker. On Railway's free/hobby tier, workers idle out after a quiet period and the first
request back in pays a cold-start tax that the browser's `<script>` tag can't survive; a 5-min
ping keeps the worker hot enough that the first real request after a quiet stretch is warm too.

Free options that all cover the single-endpoint case at no cost:

- **UptimeRobot** — 50 monitors free, 5-min interval, zero-setup signup.
- **cron-job.org** — unlimited cron jobs down to 1-min interval.
- **GitHub Actions** — a `*/5 * * * *` workflow that `curl`s the URL. Free on public repos.

This is the fastest mitigation — minutes of setup, no DNS or code change required.

### (b) Front the deployment with a CDN (long-term fix)

A CDN edge cache makes `/taxscan-push.js` and `/sw.js` resilient to any future Railway hiccup —
once the file is cached at an edge, page-time loads don't depend on the backend's warm/cold
state at all. Recommended path: **Cloudflare on a custom domain** (e.g. `push.taxscan.in`),
proxying to the Railway origin.

Cloudflare-side sketch (assumes Cloudflare basics):

- Add `push.taxscan.in` as a CNAME → `taxscan-push-production.up.railway.app`, **proxy enabled
  (orange cloud)**.
- Caching → Configuration → Cache Level: **Standard**.
- Caching → Configuration → Browser Cache TTL: **Respect Existing Headers** (we already set the
  right `Cache-Control` per asset in `src/app.ts` — Cloudflare follows it).
- Edge Cache TTL for `/taxscan-push.js` and `/sw.js`: **honour origin Cache-Control** — origin
  sends `max-age=300, stale-while-revalidate=86400` for the SDK and `no-cache` for the SW;
  Cloudflare respects both, so the SW still revalidates every fetch.
- Flip `TAXSCAN_PUSH_CONFIG.apiBase` on taxscan.in to `https://push.taxscan.in` and update the
  vendor `<script src>` URL to match.

The SW reads `?api=…` from its own URL (`/sw.js?api=…`), so a cross-origin backend works without
SDK or SW code changes — the SDK passes the apiBase through to SW registration's query string.

## RSS poller

The poller is off by default. To enable, set in `.env`:

```
RSS_ENABLED=true
RSS_POLL_CRON=*/5 * * * *
RSS_FEED_CORPORATE=https://www.taxscan.in/corporate-laws/feed
RSS_FEED_GST=https://www.taxscan.in/cst-vat-gst/feed
RSS_FEED_INCOME_TAX=https://www.taxscan.in/income-tax/feed
RSS_FEED_CUSTOMS=https://www.taxscan.in/excise-customs/feed
```

The cron is interpreted in `Asia/Kolkata`. On each tick the poller iterates the configured feeds
sequentially and, for any item whose `guid` isn't already in the `FeedItem` table, creates a
Campaign and dispatches it via the Task 5 service to the `taxscan` portal.

### Sections come from the feed source, not from `<category>`

Each feed is bound to one topic at configuration time. Every item from that feed dispatches to
that topic (`target: { type: 'topics', topics: [<feed-topic>] }`). Individual `<category>` tags on
items are ignored — taxscan packs editorial meta like "Top Stories" into every item, which would
otherwise either flood or misroute.

### Cross-feed dedupe (GUID-only)

The same article shows up in multiple section feeds — e.g. an Income Tax piece on a GST topic
also surfaces in `/cst-vat-gst/feed`. The `FeedItem` table's unique key is `guid` alone, so the
first feed to claim a GUID sends it and any later feed seeing the same GUID skips it. The losing
feed's poll counts it under `alreadySeen`. The winning feed's URL is recorded on the FeedItem row
for debugging.

### Adding or removing a section

Add a line to `.env`:
```
RSS_FEED_SERVICE_TAX=https://www.taxscan.in/service-tax/feed
```
The topic slug `service-tax` is derived from the env var name (suffix lowercased,
`_` → `-`). Remove the line to take it offline. No code change.

`/service-tax/feed` and `/other-taxations/feed` are confirmed to return valid RSS but aren't in
the default config — add them via env when needed.

### First-run behaviour

A fresh install with an empty `FeedItem` table will treat every current feed item as new and
dispatch all of them on the first poll. Keep `RSS_ENABLED=false` until you're ready, or prime the
table with a one-off script.

## Scheduled-campaign sweeper

Campaigns that hit the quiet-hours gate are persisted with `status=SCHEDULED` and `scheduledAt` set
to the next allowed instant. The sweeper is a separate cron tick that picks them up:

```
SWEEPER_ENABLED=true
SWEEPER_CRON=* * * * *
```

Each tick finds `status=SCHEDULED AND scheduledAt <= now`, re-checks quiet hours (a campaign landing
back inside a window gets its `scheduledAt` pushed forward instead of sent), and otherwise claims
the row atomically (`SCHEDULED → DRAFT`) before running the same send loop used by `/api/send`. The
sweeper has its own single-flight lock so a slow tick can't overlap the next one.

### Dispatch failure policy

If a dispatch throws after the `FeedItem` row has been claimed, the row is left in place
(`campaignId` stays null) and the item is logged but never retried. This is deliberate — it keeps
"never re-send" inviolable across crashes, at the cost of permanently skipping one item per failed
dispatch. Watch the logs.

## Cutover from iZooto

Two flags let this system run safely **side-by-side with iZooto** before taking over.

| Flag | Where | Default | Behaviour |
|---|---|---|---|
| `SEND_MODE` | backend `.env` | `capture_only` | The RSS poller still detects new items, slugs them by feed source, and writes Campaigns as `DRAFT` (linked from `FeedItem.campaignId`), but **does not dispatch**. Subscribers keep receiving from iZooto. Admin manual sends through `/api/send` are unaffected — only the RSS poller is gated. |
| `CUTOVER_MODE` | browser SDK (`window.TAXSCAN_PUSH_CONFIG.cutoverMode`) | `false` | After our own service worker is live, the SDK walks every SW registered on the page and unregisters **only iZooto's** — identified by host (`cdn.izooto.com` or any `*.izooto.com`) with a case-insensitive `/izooto/i` substring fallback. The site's own PWA worker at `/service-worker.js` and our push worker are explicitly spared. When `false`, no unregister runs (parallel-run default). |

### Safe sequence

1. **Day 0 — parallel run** (default).
   ```
   SEND_MODE=capture_only
   window.TAXSCAN_PUSH_CONFIG = { ...config, cutoverMode: false }
   ```
   - iZooto sends notifications (status quo).
   - Our RSS poller runs but stores items as DRAFT — log line shows `mode=capture_only sent=0 captured=N`.
   - The SDK's recapture path silently migrates any returning iZooto subscriber whose `Notification.permission === 'granted'`. Watch
     `subscribersBySource.recapture` climb on the Dashboard.
   - Optionally bulk-import the iZooto CSV (see next section).

2. **Day N — take over** (flip both flags **at the same time**).
   ```
   SEND_MODE=live
   window.TAXSCAN_PUSH_CONFIG = { ...config, cutoverMode: true }
   ```
   - Our RSS poller dispatches normally; log line shows `mode=live sent=N captured=0`.
   - On every subscriber's next visit, the SDK unregisters iZooto's SW. From that visit on, iZooto can no longer reach them through this browser.

**Do not run `SEND_MODE=live` with `cutoverMode=false` for any extended period** — both systems would send the same article. The danger window is from the moment you flip `SEND_MODE` until every subscriber has revisited and the SDK has unregistered iZooto's SW for them.

### Bulk import (Strategy B, optional)

```
npm run import:izooto -- path/to/izooto-export.csv
npm run import:izooto -- path/to/izooto-export.csv --dry-run   # validates without writing
```

CSV format: header row with at least `endpoint, p256dh, auth`; optional `userAgent`. Each row becomes a Subscriber + a SUBSCRIBED Event tagged with `meta.source = "import"`. The script prints a per-run summary:

```
[import:izooto] === Summary ===
  Total rows in file:        1247
  Successfully imported:     1198
  Skipped (already in DB):   42
  Skipped (bad/empty keys):  7
  Errors:                    0
  ────────────────────────────────
  Migrated 1198 of 1247 (96.1%)
```

The imported count then shows up in `/api/metrics → subscribersBySource.import` and on the Dashboard's "Subscriber sources" table — that's how you confirm the import "stuck" after the script returns.

**Caveat:** Strategy B only works cleanly if iZooto registered subscribers with **your** VAPID public key. If iZooto used its own VAPID, the endpoints are technically valid but sending to them will return 403 from FCM/Mozilla. The Task 9 FAILED-event path catches that — sends fail visibly and the bad endpoints get flipped to EXPIRED automatically — but the migration won't actually deliver notifications. Recommend **Strategy A (recapture only)** unless you're sure about the VAPID-key history.

## What good looks like

The dashboard surfaces four primary metrics as coloured indicators (green / amber / red). Targets
are based on industry baselines for web push on news / publishing sites — treat them as
benchmarks, not contractual SLOs.

| Metric | What it measures | Target (green) | Warning (amber) | Below target (red) |
|---|---|---|---|---|
| **Opt-in rate** | `PROMPT_ACCEPTED ÷ PROMPT_SHOWN` — of readers who saw the soft prompt, how many granted notification permission. | **≥ 5%** | 3–5% | < 3% |
| **CTR** (per campaign and overall) | `CLICKED ÷ SENT` — of notifications delivered, how many were clicked. | **≥ 6%** | 4–6% | < 4% |
| **Unsubscribe rate** | `UNSUBSCRIBED ÷ SUBSCRIBED` (lifetime, all sources). | **< 0.5%** | 0.5–1% | ≥ 1% |
| **Delivery rate** | `SENT ÷ (SENT + FAILED)` event counts. A FAILED event is recorded for every 404/410 (subscription dead) and every other transient failure during dispatch. | **≥ 95%** | 90–95% | < 90% |

Notes on what each indicator means in practice:

- **Opt-in below 3%** usually points at a prompt-fatigue problem — copy not compelling, timing
  too aggressive, or the soft prompt firing on the wrong pages. Check `funnel.promptShown` is
  reasonable (not zero, not the same as page views).
- **CTR below 4%** suggests either notification copy / icon issues or that the audience isn't
  well-matched to the content. Look at per-campaign CTR in the Campaigns view — a single bad
  campaign can drag the overall down.
- **Unsubscribe spike (≥ 1%)** is usually a content-quality or frequency-cap signal. The cap
  defaults to 4/day per subscriber but you can tune `FREQ_CAP_PER_DAY`.
- **Delivery rate below 95%** means the subscriber base has accumulated dead endpoints faster
  than the natural prune cycle. The 410-handling path flips subscribers to EXPIRED automatically,
  so this should self-heal over a few cycles. If it doesn't, check the `[rss] poll` and the
  `dispatchCampaign` logs for repeating failure modes.

## Admin SPA

A small Vue 3 + Vite app lives in `admin/`. Three screens: Compose & send, Campaigns, Dashboard,
behind a password login that exchanges for the bearer token.

### First-time setup

```bash
# 1. Create the first ADMIN user against your dev database.
npm run create-admin    # interactive prompt: email + password (12+ chars,
                        #                     mixed case + digit)

# 2. In one terminal — backend.
npm run dev

# 3. In another terminal — Vite dev server (proxies /api → :3000).
cd admin
npm install            # first time only
npm run dev            # opens on http://localhost:5173
```

Open `http://localhost:5173/login`, sign in with the email + password you just created. The backend
sets a signed `tx_push_session` cookie (HTTP-only, 8h sliding expiry). The SPA stores nothing —
the cookie is the source of truth — and the router guard pings `GET /api/auth/me` on every
navigation to refresh the user's role / `passwordResetRequired` flag.

### Adding team members

Once logged in as an ADMIN, additional users will be managed from the **Users** screen that
Phase 6 of `USER_MANAGEMENT_PLAN.md` will land. Until then, run `npm run create-admin` again for
each new admin, or call `POST /api/users` directly (cookie-authenticated, ADMIN-only — full
details in the [Admin-managed user lifecycle](#admin-managed-user-lifecycle-phase-3) section).

When an admin resets a user's password via `POST /api/users/:id/reset-password`, the next time
that user logs in the SPA will route them straight to `/change-password` with a forced-flow
modal that cannot be dismissed. Once they change the password the `passwordResetRequired` flag
is cleared and normal navigation resumes.

### Send test to internal segment

The Compose screen's "Send test" button posts a campaign with `target: { type: 'topics', topics: [TEST_SEGMENT_TOPIC] }`
and `breaking: true`. To receive these on your dev browser, open the demo page (`/`), accept the
soft prompt, and tick the topic that matches `TEST_SEGMENT_TOPIC` (default `test`). Add `test`
to the topic chooser in `public/taxscan-push.js` for a fully wired internal-test flow, or just
include `test` in the array stored at `txn_push_topics` in localStorage from DevTools.

### Production deploy

The root `npm run build` now chains `build:admin` automatically (Vite → `admin/dist/`). On deploy,
Express serves the built SPA at `/admin/*` via `app.use('/admin', express.static(...))` with an
SPA fallback so client-side routes (e.g. `/admin/campaigns`) return `index.html`. The mount lives
AFTER `/api/*` so it can never shadow the API.

Vite is configured with `base: '/admin/'` for builds (so asset paths line up with the Express
mount) and `base: '/'` for dev (so Vite on `:5173` works unchanged). Vue Router reads the same
base from `import.meta.env.BASE_URL`, so links work in both modes without code changes.

In production, log in at `https://<your-domain>/admin/`.

### Playwright E2E (admin)

One happy-path spec covers the literal acceptance criterion (log in → compose → send → dashboard
shows CTR). Run it from `admin/`:

```bash
cd admin
npm run e2e
```

Playwright boots both servers itself with `E2E_MOCK_SENDER=true` so the dispatch path is exercised
end-to-end without touching FCM. The `finally` block runs `npm run db:cleanup-e2e` from the project
root, which deletes anything whose subscriber endpoint starts with `https://e2e-test.example.com/`
or whose campaign title starts with `E2E `. If a run crashes hard you can run that cleanup script
manually.

## Authentication

The backend supports two auth methods that coexist deliberately:

### Bearer token — for scripts, cron, external clients

Send `Authorization: Bearer $ADMIN_TOKEN` on any admin endpoint. The RSS poller, sweeper, ad-hoc
`curl` calls, and any future cron use this path. The bearer token never expires, never changes
between deploys (unless you rotate it), and bypasses per-user role checks — it represents the
"service" identity. **`ADMIN_TOKEN` is the load-bearing secret here; treat it like a database
password.**

### Cookie sessions — for the admin SPA and human users

Per-user accounts authenticated via `POST /api/auth/login` with `{ email, password }`. The
response sets a signed, HTTP-only, `SameSite=Lax`, 8-hour sliding-expiry cookie named
`tx_push_session`. Subsequent calls to `/api/auth/me`, `/api/auth/logout`, and admin endpoints
(after Phase 4 wires them) read the cookie automatically.

Endpoints:

- `POST /api/auth/login` — body `{ email, password }`. 200 + `Set-Cookie` on success. 401 on
  bad credentials. 423 after 5 failed attempts for that email in 15 minutes (resets after the
  window). 429 on per-IP rate-limit breach (default 5/min).
- `POST /api/auth/logout` — revokes the session row and clears the cookie. Returns 204.
- `GET /api/auth/me` — returns `{ id, email, role, lastLoginAt }` for the current session. 401
  without a valid cookie.

### Creating the first admin

```bash
npm run create-admin
```

Interactive prompt: email + password (password is masked on a TTY). Validates password (min 12
chars, mixed case + digit), hashes with `bcrypt` cost 12, creates a single `User` row with
`role=ADMIN`, `isActive=true`. Refuses to overwrite an existing email.

After that first user exists, log in at `/admin/` and create additional users via the admin
UI (Phase 6 will add this screen) or via repeated `npm run create-admin` runs.

### Admin-managed user lifecycle (Phase 3)

Once the first admin is in place, additional users are added via the API (Phase 6 will surface
this in the SPA). The lifecycle is **admin-creates → out-of-band password share → user changes
on first login**, deliberately keeping email-sending out of v1.

- **`POST /api/users`** (ADMIN only) — body `{ email, password, role }`. Returns 201 with the
  new user (no `passwordHash`). 409 if email is taken; 400 if password fails policy.
- **`GET /api/users?limit=20&offset=0&includeInactive=false`** (ADMIN only) — paginated list +
  total. `includeInactive=true` shows deactivated rows.
- **`GET /api/users/:id`** (ADMIN only) — one user, 404 if missing.
- **`PATCH /api/users/:id`** (ADMIN only) — body may include `role` and/or `isActive`. The
  **last-active-admin guard** returns 409 if the change would leave zero active admins (e.g.
  the only admin trying to deactivate themselves, or demote themselves to PUBLISHER).
  Deactivating a user also revokes all their active sessions immediately.
- **`POST /api/users/:id/reset-password`** (ADMIN only) — generates a 16-character temporary
  password meeting policy (lowercase + uppercase + digit + symbol), updates the user's
  `passwordHash`, sets `passwordResetRequired=true`, revokes all the user's sessions, and
  returns the temp password in the response so the admin can share it through their usual
  out-of-band channel (Slack DM, in-person, etc.). The user can log in immediately with the
  temp password.
- **`POST /api/auth/change-password`** (any role) — body `{ currentPassword, newPassword }`.
  Verifies the current password, applies the new one, **revokes all the user's other sessions
  but keeps the calling session live**, and clears `passwordResetRequired` if it was set. 401
  if the current password is wrong, 400 if the new password fails policy.

A `passwordResetRequired=true` flag is exposed on `GET /api/auth/me` so the SPA (Phase 5+) can
gate navigation behind a "change your temp password" modal on first login.

### Audit log (Phase 4)

Every authentication event, user-management action, and campaign dispatch writes an `AuditLog`
row through the centralised `src/lib/audit.ts` helper. Writes are **non-throwing** — if the DB
write fails the underlying action still succeeds and a `[audit]` warning is logged.

- **`GET /api/audit`** (any logged-in user — ADMIN or PUBLISHER). Query params:
  `action`, `userId`, `since`, `until` (ISO datetimes), `limit` (default 50, max 200), `offset`.
  Returns `{ items, total }` with each item joined to the actor's `{ id, email, role }` so the UI
  doesn't have to look up users separately. The plan deliberately chose "everyone on the team can
  see who did what" over "ADMINs only" — change the middleware to `requireUser(['ADMIN'])` if you
  ever want to restrict it.

#### Append-only guarantee — two defence layers

`AuditLog` rows cannot be edited or deleted by any normal application code path:

1. **DB-level trigger** (Phase 1) — `BEFORE UPDATE OR DELETE` on `AuditLog` raises an
   exception unless the deleting transaction has set `audit_log.allow_purge = 'true'` via
   `SET LOCAL`. This catches `psql`, ORM bypasses, and any future code path that goes through
   raw SQL.
2. **Prisma client extension** (Phase 4) — `prisma.auditLog.update / updateMany / delete /
   deleteMany / upsert` throw immediately at the application layer, before any SQL is sent.
   Catches accidental usage in PR review.

The only legitimate code path that purges audit rows is the retention sweeper below — it opens
a single transaction, sets the session variable, and uses `$executeRaw` (bypassing the Prisma
extension by going around it).

#### Retention sweeper

A `node-cron` job runs daily at `03:00` IST and deletes rows past two windows:

```
AUDIT_LOG_SWEEPER_ENABLED=true                    # default true
AUDIT_LOG_SWEEPER_CRON=0 3 * * *                  # 03:00 IST daily
AUDIT_LOG_RETENTION_DAYS=90                       # everything else
AUDIT_LOG_FAILED_LOGIN_RETENTION_DAYS=30          # LOGIN_FAILED rows are noisier
```

Each tick logs how many rows it deleted in each window. The carve-out (`SET LOCAL`) is scoped to
the sweeper's transaction so a concurrent connection trying `DELETE` on `AuditLog` still hits
the trigger error — no leak.

#### Campaign attribution + dispatch audit

`dispatchCampaign` (in `src/services/send.ts`) accepts an optional `createdByUserId`. The
`/api/send` route handler passes `req.user.id` when the call came via a cookie session,
`null` when via bearer (RSS poller, sweeper, external curl). The value is persisted on
`Campaign.createdByUserId` and copied into the `CAMPAIGN_DISPATCHED` audit row's `userId`,
so the activity feed and any per-user dashboards can answer "who sent this campaign?". If the
dispatch throws, a `CAMPAIGN_DISPATCH_FAILED` row is written instead and the throw propagates.

### `SESSION_COOKIE_SECRET`

Required env var. Signs the session cookie. Minimum 32 characters; startup self-check refuses to
boot if missing or too short. Generate with:

```bash
openssl rand -hex 32
```

Rotating it invalidates every existing session cookie (users must log in again). It does NOT
invalidate the session rows in the DB — those stay until expiry or explicit revoke — but they
become unreachable because no valid signed cookie maps to them. The retention sweeper (Phase 4)
will eventually clean expired session rows.

## Admin send endpoint

`POST /api/send` is the admin-only dispatch endpoint. Authenticate with a static bearer token:

```
Authorization: Bearer $ADMIN_TOKEN
```

Body:

```json
{
  "portal": "taxscan",
  "title": "...",
  "body": "...",
  "url": "https://taxscan.in/article/123",
  "icon": "https://taxscan.in/icon.png",
  "target": { "type": "all" },
  "breaking": false
}
```

`target` is either `{ "type": "all" }` or `{ "type": "topics", "topics": ["gst", "income-tax"] }`. The
service applies the per-subscriber daily cap (`FREQ_CAP_PER_DAY`, default 4) and the IST quiet-hours
window (`QUIET_HOURS_START`/`QUIET_HOURS_END`, default 23:00→07:00). Inside the quiet window the
campaign is persisted as `SCHEDULED` with `scheduledAt` set to the next allowed instant — set
`breaking: true` to bypass.

## Scripts

| Command              | What it does                                          |
| -------------------- | ----------------------------------------------------- |
| `npm run dev`        | Start the API with auto-reload (`ts-node-dev`)        |
| `npm run build`      | Compile TypeScript to `dist/`                         |
| `npm start`          | Run the compiled server                               |
| `npm run db:migrate` | Apply / create Prisma migrations against `DATABASE_URL` |
| `npm run db:studio`  | Open Prisma Studio                                    |
| `npm run gen:vapid`  | Print a fresh VAPID key pair                          |
| `npm run lint`       | ESLint over `src/`                                    |
| `npm run format`     | Prettier over `src/`                                  |
