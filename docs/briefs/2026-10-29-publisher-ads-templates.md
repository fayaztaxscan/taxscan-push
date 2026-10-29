# Brief: Publishers may use Ads and Templates; the guide drops its stored PDF

- **Date / name:** 2026-10-29-publisher-ads-templates → branch `build/publisher-ads-templates`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first)

## Goal
A PUBLISHER can open and use the **Ads** and **Templates** screens and every API behind them, exactly as an ADMIN
can today. Nothing else about roles changes. **And** the admin guide has one copy only (the HTML): the committed
PDF and its build script go, and the Guide screen's "Download PDF" becomes "Print / Save as PDF".

## Why (owner's words)
> 2026-10-29: "Let us give publisher access to Digests, Ad and Templates too." (Digests is already open to
> publishers.) The owner wants Anagha, a publisher, to run the digest trial end to end. This reverses the 22 Oct
> design decision that "admins edit templates/ads".
> 2026-10-29, on dropping the PDF: "Yes". Two copies drifted twice; a PDF made on the spot is always current.

## Scope
**In:**
- Server: every ads route (`src/routes/digestAds.ts`, the `ADMIN` guard at line 35, which also covers the ad
  image upload) and every templates route (`src/routes/digestTemplates.ts` line 72, **and** the early
  pre-parser guard in `src/app.ts` ~line 83 on `/api/digest/templates`) admit `['ADMIN', 'PUBLISHER']`. The
  `ADMIN_TOKEN` bearer still works. A request with no session still gets 401. Rename the guard constants so they
  don't say `ADMIN` (e.g. `STAFF`).
- SPA: `admin/src/router.ts` (drop `meta.roles` on `/ads` and `/templates`), `admin/src/components/NavBar.vue`
  (show Ads + Templates to every signed-in user).
- Any wording inside the Ads, Templates and Digests screens that says these are admin-only.
- Tests: change the two existing "publisher gets 403" tests (`digestAds.test.ts:693`,
  `digestTemplates.test.ts:488`) to assert that a publisher gets through. Keep the 401 for no session.
- Admin guide `docs/Taxscan-Push-Admin-Guide.html` → **v2.4, dated 29 October 2026**. Section 10's heading
  "(Admins)", the contents line 126, the role table ~line 163, the menu table ~line 413, the note ~line 620
  "Templates are for Administrators only", and the "An admin opens Ads/Templates" rows (~658, 662, 667, 737)
  all become "anyone signed in" / "an editor". Remove any wording about downloading the PDF; say "Print / Save
  as PDF" instead.
- **Guide PDF removal:** `git rm docs/Taxscan-Push-Admin-Guide.pdf scripts/build-guide.ts`; drop `build:guide`
  from `package.json`; `GET /api/guide` (src/routes/api.ts ~648) becomes an auth-gated **302 to `/admin/guide`**
  so old bookmarks and links in sent mail still land somewhere. `/api/guide.html` is unchanged.
  `admin/src/views/Guide.vue`: replace the Download link with a **Print / Save as PDF** button that calls
  `print()` on the same-origin iframe's window. Update the comment at the top of Guide.vue.
- Make the guide's existing `@page` / `@media print` rules produce a clean PDF from Chrome's print dialog: A4,
  no app menu bar (the iframe prints only the guide), page breaks before each `<h2>` section, and tables not
  split mid-row where avoidable.
- `docs/EMAIL_DIGEST_DESIGN.md`: one dated line in §12 decisions recording the owner's change.

**Out (do not build):**
- Users, Report-email recipients, `/api/admin/subscribers`, and anything else ADMIN-only stays ADMIN-only.
- Who receives the digest **alert** emails (admins today). Don't change it; the owner hasn't decided.
- No new role, no per-user permission system.

## Acceptance tests
1. A PUBLISHER session gets 2xx on every ads route, including coverage and image upload, and on every
   templates route, including previews, activate, revert and the 600 KB body path. These are the same calls the
   two existing role tests enumerate.
2. No session → 401 on all of them; the bearer and an ADMIN still pass.
3. **Guard against over-opening:** a PUBLISHER still gets 403 on `/api/users` (GET + POST invite),
   `/api/report-recipients` and `/api/admin/subscribers`.
4. Ad and template changes made by a publisher write the same audit rows, with the publisher as the actor.
5. SPA: signed in as a publisher, the menu shows Ads and Templates and both pages load; Users stays hidden.
   Check this in a real browser against the local dev server with the build DB. Use one browser only.
6. The guide says v2.4 and nowhere calls Ads or Templates admin-only (`grep -i` on the HTML for "Admins
   only" / "Administrators only" near Ads/Templates finds nothing). Paste the grep in the REPORT.
7. `GET /api/guide` → 302 to `/admin/guide` with a session, 401 without; `?download=1` behaves the same. Update
   the `api.test.ts` "GET /api/guide" block (~385) to match. `/api/guide.html` tests unchanged.
8. In a real browser: Guide → **Print / Save as PDF** → "Save as PDF" gives an A4 PDF of the guide only (no app
   menu), sections start on new pages. Attach the saved PDF's page count and a screenshot of page 1 to the REPORT
   (in the worktree, untracked; give the path).
9. `grep -rn "Guide.pdf\|build:guide\|build-guide" src admin/src scripts package.json` finds nothing.
10. tsc, lint, `npm run build:admin`, and the full suite are green.

## Files
- `src/app.ts`, `src/routes/digestAds.ts`, `src/routes/digestTemplates.ts`
- `admin/src/router.ts`, `admin/src/components/NavBar.vue`, `admin/src/views/{Ads,Templates,Digests}.vue` (wording only)
- `src/__tests__/digestAds.test.ts`, `src/__tests__/digestTemplates.test.ts`, and a new test for acceptance 3
  (or extend an existing role test)
- `docs/Taxscan-Push-Admin-Guide.html` (edit), `docs/Taxscan-Push-Admin-Guide.pdf` + `scripts/build-guide.ts`
  (delete), `package.json` (script line only; package-lock untouched), `src/routes/api.ts` (`/api/guide`),
  `admin/src/views/Guide.vue`, `src/__tests__/api.test.ts`, `docs/EMAIL_DIGEST_DESIGN.md` (§12 line)

## Constraints
- `NEXT_STEP.md` mentions `build:guide`. Don't touch it: it's the record, and planning updates it.
- No flag: this is a permission change the owner asked for directly, it is small, and it's reversible by
  revert. No migration. No new env.
- Keep the guard order in `app.ts`: authenticate **before** the 600 KB JSON parser.

## Context the builder needs
- Roles are only `ADMIN` and `PUBLISHER` (`src/routes/users.ts:40`). `requireUser` / `requireBearerOrUser`
  take the allowed list.
- This brief is queued behind `2026-10-29-audience-pull-writer`. Start it only after that REPORT is pushed:
  one brief at a time.
