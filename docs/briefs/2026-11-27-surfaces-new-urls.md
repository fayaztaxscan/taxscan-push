# Brief: Surfaces report counts new-CMS article URLs

- **Date / name:** 2026-11-27-surfaces-new-urls  →  branch `build/surfaces-new-urls`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first)

## Goal
Reports → Surfaces (Google Discover / Google News) shows the October and November clicks again. Every article page counts,
whether its address is the old `/<section>/<slug>-<id>` or the new CMS's `/<section>/<slug>`. Non-article pages stay out.

## Why (owner's words)
> 27 Nov 2026: "Is our https://push.taxscan.in/admin/reports correct? We have been getting listed regularly in google
> discovery now a days. But I do not see those numbers in the report." (screenshot: every bench "—" for Oct and Nov)

Facts (prod, read-only, 27 Nov):
- `ArticleSurfaceStat` matches the Search Console API exactly (property `https://www.taxscan.in/`); the SYNC is fine.
- The REPORT drops each row whose path doesn't end in `-\d{5,}` (`ARTICLE_PATH_JS_RE`, `surfacesReport.ts:398` grid and
  `:456` top list). New-CMS article URLs carry no id (same change as CLAUDE.md "2 Nov, PR #94").
- Discover clicks, id-path vs no-id path: Aug 141,721 / 0 · Sep 119,278 / 214 · **Oct 17 / 39,303 · Nov 0 / 18,881**.
  Google News the same shape (Oct 32 / 533).
- No-id paths since 28 Sep are all two segments. First segments with clicks: gst 26,239 · other-taxations 22,859 ·
  income-tax 8,403 · corporate-laws 721 · news-updates 558 · excise-customs 181. Non-article two-segment pages seen:
  `/trackers/gst`, `/trackers/income-tax`. Pushed taxscan.in links since 28 Sep also use `subscription`, `top-stories`,
  `pricing` (site pages, not articles).
- (Separately, and NOT for this build: Google's own Discover numbers also fell from 16 Nov — ~200–360 clicks/week. The
  report must show that honestly once fixed.)

## Scope
**In:**
1. One shared rule `isArticlePath(path)` (in `readsReport.ts` next to `ARTICLE_PATH_JS_RE`, or a small module both import):
   true when the path ends in the old id (today's rule) **or** is exactly `/<section>/<slug>` with `<section>` in an
   allow-list of taxscan.in article sections: `gst, income-tax, corporate-laws, excise-customs, other-taxations, cst-vat,
   service-tax, job-scan, news-updates, top-stories` — confirm `top-stories`/`news-updates` hold articles (look at a few
   paths in your seed/prod-shaped data; if unsure, keep them in and say so in the REPORT). `trackers`, `subscription`,
   `pricing`, the homepage and single-segment pages are NOT articles. Trailing slash ignored.
2. `surfacesReport.ts`: both the grid loop and `topSurfacedArticles` use `isArticlePath` instead of `ARTICLE_PATH_JS_RE`.
   Classification (`titleFromPath` → category/bench) is unchanged and already works on id-less slugs.
3. `readsSummaryForWindow` keeps its `usedCms` bypass; switch its GA branch to `isArticlePath` too (one rule, no drift).
   Leave the GA API filter string `ARTICLE_PATH_RE` alone (GA covers dates before 8 Oct only) — note it in a comment.
4. Admin guide: one line under Reports → Surfaces that articles from both URL styles count. Bump the guide version.

**Out (do not build):**
- No sync change, no backfill, no migration — the stored rows are already right.
- No investigation of the real Discover drop (owner is checking Search Console's Manual actions / Discover pages).
- No change to the coverage report's `articleKey()`.

## Acceptance tests
Each one must PASS in the REPORT.
1. `isArticlePath`: `/gst/foo-bar-12345` ✓, `/gst/foo-bar` ✓, `/other-taxations/foo` ✓, `/income-tax/foo/` ✓,
   `/trackers/gst` ✗, `/subscription/x` ✗, `/pricing` ✗, `/` ✗, `/gst` ✗, `/foo-bar` (one segment, no id) ✗,
   `/foo-bar-12345` (old one-segment id) ✓ as today.
2. Surfaces report over a fixture with id and no-id Discover rows in Oct/Nov: the month columns include the no-id clicks,
   bench/category rows are filled (e.g. a `…-delhi-high-court` slug lands on Delhi High Court), totals = sum of article rows.
3. Top most-surfaced list includes no-id articles, titled from the Campaign when pushed, else from the slug.
4. `/trackers/gst` rows with clicks never appear in any grid row, total or top list.
5. Existing `surfacesReport`, `readsReport`, `searchSurfaces` tests pass (say which assertions changed, if any).
6. Real browser (local, prod-shaped data or seeded): Reports → Surfaces shows non-dash Oct/Nov cells; screenshot numbers in the REPORT.

## Files
- `src/services/readsReport.ts` (rule), `src/services/surfacesReport.ts` (two call sites)
- Tests: `src/__tests__/surfacesReport.test.ts`, `src/__tests__/readsReport.test.ts`
- Admin guide (Reports → Surfaces line + version)

## Constraints
- Flag: none — a report-only correction; history reclassifies at read time.
- Migrations: none.
- Full suite: no — area tests `surfacesReport|readsReport|searchSurfaces|reports`.
- Report cache: `/api/reports/*` short TTL; nothing to clear.

## Context the builder needs
- `ARTICLE_PATH_JS_RE` doc comment (readsReport.ts ~315) explains why there must be ONE copy of the article rule.
- `readsPath()` (`src/services/reads.ts`) gives the stored `pagePath` shape (no host, no trailing slash).
- CLAUDE.md "2 Nov, PR #94": new article URLs are `/<section>/<slug>`, no numeric id.
