# REPORT: digest-polish

- Branch `build/digest-polish` (base `origin/develop` @ 980a45a); code commit `4ecec801ad39ee5dec6ef89ef4a155c9c6acf219`.

## Files changed
- `src/services/digest/renderer.ts`: light-only email (metas + `:root`, own dark palette removed); `solid()` gradient fallback on header and buttons; Gmail `[data-ogsb]`/`[data-ogsc]` hooks; `LOGO_PATH` → on-dark logo; story picture 240×126 (1.91:1) with width/height attributes + fixed inline size + `object-fit:cover`; headline no longer has top padding; Read more is a fixed 140×44 centred box with 14 px above; image ads always 552 px wide, height from the stored size.
- `public/email/taxscan-logo-on-dark-440.png` (new): the logo on `#3b3543`, 440×106, RGB. The old white PNG stays.
- `admin/src/views/Ads.vue`: one line, "Best size: 1200 × 628 (wide rectangle)."
- Tests: new `digestPolish.test.ts` (12); updated `digestRenderer`, `digestTemplates`, `digestLookalike` for the new markup (colour-scheme metas, button style, logo path, 240×126, phone CSS, tap-target rule).

## Migrations / flags
None / none.

## Results
- tsc: exit 0. lint: 0 errors. `npm run build:admin`: ok.
- Full suite (`--maxWorkers=1`): `Test Suites: 78 passed, 78 total` / `Tests: 1583 passed, 1583 total`.

## Acceptance
1. PASS: light-only, gradient + colour on header and buttons, logo `src` is the on-dark PNG.
2. PASS: width+height attributes and inline sizes (240 px); ads carry width/height from stored size (800×210 → 552×145; 1200×628 → 552×289).
3. PASS: ghost cells `valign="top"`, columns `vertical-align:top`, no headline top padding; Read more fixed box + VML kept.
4. PASS: worst case FREE html 66,162 B / budget 73,212 B; PREMIUM 66,600 / 73,650 (limit 75 KB = 76,800). Before: 66,150 / 73,200.
5. PASS with one caveat (below). Screenshots in `visual-check/` (untracked): `{light,dark,forced,zoho}-{375,768,1024}.png`, full path `/Users/bestdoc/Documents/taxscan-push-worktrees/digest-polish/visual-check/`. Made with headless Chrome, each width in an iframe (headless won't go below ~500 px). `dark` = `preferredColorScheme=1`; `forced` = `--enable-features=WebContentsForceDark --force-dark-mode`; `zoho` = the same HTML with `<style>` stripped.
6. PASS: tsc, lint, build:admin, full suite.

## Findings by Anagha's issue
1. Header/logo: stays `#3b3543` under dark preference and under Chrome forced dark (the gradient holds); the logo now carries its own background.
2. Read more: yellow with black, centred, in light, dark-preference and Zoho-like. **Caveat: under Chrome's forced dark the yellow still turns dull brown (white text)** — the gradient did not stop it. I tried a hosted 1×1 yellow image as an extra background layer: the yellow held, but forced dark also flipped the text to white on yellow, which is unreadable. I did not ship that; brown with white text at least reads. Real behaviour in Zoho Mail's own dark mode is unverified until the staff trial.
3. Level tops: picture and headline now start at the same line at 768/1024.
4. Zoho-like (no `<style>`): pictures stay 240 px wide at 375/768/1024.
5. Ads: full 552 px width. A narrow image is scaled up; the hint line asks for 1200×628.

## Deviations / notes
- No picture size is stored, so the box is an assumed 1.91:1; other shapes are cropped by `object-fit:cover` (Outlook ignores it and stretches inside the attribute box).
- Headline link keeps a ≥44 px tap area by moving its padding below (`0 0 18px 0`); `digestRenderer` tap-target test updated accordingly.
- On phones the picture is full width at its box aspect, capped at 240 px high.
- Saved custom templates are untouched (they keep their own head/styles); only the built-in changed.
- Agents: none.

## Clean-up
```sh
git worktree remove --force ../taxscan-push-worktrees/digest-polish
dropdb taxscan_push_build_digest-polish; dropdb taxscan_push_build_digest-polish_shadow
git branch -D build/digest-polish; git push origin --delete build/digest-polish
```
