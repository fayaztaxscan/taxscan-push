# REPORT: 2026-10-29-guide-pdf-builtin-preview

- **Branch:** `build/guide-pdf-builtin-preview` (base `origin/develop` at `6111d3b`)
- **Code commit:** `80ab09b077cdb38a98c65769c97e9f04908db9c1`
- **Result:** all 5 acceptance items PASS. One note for planning about where part of this was first built (below).

## Where this came from (read first)

While I was building `2026-10-29-publisher-ads-templates`, that brief was re-written on `develop` to add the PDF removal. By the time I read the new text, planning had already merged my first push (`71a8e3d`) and split the extra scope into this brief. I had by then built the PDF-removal half on the publisher branch (uncommitted, never pushed). I saved that diff as a patch outside the repo, discarded it from the publisher worktree (nothing of it reached `origin`), and applied it here. The patch applied cleanly and everything below was re-verified on this branch.

## Files changed

- `docs/Taxscan-Push-Admin-Guide.pdf`, `scripts/build-guide.ts`: **deleted** (`git rm`).
- `package.json`: the `build:guide` script line only. `package-lock.json` untouched.
- `src/routes/api.ts`: `GET /api/guide` is now `requireBearerOrUser()` → `res.redirect(302, '/admin/guide')`, with or without `?download=1`. `/api/guide.html` unchanged. Comment updated.
- `src/__tests__/api.test.ts`: the "GET /api/guide" block now asserts 401 without auth, 302 `Location: /admin/guide` with it, and the same (no `Content-Disposition`) for `?download=1`. The `/api/guide.html` test is unchanged.
- `admin/src/views/Guide.vue`: the Download link is a **Print / Save as PDF** button calling `print()` on the same-origin iframe's window; header comment rewritten.
- `admin/src/views/Templates.vue`: a **Preview built-in** / **Hide built-in** button per version in the In-use card; it opens a "Built-in template preview" card with the same `EmailPreviewFrame`, the same Recent stories / Biggest case toggle and Phone / Tablet / Desktop widths (shared with the saved-template preview), loading `GET /api/digest/templates/builtin/preview/<audience>?data=recent|worst`. Shown whether or not a template is active. No server change.
- `docs/Taxscan-Push-Admin-Guide.html`: cover and footer → **v2.5, 29 October 2026**; one sentence about Preview built-in in §10. The guide had **no wording about downloading a PDF** (grep: only "Download image" for report images, which is unrelated), so nothing to remove there. Its existing `@page` / print rules already give the result below, so I did not change the CSS.

## Migrations / flags / env

None.

## Test results (verbatim)

- `npx tsc -p tsconfig.json --noEmit`: exit 0, no output.
- `npm run lint`: the three known errors only (`audienceConfig.test.ts 226:34`, `digestRenderer.test.ts 513:19` and `513:23`); nothing new.
- `npm run build:admin`: `✓ built in 5.31s`.
- `src/__tests__/api.test`: `Tests: 31 passed, 31 total`.
- **Full suite:** `Test Suites: 71 passed, 71 total` · `Tests: 1402 passed, 1402 total` (run with `--maxWorkers=1`, see Worth remembering).

## Acceptance tests

1. **PASS.** Unit tests above; also in the browser (session cookie): `fetch('/api/guide?download=1', {redirect:'manual'})` → `opaqueredirect`, and following `/api/guide` ends at `/admin/guide` with 200.
2. **PASS.** Paste:
   ```
   $ grep -rn "Guide.pdf\|build:guide\|build-guide" src admin/src scripts package.json
   $ echo $?
   1
   ```
   (no matches). `docs/EMAIL_DIGEST_DESIGN.md:1238` and `NEXT_STEP.md` still mention `build:guide` as history; both are record/docs I was told not to touch.
3. **PASS, with one limit.** In Chrome as a publisher: Guide shows **Print / Save as PDF** (no Download link). Clicking it calls `print()` on the iframe's own window (I replaced `print` on that window to record the call, `onIframeWindow: true`; the guide inside reported "Version 2.5" and the new Preview built-in sentence). **I cannot drive Chrome's native print dialog from the automation**, so the PDF itself was made with Chrome's own print engine (`--print-to-pdf`) from the same guide HTML: **21 pages, A4 (594.96 × 841.92 pt)**, guide only, every numbered section starts on a new page, footer reads "Version 2.5 · Updated 29 October 2026". Page 1 (cover) is a clean A4 cover with no app menu. Files, untracked, in the worktree:
   - `/Users/bestdoc/Documents/taxscan-push-worktrees/guide-pdf-builtin-preview/print-check/guide-v2.5.pdf`
   - `/Users/bestdoc/Documents/taxscan-push-worktrees/guide-pdf-builtin-preview/print-check/page-01.png`
4. **PASS.** As a publisher, Templates → **Preview built-in** for **Free** and for **Premium** both render in the frame (Premium shows its "Premium" badge). **Recent stories ↔ Biggest case** change the frame's `data=` (`recent`/`worst`), and **Phone / Tablet / Desktop** set the frame to 375 / 768 / 1024 px (read back from the page: `…/builtin/preview/premium?data=recent` at 768 px, `?data=worst` at 375 px). The frame stays `sandbox=""`. Screenshots (untracked):
   - `/Users/bestdoc/Documents/taxscan-push-worktrees/guide-pdf-builtin-preview/print-check/builtin-free-biggest-desktop.jpg`
   - `/Users/bestdoc/Documents/taxscan-push-worktrees/guide-pdf-builtin-preview/print-check/builtin-premium-biggest-desktop.jpg`
5. **PASS** (tsc, lint no new errors, build:admin, full suite).

## Agents run

None.

## Deviations from the brief

1. Acceptance 3 uses Chrome's print engine on the guide HTML instead of the interactive print dialog (see above). The button wiring is verified separately.
2. The guide HTML needed no print-CSS change and no PDF-download wording removal, because neither was present or needed.

## Worth remembering

- **The machine was heavily loaded** (load average 13–20 on 4 cores from other processes) during this build. With the default 2 workers the full suite flaked a *different* suite on each of three runs (`digestRetention` fold parity, `metricsWarmer` "live parts", `digestTick` complaint-rate), each passing when re-run alone. `--maxWorkers=1` gave a clean 1,402/1,402. Worth knowing before reading a red suite as a regression while another session is running heavy jobs.
- `scripts/` still has other scripts; only `build-guide.ts` went. Any local habit of running `npm run build:guide` now errors with "missing script".
- Browser check users (`pub-check@team.test`, `adm-check@team.test`) exist only in this build DB.
- The built-in preview needs no active template and no draft, so a publisher can compare a draft with the default side by side by opening both previews.

## Clean-up

```sh
git worktree remove ../taxscan-push-worktrees/guide-pdf-builtin-preview
dropdb taxscan_push_build_guide-pdf-builtin-preview; dropdb taxscan_push_build_guide-pdf-builtin-preview_shadow
git branch -D build/guide-pdf-builtin-preview; git push origin --delete build/guide-pdf-builtin-preview
```
The finished publisher build also still has a worktree and databases to remove (`publisher-ads-templates`; its branch is merged):
```sh
git worktree remove ../taxscan-push-worktrees/publisher-ads-templates
dropdb taxscan_push_build_publisher-ads-templates; dropdb taxscan_push_build_publisher-ads-templates_shadow
git branch -D build/publisher-ads-templates; git push origin --delete build/publisher-ads-templates
```
