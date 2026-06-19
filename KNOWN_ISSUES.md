# Known issues

Persistent, non-blocking issues we know about and have chosen not to fix
immediately. Each entry names the impact, how to measure it (so we can
size the problem before paying the fix cost), and a concrete starting
point for the eventual fix.

Stable numeric IDs (`#1`, `#2`, …) so cross-references in commits and
docs don't break — new entries are appended at the bottom, not
inserted at the top.

---

## 1. Hocalwire's `Utils.loadScripts` injects the SDK 20–28 s after navigation

**Filed:** 2026-06-06. **Owner:** vendor (Hocalwire). **Severity:** moderate.

> **✅ RESOLVED & RUNTIME-VERIFIED 2026-06-16.** Hocalwire shipped the fix: the live
> pages now render a static `<script src="…/taxscan-push.js" defer></script>` in `<head>`
> (config block unchanged), and the SDK is **no longer** inside the `Utils.loadScripts('…')`
> ad-loader. Browser timing test on an article page
> (`…/e-way-bill-system-under-gst-…/478305`) confirmed: **`taxscan-push.js` Resource-Timing
> `startTime` = 499 ms** (was ~20,000–28,000 ms), `window.TaxscanPush` = `"object"` (SDK
> executed), SW registered (`/sw.js?api=…`). The fast-bounce blind spot is closed. **Now
> watch the `recapture` source count + active-subscriber growth over the following days —
> they should climb faster.** Issue closed; original writeup retained below for history.

### What's happening

The vendor template renders `window.TAXSCAN_PUSH_CONFIG` inline in `<head>`
correctly, but does NOT also render a literal `<script src=".../taxscan-push.js"
defer>` tag. Instead it passes the SDK URL into Hocalwire's own
`window.Utils.loadScripts(...)` async loader, which dynamically creates a
`<script>` element later in the page lifecycle. On `CUTOVER_LIVE_VERIFY.md`'s
run that injection happened **roughly 20–28 seconds after navigation**.

Before that window elapses, `typeof window.TaxscanPush === "undefined"` and
`Array.from(document.scripts).find(s => /taxscan-push.js/i.test(s.src))` returns
nothing.

### Impact

Visitors who close the tab in the first ~25 s of a visit (the "bounce"
segment on a news site is non-trivial) **never load the SDK at all**. For
them:

- No soft prompt ever renders.
- No recapture POST happens — iZooto-granted browsers never get migrated.
- `cutoverMode` never runs, so iZooto's leftover SW (on returning iZooto
  subscribers' devices) is never unregistered.

Whatever percentage of taxscan.in traffic bounces inside 25 s is currently
**invisible to the new system**.

### How to measure

Two complementary signals:

- **Backend**: compare `GET /api/config` hit count (proxy for "SDK loaded
  successfully") against pageview count from whatever analytics taxscan.in
  uses. The gap is approximately the bounce-before-SDK-load fraction.
- **Browser**: in Claude in Chrome, navigate to taxscan.in, immediately
  start polling `typeof window.TaxscanPush !== 'undefined'`, record the
  first-true timestamp. We have one data point (20–28 s); a few more
  samples across times of day and articles would tell us if that's typical
  or worst-case.

### Proposed fix

Email Hocalwire to render the literal tag statically in `<head>`, next to
the existing `TAXSCAN_PUSH_CONFIG` inline block:

```html
<script>
  window.TAXSCAN_PUSH_CONFIG = {
    apiBase: 'https://taxscan-push-production.up.railway.app',
    cutoverMode: true
  };
</script>
<script
  src="https://taxscan-push-production.up.railway.app/taxscan-push.js"
  defer
></script>
```

That's exactly what the original brief asked for. The browser's own
`defer` attribute already gives the right "after-parse, non-blocking"
semantics — there's no need for a custom async loader on top.

If they push back on changing the template, an acceptable middle ground
is asking them to fire `Utils.loadScripts(...)` earlier in the page
lifecycle (e.g. at the top of `<body>` rather than late in their bundle).

---

## 2. SDK skips `POST /api/subscribe` when `applicationServerKey` already matches — can ghost subscribers

**Filed:** 2026-06-06. **Owner:** internal. **Severity:** low (until measured).

### What's happening

`ensureSubscribedSilently` in `public/taxscan-push.js` (lines 137–150)
short-circuits when the browser already has a push subscription whose
`applicationServerKey` byte-equals our VAPID public key:

```js
if (existing) {
  var k = existing.options && existing.options.applicationServerKey;
  if (k && bytesEqual(new Uint8Array(k), ourKey)) {
    // Already ours — no recapture needed. Don't churn the endpoint.
    return existing;
  }
  …
}
…
await post('/api/subscribe', { … });
```

The comment is correct about the normal case: a previously-onboarded
subscriber whose POST already landed shouldn't re-POST on every visit
(would churn rows and inflate event counts).

The failure mode: if the original POST silently failed (network
flap, transient 5xx, rate-limit reject, etc.) and was never retried,
the SDK will keep returning early on every subsequent visit. The browser
thinks it's subscribed; the backend has no row; **no campaigns will ever
reach them**. They're a browser-side ghost.

### Impact

Unknown size. Probably small in steady state (the public limiter at
60/min is generous, and a flap during the POST itself is rare). But the
design is fail-silent — there's no telemetry today that would surface a
ghost subscriber. We could be losing reach and have no way to know.

### How to measure

Two angles:

- **Direct probe**: ship a lightweight `GET /api/subscriber/exists?endpoint=<encoded>`
  endpoint and have the SDK call it once on every load. Log `(exists, browser-thinks-subscribed)`
  combinations as a debug event for a week — any `(false, true)` row is
  a confirmed ghost. Do this BEFORE deciding whether the fix below is
  worth the round-trip cost.
- **Indirect signal**: `subscribersBySource.recapture` on the admin
  dashboard. Flat / much-lower-than-expected counts during a traffic
  window when many iZooto-era visitors should be returning is evidence
  some are being ghosted.

### Proposed fix

Add the `GET /api/subscriber/exists?endpoint=<encoded>` endpoint
(unauthenticated, public, rate-limited like `/api/track`) and change the
SDK shortcut to:

1. If `existing` matches our VAPID, GET `/api/subscriber/exists`.
2. If `exists === true`, return early (current behaviour).
3. If `exists === false`, fall through to the POST.

One extra round-trip per page load is cheap (single GET, ~100 bytes,
cacheable). The fix preserves the "don't churn rows" intent for the
common case while closing the ghost failure mode.

Defer until we've measured the size via the indirect signal above. If
the recapture counter climbs sensibly under real traffic, this can
stay filed.

---

## 3. `taxscan.in/sw.js` served with `Cache-Control: immutable, max-age=31536000`

**Filed:** 2026-06-06. **Owner:** vendor (Hocalwire). **Severity:** low (mostly defused by the SW spec).

### What's happening

The vendor-uploaded copy of our service worker at `https://www.taxscan.in/sw.js`
is served with:

```
cache-control: immutable, public, max-age=31536000, s-maxage=31536000
```

One year. The `immutable` directive also tells the browser to skip
revalidation on manual reload. This is Hocalwire's default for static
assets; they didn't apply SW-specific rules.

Our Railway-origin copy at `https://taxscan-push-production.up.railway.app/sw.js`
already serves `Cache-Control: no-cache` (set in `src/app.ts`), which is the
documented best practice. But production goes through the vendor-uploaded
copy, so the vendor's header is the one that's live for real subscribers.

### Impact

In 95% of cases, **none**. The Service Worker spec defines its own update
mechanism that bypasses the HTTP cache: with the default `updateViaCache:
'imports'`, the browser checks for SW updates by fetching the main script
straight from the network, ignoring whatever `Cache-Control` says. So a
sw.js change shipped today still propagates to existing browsers on their
next page visit, regardless of the 1-year header.

The cache header *does* affect the edge cases:

- **First-install fetch** for a brand-new visitor. The initial `register()`
  call's underlying fetch CAN use HTTP cache, so a stale CDN edge between
  the user and Hocalwire's origin could hand out an old sw.js for up to a
  year. Once installed, updates flow normally via the spec mechanism.
- **Non-mainstream browsers** (embedded webviews, oddball mobile browsers)
  that don't implement the spec's update bypass correctly. Mainstream
  Chrome / Edge / Firefox / Safari handle it fine.
- **Emergency rollouts** if we ever need every browser to pick up a sw.js
  fix within hours rather than days — the spec mechanism updates "soon
  after next visit," not "immediately for all current users."

### How to measure

Not really measurable until we ship a sw.js change and observe propagation.
If we do and see a long tail of stale-SW behaviour from a specific browser
or geography, that's the signal. Until then, treat as "noted, not acting."

### Proposed fix

**Two complementary options. Pick if/when needed:**

1. **Ask the vendor** to set `Cache-Control: no-cache` (or at minimum
   `max-age=0, must-revalidate`) specifically on `/sw.js`. Single-line
   email to Hocalwire. Permanent fix.
2. **Cache-bust the registration URL** ourselves — bump a `&v=N` param in
   the SDK's `register()` call when we want to force a refresh. We control
   `public/taxscan-push.js`; the SDK currently registers
   `/sw.js?api=<apiBase>`. Adding `&v=N` and incrementing N makes the
   browser treat it as a new registration. Works without any vendor action.
   This is the emergency escape hatch.

Keep this filed until we actually need to ship a sw.js change.

---

## 4. Our `/sw.js` replaced the site's PWA worker — offline fallback page is gone

**Filed:** 2026-06-06. **Owner:** internal. **Severity:** very low (accepted tradeoff).

### What's happening

Before our cutover, taxscan.in registered its own minimal PWA service worker
at `https://www.taxscan.in/service-worker.js` (still on disk as of 2026-06-06,
1,566 bytes). It did one thing: when a user navigated while offline, it
served a cached copy of `/offline` instead of the browser's default "no
internet" page. No push handling, no notification handling, no article
caching — just an offline fallback page.

Our SDK registers `/sw.js?api=…` at scope `/`. The browser's SW spec only
allows one active worker per scope, so our registration **replaced** the
site PWA's registration. Our SW has no `fetch` handler, so navigation
requests now go straight to network with no offline fallback.

The original PWA's three handlers, for reference:

```js
self.addEventListener('install',  …  cache.addAll(['/', '/offline']));
self.addEventListener('activate', …  self.clients.claim() + prune old caches);
self.addEventListener('fetch',    …  navigations: network-first → cached '/offline');
```

### Impact

- A subscriber who loses connectivity mid-navigation now sees Chrome /
  Safari's default offline page instead of taxscan.in's branded `/offline`
  page. Small UX downgrade, triggered only during the specific window
  between losing connectivity and landing on a new URL.
- No effect on push delivery, click-through, or anything we actively ship —
  these are all SW push-event paths, independent of the fetch handler.
- No effect on the "Add to Home Screen" / install-as-app behaviour — that's
  driven by `manifest.json` (still served at `/manifest.json`, unchanged),
  not by the SW.

### How to measure

There's no direct backend signal. The legitimate signals are:

- **Direct user reports**: complaints about the offline page being missing.
- **Analytics**: if taxscan.in tracks `/offline` pageviews via any analytics
  (Hocalwire-side, GA, etc.), the count should have dropped to ~0 since the
  cutover. Compare against pre-cutover counts to estimate how many sessions
  the old PWA was actually catching.

### Proposed fix (parked — DO NOT ship without an explicit ask)

If we decide the offline page is worth restoring: port the original PWA's
behaviour into our `public/sw.js` (~20 lines). The full snippet, dropped
straight into our SW, would be:

```js
const OFFLINE_CACHE = 'taxscan-offline-v1';
const OFFLINE_PAGES = ['/', '/offline'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    self.skipWaiting();
    const cache = await caches.open(OFFLINE_CACHE);
    await cache.addAll(OFFLINE_PAGES);
  })());
});

self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith((async () => {
    try { return await fetch(event.request); }
    catch {
      const cache = await caches.open(OFFLINE_CACHE);
      return await cache.match('/offline');
    }
  })());
});
```

Then deploy and ask Hocalwire to re-upload `/sw.js`. Browsers' SW update
mechanism picks up the new version on next visit.

**Risk if shipping**: adding a `fetch` handler intercepts every navigation
for every subscriber. A bug in this path would break basic browsing
site-wide. Test thoroughly before deploying.

**Current decision (2026-06-06): accept the tradeoff.** This entry exists
so a future session sees the rationale rather than re-discovering the
choice from verification reports.

---

## 5. Send pacing: cooldown DROPS cooled subscribers and "first-published article wins" — no editorial priority or digest

**Filed:** 2026-06-16. **Owner:** internal. **Severity:** moderate (content-selection quality + reach).

### What's happening

Each new RSS article is dispatched immediately as its own campaign. Two
throttles in `filterByCap` (`src/lib/cap.ts`) gate the send: `FREQ_CAP_PER_DAY`
(daily volume) and `MIN_GAP_MINUTES` (default 30, per-subscriber cooldown).
A subscriber with a `SENT` event newer than `now − MIN_GAP_MINUTES` is put in
the `cooled` bucket and **dropped for that campaign — not deferred**.

Consequence, visible in live campaign data (2026-06-16): when several articles
publish inside one 30-min window, the **first** one reaches the full eligible
base (~1,800), and every article behind it finds almost everyone cooled →
sub-100 reach. The surviving article is whichever published **first**, not the
most important. A routine CESTAT order can "use up" the cooldown and a landmark
ruling 10 minutes later goes to <100 subscribers and is never re-sent.

### Impact

- **Arbitrary selection.** No editorial priority — importance doesn't decide
  who gets full reach; publish order does.
- **Permanent under-delivery.** Cooled subscribers are dropped, so most
  articles reach a near-random sliver of the base and are never retried.
- Likely depresses aggregate engagement vs. a model that sends the *best*
  item to the *most* people. (NOTE: we previously called the measured
  CTR ~0.66% "low" — that is **not** defensible: a verified research pass
  refuted every specific news-publisher CTR benchmark, so 0.66% is currently
  uninterpretable. The case for change rests on the selection/drop defects
  above, not on a benchmark.)

### How to measure

- Per-campaign `sent` vs. eligible-base size, grouped by publish-time
  clustering: quantify how often a campaign reaches <100 because it sits
  behind another within the cooldown window (the `cooled` bucket count is
  already returned in the dispatch result + `CAMPAIGN_DISPATCHED` audit
  metadata).
- A/B (live system only): defer-not-drop vs. current drop — compare total
  reach and CTR. The literature can't answer this; it's empirical for us.

### Proposed fix

Move from "per-article immediate send + drop-on-cooldown" to **editorial
priority + batching/digest + defer-not-drop**. Verified best-practice basis
(deep-research pass, 2026-06-16; 12 confirmed claims, adversarially verified):

- **Priority, not first-come** *(high conf., 3-0)* — urgent/important items
  send instantly; less-critical items are batched into a digest. The current
  design has neither. (SuprSend; corroborated by Apple APNs, Braze, Novu.)
- **Batching reduces fatigue & improves UX** *(high, 3-0)* — peer-reviewed
  (Fitz/Kushlev 2019, n=237 RCT; ~3×/day batching optimal). Braze: digests
  ~35% higher engagement, ~28% lower opt-out.
- **More frequency → lower per-message open rate** *(high, 3-0)* — peer-reviewed
  (Wohllebe 2021, n=17,500). Selection matters more than raw volume.
- **Topic targeting (already implemented) lifts CTR ~1.3–1.4×** *(medium, 2-1)*
  — keep and lean into the GST/Income-Tax opt-ins. (PushEngage.)
- **"Skip on cap" is acceptable ONLY when paired with priority/digest**
  *(high)* — Braze also skips capped messages, but couples it with explicit
  priority handling. We have the skip without the priority/digest half — that
  is exactly the gap.
- **Daily cap ~4/day is the safe ceiling** *(medium)* — vendors span 2–8/day;
  Chrome's Jan-2026 notification rate-limiting makes ~4/day a real ceiling, not
  just advice. News/media has more headroom than most verticals.
- **Send-time optimization: deprioritize** *(medium)* — uplift claims were
  refuted, and naive implementations drop users with no computed time (the same
  antipattern). Not worth it now.

Concrete shape (fits the existing Node/Express + node-cron + web-push stack,
**no Redis/BullMQ** — preserves the Phase-1 constraint):

1. Poller collects new articles into a short window (e.g. 10–15 min) instead of
   firing each immediately.
2. Rank candidates by editorial priority (topic match to subscriber opt-in +
   recency + an importance signal).
3. Send the **top item(s)** now; **bundle the rest into a periodic digest**
   ("5 new GST rulings today").
4. **Defer** cooled subscribers to their next eligible slot (persist in
   Postgres) rather than dropping them.
5. Keep topic segmentation; set `FREQ_CAP_PER_DAY` to ~4.

Open empirical questions (A/B on the live system, not answerable from
literature): does defer-not-drop actually raise total reach/CTR here, what
digest cadence fits legal-news subscribers who may want timely ruling alerts,
and what importance signal best ranks rulings (court/ruling type, recency).

Full verified report + sources: deep-research run 2026-06-16 (transcript under
the session's `workflows/` dir). Benchmark caveat above stands — do not set caps
against any specific unsubscribe-vs-frequency curve; several were refuted.

---

## 6. GitHub `*/5` warm-ping fires only every ~2–4.5 h (redundant — UptimeRobot covers liveness)

**Filed:** 2026-06-19. **Owner:** internal. **Severity:** low (downgraded — see update).

> **✅ UPDATE 2026-06-19 — worker is NOT actually going cold; this is effectively a non-issue.**
> The UptimeRobot monitor on `…up.railway.app/healthz` is confirmed active, checking **every
> 5 min**, showing **100% uptime over the last 7 and 30 days (0 incidents, 0m down)** and a
> 12-day continuous up-streak, flat ~290 ms response time. So the unreliable GitHub `*/5` ping
> is redundant — UptimeRobot is the real, reliable keep-warm/liveness pinger and the worker
> stays warm. The cold-worker theory for the 2026-06-19 "Refresh failed" reports is therefore
> **refuted**: the server was up 100% on those days. Remaining likely cause of those reports is
> the 8h session TTL (day-apart logout → 401) + occasional mobile network blips, both now
> handled gracefully by the client retry + 401→login shipped in `69bd496`. No action needed on
> the warm-ping; leaving the GitHub workflow in place as a harmless secondary. Original analysis
> retained below for history.

### What's happening

`.github/workflows/warm-ping.yml` is scheduled `cron: '*/5 * * * *'` to hit
`/healthz` every 5 minutes and keep the Railway worker hot. GitHub heavily
throttles/deprioritises scheduled workflows (especially high-frequency `*/5` on
lower-activity repos), so the runs do **not** happen every 5 min. `gh run list
--workflow=warm-ping.yml` on 2026-06-19 showed actual gaps of **~1.9–4.5 hours**:

```
06-19 02:34 → 06-18 23:48 → 21:56 → 19:50 → 17:30 → 14:11 → 10:55 → 06:26
```

During those multi-hour gaps the worker can idle/cold-start, so the first
request after idle (a page load or a Refresh click) is slow or returns 5xx.

### Impact

Surfaced as the user-reported "clicked Refresh and the site failed to load,"
intermittently, on both desktop and mobile. The client-side timeout + retry
shipped 2026-06-19 (commit `69bd496`) now **masks** this (a retry usually hits a
now-warm worker), but the underlying cold-worker window still exists. When warm,
latency is fine (`/api/metrics` ~0.34s, `/api/reports` ~0.20s) — so this is purely
a cold-start problem, not slow queries.

### How to measure

- `gh run list --workflow=warm-ping.yml -L 20` — confirm the real cadence vs the
  intended 5 min (the gaps above are the symptom).
- Railway metrics/logs — look for cold-start spikes or restarts correlated with
  the ping gaps and with reported failures.

### Proposed fix

Don't rely on GitHub's `*/5` schedule for liveness. Options (pick one):

1. **Confirm UptimeRobot is still active** (5-min monitor on `/healthz`, set up at
   go-live) — it's an independent, reliable pinger and the real safety net. If it
   lapsed, re-enable it. This alone likely closes the gap.
2. Move the warm-ping to an external cron pinger (cron-job.org, a Railway cron
   service, or an Uptime/Cloudflare worker) that actually fires every 5 min.
3. Configure Railway so the service does not idle (min replicas / always-on),
   removing the need to keep it warm at all.

Until then, the client retry keeps the symptom mostly invisible to users.
