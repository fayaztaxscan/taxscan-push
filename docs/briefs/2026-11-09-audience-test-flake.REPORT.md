# REPORT: audience-test-flake

- **Brief:** `docs/briefs/2026-11-09-audience-test-flake.md` (planning, taxscan-push-64; base `origin/develop` 10d325c)
- **Branch:** `build/audience-test-flake`
- **Code commit:** `defee7a` — `test(jest): serialise the audience suites with one DB lock (brief 2026-11-09-audience-test-flake)`
- **Date:** 2026-11-12 (IST evening). Machine: shared 4-core Mac, load average 4–7 during the runs.

## In one paragraph
The audience suites no longer interfere with each other: a custom jest environment takes one Postgres advisory lock for every
suite that touches the shared audience tables. **Audience-only runs: 2 of 4 failed without the lock, 0 of 4 with it.** Production code
is untouched. **But acceptance 1 as literally written FAILED:** two of my five consecutive full-suite runs failed in suites that are
NOT the shared-count mechanism (`cmsEvents`; `cmsNoticesDoor` + `socialComposeSkip`), and the same full suite WITHOUT my change also
failed 3 of 5 runs (`telegramWorker` twice, plus the target flake once). The suite has other flake families this brief does not cover;
a Release check will still fail its first run some of the time. Details and proposals below.

## What changed
| File | What / why |
|---|---|
| `jest.environment.js` (new, repo root, plain CommonJS) | `jest-environment-node` + one lock. In `setup()` a suite whose SOURCE names `audienceMember` / `cmsAccount` (any case) or imports `services/audience/(pull\|writer\|ingest\|statusImport)` takes `pg_try_advisory_lock(827411)` on a dedicated one-connection Prisma client (polls every 250 ms, gives up after 20 min). `teardown()` releases it — AFTER the file's own `afterAll` cleanup. A 30 s `SELECT 1` heartbeat keeps the lock connection from idling out. |
| `jest.config.js` | `testEnvironment: 'node'` → `'<rootDir>/jest.environment.js'` (plus a comment). Nothing else. |

`src/` is unchanged (`git diff origin/develop -- src` is empty). 15 of 119 suites are locked (picked by their source text, so a new audience suite is covered with no list to maintain):
`audienceConfig, audienceFreeReaders, audienceGuard, audienceIngest, audienceNotices, audiencePrep, audiencePull, audiencePullAcceptance, audienceQa, audienceQaFollowups, audienceRefused, audienceStatusImport, audienceWriter, cmsEvents, cmsNoticesDoor`.
The other 104 run in parallel exactly as before. Switch the lock off for any run with `npx jest --testEnvironment node`.

- **Migrations:** none. **Flags/env:** none. **Full suite:** ran (the brief's `Full suite: yes`).

## Root cause (confirmed)
`AudienceMember` has no portal column and the suites only scope `AudienceSyncState` by a unique portal. `pull.ts:205`
(`mailedBefore = audienceMember.count({ desiredRole notIn NONE/FREE })`) is global, so another worker's rows move the change cap under a
running test. The same sharing also bit two OTHER audience tests (seen without the lock): `audienceRefused` ("refused again after a retry…",
global refused-Premium count on the Audience card: expected 2, received 1) and `audienceIngest` ("seq 7 deleted, erasure TRUE…", global
`AUDIENCE_ERASURE` audit count: expected 199, received 200). The lock covers all of them.

## Verification
- `npx tsc -p tsconfig.json --noEmit` → exit 0. `npm run lint` → exit 0 (lint scope is `src/**/*.ts`; the new file is outside it, `node --check` ok).
- **Serialisation probe** (throwaway suites, deleted): two suites naming `audienceMember`, 3 s each, `maxWorkers: 2`.
  With the lock: B 0–3000 ms, A 3302–6302 ms (serial). Same two files with `--testEnvironment node`: B 0–3002, A 3–3005 (overlap).
  A control suite without the table words overlapped with a locked one.

### Acceptance tests
1. **Five consecutive full-suite runs, no audience failure, no "failed to exit gracefully" line → FAILED as written** (no "failed to exit" line in any run).
   Verbatim, locked runs (`nice`, `maxWorkers: 2`, `NODE_OPTIONS=--max-old-space-size=1536`):
   ```
   run1  Test Suites: 1 failed, 118 passed, 119 total | Tests: 1 failed, 2841 passed, 2842 total | Time: 117.609 s   FAIL cmsEvents
   run2  Test Suites: 119 passed, 119 total           | Tests: 2842 passed, 2842 total           | Time: 88.35 s, estimated 117 s
   run3  Test Suites: 119 passed, 119 total           | Tests: 2842 passed, 2842 total           | Time: 113.941 s
   run4  Test Suites: 119 passed, 119 total           | Tests: 2842 passed, 2842 total           | Time: 96.303 s, estimated 113 s
   run5  Test Suites: 2 failed, 117 passed, 119 total | Tests: 2 failed, 2840 passed, 2842 total | Time: 108.434 s   FAIL cmsNoticesDoor, socialComposeSkip
   ```
   None of the three failures is the shared-count mechanism (see "Other flakes"). No `audiencePullAcceptance` / `audienceFreeReaders` / `audienceRefused` / `audienceIngest` failure in any locked run.
   Same suite WITHOUT the lock (`--testEnvironment node`, run the same evening):
   ```
   run1  1 failed, 118 passed | Tests: 1 failed, 2841 passed | Time: 89.875 s, estimated 107 s   FAIL telegramWorker
   run2  119 passed          | Tests: 2842 passed           | Time: 89.058 s
   run3  119 passed          | Tests: 2842 passed           | Time: 99.512 s
   run4  1 failed, 118 passed | Tests: 1 failed, 2841 passed | Time: 88.192 s, estimated 98 s   FAIL telegramWorker
   run5  1 failed, 118 passed | Tests: 1 failed, 2841 passed | Time: 83.302 s, estimated 87 s   FAIL audienceFreeReaders #8 (the target flake: expected "change_too_large", received null, roleChanges 101)
   ```
   Baseline on the unmodified code: first run `Tests: 2832 passed` + 1 suite failed to compile only because `admin/node_modules` was missing (`adminLoginFeatures`, "Cannot find module 'vue'" — see Traps);
   second run (admin deps installed) `Test Suites: 119 passed, 119 total | Tests: 2842 passed, 2842 total | Time: 103.303 s, estimated 142 s`.
   **The sharper measurement (only the 15 audience suites, 4 runs each, run one after another):**
   ```
   WITHOUT lock  run1 414 passed (28 s) | run2 1 failed, 413 passed (28 s) audienceRefused | run3 414 passed (34 s) | run4 1 failed, 413 passed (33 s) audienceIngest
   WITH lock     run1 414 passed (50 s) | run2 414 passed (54 s)             | run3 414 passed (55 s)  | run4 414 passed (53 s)
   ```
2. **The two named tests still fail when their behaviour is broken → PASS.** `src/` reverted after each (`git diff -- src` empty).
   - `audiencePullAcceptance` "acceptance 3 — the change cap as a percentage": `pull.ts` `changeLimit(mailedBefore, cfg)` → `changeLimit(0, cfg)` ⇒ FAILED (`breakerOpened` expected null, received `change_too_large`). Unmutated control: passed.
   - `audienceFreeReaders` #8: `ingest.ts` `countsAsRoleChange` → also true when `from !== to` (FREE moves count) ⇒ FAILED (`on.roleChanges` expected 0, received 1000). Unmutated control: passed. (My first mutation didn't compile — unused `eff` — and gave "Tests: 0 total"; redone with a compiling change.)
3. **Full-suite time not more than ~20 % longer → borderline PASS (noisy).** Locked full runs 119 / 91 / 115 / 98 / 110 s (mean 106.6, median 110); unlocked runs 92 / 91 / 102 / 90 / 86 s (mean 92.2, median 91); the clean baseline 105 s. So **+15.6 % on means, +20.9 % on medians, +1.5 % vs the baseline run.** The 15 audience suites alone go 28–34 s → 50–55 s (about +70 %), as expected: they now run one after another; the rest of the suite hides most of it. The Mac was shared (load 4–7), so treat ±10 % as noise.

## Other flakes seen (NOT fixed — outside this brief; cause unknown unless stated)
| Suite / test | Seen | What it said |
|---|---|---|
| `cmsEvents` "log lines carry the event type and id only…" (line 484) | locked run 1 | expected `webhook refused (step=signature\|replay)`; the second post logged NOTHING. **My first theory (random `PREVIOUS` starting with "0") is WRONG** — I forced that and the test still passes (a repeat event id is refused as a replay). Cause unknown. |
| `cmsNoticesDoor` "the default is 30 an hour" (line 368) | locked run 5 | 31st request expected 429, got 200. The limiter is a plain per-instance `express-rate-limit` MemoryStore, no fake timers; I could not explain it from the code. |
| `socialComposeSkip` #10 Facebook (line 741) | locked run 5 | `GET /api/facebook/posts` expected 200, got 404 (the route is mounted with `enabled: () => true`). Unlocked suite. |
| `telegramWorker` ("Post to" list; "Retry posts a FAILED row…") | unlocked runs 1 and 4 | 401 on a cookie route; 404 on an unknown row id. Unlocked suite. |
No DB pool / deadlock / connection errors in any failing output. Pattern: different suites fail each time, at roughly the same overall rate with and without the lock (locked 3/5 runs clean, unlocked 3/6 clean) — consistent with generic cross-suite sharing of other tables (users/sessions, Campaign, social post rows), which looks like the same disease in another family. I did NOT prove that.

## Deviations from the brief
- **None in code.** I did not touch `src/` (the brief's "stop and say so if production must change" never arose).
- Acceptance 1 is reported as FAILED, not massaged: I did not re-run until five happened to pass.
- Environment only: installed `admin/node_modules` (`cd admin && npm ci`) so the full suite can compile `adminLoginFeatures` (the Release check gets it from `build:admin`).

## Worth remembering (planning decides what becomes record)
- **Why teardown, not afterAll:** jest-circus runs same-level `afterAll` hooks in definition order, so a lock released from a hook registered before the file's own cleanup would release BEFORE the cleanup. `teardown()` is after everything.
- **The rule is source-text based.** A suite that reaches `AudienceMember` only through other imports (e.g. digest tests using `audienceTarget`) is NOT locked; none flaked, but it is a gap. A cheap guard would be a source-scan test that every suite naming those tables is picked.
- `jest-environment-node` is a transitive dependency of `jest` (hoisted); I did not add it to `package.json`, to leave the lockfile alone. It must be a CommonJS `.js` file: jest loads a test environment before any TypeScript transform.
- The lock key is per database, so the planning dev DB and any build DB never wait on each other; a killed worker releases it at once (session lock).
- The two `AUDIENCE_ERASURE` / refused-count failures prove the original problem was wider than the one cap test: any test that reads a global count in a shared table can race.
- **Suggestions (not built):**
  1. A separate brief for the OTHER flake families (social/Telegram/CMS-door suites): either serialise the suites that share users/sessions/Campaign/post tables with the same environment (extend the source-text rule), or give them scoped counts. Until then expect a Release check to fail its first run roughly 2 times in 5 on this Mac and pass on a re-run.
  2. A `testSequencer` that spreads the locked suites apart would hide most of the +15–20 %.
  3. Look at `cmsEvents` (no refusal log) and `cmsNoticesDoor` (no 429) with more runs; both sit in the locked set but don't depend on the shared tables as far as I can see.

## Agents run
None (no subagents).

## Clean-up (planning runs this after merging)
```sh
git worktree remove ../taxscan-push-worktrees/audience-test-flake
dropdb taxscan_push_build_audience-test-flake; dropdb taxscan_push_build_audience-test-flake_shadow
git branch -D build/audience-test-flake; git push origin --delete build/audience-test-flake
```
(The database names contain hyphens; `dropdb` accepts them as written.)
