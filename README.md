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
RSS_FEED_URL=https://www.taxscan.in/feed
RSS_POLL_CRON=*/5 * * * *
```

The cron is interpreted in `Asia/Kolkata`. On each tick the poller fetches the feed and, for any
item whose `(feedUrl, guid)` pair is not in the `FeedItem` table, creates a Campaign and dispatches
it via the Task 5 service to the `taxscan` portal. Items with one or more `<category>` elements are
sent to topic-targeted subscribers; otherwise the campaign targets `all`.

### Topic slug convention

RSS categories are slugged with `s.toLowerCase().replace(/[^a-z0-9]+/g, '-')`. The subscribe form
must use the same convention so subscriber `topics` line up with RSS category slugs.
Examples: `Income Tax → income-tax`, `GST → gst`, `Customs & Trade → customs-trade`.

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
