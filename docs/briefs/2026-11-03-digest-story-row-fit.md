# Brief: Digest story row — picture and text side by side in every desktop pane, no gap

- **Date / name:** 2026-11-03-digest-story-row-fit  →  branch `build/digest-story-row-fit`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first). This is the digest email's look → **ui-developer** agent.

## Goal
In the built-in digest, every main story shows its picture on the left and its headline, summary and Read More on the
right, side by side in any desktop/tablet reading pane (about 600 px and wider), and the text block is no taller than
the picture, so the next story follows after the normal 20 px row gap with no empty band. Phones (≤ 600 px) keep
today's stacked layout.

## Why (owner's words)
> 3 Nov 2026: "We do not want gap between images. Can we place all contents along side the image in the side panel. We
> need to fit in button also there. So that the entire newsletter layout look clean." Owner approved: columns in
> proportion + compact text ("yes").

What the 3 Nov digest actually did (planning reproduced it in headless Chrome from the owner's saved copy):
- **Owner, Zoho Mail web, 3-panel layout, email pane ≈ 780 px:** every story STACKS — picture alone on the left with
  empty space to its right, text below. Cause: the row is two `display:inline-block` divs capped at 280 + 20 + 560 px,
  so it wraps whenever the pane is narrower than 860 px (`renderer.ts` `itemRow`, ~line 770).
- **Anagha (looks like Outlook, dark mode):** side by side but the right of the headline is CUT OFF — the MSO table is
  a fixed `width="860"` and doesn't fit the pane.
- **Full-width browser (≥ 900 px):** side by side, but the text column (2–3-line headline + 2–3-line summary at 16/24 +
  13 + 38 px button ≈ 160–210 px) is taller than the 147 px picture → 15–60 px of white under each picture.
- Dark mode is fine now (Read More readable in Anagha's screenshot) — the purple fallback is NOT needed.

## Scope
**In:**
1. **Proportional story row.** Picture column ≈ one third, gap ≈ 2–3 %, text column ≈ the rest, of the 860 px inner
   width (at full width this is still ~280 / 20 / 560). The columns must stay side by side from ~600 px up and shrink
   with the pane; the picture keeps 1.91:1 (`aspect-ratio:1200/628`, `height:auto`). Suggested technique (builder may
   choose another that passes the tests): inline-block columns with **percentage widths** plus a `min-width` floor on
   each (e.g. picture ≥ 180 px, text ≥ 300 px) inside a `font-size:0` cell, so they still stack by themselves on a
   phone even in an app that drops `<style>`; the ≤ 600 px media query keeps doing the phone tightening.
2. **Outlook (MSO) table in percentages** (`width="100%"`, cells in %), so Outlook fits the pane instead of cutting
   the text off. The outer MSO wrapper may stay 900 if Outlook needs it, but the story row must not be wider than the
   pane it sits in.
3. **Compact text column, desktop sizes** (phones keep their current overrides where noted):
   - Headline: Arial 16 px bold, line-height ~21 px (exact in Outlook), black, linked — unchanged otherwise.
   - Summary: 14 px, line-height ~19–20 px, #333, ~6 px under the headline; **at most 2 lines**. Trim it by characters
     (word boundary + "…") so it fits 2 lines in the text column at a ~780 px pane; when the headline will run to
     **3 lines** at that width, trim the summary to **1 line**. Put the char limits in named constants with a comment
     on how they were derived (they are estimates — Arial 14 px ≈ 6.5 px/char, 16 px bold ≈ 8.3 px/char).
   - Read More: ~8 px under the summary, **30 px tall** on desktop (width 96 unchanged, same colours); phones keep the
     full-column 43 px button.
   - Target: for 2-line headlines (most stories) the text block is ≤ the picture height at a 780 px pane; for every
     story it is ≤ the picture height at full width (900). A very long headline in a narrow pane may run a few px past
     the picture — acceptable, report which fixture stories do.
4. **ICYMI rows** (text-only) stay aligned with the main text column: their spacer becomes the same proportion
   (picture + gap) instead of the fixed 300 px.
5. **Brand block** (no-picture placeholder) follows the picture column's width and keeps the 1.91:1 box.
6. Update the renderer's doc comments (the "280 / 20 / 560", "16/24", "13 px", "38 px" descriptions) and the admin
   guide's digest-look paragraph if it states those sizes (bump the guide's minor version).

**Out (do not build):**
- Ad rows, header/banner, footer, ICYMI wording, number of stories, subject, colours, dark-mode rules.
- The phone layout (≤ 600 px) beyond keeping it working — owner: phones stay stacked.
- Custom templates' own markup (only the built-in story-row HTML the renderer emits).
- Any flag, schema or sender change.

## Acceptance tests
Each one must PASS in the REPORT.
1. Unit (renderer): a main story row's columns use percentage widths (no fixed `max-width:280px`/`560px` that forces a
   wrap below 860 px); the MSO table is `width="100%"` with percentage cells; ICYMI spacer is proportional.
2. Unit: summary trimming — ≤ the 2-line limit for a short headline, ≤ the 1-line limit for a 3-line headline, cut on a
   word boundary ending "…", never trims the headline; empty summary still renders no `<p>`.
3. Unit: desktop Read More is 30 px tall; phone CSS still makes it 43 px full width; summary 14 px; headline 16 px.
4. Unit: the 15-story fixture (`docs/briefs/2026-11-03-digest-story-row-fit.fixture.json`, the real 3 Nov headlines +
   summaries) renders under the existing 80 KB warn line (report the size before/after).
5. **Real browser** (headless Chrome is fine), the fixture rendered, screenshots at **1000, 780, 650 and 375 px**:
   - 1000 / 780 / 650: every main story side by side, nothing cut off, the next picture starts ~20 px after the
     previous row's taller part; list any story whose text runs past its picture and by how many px.
   - 375: stacked exactly as today (full-width picture, text, full-column 43 px Read More).
   - Also one render with `<style>` removed at 375 px: columns still stack (no squeezed side-by-side).
   Commit the screenshots under `docs/briefs/2026-11-03-digest-story-row-fit.shots/` and reference them in the REPORT.
6. Existing digest tests still pass (old-format / lookalike / polish / renderer tests will need their size and
   layout assertions updated — update them to the new numbers, don't delete the checks).

## Files
- `src/services/digest/renderer.ts` — `itemRow`, `brandBlock`, `button` (height param already exists), story-row
  constants, phone media query, comments.
- Possibly `src/services/digest/builder.ts` only if the summary trim belongs with `EXCERPT_MAX` — prefer the renderer
  (it knows the headline length and the layout).
- Admin guide page if it states the story sizes.
- Tests: `src/__tests__/digestRenderer.test.ts`, `digestOldFormat.test.ts`, `digestLookalike.test.ts`,
  `digestPolish.test.ts`, `digestDefaultStoryImage.test.ts` (+ a new test file for this brief if cleaner).

## Constraints
- Flag: none — a look change to the built-in template, like #89/#92/#93. The next 06:30 run uses it after deploy.
- Migrations: none.
- Full suite: no — area tests: `nice -n 10 npx jest src/__tests__/digest` (digest renderer/template area).
- Docs that ship with it: admin guide digest paragraph if it quotes sizes.
- Email-safe only: no flex/grid, no `object-fit` dependence for layout, inline styles first, `<style>` only as the
  phone/dark-mode enhancement. Keep `mso-line-height-rule:exactly` on fixed line-heights.
- Don't change what Mailercloud receives beyond the HTML (subject, names, lists untouched).

## Context the builder needs
- Planning's reproduction: the owner's saved 3 Nov email opened in headless Chrome at 1000 px (gap under 3-line-headline
  stories) and 800 px (stacks). Command used:
  `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars --window-size=780,1400 --screenshot=out.png file://<abs path>.html`
- Phone overrides live in the `@media only screen and (max-width:600px)` block (`.ts-stcol`, `.ts-stgap`, `.ts-pic`,
  `.ts-sttext`, `.ts-btnt`, `.ts-btn`) — keep those class names so the phone layout stays as is.
- `STORY_IMAGE_WIDTH/HEIGHT`, `STORY_GAP`, `STORY_TEXT_WIDTH`, `EMAIL_INNER_WIDTH=860` are exported — check importers
  before renaming.
- Zoho strips nothing relevant here (the owner's pane simply is ~780 px); Outlook uses the MSO table.
