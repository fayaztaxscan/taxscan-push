# Brief: Stop the audience test flake that fails Release checks

- **Date / name:** 2026-11-09-audience-test-flake  →  branch `build/audience-test-flake`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first).

## Goal
The full suite stops failing at random in the audience tests, so a Release check passes on its first run.

## Why
Two Release checks in a row on 9 Nov failed their FIRST full run and passed the second. Run 1 (2b96cc2): `audienceFreeReaders` #8 +
`audiencePullAcceptance` "acceptance 3 — limit = max(5 % of mailed members, 100)". Run 2 (5bc88ae): `audiencePullAcceptance` again
(expected no breaker, got `change_too_large`; roleChanges 130 vs 120 expected). Cause (build session): `src/services/audience/pull.ts:205`
computes the breaker's change limit from a GLOBAL count of mailable members (`audienceMember.count({ where: { desiredRole: { notIn: ['NONE','FREE'] } } })`),
so audience suites running in parallel jest workers on the same database see each other's rows. Audience code is unchanged since PR #112.

## Scope
**In:** make the affected audience suites isolated. Preferred: run every suite that writes `AudienceMember` / `CmsAccount` serially (one jest
project or a shared lock), or give each its own scope it cleans before and after. Production behaviour of `pull.ts` must NOT change unless the
count is genuinely wrong in production (one portal today, so it is not). If the fix needs a production change, stop and say so.

**Out:** any change to breaker thresholds or audience rules.

## Acceptance tests
1. Five consecutive full-suite runs under `nice` with `maxWorkers: 2` pass with no audience failure and no "failed to exit gracefully" line
   (report all five verbatim result lines).
2. The two named tests still fail when their asserted behaviour is broken (one mutation each).
3. Full-suite time does not grow by more than ~20 %.

## Constraints
- Flag: none (tests only). Migrations: none. Full suite: yes (that is the test).
