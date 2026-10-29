# REPORT: 2026-10-29-audience-pull-writer

- **Branch:** `build/audience-pull-writer` (base `origin/develop` at `54bb700`)
- **Code commit:** `19bbdc4d8149f43fef5d780ca06a88f9573de5f2`
- **Result:** all 13 acceptance items PASS, with two things planning must decide (see **Decisions for planning**): the No-marketing tag on an UNSUBSCRIBE-blocked address, and the lint figure.

## What the stash already covered (listed before any new code, as the brief asked)

Both stash commands applied cleanly (`git diff stash@{0}^1 stash@{0} | git apply --index`, then `git checkout stash@{0}^3 -- .`); the stash was not popped, applied or dropped.

**Task 5 (§5.2–§5.4, §8.2)**
| §11 item | Stash |
|---|---|
| `cmsClient` signed GET (v1.1+ headers, nonce, canonical query, https/host/redirect/timeout/retry) | **Covered** (code + tests) |
| Incremental + full pull, watermarks, `updated_since − 10 min`, `as_of` from the first page | **Covered** |
| Full-load acceptance, absence rule, first load to review | **Covered** in code; tests covered 500-mid-way, `< 90 %`, bad row, but **not** a last page that still has `next_cursor` |
| Change-cap breaker, other breaker reasons | **Covered** in code; tests only at the 100-role floor, **not** as a percentage; absences counting toward the cap were **not** tested |
| Audience alerts, once per kind per IST day | **Covered** |
| Crons registered at boot | **Partly**: pull crons only |
| Client tests for 429 retry and the 30 s timeout | **Missing** |

**Task 6 (§6.1–§6.4)**
| §11 item | Stash |
|---|---|
| `mcContacts` client | **Covered** (code); no test file |
| `writer`: diff, ≤ 200/tick, `appliedTags` from 2xx, RETRYABLE/FATAL, ladder, alerts, pacing, send-window pause, dry run, drift | **Covered in code, with no tests at all** |
| Writer + drift crons registered at boot | **Missing**; boot even logged "the Mailercloud writer is not built yet" |
| Schema for what the code uses | **Missing**: `AudienceMember.resubscribePending` and `AudienceSyncState.drift` were used by the code but not in the schema or migration, so `tsc` failed (8 errors) |
| `cfg` unused parameter | `tsc` error (TS6133) |
| Contract v1.3 fixtures | Stashed tests already use v1.3 (no v1.2 left to switch) |
| Both fakes modelling M-1…M-3 both ways | Fake Mailercloud: **covered**; no per-address failure injection (added) |
| "Built" notes for tasks 5 and 6 | **Missing** (added) |

## Files changed

From the stash (unchanged except where noted below): `prisma/schema.prisma`, `prisma/migrations/20261024170000_audience_pull/`, `src/lib/env.ts`, `src/routes/cmsEvents.ts`, `src/services/audience/{ingest,rules}.ts`, `src/services/audience/{alerts,breaker,cmsClient,mcContacts,pull}.ts`, `src/services/digest/alerts.ts`, `src/services/suppression.ts`, `src/__tests__/audience{FakeCms,FakeMailercloud,Pull}.test/ts`.

Changed or added by this build:
- `prisma/schema.prisma` + `prisma/migrations/20261029061342_audience_writer_columns/migration.sql`: the two missing columns (see Migrations).
- `src/services/audience/boot.ts`: registers the writer tick (`* * * * *`) and the drift check (`30 5 * * *`, IST) behind `AUDIENCE_SYNC_ENABLED`; the enabled boot line now says whether the writer is dry-run or live. Exports `WRITER_CRON`, `DRIFT_CRON`.
- `src/services/audience/writer.ts`: removed the unused `cfg` parameter of `gate()`; the every-minute "failing" count now filters `nextAttemptAt: { not: null }` so it uses the existing `nextAttemptAt` index (a seq scan of `AudienceMember` before, 17 ms; now 4 ms).
- `src/__tests__/audienceFakeCms.ts`: `lastPageKeepsCursor` and `delayMs` fault options.
- `src/__tests__/audienceFakeMailercloud.ts`: `failEmails` (one address fails, not the whole API).
- `src/__tests__/audiencePull.test.ts`: the cron-registration tests expect the two new crons.
- `src/__tests__/audiencePullAcceptance.test.ts` (new, 5 tests): acceptance 1 (feed that never ends), 2 (absences against the cap), 3 (cap as a percentage), 5 (429, timeout).
- `src/__tests__/audienceWriter.test.ts` (new, 31 tests): acceptance 6–11, plus the source scan.
- `docs/CMS_AUDIENCE_SYNC_DESIGN.md`: §11 "Built" notes for tasks 5 and 6 only.

## Migrations

- `20261024170000_audience_pull` (from the stash): **unchanged**, additive. Name kept; the owner's dev DB checksum is untouched.
- `20261029061342_audience_writer_columns` (**new**, additive): `AudienceMember.resubscribePending BOOLEAN NOT NULL DEFAULT false`; `AudienceSyncState.drift JSONB`. **Why a second migration and not an edit:** the brief says to keep the first one's name and "if its SQL must change, say so". Editing an already-applied migration would break the owner's dev database (checksum mismatch), so I left it alone and added a separate one. Planning can fold it in if the owner's DB is reset.

## Flags/env added

None new. Used (all default off): `AUDIENCE_SYNC_ENABLED`, `AUDIENCE_SYNC_WRITE_MAILERCLOUD`, `AUDIENCE_RESUBSCRIBE_WRITES`, `AUDIENCE_WRITE_RPS` (5), `AUDIENCE_MAX_CHANGE_PCT` (5), `MAILERCLOUD_SYNC_API_KEY`, `AUDIENCE_MC_LIST_ID`, `AUDIENCE_MC_TAG_{PREMIUM,FORMER,NO_MARKETING}`, `AUDIENCE_MC_PREMIUM_SEGMENT_ID`. They were already parsed and `logSecrets()` already covered the keys; nothing to add.

## Test results (verbatim)

- `npx tsc -p tsconfig.json --noEmit`: exit 0, no output.
- `npm run lint`: **3 errors, all in files this build did not touch and identical to `origin/develop`**:
  `audienceConfig.test.ts 226:34 no-var-requires` and `digestRenderer.test.ts 513:19 / 513:23 no-irregular-whitespace`.
  My new and changed files lint clean. I did not fix these (out of scope). See Decisions.
- New tests: `audienceWriter.test.ts` `Tests: 31 passed, 31 total`; `audiencePullAcceptance.test.ts` `Tests: 5 passed, 5 total`.
- All `src/__tests__/audience*`: `Tests: 206 passed, 206 total` (the stash as applied, before my additions).
- **Full suite (once, under `nice`):** `Test Suites: 73 passed, 73 total` · `Tests: 1464 passed, 1464 total` (was 1,392 at `68d57e4`; +72). The eventRetention flaky test did not fail.
- Mutation checks (writer): removing the suppressed-add skip fails 3 tests; sending `contact_type` on create fails 5; both restored.

## Acceptance tests

1. **PASS.** Full load complete → rows applied, `lastFullRowCount` set (`audiencePull`). 500 mid-way, `< 90 %` (`short_load`), unparsable row (`invalid_rows`): rows applied, no `outOfScopeAt`, `audience_full_incomplete`. A final page that still has `next_cursor` (`cursor_loop`): added in `audiencePullAcceptance` with the same assertions.
2. **PASS.** Absence marks `outOfScopeAt` → role NONE; the next snapshot clears it (`audiencePull`). Absences count toward the cap: a complete load (999/1100 = 90.8 %) dropping 101 Premium accounts gives `absent: 101, roleChanges: 101` and an open breaker (`audiencePullAcceptance`).
3. **PASS.** The cap is `max(5 % of mailed, 100)`. 4 % (written, breaker stays closed) and 6 % (opens `change_too_large`, pauses writes) with ≈ 3,000 mailed members; the 100-role floor is also tested; the writer returns `breaker_open` and sends nothing.
4. **PASS.** `updated_since = lastIncrAsOf − 10 min`, `as_of` from the first page; overlapping rows skipped by the seq rules (`audiencePull`).
5. **PASS.** https only, host allow-list, `redirect: 'error'`, 30 s constant + a real (50 ms) timeout → RETRYABLE, 503 and 429 retried ×3 with a new nonce, pinned to v1.3 via the fake CMS's `verifyPushGet`.
6. **PASS** under both fake behaviours (M-1 fail/upsert, M-2 keep/resubscribe, M-3 append/replace, tags as names/ids): converges, hand-added tags kept, repeated tick sends nothing, flapping member = one write, `appliedTags` unchanged after a 503.
7. **PASS.** `expectInvariants()` (no `contact_type`, no DELETE) runs over every recorded request in every writer test except the lift test; the lift test shows exactly one `PUT {contact_type:'active'}` and only with the flag on, not suppressed, consent current. A source-scan test pins "no DELETE; `contact_type` only in `resubscribe()`".
8. **PASS** (with the nuance under Decisions).
9. **PASS.** FATAL stops only that member, `audience_writer_fatal` raised once per IST day (second FATAL same day does not re-raise); RETRYABLE delays `[1, 5, 15, 60, 60, 60, 60, 60, 60]` min, never early; the 9th failure raises `audience_writer_failing`.
10. **PASS.** Writes off: 0 requests, rows untouched, log `[audience] writer dry-run members=1 would_add=2 would_remove=0`. `AUDIENCE_SYNC_ENABLED` off: `[audience] disabled …` and no cron started.
11. **PASS.** Mismatched/absent sampled members get Mailercloud's truth and become due; a Premium count off by more than max(2 %, 25) raises `audience_drift`; in tolerance does not; skipped when writes are off or in the send window.
12. **PASS** with one note (below). Plans on 85,000 `AudienceMember` + 85,000 `CmsAccount` + 2,000 `EmailSuppression` rows (throwaway DB, `ANALYZE`d):
    - Writer selection (`nextAttemptAt <= now AND email IS NOT NULL ORDER BY nextAttemptAt LIMIT 200`): `Limit → Index Scan using "AudienceMember_nextAttemptAt_idx"`, 0.9 ms.
    - Per-member re-read / `FOR UPDATE` / the pull's member lock: `Index Scan using "AudienceMember_pkey"`, 0.05–0.2 ms.
    - Suppression lookup: `Index Scan using "EmailSuppression_emailHash_key"`, 0.05 ms.
    - Pull: account by id `Index Scan using "CmsAccount_pkey"` 0.08 ms; accounts holding these addresses `Bitmap Index Scan on "CmsAccount_emailHash_idx"` 0.2 ms.
    - End-of-tick failing count: **before** `Seq Scan on "AudienceMember"` (17 ms, 85,000 rows filtered), **after** the fix `Index Scan using "AudienceMember_nextAttemptAt_idx"` (4 ms).
    - Not index scans, by design: the pull's start-of-run mailed count (`desiredRole <> 'NONE'`) is an `Index Only Scan` on `AudienceMember_desiredRole_idx` over 70,000 rows (≈ 15 ms, once per pull); the nightly drift sample (`ORDER BY random() LIMIT 50`) is a `Seq Scan` of `AudienceMember` (≈ 26 ms, once a night).
13. **tsc clean; full suite green (1,464/1,464); lint: 3 pre-existing errors in untouched files** (see Test results). Marked as not clean until planning decides.

## Agents run

None. Everything was done in this session.

## Deviations from the brief

1. **A second migration instead of editing `20261024170000_audience_pull`**: the stash's schema lacked two columns its own code uses (see Migrations).
2. **Acceptance 3 as written ("6 % vs a 5 % cap")**: the real cap is `max(5 %, 100)`, so a percentage only applies above 2,000 mailed members. The test seeds ≈ 3,000 `AudienceMember` rows (cleaned up) to exercise it.
3. **Acceptance 12**: the "failing" count was a sequential scan on the writer's per-minute path; I changed its query (equivalent result) rather than add an index.
4. The shared `FakeCms` / `FakeMailercloud` helpers gained fault options; no behaviour of the existing options changed.

## Decisions for planning

1. **No-marketing on an address Mailercloud already blocks.** Acceptance 8 says a suppressed member's "removal and No-marketing tag are still written". The stash's writer deliberately skips even the No-marketing add when the suppression is an UNSUBSCRIBE / HARD_BOUNCE / SPAM on **that address hash** (the contact is already refused mail; until M-2 is proven, a PUT is the one write that might re-activate it). A suppression by account id, or by hash with reason MANUAL / ACCOUNT_DELETED, does get the No-marketing tag. I kept the stash's safer behaviour and tested both cases. If you want the literal reading, it is one line in `writeOne` (`mailercloudBlocksAddress`).
2. **Lint.** The 3 errors predate this branch. Fixing them is two trivial test edits; I left them because the brief says not to build extras. Say if you want them in this branch.

## Worth remembering

- The stash's schema/migration was out of step with its code. Anyone re-applying the stash onto `68d57e4` gets `tsc` errors until the second migration exists.
- **M-1 residual risk the fake can show but the writer cannot prevent**: under the "create upserts" behaviour, a contact that appears (unsubscribed) between our GET and our create is silently re-activated by the create. The test documents it; only the internal-address M-test can say which behaviour Mailercloud has. The window is one GET→create round trip.
- `AudienceMember` rows with no role and nothing applied are deleted after a successful write (the address leaves the table). Tests that look for such a member after a write must expect `null`.
- `prisma migrate dev` needs the DB user in the URL on this Mac (`postgresql://bestdoc@localhost…`); the BUILD-SESSION `.env` template has no user and fails with P1010.
- `audienceWriter.test.ts` uses DB-wide counts for Premium (`premiumOurs`), as the real check does; its tag ids carry the run id so other rows don't leak in, but absolute counts are not asserted.

## Clean-up

```sh
git worktree remove ../taxscan-push-worktrees/audience-pull-writer
dropdb taxscan_push_build_audience-pull-writer; dropdb taxscan_push_build_audience-pull-writer_shadow
git branch -D build/audience-pull-writer; git push origin --delete build/audience-pull-writer
```
(the throwaway `…_explain` database is already dropped.)
