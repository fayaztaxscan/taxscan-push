# Brief: Digest polish — brand colours hold, pictures keep their size, alignment, ads

- **Date / name:** 2026-10-29-digest-polish → branch `build/digest-polish`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first)

## Goal
The built-in digest looks the same, on brand, in every app and mode the staff and readers use: the dark header
with the white logo, the yellow "Read more" with black text, pictures at their intended size, picture and text
aligned, and ads at full width in their real shape.

## Why (owner + Anagha's trial feedback, 29 Oct; owner: "Go with recommendation")
Anagha reviewed day 1 of the trial (photos of her screen: the Digests preview at phone and iPad widths, and
**Zoho Mail** desktop, all in **dark mode**):
1. The header turned **light lavender** and the white logo almost vanished.
2. The yellow **Read more** turned **dull brown**, with the text sitting high in the box.
3. iPad width: the picture is shorter than the text beside it, so the two don't line up.
4. Zoho Mail: a story picture filled the whole width, huge and nearly square (Zoho ignored its width).
5. Mobile: the thin banner ad (800×210) is hard to read.

Note: the renderer **already** keeps `.ts-hdr` / `.ts-btn` colours under `@media (prefers-color-scheme:dark)`
(`src/services/digest/renderer.ts` ~787–790), yet her screens are recoloured. So something **forces** colours:
Zoho's dark mode and/or Chrome's auto-dark / a dark-mode extension on her machine. The fix must survive **forced
inversion**, not only `prefers-color-scheme`.

## Scope (the five decisions)
1. **Brand colours hold in every mode.**
   - Declare the email **light-only**: `color-scheme: light` / `supported-color-schemes: light` (meta + `:root`).
     Drop our own dark palette for the email body. *(The admin SPA's dark theme is unrelated; don't touch it.)*
   - Defend the header and the buttons against forced inversion with the known email techniques, e.g. a
     `background-image: linear-gradient(<brand>,<brand>)` on `.ts-hdr` / `.ts-btn` alongside `background-color`,
     and Gmail's `[data-ogsc]` / `[data-ogsb]` selectors. Use what works; explain your choice in the REPORT.
   - **Logo:** produce a header logo PNG that carries its own `#3b3543` background (same size as
     `public/email/taxscan-logo-white-440.png`), so even if the bar is recoloured, the logo stays legible. Serve it
     from `public/email/` and keep the old file (sent mail references it).
2. **Pictures keep their size in every app.** Each story picture has explicit `width` **and** `height` attributes
   plus inline `width`/`max-width`, so Zoho/Outlook can't stretch it.
   - Desktop / iPad: **≈ 240 px** wide beside the text.
   - Phone (stacked): full width but height-limited, at its natural aspect.
   - We know the og:image size? If not, fetch nothing new: use a fixed **1.91:1** box (the og:image standard, 1200×628)
     and state that assumption.
3. **Alignment:** the picture and text columns **start level at the top** (`valign="top"` on both cells, no stray
   top padding). Under the summary, **Read more** gets consistent spacing above it and is a **fixed-size yellow box
   with its text centred** horizontally and vertically (table-cell or padding-based, with the MSO/VML fallback
   kept).
4. **Ads:** an image ad renders at **full content width**, at its real aspect, with explicit width/height
   attributes from the stored image size (`DigestAdImage` has width/height). Add a one-line hint on the Ads screen
   under the image field: "Best size: 1200 × 628 (wide rectangle)." (Designer creatives will follow; no other
   Ads-screen change.)
5. **Verify in a browser** (one at a time), light **and** dark, at 375 / 768 / 1024 px:
   - normal `prefers-color-scheme: dark` (Chrome emulation);
   - **forced** dark: Chrome with `--enable-features=WebContentsForceDark` (or the closest available flag);
   - **Zoho-like**: an iframe or page that ignores media queries (strip `<style>`) to prove the inline sizes
     hold.

   Screenshots in the REPORT, side by side with Anagha's issues. A real-app check (Zoho Mail, Gmail app, Apple Mail)
   happens after deploy, via the staff trial; planning arranges it.

**Out:** ranking, item count, subject; the readers' push; the admin SPA's own theme; Ads beyond the one hint line.

## Acceptance tests
1. Unit: the email declares light-only; the header and button carry both `background-color` and the gradient
   fallback; the logo `src` is the new on-dark PNG.
2. Unit: every story picture has `width` and `height` attributes and inline sizes; desktop ≈ 240 px; an image ad has
   width/height from its stored size.
3. Unit: the picture and text cells are `valign="top"`; Read more is the fixed-size centred box (and the MSO fallback
   is present).
4. Worst-case size stays < 75 KB (paste the numbers).
5. Screenshots for item 5 (all six combinations, plus forced dark at 375 px).
6. tsc, lint (0 errors), `npm run build:admin`, the full suite: green.

## Constraints
No flag (the digest is in preview mode; this is its look). No migration unless a picture-size column is truly
needed (prefer none). No new dependency. Saved templates keep working; the `{{…}}` placeholders don't change.
