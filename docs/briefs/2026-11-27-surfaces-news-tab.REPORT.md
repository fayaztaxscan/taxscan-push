# Report: Surfaces adds the News tab in Google Search

- **Brief:** `docs/briefs/2026-11-27-surfaces-news-tab.md` with Follow-ups 1 and 2
- **Branch:** `build/surfaces-news-tab`, base `2f4e3bc` (develop has since moved to `2f6adcd`: record + brief commits only)
- **Code commit:** `364bc09` `feat(reports): Surfaces adds the News tab in Google Search as a third surface (brief 2026-11-27-surfaces-news-tab)`
- **Built:** 27 Nov 2026. All six acceptance tests and both follow-ups PASS. Full suite 3035/3035.

## After deploy: backfill the history
```sh
curl -sS -X POST https://push.taxscan.in/api/admin/surfaces/backfill \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"surface":"news","from":"2026-01-01"}'
# 202 {"id":"…","state":"running",…}   11 monthly chunks when run in November
curl -sS -H "Authorization: Bearer $ADMIN_TOKEN" https://push.taxscan.in/api/admin/surfaces/backfill/<id>
```
- The routine sync runs 45 s after boot. A `409 sync_running` then just means wait a minute and repeat.
- Until the backfill is done only the last 7 days of `news` exist, so earlier months show "—".
- Check against the brief's monthly figures loosely: the screen counts **article pages only**, so it should be at or
  below Search Console's property totals.
- An app restart forgets the run (`404`); post the same range again.

## Files changed
- `prisma/schema.prisma` + `prisma/migrations/20261127095058_surfaces_search_news/`: two enum values.
- `src/services/searchSurfaces.ts`: third surface (type `news`), `surfaces` option, delete scoped to the fetched
  surfaces, `searchNews=N` in the log, one lock for the cron and the backfill (`runScheduledSync`).
- `src/services/surfacesBackfill.ts` (new): request rules, monthly chunks, run state.
- `src/routes/api.ts`: `POST /api/admin/surfaces/backfill`, `GET …/:id`; two on-screen messages no longer name two surfaces.
- `src/services/surfacesReport.ts`: built from `SURFACES`; no two-surface list left.
- `src/services/readsReport.ts`: `titleFromPath` drops only an old article id (Follow-up 1).
- `scripts/backfill-surfaces.ts`: `--surface discover|news|googleNews`; a missing or misspelt value stops the script.
- `admin/src/views/Reports.vue`: third surface, hint, three-surface copy (details below).
- `admin/src/views/Activity.vue`: the new audit action in the filter, with a readable summary.
- `docs/Taxscan-Push-Admin-Guide.html` (2.40 → 2.41), `docs/SURFACES.md` (new).
- Tests: `searchSurfaces`, `surfacesReport`, `readsEmail`, new `surfacesBackfill` (40 new tests in all).

## Migrations
`20261127095058_surfaces_search_news`, additive: `SearchSurface` + `GOOGLE_SEARCH_NEWS`; `AuditAction` +
`SURFACES_BACKFILL_STARTED`.

## Flags / env
None. Sync and backfill both stay behind `SEARCH_CONSOLE_ENABLED`.

## Test results (verbatim)
Final code:
- `npx tsc -p tsconfig.json --noEmit`: exit 0, no output.
- `npm run lint`: exit 0.
- `npm run build:admin`: exit 0, `✓ 145 modules transformed.`
- **Full suite** (schema change), first run, nothing re-run:
  `Test Suites: 124 passed, 124 total` / `Tests:       3035 passed, 3035 total`

Earlier, before the Follow-up 2 wording (strings and comments only):
- New and changed files: `Test Suites: 5 passed, 5 total` / `Tests:       122 passed, 122 total`
- Area (with `api`, `audit*`, reads and scheduler files):
  `Test Suites: 12 passed, 12 total` / `Tests:       234 passed, 234 total`
- With the delete deliberately not scoped to the fetched surfaces (then restored, checksum identical):
  `Tests:       2 failed, 52 passed, 54 total`

## Acceptance tests
1. **PASS.** Build DB seeded before the migration with 40,000 surface rows and 25 audit rows; row counts, click and
   impression sums and an md5 over every row were identical afterwards. The enum lists three values.
2. **PASS.** All three types fetched and stored; with `news` failing, every stored row is byte-for-byte unchanged.
3. **PASS.** Month columns, bench and category rows for old and id-less addresses, totals, top list; site pages
   excluded; Discover and Google News payload parts equal before and after adding `news` rows.
4. **PASS.** Anonymous 401, publisher 403, ADMIN session and bearer 202; `surface=news` asks only for `news`, oldest
   month first; rerun gives identical rows and leaves Discover alone; bad surface or range 400 with no call to Google;
   status shows progress mid-run; failing chunk, busy lock, not-configured and audit row covered.
5. **PASS** (real browser, local seeded data, desktop 1440 px and 375 px). Order Discover, Google Search · News, Google
   News; hint visible; 33 surface-months on screen against independent SQL, 0 mismatches; empty state for the new
   surface checked; no horizontal overflow outside the scrolling tables; no page errors (only the expected 401 before
   sign-in); Activity shows the new action. **This check ran with the first hint wording;** Follow-up 2 then shortened
   that one string. The admin build passes; I did not repeat the browser run.
6. **PASS.** In the full suite. One existing assertion was replaced by a stricter one (the empty report now checks all
   three top lists, not only Google News); one line was added beside it for the new grid.

- **Follow-up 1 PASS:** `/gst/x-fy-2025-26` → "X fy 2025 26"; `/gst/x-section-148` → "X section 148"; `/gst/x-1448729` → "X".
- **Follow-up 2 PASS:** hint "News tab in Google Search"; guide, `docs/SURFACES.md` and code comments reworded; no
  added line mentions Top stories. Label and fold rule unchanged.

## What staff will see
- **The new section starts folded in production** (as ruled): October News tab 3,676 clicks against Discover 39,303 and
  Google News 565 is 8.4%. Its headline tile still shows.
- A month with no rows for a surface now shows "—" instead of 0 (all three, totals row included), and no Δ is worked
  out against it, so a half-backfilled surface does not read "▼ 100%".
- "Best month on screen" looks only up to the compared month. If no surface has clicks in that month, nothing folds.
- On phones the headline tiles are full width.
- **Share card:** still Discover-led, but **extended**: one line for each other surface that has figures (before, only
  Google News). Checked on screen; the PNG export was not tested.

## Deviations
- A second enum value in the same migration (the audit action): the brief asked for an audit entry and named only the
  surface value.
- The audit entry is written at start with surface, from, to and chunk count. The log is append-only, so it holds no
  final row count.
- Choices the brief left open: `surface` takes Search Console's names; `to` is optional (today, IST); `from` may be at
  most 16 months back; the run stops at the first failing chunk (the CMS-views pattern; the script still carries on);
  one backfill at a time, and a routine pass falling during one is skipped.
- `Activity.vue` was not in the brief's file list.
- `docs/SURFACES.md` is new: `docs/` had no note describing Surfaces.

## Agents run
- `ui-developer`: `Reports.vue`, `Activity.vue`, the guide, and the browser check. Its processes are stopped.
- Backend, tests and the Surfaces note: build session.
- Two public read-only requests to Google's documentation (developers.google.com, support.google.com) to check the
  `news` definition.

## Notes and suggestions (nothing below is built)
1. As before this build, a date returned for **any** fetched surface is replaced for all fetched surfaces: one that
   returned nothing for that date loses its stored rows for it. With three surfaces, replacing per surface and date
   would be the more cautious rule.
2. Older problems seen in the browser check: in range mode the Surfaces footnote still describes month-on-month Δ; on
   phones "Most picked-up articles" squeezes headlines to a few words a line (two pinned columns), now up to three
   times; the guide still says Reads come from Google Analytics with a switch "planned early November".
3. The Search Console comment in `.env.example` still names two surfaces.

## Clean-up (planning session, after merging)
```sh
git worktree remove ../taxscan-push-worktrees/surfaces-news-tab
dropdb taxscan_push_build_surfaces-news-tab; dropdb taxscan_push_build_surfaces-news-tab_shadow
git branch -D build/surfaces-news-tab; git push origin --delete build/surfaces-news-tab
```
