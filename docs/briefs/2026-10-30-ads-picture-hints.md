# Brief: Ads screen explains the picture tags and what to do

- **Date / name:** 2026-10-30-ads-picture-hints  →  branch `build/ads-picture-hints`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first). **UI work → `ui-developer` agent.**

## Goal
Someone opening Ads understands, without the guide, which ads need new pictures and exactly how to add them.

## Why (owner, 30 Oct)
PR #89 added a second picture per ad (desktop banner 1720 × 400 + optional mobile square 1080 × 1080). The edit form
states the sizes, but the Ads LIST only shows the tags "Needs mobile square" / "Old size — replace"
(`admin/src/views/Ads.vue:633–634`) with no explanation. Anagha (PUBLISHER) will add the pictures herself; the owner
asked for "a note there as a hint or useful information which helps them to add 2 images".

## Scope
**In** (`admin/src/views/Ads.vue` only, copy + small markup):
1. **Note above the ads list**, shown only when at least one ACTIVE/PAUSED ad carries a tag, counted from the list
   data, in the SPA's existing info-banner style (not an error):
   "**N ad(s) need new pictures.** Press **Edit** on each tagged ad: add a **mobile square, exactly 1080 × 1080 px**
   (phones show it instead of the wide banner), and if it says *Old size*, replace the **desktop banner with exactly
   1720 × 400 px**. JPEG or PNG, up to 250 KB each. Ads keep running meanwhile."
   Singular/plural correct; N = number of ads with at least one tag.
2. **Tag explanations:** each tag gets an accessible explanation that works on hover AND on touch/keyboard (not a
   bare `title` only — e.g. the tag is a button/`<abbr>`-like element with `aria-describedby`, or a visible one-line
   hint under the ad name on phones). Text:
   - Needs mobile square → "Phones show the wide banner, which is hard to read. Add a 1080 × 1080 square."
   - Old size — replace → "This banner isn't 1720 × 400 px. Replace it so it looks sharp on computers."
3. **Edit form wording** (line ~490): "Add the desktop banner first." → "Add a desktop banner before the square. The
   square is optional but recommended — without it, phones show the banner." Keep the other lines.
4. Admin guide, Ads page: one sentence pointing at the note/tags; bump minor version.

**Out (do not build):** no backend, size rule, upload, layout or role changes; no new tags.

## Acceptance tests
Each one must PASS in the REPORT.
1. List with 4 tagged ads → note says "4 ads need new pictures"; 1 → "1 ad needs new pictures"; none tagged (or only
   archived ones) → no note.
2. Each tag's explanation is reachable by mouse hover, keyboard focus and touch (375 px) — screenshots.
3. Edit form shows the new wording.
4. Real browser as PUBLISHER and ADMIN at desktop and 375 px; nothing overflows.
5. Admin `vue-tsc`, lint, admin build, full suite green (known flaky tests may be re-run alone).

## Files
- `admin/src/views/Ads.vue`, the admin guide HTML.

## Constraints
- Flag: none. Migrations: none. Settled visual system; plain words.
