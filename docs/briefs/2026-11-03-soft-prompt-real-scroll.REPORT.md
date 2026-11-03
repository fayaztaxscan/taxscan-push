# REPORT: soft-prompt-real-scroll

- Code commit: `d05802d` on branch `build/soft-prompt-real-scroll` (base origin/develop f048ce5).
- Agents run: ui-developer (SDK change, tests, browser check). **Deviation:** I wrote the env/config part myself (a few lines) instead of a backend-developer subagent.

## Files changed
- `public/taxscan-push.js` — reads `promptRealScroll` from /api/config; new pure helpers `isRealScrollInput`, `scrollShouldShow`, `visibleOk` (exposed via the test hook like `promptTriggers`). Flag on: scroll trigger needs a prior **trusted** wheel / touchmove / scroll-key keydown / pointerdown, `scrollTop >= clientHeight`, `scrollHeight >= 2 × clientHeight`, plus the existing ≥ ratio; the check also re-runs the moment the first trusted input arrives. `maybeShow` in a hidden tab (flag on) **waits for `visibilitychange` → visible and asks again** (all earlier checks re-run; `promptShown` prevents a double show). Flag off: original scroll code and `maybeShow` unchanged (`visibleOk` always true).
- `src/lib/env.ts` — `env.softPrompt.realScroll` from `SOFT_PROMPT_REAL_SCROLL` (default off). `src/routes/api.ts` — `/api/config` adds `promptRealScroll: boolean`. `.env.example` — flag line.
- `scripts/sql/soft-prompt-funnel.sql` — header comment only: "SOFT_PROMPT_REAL_SCROLL switch date: <placeholder>".
- `src/__tests__/softPrompt.test.ts` — 6 SDK-rule tests + 2 API tests (config flag boolean/default false; `/api/track` rejects new trigger values, enum unchanged).
- `docs/briefs/2026-11-03-soft-prompt-real-scroll.shots/` — 8 screenshots (desktop-/phone- A–D).

## Migrations / flags
None. Env: `SOFT_PROMPT_REAL_SCROLL` (default off). `trigger` meta values unchanged.

## Results
- tsc: clean. lint: clean.
- `nice -n 10 npx jest src/__tests__/softPrompt --runInBand --forceExit`: 1 suite, 15 passed, 0 failed.
- **Full suite ran** (a new env flag touches config/env loading): `Test Suites: 97 passed, 97 total` / `Tests: 1925 passed, 1925 total`.

## Acceptance
1. PASS (unit) — no trusted input: no show; trusted input at 70% on a 5×-window page: shows; <60% or <1 window scrolled: no; exactly 2 windows tall and one window scrolled: shows; a 1.2-window page never shows; flag off = ratio-only as today.
2. PASS (unit) — hidden tab blocks both triggers (both go through `maybeShow`); visible shows. Option chosen: **wait**.
3. PASS — `/api/config` carries the flag, default false; `/api/track` still rejects `real-scroll` / `scroll-real`.
4. PASS — Chromium via Playwright, flag on (v2), local app + build DB, every non-localhost request aborted, `Notification.requestPermission` stubbed. Real scroll on a 6000 px page: card shows at scrollY ~3500, `PROMPT_SHOWN trigger=scroll` recorded locally (desktop 1280 with a real mouse wheel; phone 375 with touch gestures via CDP). `scrollTo(0,99999)` with no input: page scrolls, no card, nothing tracked (both widths). Short page (~1.2 windows): no card. Dwell: no card early, shows at ~46 s with trigger=dwell (both widths, real 45 s wait).
5. PASS — tsc, lint, soft-prompt tests.

## Not browser-tested (unit only)
The "≥ 60 % but under one window" case and a hidden tab.

## Notes
- Scroll listener also re-checks on the first trusted input, covering a page already scrolled before the first input and a touchmove arriving before its scroll event (inside the brief's rules).
- Local build DB: 4 `PROMPT_SHOWN` rows from the browser runs were deleted. Production never contacted.
- After deploy and switch-on, planning measures with `scripts/sql/soft-prompt-funnel.sql`; stop rule in the brief (real grants < ~4/day for a week → flag off).

## Clean-up
```sh
git worktree remove ../taxscan-push-worktrees/soft-prompt-real-scroll
dropdb taxscan_push_build_soft-prompt-real-scroll; dropdb taxscan_push_build_soft-prompt-real-scroll_shadow
git branch -D build/soft-prompt-real-scroll; git push origin --delete build/soft-prompt-real-scroll
```
