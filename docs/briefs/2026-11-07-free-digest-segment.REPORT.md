# REPORT: 2026-11-07-free-digest-segment

- **Code commit:** `2356018a1e813c64c1a3ca43d5473574df59d662` — `feat(digest): Free digest can target a Mailercloud segment (brief 2026-11-07-free-digest-segment)`
- **Branch:** `build/free-digest-segment` (cut from `origin/develop` `65df540`)
- Status: **built, all acceptance tests PASS, full suite green.** No mismatch between the brief and the code.

## Files changed
- `src/lib/env.ts` — `DIGEST_FREE_SEGMENT_IDS` via `listEnv` → `cfg.audiences.free.segmentIds`.
- `src/services/digest/runner.ts` — `audienceTarget`, Free branch: with a segment set, the target is exactly `{ listIds: [], segmentIds, tagIds: [], excludeListIds: [], excludeTagIds: [] }`, derived or not; three refusals (below). Doc comment updated.
- `src/services/digest/screen.ts` — `digestRunDetail` returns a top-level `freeTargetsSegment` boolean (true only when the Free target resolves OK and has a segment; never the id).
- `admin/src/composables/digestView.ts` — pure `freeConfirmDetail()` + the two sentence constants (ui-developer).
- `admin/src/views/Digests.vue` — `freeTargetsSegment?` on the `Detail` type; the Send Free `ConfirmPush` uses `:detail="freeConfirmDetail(detail.freeTargetsSegment)"` (ui-developer). Heading, title, button and the Cancel-focused default untouched.
- `src/__tests__/digestFreeSegment.test.ts` (new, 18 tests) — acceptance 1–8 and 10, plus the "build fails closed" constraint.
- `src/__tests__/digestFreeConfirm.test.ts` (new, 4 tests, pure) — the dialog wording (ui-developer).
- `docs/EMAIL_DIGEST_DESIGN.md` §5 — new `DIGEST_FREE_SEGMENT_IDS` row with the three refusals; the `DIGEST_FREE_LIST_IDS` and `DIGEST_FREE_EXCLUDE_*` rows say when they do not apply.
- `docs/DIGEST_PILOT_RUNBOOK.md` — new subsection "Free to real readers: the segment" (the brief's 5-step rollout order, the three refusals, "change it only outside 06:15–17:00 IST", rollback) before Stage 4.
- `docs/Taxscan-Push-Admin-Guide.html` — one bullet in the Send Free section; version 2.25 → **2.26**, "Updated 7 November 2026".
- `docs/briefs/2026-11-07-free-digest-segment.shots/` — 5 screenshots (in the report commit).

## Migrations
None.

## Flags / env
`DIGEST_FREE_SEGMENT_IDS` — default empty (= off: nothing changes). Not set by this build.

## Test results (verbatim)
- `npx tsc -p tsconfig.json --noEmit` → exit 0, no output.
- `npm run lint` → `eslint "src/**/*.ts"`, exit 0, no output.
- New tests: `digestFreeSegment.test.ts` — `Tests: 18 passed, 18 total`; `digestFreeConfirm.test.ts` — `Tests: 4 passed, 4 total` (run by the ui-developer, and again inside the full suite).
- Admin build (`cd admin && npm run build`, includes `vue-tsc --build --force`): `✓ built in 2.47s`, exit 0 (ui-developer's run).
- **Full suite — ran, because the brief says `Full suite: yes` and the change touches config/env:**
  `Test Suites: 104 passed, 104 total` / `Tests: 2381 passed, 2381 total` (2,359 on `develop` + 18 + 4). It includes every `digest*` and `audienceGuard` test file, so the area tests are covered by it. The known flaky eventRetention test did not fail.
  - The run printed `A worker process has failed to exit gracefully and has been force exited`; exit code 0. I did not investigate it, so I can't say whether it is new.
  - After that run I changed one word in the admin guide (a docs file no test reads) and amended the commit; no code changed since.

## Acceptance tests
| # | Result | Where |
|---|---|---|
| 1. Setting unset: Free exactly as today, derived and non-derived, incl. today's refusals | PASS | `digestFreeSegment.test.ts` "1." (4 tests) |
| 2. Segment set, list empty, manual on: segment target, everything else empty; derived on and off | PASS | "2." (3 tests; also several segments, configured excludes ignored) |
| 3. Segment + list both set: refused, reason names both settings | PASS | "3." |
| 4. Segment set, manual off: refused, reason names `DIGEST_FREE_MANUAL` | PASS | "4." |
| 5. Free segment id equal to a Premium segment id: refused | PASS | "5." |
| 6. `createDraft` body: `segments` has the id; `list_ids`, `tag_ids`, `exclude_*` empty | PASS | "6." — real `MailercloudSender` against the local fake HTTP server |
| 7. Premium's target unchanged in every case | PASS | "7." (5 Free setups × derived on/off, compared with the baseline) |
| 8. A pressed Send Free on a segment-target draft schedules once; gates as `digestFreeManual.test.ts` | PASS | "8." — morning draft carries the segment target, one press = one `schedule`, a second press refused, quiet hours and past-cutoff refused, a refused target stops the press (`config_invalid`). The whole existing `digestFreeManual.test.ts` also passes. |
| 9. Dialog line only when a segment is the target; browser check against a stubbed API, screenshots | PASS | `digestFreeConfirm.test.ts` (4) + the screenshots below; the screen boolean is false for a list target and for a refused config (`digestFreeSegment.test.ts` "9.") |
| 10. Screen payload contains no segment id | PASS | "10." — `JSON.stringify(detail)` contains neither `seg-free` nor `seg-premium` nor `segmentIds` |

**Screenshots** (`docs/briefs/2026-11-07-free-digest-segment.shots/`; Playwright Chromium against the Vite dev server with `/api/*` stubbed, fake content only, a real 375×812 viewport for the phone ones; the script is not in the repo): `dialog-segment-desktop.png` and `dialog-segment-375.png` (line shown; 4 text lines at 375 px, both buttons inside the screen), `dialog-list-desktop.png`, `dialog-list-375.png` (`false`: original sentence only), `dialog-absent-375.png` (field missing: identical to `false`). I looked at the two segment ones myself.

**Constraint check — a Free refusal stops the whole morning build, Premium included:** kept and tested (segment + list both set → no draft created for either version, run not BUILT). The runbook says to change the setting only outside 06:15–17:00 IST.

## Agents run
- `ui-developer` (one, background): the dialog line, `freeConfirmDetail`, `Digests.vue`, its pure test, the browser check at desktop and 375 px with screenshots. I reviewed its diff and the two segment screenshots.
- I did the backend, the tests, the docs and the full suite myself.

## Deviations from the brief
- The dialog helper's test is a **root jest file** (`digestFreeConfirm.test.ts`), because admin has no unit-test runner (only Playwright e2e that boots the backend); `digestScreen.test.ts` already imports admin helpers the same way.
- The guide's page footer still said **Version 2.24** (the previous build bumped only the cover to 2.25), so I set both places to 2.26.
- The new dialog line is appended to the **same paragraph**, not a paragraph of its own, because `ConfirmPush` takes a plain string and changing that shared component is out of scope.

## Worth remembering (planning decides what becomes record)
1. **Stale count in the dialog title, right above the new line.** `freeConfirmTitle` shows "Free: ~10,066 readers", which comes from `audienceEstimate().FREE`, i.e. the `targeted` figure of the **last Free send**, not a live count. With a segment target it will show the old list's size (or "Free: full list" if there never was a Free send) until the first segment send records its own, directly above "check its count". Not built (the brief rules out showing the segment's count). Cheap fix for a follow-up brief: when `freeTargetsSegment` is true, show "Free: the Free segment" instead.
2. The unchanged first sentence of the dialog still says "goes to the Free list" when a segment is the target (kept as instructed).
3. With `DIGEST_AUDIENCE_FROM_CMS` on and `AUDIENCE_MC_TAG_PREMIUM` / `_NO_MARKETING` unset, `audienceTarget` still refuses before reaching the Free branch, so Free with a segment is refused too. Premium would be refused as well; left as is.
4. `freeTargetsSegment` is computed from the resolved target, so a refused configuration reads `false`; the button's own reason already explains the refusal.
5. `social-every-link` (built in the same session, not pushed) also edits `src/lib/env.ts`, in a different place (`SOCIAL_ANY_LINK_FROM`, a new `env.social` block next to `env.whatsapp`). Expect a small, textual merge at planning.

## Clean-up (planning runs this after merging)
```sh
git worktree remove ../taxscan-push-worktrees/free-digest-segment
dropdb taxscan_push_build_free-digest-segment; dropdb taxscan_push_build_free-digest-segment_shadow
git branch -D build/free-digest-segment; git push origin --delete build/free-digest-segment
```
