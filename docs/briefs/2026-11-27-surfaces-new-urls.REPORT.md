# Report: Surfaces report counts new-CMS article URLs

- **Brief:** `docs/briefs/2026-11-27-surfaces-new-urls.md`
- **Branch:** `build/surfaces-new-urls`, base `28e0d18` (develop has since moved to `ba14c5c`, a brief file only)
- **Code commit:** `214a00f` `fix(reports): Surfaces counts new-CMS article URLs (brief 2026-11-27-surfaces-new-urls)`
- **Built:** 27 Nov 2026. All six acceptance tests PASS.

## Files changed
- `src/services/readsReport.ts`: new `isArticlePath()` (old id address, or exactly `/<section>/<slug>` in the brief's
  section list; trailing slash ignored). `ARTICLE_PATH_JS_RE` is gone; its pattern is now the private
  `ARTICLE_ID_PATH_RE`. The GA branch of `readsSummaryForWindow` uses the new rule; `usedCms` bypass kept. Comment on
  the GA API filter `ARTICLE_PATH_RE` (left unchanged).
- `src/services/surfacesReport.ts`: grid loop and `topSurfacedArticles` use `isArticlePath`.
- `src/__tests__/readsReport.test.ts`: 26 new tests (rule table; reads summary over id-less GA rows).
- `src/__tests__/surfacesReport.test.ts`: 5 new tests (Oct/Nov fixture with both URL styles and site pages).
- `docs/Taxscan-Push-Admin-Guide.html`: one line under the Surfaces tab; version 2.39 → 2.40.

## Migrations
None.

## Flags / env
None. Report-only; history reclassifies at read time. The Surfaces cache is the usual short TTL.

## Test results (verbatim)
- `npx tsc -p tsconfig.json --noEmit`: exit 0, no output.
- `npm run lint` (`eslint "src/**/*.ts"`): exit 0.
- New tests (`jest surfacesReport readsReport`):
  `Test Suites: 2 passed, 2 total` / `Tests:       60 passed, 60 total`
- Area (`surfacesReport|readsReport|searchSurfaces|reports|readsEmail|readsCms|reportScheduler`):
  `Test Suites: 7 passed, 7 total` / `Tests:       138 passed, 138 total`
- `api.test.ts` (reads the guide), run after the guide edit:
  `Test Suites: 1 passed, 1 total` / `Tests:       32 passed, 32 total`
- Full suite: **not run** (brief says no; no schema, auth, send path, config or `useApi` change).
- `npm run build:admin`: not run (no `admin/` change).

Do the new tests catch the fault? Two temporary edits to `isArticlePath`, each restored (checksum identical) before the
runs above:
- old rule only: `Tests:       15 failed, 45 passed, 60 total`
- any two-segment path counts (no section list): `Tests:       10 failed, 50 passed, 60 total`

The first run of the new tests had 1 failure from my own fixture (a `/gst/…` slug with no "gst" word did not land in
the GST category row). I changed the fixture slug, not the code. See note 2.

## Acceptance tests
1. **PASS.** Every path in the brief's list, plus each listed section and a few near misses (`/gstx/foo`,
   `/gst/page/2`, `/gst/`, empty).
2. **PASS.** Oct and Nov columns count id-less clicks (Discover Oct 510 clicks / 3 articles, Nov 100 / 2); the
   `…-delhi-high-court` slug fills Delhi High Court; every category and bench grid adds up to the column totals for both
   surfaces. Range mode checked too.
3. **PASS.** Id-less articles in the top list; title from the Campaign (stored URL with a UTM) when pushed, else from
   the slug.
4. **PASS.** `/trackers/gst` (5,000 clicks), `/trackers/income-tax`, `/subscription/…`, `/pricing`, `/gst` and `/` are in
   no total, grid row or top list.
5. **PASS.** Existing `surfacesReport`, `readsReport`, `searchSurfaces` tests pass; **no existing assertion changed**.
6. **PASS** (real browser, local, **seeded** prod-shaped data, desktop 1440 px and 375 px). Screen / independent SQL over
   the article-only seed rows:

   | Month | Discover | Google News |
   |---|---|---|
   | Aug | 141.7k / 141,721 | 1.1k / 1,075 |
   | Sep | 119.3k / 119,278 | 905 / 905 |
   | Oct | 39.3k / 39,303 | 533 / 533 |
   | Nov (partial) | 18.9k / 18,881 | 214 / 214 |

   Oct and Nov show numbers in bench and category tables (dashes only where the seed has no row). Delhi High Court
   Discover Oct 12.9k, Nov 6.2k (SQL 12,865 / 6,183). No site page on screen or in a top list. Custom range 1–24 Nov
   against the 24 days before: Discover 18.9k / 24.8k, News 214 / 335. No console errors. The local sync logged that it
   was not started (no credentials). Not tested: image export, a real phone.

## Section list: `top-stories` and `news-updates`
**Not confirmed; both kept, as the brief allows.** I read the public `news-sitemap.xml` (55 article URLs) and master
feed (50) once, ~15:05 IST. Every URL is `/<section>/<slug>` with no id, under `income-tax`, `gst`, `excise-customs`,
`other-taxations`, `job-scan` or `corporate-laws`, all in the list. Neither `top-stories` nor `news-updates` appears. A
read-only prod look at a few `/news-updates/…` paths in `ArticleSurfaceStat` would settle it.

## Agents run
- `ui-developer`: the guide line + version, and the real-browser check. Its servers and browsers are stopped.
- Backend and tests: done in the build session.

## Deviations
- Ran three test files beyond the brief's pattern (`readsEmail`, `readsCms`, `reportScheduler`) because they cover
  `readsSummaryForWindow`, plus `api.test.ts` for the guide.
- Two read-only requests to `www.taxscan.in` (sitemap and feed, above), since the build database holds no real paths.

## Notes and suggestions (nothing below is built)
1. **Fallback headlines lose a trailing number.** `titleFromPath` strips any `-<digits>`, which was right when every
   counted address ended in an id. 2 of the 55 sitemap URLs now end in digits, e.g.
   `/gst/icai-releases-technical-guide-on-gst-annual-return-gstr-9-for-fy-2025-26` (the slug title would end
   "fy 2025") and a `…-read-order-2` one. Only shows for articles with no pushed Campaign (top list, reads email).
   Suggest `-\d{5,}$` with a test.
2. **Classification ignores the section.** Category and bench come from the slug alone, so a `/gst/…` story whose slug
   names no GST term is not counted under GST. The section is now in the address and could be a hint. As briefed,
   unchanged.
3. **GA filter left as briefed.** `ARTICLE_PATH_RE` still asks GA for id addresses only, so GA-sourced parts of the
   Reads tab omit id-less articles (28 Sep to 7 Oct with the production cut-over).
4. **`cst-vat` vs `cst-vat-gst`.** The default GST feed in `src/lib/env.ts` is `/cst-vat-gst/feed`; the list has
   `cst-vat`. No `cst-vat-gst` article path in the sitemap, the feed or the brief's click figures, so no sign of a miss.
   A prod query of distinct first segments would close it.
5. **A new article section must be added to `ARTICLE_SECTIONS`**, or its stories drop out silently.
6. **Older problems on the screen** (`admin/src/views/Reports.vue`, seen in the browser check, left alone):
   - range mode's footnote still says Δ compares "the last complete month with the one before it";
   - on phones the range date inputs are 13 px (iOS zooms on focus): a later base rule overrides the 16 px phone rule;
   - "flat" prints in red when a change rounds to 0%;
   - at 375 px the pinned label takes about half the grid, so Oct and Nov need a swipe.

## Clean-up (planning session, after merging)
```sh
git worktree remove ../taxscan-push-worktrees/surfaces-new-urls
dropdb taxscan_push_build_surfaces-new-urls; dropdb taxscan_push_build_surfaces-new-urls_shadow
git branch -D build/surfaces-new-urls; git push origin --delete build/surfaces-new-urls
```
