# Brief: digest polish — match the old newsletter on phones, Outlook hardening, owner's five choices

- **Date / name:** 2026-10-30-digest-polish-old-look  →  branch `build/digest-polish-old-look`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first). Email look + Templates screen → **`ui-developer`**;
  the setting/storage/route part → `backend-developer`. One subagent at a time.

## Goal
The built-in digest looks like the old Mailercloud newsletter on phones as well as desktop, holds its shape in
Outlook and in apps that strip `<style>`, and carries the owner's five decisions below.

## Why (owner, 30 Oct: "I need the result to look perfect")
A read-only visual review compared our render with the old newsletter at 1000 px and 375 px. Full write-up, measurements
and screenshots: `/private/tmp/claude-501/-Users-bestdoc-Documents-taxscan-push/372444ff-4685-48b1-9092-cf2421488059/scratchpad/visual-review/digest-visual-review.md`
(+ `*.png`, `crops/`); the review's render script `…/scratchpad/scripts/render.ts` renders FREE/PREMIUM offline with
fixtures — reuse it for your before/after. Line numbers below are from that review (renderer.ts as of `develop`
after PR #89); re-locate them.

## Scope — fixes (match the old look)
1. **Phone Read More full width:** phone rules (~841–848) add `.ts-btn{display:block!important;width:auto!important;
   height:43px!important;line-height:43px!important}` (old: 335×43 at 375 px).
2. **Mobile ad square fills the column on phones:** the mobile `<img>` (~669) gets the phone full-width class (old
   335×335); keep 300 px as the desktop/inline cap only where it applies.
3. **No grey rule between stories/ads:** remove `border-top:1px solid ${C.rule}` on story and ad rows (~754, 673, 683);
   spacing = 20 px white space like the old one (`padding:20px 20px 0 20px`, bottom pad on the last row of a block).
4. **Desktop Read More 96 px wide** (old VML 95): `button(href,'Read More',…)` (~752); all buttons 38 px tall,
   incl. the text-only ad's CTA (~687).
5. **Phone header compact:** `.ts-hdr{padding:14px 10px 12px!important}` and a 160 px logo on phones (give the logo
   `<img>` (~890) a class).
6. **White edge to edge on phones:** outer cell padding (~853) 0 on phones; `.ts-pad` 20 px.
7. **Footer name twice:** the footer prints `Taxscan · ${postal}` (~922) and the real `DIGEST_POSTAL_ADDRESS` begins
   "Taxscan Edutech Private Limited…" → print the postal address alone.
8. **Holds shape without `<style>`:** build the story row from two `display:inline-block` divs (`width:100%`,
   `max-width` 280 / 560, `vertical-align:top`) with an Outlook-only (MSO conditional) 280/20/560 table — stacks on
   phones with no media query (review item 6, screenshot `phone-375-NO-STYLE-old-vs-ours.png`).
9. **Outlook hardening:** headline/summary `line-height:24px;mso-line-height-rule:exactly` (~746, 750); the button
   wrapper uses `padding-top:13px`, not margin (~752); the mobile ad block wrapped in
   `<!--[if !mso]><!-->…<!--<![endif]-->` in addition to `mso-hide:all` (~668).
10. Fix the comment (~835–838): `[data-ogsb]/[data-ogsc]` are Outlook.com / new Outlook hooks, not Gmail's.

## Scope — owner's decisions (30 Oct, "go with recommendation")
A. **Default story picture.** A story with no picture shows a default picture so every row keeps the 280 + 560 shape.
   - **Interface:** on **Templates** (ADMIN + PUBLISHER), a "Default story picture" card: upload **exactly
     1600 × 840 px**, JPEG/PNG, ≤ 250 KB (same validation style + messages as ad images), preview, replace, remove.
     Store the bytes in the existing `DigestAdImage` table (reuse its upload/dedupe/serving) and the choice in a new
     single-row setting (additive migration, e.g. `DigestSetting` key/value or a one-row table — say which). Audited
     (reuse `DIGEST_TEMPLATE_SAVED` with metadata, or add an additive `AuditAction` — say which).
   - **Until Anagha uploads one:** the picture cell shows the brand block — background `#3b3543` with the existing
     `public/email/taxscan-logo-white-440.png` centred — same 280 × 147 box, so the row shape holds from day one.
   - Frozen at the 06:30 build like `imageUrl` (a later upload never changes a built run).
B. **15 stories:** `DIGEST_MAX_ITEMS` default 12 → **15** (`src/lib/env.ts:110`; not set on Railway). Check the size
   budget/refusal tests still pass at 15 + ICYMI + 3 ads and report the bytes.
C. **Date in the header bar:** remove the line above the header; the bar reads "Daily Digest · 30 October 2026"
   (+ Premium badge) under the logo, white text (as before PR #89, but keep the compact phone header from fix 5).
D. **ICYMI without pictures:** "In case you missed it" stories render text-only (headline, summary, Read More) in the
   560-wide text style, left-aligned with the main column's text on desktop, full width on phones — visibly secondary.
   The preheader's "Plus N more" counts main stories only.
E. **Social row like the old:** icons 24 px, light-grey strip (`#f2f3f5` or the page colour), no rule above; the five
   links stay.

F. **"Biggest case" preview shows broken pictures** (owner screenshot, 30 Oct). The worst-case fixture
   (`src/services/digest/templates.ts:183`) uses made-up `documents.taxscan.in/cms/media/…-<n>.jpg` URLs so the size
   check measures realistic URL lengths; in the PREVIEW they 404 and show a broken-image icon. Keep the long URLs for
   the size/budget check, but when the fixture is rendered for **display** (Templates → Biggest case), use the
   default story picture if one is set, else the brand block (decision A) — never a URL that doesn't exist.

**Out (do not build):** dark-mode hacks; template HTML editing changes; ad rules; any change to sending, approval or
subject edit.

## Acceptance tests
Each one must PASS in the REPORT.
1. Renderer tests updated for 1–10 (structure: no `border-top` on rows, button widths 96/38, MSO wrappers, line-height
   rules, footer without "Taxscan ·", inline-block row + MSO table).
2. Before/after screenshots with the review's script at 1000 px and true 375 px (iframe), FREE and PREMIUM, side by
   side with the old 30 Oct email: phone button 335-ish × 43, mobile ad full column, no rules, compact header, white
   edges; and the **no-`<style>`** render at 375 px stacks (picture full width, not a sliver).
3. Default picture: upload 1600×840 accepted; 1600×841 / 1200×628 refused naming both sizes; > 250 KB refused;
   ADMIN + PUBLISHER can upload/replace/remove; a run built before an upload keeps its frozen picture; no default
   set → brand block in the 280 × 147 box.
4. 15 main stories render; total HTML bytes with 15 + 3 ICYMI + 3 ads reported and under the warning threshold.
5. Header shows "Daily Digest · <date>" in the bar; no separate date line.
6. ICYMI rows have no `<img>`; preheader count excludes ICYMI.
7. Social row: 24 px icons, no top rule, grey strip.
8. Templates screen: real browser, desktop + 375 px, both roles.
9. `tsc`, lint, admin `vue-tsc`, admin build, full suite green (known flaky tests may be re-run alone).

## Files
- `src/services/digest/renderer.ts`, `builder.ts` (frozen default picture), `adImages.ts` (reuse validation with a
  1600 × 840 rule), `src/lib/env.ts`, `src/routes/digestTemplates.ts` (default-picture routes), `prisma/schema.prisma`
  + migration (additive, prefix `20261030…`/`20261031…`), `admin/src/views/Templates.vue`, admin guide, backup
  (`src/services/backup.ts`: include the new setting table if one is added — format stays restorable).
- Tests: renderer, templates route, ad-image tests.

## Constraints
- Flag: none — the staff list is the only audience; the owner reviews the next morning's send.
- Migrations: additive only.
- Size: stay under the existing warning threshold at 15 stories; if not, stop and report rather than raise limits.
- Never re-render an already-built run.
