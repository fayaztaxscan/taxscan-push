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

Drop a 192×192 PNG at `public/icon-192.png`. If missing, browsers fall back to a default. The
service worker reads `payload.icon` from each push first, then `/icon-192.png`.

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

### Run it locally

```bash
# in one terminal — backend
ADMIN_PASSWORD=your-pw npm run dev

# in another — Vite dev server, proxies /api → :3000
cd admin
npm install        # first time only
npm run dev        # opens on http://localhost:5173
```

Sign in with `ADMIN_PASSWORD`; the SPA stores the issued bearer token in `localStorage` and attaches
it to every subsequent `/api/*` call.

### Send test to internal segment

The Compose screen's "Send test" button posts a campaign with `target: { type: 'topics', topics: [TEST_SEGMENT_TOPIC] }`
and `breaking: true`. To receive these on your dev browser, open the demo page (`/`), accept the
soft prompt, and tick the topic that matches `TEST_SEGMENT_TOPIC` (default `test`). Add `test`
to the topic chooser in `public/taxscan-push.js` for a fully wired internal-test flow, or just
include `test` in the array stored at `txn_push_topics` in localStorage from DevTools.

### Production deploy (out of scope for Phase 1)

`cd admin && npm run build` produces a static bundle in `admin/dist/`. A future task can mount it via
`app.use('/admin', express.static('admin/dist'))` to serve at `/admin`.

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
