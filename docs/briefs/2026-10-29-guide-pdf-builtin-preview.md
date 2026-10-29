# Brief: Guide without a stored PDF; preview the built-in digest template

- **Date / name:** 2026-10-29-guide-pdf-builtin-preview → branch `build/guide-pdf-builtin-preview`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first)

## Goal
1. The admin guide has one copy only, the HTML. The committed PDF and its build script go. The Guide screen's
   "Download PDF" becomes **Print / Save as PDF**.
2. The Templates screen can preview the **built-in** template for Free and Premium. Today the server route
   exists but no button uses it.

## Why (owner's words)
> 2026-10-29: drop the stored PDF guide — "Yes". (The two copies drifted twice; a PDF made on the spot is always current.)
> 2026-10-29: "can we give an option to see how a built in template will look like to users?" — "Yes".

These were folded into `2026-10-29-publisher-ads-templates` after that build had already started from the
earlier text, so they were not built. The publisher work is merged to `develop` (v2.4 guide, regenerated PDF).

## Scope
**In:**
- `git rm docs/Taxscan-Push-Admin-Guide.pdf scripts/build-guide.ts`; drop `build:guide` from `package.json`
  (script line only; package-lock untouched).
- `GET /api/guide` (src/routes/api.ts ~648) becomes an auth-gated **302 to `/admin/guide`**, with and without
  `?download=1`, so old links in sent mail still land somewhere. `/api/guide.html` is unchanged.
- `admin/src/views/Guide.vue`: replace the Download link with a **Print / Save as PDF** button that calls `print()`
  on the same-origin iframe's window. Update the comment at the top of the file.
- The guide HTML's `@page` / `@media print` rules: A4, page breaks before each `<h2>` section, and table rows not
  split where avoidable. Remove the guide's own wording about downloading a PDF; say "Print / Save as PDF". Bump to
  **v2.5, 29 October 2026**.
- Templates screen (`admin/src/views/Templates.vue`): in the **In use** card, a **Preview built-in** action per
  version (Free / Premium). It opens the built-in template in the same `EmailPreviewFrame` the saved-template
  preview uses, with the same **Recent stories / Biggest case** toggle and Phone / Tablet / Desktop widths, via
  the existing `GET /api/digest/templates/builtin/preview/:audience?data=recent|worst`. Show it whether or not a
  template is active, so the default can always be compared.
- Guide §10: one sentence on Preview built-in.

**Out:**
- Any change to the built-in template's look (a separate brief follows once the owner decides).
- Any server change for the preview: the route already exists and is STAFF-gated.

## Acceptance tests
1. `GET /api/guide` and `/api/guide?download=1` → 302 `Location: /admin/guide` with a session, 401 without.
   Update the `api.test.ts` "GET /api/guide" block (~385).
2. `grep -rn "Guide.pdf\|build:guide\|build-guide" src admin/src scripts package.json` finds nothing. Paste it.
3. In a real browser: Guide → Print / Save as PDF → Save as PDF gives an A4 PDF of the guide only (no app menu), with
   sections on new pages. Give the page count and a screenshot of page 1 in the REPORT (an untracked file in the
   worktree; give the path).
4. In a real browser, as a **publisher**: Templates → Preview built-in, for Free and for Premium, renders in the frame.
   The data toggle and the three widths work. Screenshot one of each audience.
5. tsc, lint (no new errors; the three existing ones are known), `npm run build:admin`, and the full suite are green.

## Files
`docs/Taxscan-Push-Admin-Guide.{html,pdf}`, `scripts/build-guide.ts`, `package.json`, `src/routes/api.ts`,
`src/__tests__/api.test.ts`, `admin/src/views/{Guide,Templates}.vue`.

## Constraints
- No flag, no migration, no env.
- Don't edit `NEXT_STEP.md` (it mentions `build:guide`; planning updates it).
- The build note from last time: `build:guide` hung on Chrome teardown on this Mac. After this brief it no
  longer exists, so don't try to run it.
