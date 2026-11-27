# Report: Surfaces keeps only clicked rows

- **Brief:** `docs/briefs/2026-11-27-surfaces-clicked-only.md` with Follow-up 1
- **Branch:** `build/surfaces-clicked-only`, base `9985a8c` (develop has since moved to `ca20d40`, the Follow-up, brief only)
- **Code commit:** `c8359d4` `fix(reports): Surfaces keeps only clicked rows (brief 2026-11-27-surfaces-clicked-only)`
- **Built:** 27 Nov 2026. All six acceptance tests and Follow-up 1 PASS. Full suite: 3038 of 3040 on its one run; the
  2 failures pass when their files run alone (below).

## After deploy (planner)
`VACUUM FULL "ArticleSurfaceStat";` The migration only deletes; the table does not shrink until this runs. On the build
copy with production's row counts: the delete of 830,299 rows took 3.9 s (inside `migrate deploy`, so start-up takes a
few seconds longer), then `VACUUM FULL` took 7 s and the table with indexes went **650 MB → 25 MB**.

## Files changed
- `src/services/searchSurfaces.ts`: writes only rows with a click; the dates to replace come from everything fetched.
- `prisma/migrations/20261127111037_surfaces_clicked_only/`: the cleanup.
- `prisma/schema.prisma`: comment (rows exist only for clicked page-days).
- `src/services/surfacesReport.ts`: two comments that now said the opposite. No logic change.
- `scripts/backfill-surfaces.ts`: closing line says clicked rows were written.
- `admin/src/views/Reports.vue`: impressions hint, click rate removed, dash and "no figures" wording.
- `docs/SURFACES.md`, `docs/Taxscan-Push-Admin-Guide.html` (2.41 → 2.42).
- Tests: `searchSurfaces`, `surfacesBackfill`, `surfacesReport` (5 new).

## Migrations
`20261127111037_surfaces_clicked_only`: `DELETE FROM "ArticleSurfaceStat" WHERE clicks = 0;` Data only, safe to run
again (a second run deleted 0). **Not reversible** except by backfilling, which now keeps clicked rows only.

## Flags / env
None.

## Test results (verbatim)
- `npx tsc -p tsconfig.json --noEmit`: exit 0, no output. `npm run lint`: exit 0.
- `npm run build:admin`: exit 0, `✓ 145 modules transformed.`
- `searchSurfaces|surfacesReport|surfacesBackfill|readsReport` (before the screen work):
  `Test Suites: 4 passed, 4 total` / `Tests:       122 passed, 122 total`
- **Full suite**, one run, final code:
  `Test Suites: 2 failed, 122 passed, 124 total` / `Tests:       2 failed, 3038 passed, 3040 total`
  - `facebookWorker` › API: list, retry, skip: `Expected: 400`, `Received: 404`
  - `digestScreen` › send now is refused while DIGEST_SEND_LIVE is off: `Expected: 409`, `Received: 404`
- Each re-run alone: `facebookWorker` `Tests:       41 passed, 41 total`; `digestScreen`
  `Tests:       50 passed, 50 total`. Neither is on the known-flaky list; this build touches neither area. The full suite
  was not run a second time.
- Deliberate faults, each restored (checksum identical): dates taken from the written rows only
  `Tests:       1 failed, 56 passed, 57 total`; no click filter `Tests:       3 failed, 54 passed, 57 total`.

## Acceptance tests
1. **PASS.** All three surfaces; a page under two URL spellings, one clicked, is stored once with both rows'
   impressions; two unclicked spellings store nothing.
2. **PASS.** Handling: the dates to replace are taken from **all fetched rows**, the insert from the clicked ones, so a
   date that came back all unclicked is deleted and gets nothing. A date Google did not return is left alone, as before.
3. **PASS.** One write path: backfill endpoint → `startSurfacesBackfill` → `syncSearchSurfaces({surfaces:[one]})`, which
   is also what the cron and the script call; it holds the table's only insert. Route test included.
4. **PASS.** Build copy seeded **before** the migration with production's row and zero-click counts (click and
   impression values are invented):

   | Surface | rows before → after | clicks before = after | impressions before → after |
   |---|---|---|---|
   | Discover | 12,413 → 11,475 | 235,011 | 5,591,534 → 5,140,171 |
   | Search News | 839,057 → 33,860 | 694,171 | 377,996,600 → 15,258,501 |
   | Google News | 26,707 → 2,543 | 52,077 | 12,034,025 → 1,134,777 |

   Clicks per month, identical before and after (all 33 surface-months, as are the clicked-row counts):

   | 2026 | Jan | Feb | Mar | Apr | May | Jun | Jul | Aug | Sep | Oct | Nov |
   |---|---|---|---|---|---|---|---|---|---|---|---|
   | Discover | 22343 | 19919 | 22365 | 21671 | 22284 | 21703 | 22181 | 22311 | 21186 | 21706 | 17342 |
   | Search News | 65245 | 59248 | 65852 | 63101 | 65366 | 63099 | 65311 | 65662 | 63267 | 65283 | 52737 |
   | Google News | 4826 | 4525 | 4836 | 4730 | 4931 | 4787 | 4925 | 4965 | 4525 | 5023 | 4004 |

   An md5 over every field of the 47,878 clicked rows is identical before and after.
5. **PASS** (as Follow-up 1 defines it). Fixture report built before and after removing unclicked rows: columns, every
   click total, every cell with a click and the top lists' clicks identical; an unclicked-only cell becomes a dash and an
   unclicked-only row disappears. Hint checked in a real browser (desktop and 375 px).
6. **PASS.** In the full suite; **no existing test line changed**.
- **Follow-up 1 PASS:** dash footnote and guide include "shown but never clicked"; hint reads exactly "Impressions count
  a page only on days it got at least one click."

## What staff will see
- **Click rate is removed** (top-list column and cell tooltips). With about 96% of Search News rows gone, clicks ÷ stored
  impressions would read many times higher than Google's, and no short label makes that usable.
- Impressions appear only in the top lists (hint above each) and in cell tooltips (hint at the end). Headline tiles and
  the share card show none. Phones have no hover, so per-cell impressions cannot be seen there.
- "No figures" / "no pickup" wording now says no clicks were recorded.
- A surface with no clicks in a compared period shows "—" for its change.
- The "Google has reported up to" date is now the last day that has a click.

## Deviations
- The sync's `rows` and per-surface counts (log line, backfill status) now count rows **written**, not rows fetched.

## Agents run
- `ui-developer`: `Reports.vue`, the guide, admin build and browser check. Its processes are stopped.
- Backend, migration, tests, `docs/SURFACES.md`: build session.

## Notes and suggestions (nothing below is built)
1. **A likely cause of the stray 404 test failures (not proven).** On this Mac a server listening on `::` can share a
   port with another listening on `127.0.0.1`, and a request to `127.0.0.1` then reaches the second (checked with a
   short Node script). Supertest's `request(app)` listens without a host and calls `127.0.0.1`, so a stand-in server in
   the other jest worker, or any local program, on that port would answer 404. I did not show that the system hands out
   such a port by itself. Worth a small brief: give supertest a server already listening on `127.0.0.1`. It would fit
   the `socialPause` and `telegramWorker` flakes and today's two.
2. The guide still says Search News shows a dash "until its earlier months have been collected". Harmless, but the
   backfill is done; the sentence can go.
3. Older, unchanged: in range mode the footnote still describes a month-on-month Δ.

## Clean-up (planning session, after merging)
```sh
git worktree remove ../taxscan-push-worktrees/surfaces-clicked-only
dropdb taxscan_push_build_surfaces-clicked-only; dropdb taxscan_push_build_surfaces-clicked-only_shadow
git branch -D build/surfaces-clicked-only; git push origin --delete build/surfaces-clicked-only
```
