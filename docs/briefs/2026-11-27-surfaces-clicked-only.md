# Brief: Surfaces keeps only clicked rows

- **Date / name:** 2026-11-27-surfaces-clicked-only  →  branch `build/surfaces-clicked-only`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first)

## Goal
`ArticleSurfaceStat` stores only (page, date, surface) rows with **at least one click**. The click figures on Reports →
Surfaces stay exactly the same; the table shrinks from ~456 MB to tens of MB and stops growing ~0.5 GB a year.

## Why (owner's words)
> 27 Nov 2026: "yes, go with option 1" — option 1 = "Keep only rows that got at least one click, then reclaim the space.
> Click figures stay exactly the same; the 'impressions' figure would count only pages that were clicked."

Facts (prod, read-only, 27 Nov after the `news` backfill, PR #119):
| surface | rows | zero-click rows |
|---|---|---|
| DISCOVER | 12,413 | 938 |
| GOOGLE_NEWS | 26,707 | 24,164 |
| GOOGLE_SEARCH_NEWS | 839,057 | 805,197 |
Table 456 MB, DB 1.4 GB, volume 52% (4.6 GB).

## Scope
**In:**
1. **Sync + backfill:** `searchSurfaces.ts` drops rows whose clicks (after the per-path merge and rounding) are 0 before
   writing — all three surfaces, one rule. The replace-by-date and "all fetches finish before any delete" behaviour stay.
   A date where every row had 0 clicks still deletes that date's old rows (so stale zero rows can't linger) — say how you
   handled it.
2. **Cleanup migration:** `DELETE FROM "ArticleSurfaceStat" WHERE clicks = 0;` (data-only, idempotent). No VACUUM in the
   migration — the planner runs `VACUUM FULL "ArticleSurfaceStat"` after deploy.
3. **Screen honesty:** wherever Surfaces shows impressions (cells, headline, tooltips, share card), it reads as
   impressions **of clicked pages**: one short hint near the impressions figure, e.g. "Impressions count pages with at
   least one click." Any CTR (clicks ÷ impressions) shown must be labelled likewise or removed — say which.
4. Docs: `docs/SURFACES.md` + admin guide (one line, version bump); the `ArticleSurfaceStat` schema comment says rows exist
   only for clicked pages.

**Out (do not build):**
- No change to clicks, columns, benches, categories, top list order (it sorts by clicks already).
- No change to the Search Console query (it can't filter on clicks).
- No other table.

## Acceptance tests
Each one must PASS in the REPORT.
1. Sync with mocked rows (some 0-click, some ≥1, two URLs folding onto one path where one has clicks) writes only paths
   with clicks ≥ 1; the folded path keeps both rows' impressions.
2. A date whose rows are all 0-click: old rows for that date are removed, nothing new written.
3. Backfill endpoint follows the same rule (same code path — show it).
4. Migration on a prod-shaped copy: zero-click rows gone, clicked rows untouched, clicks totals per surface/month identical
   before vs after (show the numbers).
5. Surfaces report for a fixture: click cells identical before/after removing zero-click rows; the impressions hint shows.
6. Existing `searchSurfaces`, `surfacesReport`, `surfacesBackfill`, `readsReport` tests pass.

## Files
- `src/services/searchSurfaces.ts`, migration `prisma/migrations/<ts>_surfaces_clicked_only/`, `prisma/schema.prisma` (comment)
- `admin/src/views/Reports.vue` (hint → `ui-developer`)
- Tests: `searchSurfaces`, `surfacesReport`, `surfacesBackfill`
- `docs/SURFACES.md`, admin guide

## Constraints
- Flag: none — owner's decision; clicks unchanged.
- Migrations: one, data-only DELETE.
- Full suite: **yes** (migration).
- After deploy (planner): `VACUUM FULL "ArticleSurfaceStat"` on prod (locks only that table, seconds–a minute), then record
  the new size.

## Context the builder needs
- `searchSurfaces.ts`: the per-path merge (`surfacePagePath`, rounding) happens before write; filter after it.
- Brief `2026-11-27-surfaces-news-tab` + its REPORT for the backfill path.
- `docs/EVENT_RETENTION.md` / CLAUDE.md for the earlier VACUUM FULL precedent.

## Follow-up 1 (planning, 27 Nov — builder's catch, agreed)
1. Acceptance 5 means: click TOTALS and every cell with ≥ 1 click identical. A cell made only of 0-click rows becomes a
   dash, a row made only of such cells disappears, article counts count clicked articles, equal-click ties in the top list
   may reorder. Reword the dash footnote + guide: a dash now also covers "shown but never clicked".
2. Rows are per page per DAY, so the hint reads: "Impressions count a page only on days it got at least one click."
