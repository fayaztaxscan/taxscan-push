# REPORT: digest-story-row-fit

- Code commit: `140e401` on branch `build/digest-story-row-fit` (base origin/develop ba10143)
- Agents run: ui-developer (implementation, tests, Chrome measurements); I re-ran tsc, lint and the digest tests myself.

## Files changed
- `src/services/digest/renderer.ts` — percentage columns (picture 33% min 180, gap 2.5%, text 64% min 300) in a font-size:0 cell; MSO table width=100% with 33/3/64% cells (ICYMI 36/64); compact text (headline 16/21, summary 14/19 #333 6px under, Read More 30px, 7px under summary); `fitSummary()` with named constants HEADLINE_2LINE_CHARS=104, SUMMARY_2LINE_CHARS=130, SUMMARY_1LINE_CHARS=62 (derivation in comment); brand block width 100% + aspect-ratio (MSO-only 147px cell); phone block restores 16/24 headline, 16/24 summary, 13px + 43px full-column button via new classes ts-hl / ts-sum / ts-more; doc comments updated.
- `docs/Taxscan-Push-Admin-Guide.html` — digest-look paragraph reworded (it quoted no sizes); version 2.17 → 2.18.
- `src/__tests__/digestLookalike|OldFormat|Polish|Renderer|Templates.test.ts` — size/layout assertions updated, none deleted.
- `src/__tests__/digestStoryRowFit.test.ts` — new, acceptance 1–4.
- `docs/briefs/2026-11-03-digest-story-row-fit.shots/` — new-1000/780/650, iframe375-new, iframe375-new-nostyle, old-780-before.

## Migrations / flags
None / none.

## Results
- tsc: exit 0, no output
- lint: `eslint "src/**/*.ts"`, no errors
- Area tests (`npx jest src/__tests__/digest`): Test Suites: 25 passed, 25 total / Tests: 765 passed, 765 total
- Full suite: not run (not required; no shared foundation touched). `build:admin` not run (SPA unchanged).

## Acceptance
1. PASS — percentage columns, no max-width 280/560; MSO table 100%; ICYMI spacer proportional.
2. PASS — short headline ≤130 chars, 3-line headline (>104) ≤62; word-boundary "…"; headline untouched; empty summary → no <p>.
3. PASS — desktop Read More 30px, summary 14, headline 16; phone button 43px full width (measured 335×43).
4. PASS — fixture 46,135 → 46,088 bytes (under 80 KB warn).
5. PASS with caveats. Text-block height minus picture height (px): 1000 pane: all 13 stories side by side, text 24–47 shorter than picture. 780: 0 for 7 stories, −2…−23 for the rest, none over. **650: every story runs over by +18…+62** (story 1, 4-line headline, +62; others +22/+40/+41) — picture is only 103 px tall there; still side by side, nothing cut off. 375 (iframe): stacked, picture 335×175, Read More 335×43. 375 with <style> removed: stacked, not squeezed.
6. PASS.

## Deviations / notes
- Headless Chrome won't go below a 500 px window, so 375 px shots are a 375 px iframe inside a 500 px canvas.
- With <style> stripped, the stacked picture is 180 px wide, left-aligned (the min-width floor the brief suggested); with the style block it is full width.
- Phone summaries are also trimmed to the 130/62 char limits (less than today's 220). Not restored for phones.
- Read More sits 7 px under the summary (brief said ~8).
- Desktop summary carries both `ts-body ts-sum` so existing dark-mode/test selectors on ts-body still match.
- Not tested in real Outlook or Zoho — Chrome only. Suggestion: check the next staff digest in Zoho + Outlook.
- Suggestion: 650 px overrun could be reduced by raising the text min-width or trimming more at narrow widths; not built (outside brief's 780/900 target).

## Clean-up
```sh
git worktree remove ../taxscan-push-worktrees/digest-story-row-fit
dropdb taxscan_push_build_digest-story-row-fit; dropdb taxscan_push_build_digest-story-row-fit_shadow
git branch -D build/digest-story-row-fit; git push origin --delete build/digest-story-row-fit
```
