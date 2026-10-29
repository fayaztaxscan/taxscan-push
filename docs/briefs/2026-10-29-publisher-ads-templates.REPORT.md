# REPORT: 2026-10-29-publisher-ads-templates

- **Branch:** `build/publisher-ads-templates` (base `origin/develop` at `36f1a9b`)
- **Code commit:** `a7162f0d98cf51beec2a3079d4d1e4f5599d242f`
- **Result:** all 7 acceptance items PASS. One thing for planning: lint still shows 3 errors that were already on `develop` (see Test results).

## Files changed

- `src/routes/digestAds.ts`: guard constant `ADMIN` → `STAFF = requireBearerOrUser(['ADMIN', 'PUBLISHER'])` on every ads route and the image upload; header comment updated.
- `src/routes/digestTemplates.ts`: same rename and widening on all 11 templates routes; header comment updated.
- `src/app.ts`: the early pre-parser guard on `/api/digest/templates` is now `['ADMIN', 'PUBLISHER']`. Order kept: cookie parser → guard → 600 KB JSON parser.
- `src/routes/digest.ts`: two comments only ("ADMIN only" → "ADMIN or PUBLISHER").
- `admin/src/router.ts`: `meta.roles` dropped on `/ads` and `/templates`. `/users` keeps its ADMIN gate.
- `admin/src/components/NavBar.vue`: Ads and Templates links shown to every signed-in user. Users link still ADMIN-only.
- `admin/src/views/{Ads,Templates}.vue`: the "ADMIN only" doc comments only. No user-visible text on Ads, Templates or Digests said admin-only (grep: nothing), so no visible wording changed there.
- `src/__tests__/digestAds.test.ts`, `src/__tests__/digestTemplates.test.ts`: the two "publisher gets 403" tests replaced (see Acceptance). 401 for no session is kept.
- `src/__tests__/publisherStaffBoundary.test.ts` (new, 8 tests): acceptance 3.
- `docs/Taxscan-Push-Admin-Guide.html` + `.pdf`: v2.4, 29 October 2026; role table, menu note, "Who can do what" box, section 10 heading and wording, contents line, "An admin opens…" rows.
- `docs/EMAIL_DIGEST_DESIGN.md`: one dated "Decided 29 Oct 2026 (owner)" line in §12.

## Migrations / flags / env

None. No flag (as the brief says).

## Test results (verbatim)

- `npx tsc -p tsconfig.json --noEmit`: exit 0, no output.
- `npm run lint`: **3 errors, all in files this build did not touch (same as on `origin/develop` and in the previous REPORT):** `audienceConfig.test.ts 226:34 no-var-requires`; `digestRenderer.test.ts 513:19` and `513:23 no-irregular-whitespace`. My files lint clean.
- `npm run build:admin`: `✓ built in 2.82s`.
- Touched suites: `Test Suites: 3 passed, 3 total` · `Tests: 124 passed, 124 total` (`digestAds`, `digestTemplates`, `publisherStaffBoundary`).
- **Full suite:** `Test Suites: 71 passed, 71 total` · `Tests: 1402 passed, 1402 total`. (This branch is based on `develop`, which does not have the audience-pull-writer work, so the total is lower than that REPORT's 1,464. It is the same base as before plus 8 net new tests.)
- Mutation check: putting the early `app.ts` guard back to `['ADMIN']` fails both new templates tests (large-body path and audit), then restored.

## Acceptance tests

1. **PASS.** Publisher session gets 2xx on all 6 ads calls (list, coverage, create, update, archive, image upload) and on all 11 templates calls: list, get, create, a **120 KB body** (past the 64 KB default parser, so it exercises the 600 KB path), update, validate, preview, built-in preview, activate, schedule, archive, plus **revert** (own portal with two activations).
2. **PASS.** The same calls with no session → 401; the bearer (`ADMIN_TOKEN`) and an ADMIN session still get 200.
3. **PASS.** A publisher gets 403 and no session gets 401 on `GET /api/users`, `POST /api/users`, `GET/POST/DELETE /api/report-recipients`, `GET /api/admin/subscribers` and `POST /api/admin/subscribers/:id/test-segment`. A second test confirms the refused invite and recipient were not created.
4. **PASS.** A publisher's ad create/update/archive writes `DigestAd` audit rows (≥ 3, all with `userId` = the publisher). A publisher's template save and activate write exactly `DIGEST_TEMPLATE_SAVED`, `DIGEST_TEMPLATE_ACTIVATED`, and an archive writes `DIGEST_TEMPLATE_ARCHIVED`, all with the publisher as actor. The existing admin audit test (actor = admin, no source or HTML in metadata) still passes unchanged.
5. **PASS**, real Chrome against the local dev server (port 3917, build DB, one browser). Signed in as a PUBLISHER: the menu shows `Dashboard Compose Review Queue Campaigns Reports Digests Ads Templates Activity` and no Users. `/admin/ads` loaded (coverage check, "New ad", "ADS (0)") and `/admin/templates` loaded ("IN USE NOW", "New template"). Going to `/admin/users` directly redirected to the dashboard. Dev server stopped and tab closed afterwards. The two test users were created in the build DB only.
6. **PASS.** The PDF text says "Version 2.4 · Updated 29 October 2026" on the cover and footer (21 pages). I read the rendered pages for the role table, the screens table and section 10. Grep, HTML and PDF text:
   ```
   $ grep -n -i "admins only\|administrators only\|(admins)" docs/Taxscan-Push-Admin-Guide.html
   415:  <strong>Users</strong> <span class="muted">(Admins only)</span> …
   419:  <span class="box-t">Adding a teammate (Admins)</span>
   485:  <span class="box-t">Who gets the report email (Admins)</span>
   ```
   The PDF text gives the same three hits. None is about Ads or Templates; all three are correctly still admin-only (Users, adding a teammate, the report email list). Nothing near Ads/Templates says admin-only.
7. **PASS** except the 3 pre-existing lint errors above.

## Agents run

None.

## Deviations from the brief

1. **`npm run build:guide` exits non-zero on this Mac even though it succeeds.** Headless Chrome wrote the PDF (1,067,517 bytes) and then hit "Teardown watchdog expired", so the script prints `[build:guide] failed`. I verified the file independently: 21 pages, `pdfinfo`/`pdftotext` readable, v2.4, and I looked at the changed pages.
2. **Guide line ~662** ("After a database restore, or a campaign made by hand. An admin opens it in Mailercloud…") is about Mailercloud, not Ads or Templates. The brief listed it, so it now says "An editor", which is harmless.
3. **Left as "admins" on purpose:** the guide's note that the **alert emails** go to admins ("admins get an email and an amber notice naming the template") and "ask an admin" for the test-send recipient list, per the brief's "who receives alert emails: don't change".

## Worth remembering

- **Stale statements left in `docs/EMAIL_DIGEST_DESIGN.md`:** line ~626 (§9 "Templates and Ads are ADMIN-only") and line ~738 (§12 "Templates and Ads are admin-only") now contradict the new decision line. The brief asked for one added line only, so I did not edit them; planning may want to mark them superseded.
- A publisher can now activate a template that goes to every reader of the digest. Templates still pass the same validation checks and previews stay under the sandbox CSP; the protection that was "only admins can do it" is now just those checks plus the audit trail.
- A publisher approving the digest and also editing its template is possible; the 90-day audit rows record each separately.
- Test users for the browser check (`pub-check@team.test`, `adm-check@team.test`) exist only in the build DB, which is dropped by the clean-up below.
- `prisma migrate dev` printed nothing here (already in sync after the first run); no migration was needed.

## Clean-up

```sh
git worktree remove ../taxscan-push-worktrees/publisher-ads-templates
dropdb taxscan_push_build_publisher-ads-templates; dropdb taxscan_push_build_publisher-ads-templates_shadow
git branch -D build/publisher-ads-templates; git push origin --delete build/publisher-ads-templates
```
