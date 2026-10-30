# REPORT: digest-polish-old-look

**Status: follow-up 1 DONE — size passes, full suite green (1,718). The first-pass size table below is history.**
Code commit: `3f06e48` on branch `build/digest-polish-old-look` (base origin/develop 50f3a5b + brief item F).

## Follow-up 1 (owner, 30 Oct: "go with recommendation, maximum delivery") — DONE
1. **VML dropped** (Read More + ad CTAs): table-cell button, the `<a>` (display:block, #FEE620 bg incl. background-image, 15 px bold #000) fills the 96x38 cell, full width on phones; clickable on the whole box except Outlook for Windows (text only). Code: renderer.ts `button()`. (Landed in commit d732659.)
2. **`DIGEST_HTML_WARN_KB` 75 → 80** (src/lib/env.ts); `DIGEST_MAX_HTML_KB` stays 90. digestScheduler default test, admin guide checklist line (v2.12) and EMAIL_DIGEST_DESIGN.md §5 updated.
3. Alt = headline kept; `DIGEST_MAX_ITEMS`=15, cap still main + ICYMI together.
4. **"Biggest case" sample ads** no longer use made-up picture URLs: `worstCaseDisplayAds()` (templates.ts) draws them text-only for display (route digestTemplates.ts); the size check still uses `worstCaseFixture`. Deviation: text-only rather than "default story picture / brand block", because an ad banner is 1720x400 / 1080x1080, not the 1600x840 story shape. Test: no `/email-assets/<digit x64>` in the preview, "Sample ad 1" present; fixture ads keep their images.
5. **Size acceptance (budget = html + 150 B/link; warning 81,920 B, refusal 92,160 B):**
   - Builder's real worst case (12 main + 3 ICYMI = 15 total, 3 ads): FREE html 68,110 / budget 76,360; PREMIUM html 68,539 / budget **76,789** → 5.1 KB under the 80 KB warning, 15.4 KB under the refusal.
   - 15 main, no ICYMI, 3 ads: FREE 70,986 / 79,686; PREMIUM 71,424 / **80,124** → 1.8 KB under the warning, 12.0 KB under the refusal (test asserts ≥10 KB under 90 KB).
   - Not a producible case: 15 main + 3 ICYMI + 3 ads through the renderer directly was 88,804 html / 98,404 budget before the button change (over the refusal); not re-measured.
   - Test results after the final change: tsc clean, lint clean, **full suite once: Test Suites: 84 passed, 84 total; Tests: 1,718 passed, 1,718 total.** Admin SPA untouched this round (admin vue-tsc/build were clean at the earlier commit).
- Not re-inspected by me: the 375/1000 px render after the button change (the ui-developer did it) — worth one look at the phone button and Outlook.

## History: size decision that was needed
Budget = html bytes + 150/link. Warning 76,800; refusal 92,160. No limit raised.
| Case | html | budget |
|---|---|---|
| worstCaseFixture now (12 main + 3 ICYMI, 3 ads) | 75,877 | 84,127 (7.3 KB over warning) |
| 15 main, no ICYMI, 3 ads | 78,762 | 87,462 |
| 15 main + 3 ICYMI + 3 ads, renderer direct (builder can't produce it) | 88,804 | 98,404 (over refusal) |
| scripts/render.ts realistic fixture | 73,441 → 67,819 | 83,041 → 77,119 |
Before the work the 15-item worst case was 91,372 B. Tried: text-only ICYMI, no row rules, WRAP on story cell only, VML namespaces on <html>, dropped redundant button styles, img defaults in one head rule, MSO table without role. Remaining levers (NOT done, they change behaviour): replace the 15 Outlook VML buttons (8.8 KB) with a table-cell button (Outlook clickable on text only) → ~75.4 KB; shorter picture alt (~3.4 KB, breaks "alt = headline"). Or raise the threshold.

## Files changed
- prisma/schema.prisma + migrations/20261030150000_digest_setting: new DigestSetting key/value table (additive).
- src/services/digest/defaultStoryImage.ts (new), adImages.ts (role 'story' 1600x840, 250 KB), content.ts (resolve at build), routes/digestTemplates.ts (GET/POST/DELETE /api/digest/default-story-image, ADMIN+PUBLISHER, audited via DIGEST_TEMPLATE_SAVED metadata), templates.ts (worstCaseDisplayItems, item F).
- src/services/digest/renderer.ts: items 1–10, decisions C/D/E, brand block / default picture, preheader counts main only, footer postal alone (also in the plain-text part).
- src/services/backup.ts, scripts/restore-backup.ts: DigestSetting included (still format v2).
- src/lib/env.ts: DIGEST_MAX_ITEMS 12 → 15. Tests digestScheduler/digestBuilder updated (builder roll-forward now 15 total / 12 main).
- admin/src/views/Templates.vue: Default story picture card. docs/Taxscan-Push-Admin-Guide.html 2.11 → 2.12. docs/EMAIL_DIGEST_DESIGN.md line 488.
- Tests: new digestDefaultStoryImage (10); updated renderer/polish/lookalike/oldFormat/templates/retention.

## Migrations / flags
DigestSetting (additive). No flags added; DIGEST_MAX_ITEMS default 15.

## Test results
- tsc clean; lint clean; admin vue-tsc clean; build:admin OK.
- Full suite (before the last digestBuilder fix): Tests: 5 failed, 1712 passed, 1717 total. The roll-forward failure was then fixed (digestBuilder alone: 32 passed). Remaining 4 failures are all size tests: digestPolish "size: the worst case stays under 75 KB", digestLookalike size + footer worst-case, digestTemplates checklist size.

## Acceptance
1 renderer tests: PASS (except size). 2 screenshots: PASS — 375 px Read More 335×43 (was 120×38), desktop 96×38, mobile ad 335×335, header 111 px (logo 160), padding 0, no horizontal overflow; no-<style> render stacks (picture 280 px, not full 335 — the 280 cap must stay for desktop). Shots: /private/tmp/claude-501/-Users-bestdoc-Documents-taxscan-push/483cd430-5d7a-4077-b578-e9ec8643ab7a/scratchpad/after/ . 3 default picture: PASS (1600×841 and 1200×628 refused naming both sizes, >250 KB refused, both roles, brand block). 4 size: **FAILED** (table above). 5 header date: PASS. 6 ICYMI no <img>, preheader main-only: PASS. 7 social row: PASS. 8 Templates real browser desktop+375, both roles: PASS. 9 suite: FAILED only on the 4 size tests.

## Agents
backend-developer (storage/routes/freeze/backup/env); ui-developer (renderer, Templates card, guide, browser checks).

## Deviations / notes
- DIGEST_MAX_ITEMS caps main + ICYMI together (builder.ts ~487), so 15 main stories only occur with no ICYMI. Left as is.
- Picture in the no-<style> render is 280 px wide, not full width.
- "Biggest case" preview sample ads, when the pool can't fill slots, still use made-up /email-assets/ URLs (item F covered stories only).
- Plain-text footer also drops "Taxscan ·" (brief named html only).

## Clean-up
```sh
git worktree remove ../taxscan-push-worktrees/digest-polish-old-look
dropdb taxscan_push_build_digest-polish-old-look; dropdb taxscan_push_build_digest-polish-old-look_shadow
git branch -D build/digest-polish-old-look; git push origin --delete build/digest-polish-old-look
```
