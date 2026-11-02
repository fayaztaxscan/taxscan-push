# REPORT: digest-dark-mode-colours (main brief + follow-up 1)

- **Branch:** `build/digest-dark-mode-colours` (base `origin/develop` 76fdfd9). **Code commit:** `0f3f5f8`.

## Files changed
- `src/services/digest/renderer.ts` — `button()` drops `solid()`; `<style>` loses the `[data-ogsb]/[data-ogsc]` line, the `.ts-hdr/.ts-logo` phone rules and gets a new comment; `solid()` kept for the brand block only (comment says why). New `HEADER_BANNER_PATH`, new row placeholder **`{{header}}`** (banner `<img>` row + "Daily Digest · date" row, `#111111`, dark Premium badge; with no asset host a `#3b3543` wordmark row). Built-in shell now uses `{{header}}` instead of the `ts-hdr` cell. Story `<img>` inline = `width:100%;max-width:280px;height:auto;aspect-ratio:1200/628;object-fit:cover`.
- `public/email/taxscan-header-1800x220.png` — new, 1800×220, 10,771 B, corners `#3b3543`. Made once with Pillow (system python3, no npm dep) from `taxscan-logo-white-440.png` centred on a solid `#3b3543`, quantised to 32 colours. Only the PNG is committed.
- Tests: `digestPolish`, `digestOldFormat`, `digestRenderer`, `digestTemplates` — pinned old behaviour updated (not deleted); new block "1b" covers F1/F2/F3/F5.
- `docs/EMAIL_DIGEST_DESIGN.md` — built-in-look line updated (banner; apps recolour buttons/text together).

## Migrations / flags
None / none.

## Results (verbatim)
- `npx tsc -p tsconfig.json --noEmit`: clean. `npm run lint`: clean.
- Full suite: `Test Suites: 84 passed, 84 total` · `Tests: 1722 passed, 1722 total` (eventRetention did not flake on the last run).

## Acceptance tests
1. No `linear-gradient(#FEE620` / header pin (FREE+PREMIUM with ads): PASS (digestPolish "dark mode recolours…"; brand block keeps its pin, asserted).
2. No `[data-ogsb]`/`[data-ogsc]`: PASS.
3. Light colours unchanged for buttons (`#FEE620` cell/link, `#000000`): PASS. The header half is superseded by F1–F3.
4. Size: worst case, old → new (htmlBytes, measured with the develop renderer side by side): FREE 68,059 → 67,256; PREMIUM 68,488 → 67,685. PASS (shrinks ~800 B).
5. Updated tests + all `digest*` + tsc + lint: PASS.
6. Visual check: PASS with caveats (below).
- F1 PASS · F2 PASS · F3 PASS · F5 PASS (custom template with `{{logo}}`/`{{premium_badge}}` renders the old markup string-for-string) · F6 PASS (as 4).
- F4 (ui-developer, real browser): PASS, measured in headless Chromium 148 (Playwright cache) because the claude-in-chrome tools were unavailable; not the owner's Chrome. At 375 px every story picture and brand block = text column width (335 px, 0 px difference over 12 stories, both samples); banner = 375 px wide; at 1200 px banner 900×110, picture 280×146.53 (aspect-ratio rounding; was 147), side by side with 560 px text. Screenshots: `/private/tmp/claude-501/-Users-bestdoc-Documents-taxscan-push/b1b9efaf-a625-451b-a08e-6776335abfdb/scratchpad/vis/` (`shot-{before,after}-FREE-{pic,brand}@{900,375}.png`, `shot-w1200-*`). Only FREE was measured; PREMIUM rendered but not screenshotted.

## Agents run
ui-developer, once: before/after render + browser measurements (above).

## Deviations
- **New placeholder `{{header}}`** (row placeholder, optional, listed on the Templates screen). The built-in shell is static and needs the asset-host URL, so the banner could not stay inside `{{logo}}`/`{{date}}`. `{{logo}}`, `{{premium_badge}}`, `{{date}}` output is unchanged for custom templates. Anyone who seeds a new template from the built-in now gets `{{header}}`.
- Test fixtures that replaced `{{logo}}`/`{{date}}` inside the built-in (`marked`, alt-text, placeholder and Premium-subscription checks) now use a `LEGACY_HEADER` copy or `marked` includes `{{logo}}`.
- The built-in header ignores an explicit `logoUrl` (the banner replaces it).

## Worth remembering
- **Pictures with no `<style>` block (Zoho-like) still stay 280 px on a phone** (column 319): the column div's own inline `max-width:280px` is what caps it, and removing that would make desktop pictures stretch. Same as before the change; only fixable with a media query. The `<style>` path (iOS Mail etc.) fills the column.
- At exactly 900 px viewport the story row already stacks (card content 844 < 860 needed); side by side from ~920 px. Not caused by this change.
- On phones the header is now ~46 px tall with a ~70 px logo (was ~105 px); the owner asked for the banner, but it is visibly smaller.
- **Real dark-mode clients (iOS Mail, Gmail apps, Zoho, Outlook) are NOT verified.** The real check is the next staff send on Anagha's and the owner's phones. Outlook's handling of the banner and Gmail clipping also unchecked. Today's frozen run HTML is not re-rendered; this applies from the next 06:30 build.
- The `digest` jest path filter matches this worktree's directory name, so `npx jest digest` runs everything here.

## Clean-up (planning session, after merge)
```sh
git worktree remove ../taxscan-push-worktrees/digest-dark-mode-colours
dropdb taxscan_push_build_digest-dark-mode-colours; dropdb taxscan_push_build_digest-dark-mode-colours_shadow
git branch -D build/digest-dark-mode-colours; git push origin --delete build/digest-dark-mode-colours
```
