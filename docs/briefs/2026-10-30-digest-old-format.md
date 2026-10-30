# Brief: built-in digest follows the old Mailercloud newsletter's format (stories + ads)

- **Date / name:** 2026-10-30-digest-old-format  →  branch `build/digest-old-format`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first)
- **Supersedes** `docs/briefs/2026-10-30-ad-image-size.md` (never built — do not build it).

## Goal
The built-in digest template reproduces the old hand-made Mailercloud newsletter's layout: the same widths, story
row, type sizes, button and the desktop-banner / mobile-square ad swap. The Ads screen states the two exact image
sizes and enforces them. Stories with no RSS description get one from the article page.

## Why (owner + Anagha, 30 Oct)
Anagha's feedback on the first real staff send (points 2, 3, 4, 6, 9, and 1) and the owner: **"need to follow the same
format"** as the two old samples (`~/Downloads/GST Portal Enables GSTR-9_9C Annual Returns for FY 2025-26.eml`,
`~/Downloads/GSTR-3B vs GSTR-2A Mismatch….eml` — read the HTML part of either; it is the reference).
Our version squeezes text into a 312 px column beside a 240 px picture (600 px email), so long headlines misalign and
180-char summaries run to 4+ lines. The old one is 900 px wide with a 280 px picture and a 560 px text column, where
~220 chars is 3 lines. Today's ads (800×190–210 strips) are the old *desktop* banners shown on phones too.

## The reference, measured from the old HTML
- Outer content width **900 px** (inner 860); phones collapse to one column (≤ 600 px media query, as the old
  `.st-br` / `ml-left|ml-right` / `adapt-img` rules do).
- **Story row:** picture **280 px** wide on the left (`adapt-img` → full width on phones), **20 px** gap, text column
  **560 px** on the right, both top-aligned. Headline: Arial **16 px bold**, line-height 150 %, colour #000000,
  linked, no underline. Summary: Arial **16 px**, #333333, line-height 150 %, **15 px** above it, cut to about
  **220 characters** at a word boundary ending "…". **Read More** button: **13 px** above, #FEE620 square, text
  Arial **15 px bold #000000**, 38 px tall, padding 10 × 20 (VML roundrect for Outlook as the old one does).
- Date: the old shows the date as a small line at the very top, above the header, on the light page background
  ("Oct 15 2026"). Put our date line there (dark grey on the page colour), keep the header bar with the logo. The
  "Premium" badge stays in the header.
- **Ads:** each slot = a **desktop banner** (shown 860 px wide, hidden on phones) + a **mobile square** (shown 300 px
  wide, centred, hidden on desktop), swapped with the old `ml-mobile-hidden` / `ml-desk-hidden` CSS + `mso-hide:all`
  pattern (Outlook gets the desktop banner). Headline/CTA text under the picture stays as now.

## Scope
**In:**
1. `src/services/digest/renderer.ts` built-in template + `itemRow` + ad markup per the reference above. Update
   `STORY_IMAGE_WIDTH` (280), the text width (560), `AD_IMAGE_DISPLAY_WIDTH` (860) and the 900 px container incl.
   the MSO conditional tables. Keep: light-only colour scheme, the Gmail `[data-ogsb]/[data-ogsc]` hooks, alt text,
   preheader, social row, footer, size budget (warn well under 102 KB — check the 900 px version still fits).
2. `SUMMARY_MAX` → 220 (summary ends with "…" when cut).
3. **Missing descriptions (#9):** where the RSS excerpt is empty, use the article page's `og:description` (fallback
   `meta name=description`), fetched in the SAME 06:30 page fetch that already gets `og:image`
   (`articleImage.ts`), same host allowlist, same fail-open; stored on the frozen item like `imageUrl` (additive
   column `DigestItem.summaryFromPage` or reuse an existing excerpt field — say which in the REPORT). HTML-decoded,
   whitespace-collapsed, never markup.
4. **Ads — two images:** `DigestAd` gains a second image (`mobileImageId`, additive, nullable). Upload rules in
   `adImages.ts`: **desktop banner exactly 1720 × 400 px** (2× of 860 × 200); **mobile square exactly 1080 × 1080
   px**; JPEG/PNG; **≤ 250 KB each**; refusal message names the uploaded size and the required one. Existing ads keep
   their current single image as the desktop banner (grandfathered, any size); an ad with no mobile square shows
   its desktop banner on phones too (as today) and the Ads list tags it **"Needs mobile square"**; a desktop
   banner not 1720 × 400 is tagged **"Old size — replace"**. Neither tag blocks sending or coverage.
5. `admin/src/views/Ads.vue`: two pickers, each with a clear (not muted) line — "Desktop banner: exactly 1720 × 400
   px" / "Mobile square: exactly 1080 × 1080 px" — "JPEG or PNG, up to 250 KB". Preview shows both.
6. Templates: custom templates keep working; the new ad markup is produced by the renderer, not by templates.
7. Admin guide (Ads page): the two sizes; bump minor version.

**Out (do not build):**
- The unsubscribe merge tag (separate brief once the owner finds the right tag).
- Dark-mode work for Zoho (#1/#5 text colours) beyond moving the date line — waiting on Anagha's screenshot.
- No server-side resize/crop, no new dependency, no change to ad rules/rotation/coverage.

## Acceptance tests
Each one must PASS in the REPORT.
1. Renderer snapshot/structure tests updated: story row = 280 picture + 560 text, 900 container, headline 16 px bold
   #000, summary 16 px #333, button 15 px bold #000 on #FEE620; MSO tables present.
2. Summary: 300-char excerpt → ≤ 220 chars + "…", cut at a word; empty RSS excerpt + page description → that
   description (trimmed the same way); empty both → no summary row (as now).
3. Page-description fetch: shares the og:image request (one fetch per article — assert count), allowlist enforced,
   fail-open on error/timeout, HTML entities decoded, tags stripped.
4. Ads: 1720×400 + 1080×1080 accepted; 800×190 / 1200×628 / 1080×1081 refused as desktop or mobile with
   both sizes named; > 250 KB refused. Rendered email contains the desktop block with `ml-mobile-hidden` and the
   mobile block with `ml-desk-hidden` + `mso-hide:all`; an ad without a mobile square renders only the desktop block.
5. Existing ad (800×190, no mobile) still renders and still counts for coverage; list shows both tags.
6. Real-browser check (screenshots in the REPORT) of the built-in preview at **900+ px** and **375 px**, side by side
   with the old .eml rendered at the same widths: long-headline story, no-picture story, an ad with both images, an
   ad with one.
7. HTML size of a 15-story + 3-ad digest reported in bytes, below the existing warning threshold.
8. `tsc`, lint, admin `vue-tsc`, full suite green (known flaky "metrics warmer" may be re-run alone).

## Files
- `src/services/digest/renderer.ts`, `articleImage.ts`, `builder.ts` (frozen item), `adImages.ts`, `ads.ts`,
  `src/routes/digestAds.ts`, `prisma/schema.prisma` + migration(s), `admin/src/views/Ads.vue`, admin guide.
- Tests: the renderer, article image, ad image and ads route tests.

## Constraints
- Flag: none — the built-in template is what the staff list receives; the owner reviews the next morning's send.
- Migrations: **additive only** (`DigestAd.mobileImageId`, and the item description column if needed), prefix
  `20261030…`. The R2 backup format must still restore (add the new columns to the export if the table is in it —
  check `src/services/backup.ts`).
- Both ADMIN and PUBLISHER use Ads (owner, 29 Oct).
- Today's frozen run is history: never re-render an already-built run.

## Context the builder needs
- og:image fetch: `src/services/digest/articleImage.ts` (documents.taxscan.in only, fail-open, 06:30 build).
- Ad images live in `DigestAdImage` (bytes in Postgres, deduped by content) — reuse for the mobile square.
- The owner earlier (22 Oct) preferred one scalable ad creative; **30 Oct supersedes it: follow the old format.**
