# Brief: Surfaces report adds Google Search's News tab / Top stories

- **Date / name:** 2026-11-27-surfaces-news-tab  →  branch `build/surfaces-news-tab`, base `origin/develop`
  **AFTER `2026-11-27-surfaces-new-urls` is merged** (same files; build on top of its `isArticlePath`).
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first)

## Goal
Reports → Surfaces shows a third Google surface, **"Google Search · News"** (Search Console search type `news` = the News
tab and Top stories in Google Search), with the same month grid, benches, categories, top list and history from Jan 2026
as Discover and Google News.

## Why (owner's words)
> 27 Nov 2026: "check Google News also" … "yes, add News tab too"

Facts (Search Console API, read-only, property `https://www.taxscan.in/`, 27 Nov):
- Type `news` is bigger than `googleNews` (the Google News app/site) and we don't sync it. Monthly clicks: Jan 9,229 ·
  Feb 7,270 · Mar 5,509 · Apr 5,855 · May 4,674 · Jun 4,610 · Jul 3,569 · Aug 2,972 · Sep 5,591 · Oct 3,676 · Nov 863
  (impressions Oct 382,894 → Nov 54,780). `googleNews` for comparison: Jan 2,206 … Oct 565, Nov 36.
- The service account already has access; same endpoint, same `dimensions: ['date','page']`, only `type: 'news'` differs.

## Scope
**In:**
1. Migration: add `GOOGLE_SEARCH_NEWS` to enum `SearchSurface` (additive; name it as you see fit but keep it distinct
   from `GOOGLE_NEWS`).
2. `searchSurfaces.ts`: `SURFACES` gains `{ surface: 'GOOGLE_SEARCH_NEWS', type: 'news' }`. Keep the rule that ALL
   fetches finish before anything is deleted; a failure on any one type writes nothing for that pass. Sync log line gains
   `searchNews=N`.
3. `surfacesReport.ts`: the third surface flows through grids, totals, headline and top list (it should mostly follow
   `SURFACES`; remove any two-surface assumptions).
4. `admin/src/views/Reports.vue`: `SurfaceKey`/`SURFACE_KEYS`/labels gain the third surface, label
   **"Google Search · News"** with a one-line hint "News tab and Top stories in Google Search". Order on screen: Discover,
   Google Search · News, Google News. The share card stays Discover-led (unchanged) unless trivially extendable — say which.
5. History: backfill `news` from 2026-01-01 to today. `scripts/backfill-surfaces.ts` is month-by-month and idempotent;
   add a way to run it for ONE surface (e.g. `--surface news`) so Discover/Google News history is not re-fetched.
   Production can't run the script: `railway ssh` into the app no longer connects (static outbound IPs) and the prod DB
   has no public proxy. So **add an ADMIN/bearer endpoint**
   `POST /api/admin/surfaces/backfill {surface, from, to}` following the `cms-views/backfill` pattern (async job id,
   `GET …/:id` status, chunks ≤ 1 month, oldest first, one at a time, audit entry with counts only).
6. Docs: admin guide (Reports → Surfaces: the third surface and what it means), `docs/` note where Surfaces is described;
   guide version bump. Record the backfill command in the REPORT for the planner to run after deploy.

**Out (do not build):**
- No change to the Campaigns screen (still no Search Console columns — owner ruling, latency).
- No `web`/`image`/`video` search types.
- No investigation of the November drop.

## Acceptance tests
Each one must PASS in the REPORT.
1. Migration applies on a copy of prod-shaped data; existing rows untouched.
2. Sync with a mocked API returning rows for all three types writes three surfaces; a failure on `news` writes NOTHING for
   that pass (Discover/Google News dates not deleted).
3. Surfaces report: the third surface has month columns, bench/category rows (both URL styles via `isArticlePath`), totals
   and a top list; Discover and Google News numbers unchanged vs before for the same fixture.
4. Backfill endpoint: ADMIN or bearer only (PUBLISHER → 403, anonymous → 401); `surface=news` fetches only `news`;
   re-running a month is idempotent; a bad range → 400; status endpoint reports progress.
5. Reports.vue (real browser, phone + desktop): three sections in the order above, the hint visible, no layout break.
6. Existing `searchSurfaces`, `surfacesReport`, `readsReport`, `reports` tests pass.

## Files
- `prisma/schema.prisma` + migration
- `src/services/searchSurfaces.ts`, `src/services/surfacesReport.ts`, `scripts/backfill-surfaces.ts`,
  a small `src/services/surfacesBackfill.ts` (or similar) + route in `src/routes/api.ts`
- `admin/src/views/Reports.vue` (→ `ui-developer`)
- Tests: `searchSurfaces`, `surfacesReport`, new backfill route test
- Admin guide + Surfaces doc

## Constraints
- Flag: none — read-only data from Google into a report; the sync is already behind `SEARCH_CONSOLE_ENABLED`.
- Migrations: one, additive (enum value).
- Full suite: **yes** — schema change.
- Search Console quota: three queries per 6-hour sync plus the one-off backfill is well inside limits; keep the existing
  page cap/fail-instead-of-truncate behaviour.
- Never log tokens or the service-account JSON.

## Context the builder needs
- `searchSurfaces.ts` header: why explicit `startDate`/`endDate` (never back-date `now`, it signs the JWT).
- `scripts/backfill-surfaces.ts` header: month chunks, replace-by-date idempotency.
- `cmsViews/backfill.ts` + `api.ts:963` for the async ADMIN backfill pattern.
- Brief `2026-11-27-surfaces-new-urls` for `isArticlePath`.

## Follow-up 1 (planning, 27 Nov — from the surfaces-new-urls REPORT)
`titleFromPath` strips ANY trailing `-<digits>` (`/-\d+$/`), so a new id-less slug ending in a number loses it
(`…-fy-2025-26` → "… fy 2025"). Strip only an old article id (`-\d{5,}$`, the same rule as `isArticlePath`'s id test).
Acceptance: `/gst/x-fy-2025-26` → "X fy 2025 26"; `/gst/x-section-148` keeps 148; `/gst/x-1448729` → "X".

## Follow-up 2 (planning, 27 Nov — builder's catch)
Google's API reference defines type `news` as results from the **"News" tab in Google Search** only; Top stories is not
named. Use exact wording: the hint reads **"News tab in Google Search"** (screen, guide, Surfaces doc, code comments);
the label "Google Search · News" stays. Do not claim Top stories anywhere. The under-a-tenth fold rule applies to this
section like the others (no special case).
