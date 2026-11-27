# REPORT: one page, one id — duplicate page guard + campaignChannels test fix

- **Brief:** `docs/briefs/2026-11-27-duplicate-page-guard.md` (no follow-up)
- **Branch:** `build/duplicate-page-guard`, cut from `origin/develop` 5c7e428
- **Code commit:** `259101d`
- **Result:** built; acceptance 1–8 PASS; full suite green on the final code (second run).

## Files changed
- `src/lib/env.ts` — one pure rule `sharedPagesByUniqueId`, used by `facebookSharedPages(src)` and `linkedinSharedPages(src)`; `FACEBOOK_SHARED_ORDER` / `LINKEDIN_SHARED_ORDER`; `env.facebook.sharedPages` and `env.linkedin.sharedPages` are built from them.
- `src/services/facebook/pages.ts`, `src/services/linkedin/pages.ts` — `SHARED_PAGES` is now that one list (same values, same order).
- `src/services/facebook/worker.ts`, `src/services/linkedin/worker.ts` — boot lines take the "off" reason from the same result as the env.
- `src/__tests__/duplicatePageGuard.test.ts` — new, 28 tests.
- `src/__tests__/campaignChannels.test.ts` — `RUN`'s random part now starts with `r` (one-line comment).
- `src/__tests__/facebookAcademy.test.ts` — one case changed (see Deviations 1).
- `docs/FACEBOOK_POSTING.md`, `docs/LINKEDIN_POSTING.md` — the guard (the Facebook line replaces the old "nothing stops two pages" note).

## Migrations
None.

## Flags / env
None added. No change for a configuration whose ids all differ.

## Test results (final code)
- tsc: `npx tsc -p tsconfig.json --noEmit` → no output, `tsc exit 0`
- lint: `eslint "src/**/*.ts"` → no findings, `lint exit 0`
- admin build: not run (the SPA did not change)
- new tests: `Tests:       28 passed, 28 total`
- **Full suite: ran, twice** (brief: yes)

| Run | Result (verbatim) |
|---|---|
| 1 | `Test Suites: 1 failed, 122 passed, 123 total` / `Tests:       1 failed, 2963 passed, 2964 total` |
| 2 (final) | `Test Suites: 123 passed, 123 total` / `Tests:       2964 passed, 2964 total` |

Run 1's failure was real, not a flake: `facebookAcademy` "the env wiring…" gave Shopscan and Academy the same page id, which the
guard now refuses. The case now uses two ids.

**Do the new tests catch a missing guard?** With the clash condition disabled: `Tests:       21 failed, 7 passed, 28 total`
(then restored, checksum verified).

## Acceptance
| # | Result | How checked |
|---|---|---|
| 1 | PASS | Academy = Taxscan: not in `sharedPages`, `portalPages()` = Taxscan + Shopscan, boot line names the clash, no id in any log line; also through a fresh env load |
| 2 | PASS | Academy = Shopscan: Shopscan on, Academy off with `…is the same page as shopscan…` |
| 3 | PASS | all different: both on; Shopscan = Taxscan: Shopscan off, Academy on (all three equal: both off, each naming taxscan) |
| 4 | PASS | LinkedIn: Academy = Taxscan off; Shopscan = Academy off, Academy on; all different on; no URN logged |
| 5 | PASS | spaces and a newline around an id, on either side, still clash; a URN with one more digit does not |
| 6 | PASS | both workers schedule their cron with a clash; a tick makes one call (Taxscan's) and no row for a clashed page |
| 7 | PASS | temporary copies, deleted: suffix forced to `r123456` → `Tests:       6 passed, 6 total`; the old shape forced to `123456` → `Tests:       6 failed, 6 total` |
| 8 | PASS | full suite run 2 |

## Agents run
None (backend and docs only).

## Deviations and choices
1. `facebookAcademy.test.ts` was edited: its both-pages-on case relied on one shared id.
2. **A shared page that is itself off holds no id**, so it does not block a later one (for example Shopscan with no token: Academy
   with Shopscan's id stays on and posts there once). The Taxscan page's id counts whenever it is set, whatever its token.
3. The channel order moved to `env.ts` so the rule and the tick cannot drift; `pages.ts` re-exports it.
4. The four old per-page parsers (`parseFacebook…Env`, `parseLinkedIn…Env`) stay exported; only tests use them now.

## Worth remembering
- The random test fault is only in `campaignChannels`: 12 other files that build URLs with the same suffix
  (`socialPause`, `socialComposeSkip`, `socialAllPushes`, `socialEveryLink`, `socialPageStatus`, `linkedin*`, `facebook*`,
  `whatsappNudge`) passed with it forced to digits (`Tests:       6 failed, 641 passed, 647 total`, all 6 in `campaignChannels`,
  before the fix).
- When two shared pages clash, the earlier one wins: Shopscan over Academy on Facebook, Academy over Shopscan on LinkedIn.
- The guard compares ids only. A wrong id that matches no other page is not caught: Check connection is still the check.

## Clean-up (planning runs after merging)
```sh
git worktree remove ../taxscan-push-worktrees/duplicate-page-guard
dropdb taxscan_push_build_duplicate-page-guard; dropdb taxscan_push_build_duplicate-page-guard_shadow
git branch -D build/duplicate-page-guard; git push origin --delete build/duplicate-page-guard
```
