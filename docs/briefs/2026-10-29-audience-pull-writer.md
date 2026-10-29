# Brief: CMS audience importer, tasks 5–6 (pull + Mailercloud writer)

- **Date / name:** 2026-10-29-audience-pull-writer → branch `build/audience-pull-writer`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first)

## Goal
Finish design tasks 5 and 6 of `docs/CMS_AUDIENCE_SYNC_DESIGN.md` §11, starting from the half-built work in the
stash. When this is done we can:
- pull the CMS's Feed 1 (signed GET, incremental and full) into Postgres, including the acceptance and absence
  rules and the breaker;
- turn our members' desired tags into Mailercloud contact writes (desired-state diff, pacing, send-window pause,
  drift check).

Both stay behind flags that default off.

## Why (owner's words)
> 2026-10-29: "Resume the CMS importer (tasks 5–10), starting by restoring the half-built tasks 5–6 from the
> stash." The CMS allowlist test is ~30–31 Oct. Premium digests can't go out until the importer is done
> (owner 24 Oct: Premium ONLY from CMS active subscriptions).

## Start from the stash (do NOT pop, apply or drop it)
`stash@{0}` = "WIP audience sync tasks 5–6 (paused by owner 2026-10-24)". Its base `stash@{0}^1` is `68d57e4`.
In your worktree, after setup:

```sh
git diff stash@{0}^1 stash@{0} | git apply --index   # 8 tracked files (schema, env, routes, audience/*, digest/alerts, suppression)
git checkout stash@{0}^3 -- .                        # 10 untracked files: migration 20261024170000_audience_pull,
                                                     # audience/{alerts,breaker,cmsClient,mcContacts,pull,writer}.ts,
                                                     # __tests__/{audienceFakeCms,audienceFakeMailercloud,audiencePull.test}.ts
npx prisma generate && npx prisma migrate dev
```

If either command doesn't apply cleanly, stop and REPORT. Before writing any new code, list in your REPORT
which §11 items of tasks 5 and 6 the stash already covers, which it covers partly, and which it's missing.

## Scope
**In:**
- **Task 5** (§5.2, §5.3, §5.4, §8.2): `cmsClient` signed GET pull, incremental (hourly :10 IST) and full (nightly
  04:30 IST); full-load acceptance (all pages 200, no `next_cursor` on the last page, every row parsed, ≥ 90% of
  `lastFullRowCount`; the first load goes to review); the absence rule (`outOfScopeAt`, only on a COMPLETE load);
  the change-cap breaker; audience alerts once per kind per IST day.
- **Task 6** (§6.1–§6.4): `mcContacts` client + `writer`: the desired-state diff (≤ 200 members/tick), storing
  `appliedTags` only from a 2xx; RETRYABLE/FATAL classification reusing the digest client's; +1/+5/+15 min then
  hourly; `audience_writer_fatal` / `audience_writer_failing`; pacing (`AUDIENCE_WRITE_RPS`); the send-window
  pause; the nightly drift check (count + 50-member sample read-back).
- **Wiring:** the crons are registered at boot, and each one does nothing unless `AUDIENCE_SYNC_ENABLED` is on.
  The writer makes Mailercloud requests only with `AUDIENCE_SYNC_WRITE_MAILERCLOUD` on; when it's off it runs
  dry and logs counts only (`would_add= would_remove=`).
- Tests use the **contract v1.3** fixtures that already exist (`src/__tests__/fixtures/cms-feed-v1.3/`, incl. the
  `account.deleted_900003_seq3` erasure fixture); switch any stashed test still on v1.2.
- Add "Built" notes for tasks 5 and 6 to `docs/CMS_AUDIENCE_SYNC_DESIGN.md` §11, in the same style as tasks 1–4.

**Out (do not build):**
- Task 7 and later: digest wiring / `audienceGuard`, the Audience card + Resume route, backup v3, retention, the
  runbook and the Guide.
- Any Mailercloud **DELETE** of any kind (owner 24 Oct: the CMS erases in Mailercloud; we never delete there).
- Any change to the CMS contract. Any real network call in a test.

## Acceptance tests (each must PASS in the REPORT)
1. Fake CMS: a COMPLETE full load applies every row and sets `lastFullRowCount`; a load with a 500 mid-way, a
   final page that still has `next_cursor`, a row that won't parse, or < 90% of the previous count each
   applies its rows, sets **no** `outOfScopeAt`, and raises `audience_full_incomplete`.
2. Absence: a complete load missing account X marks X `outOfScopeAt` → `memberRole` NONE. A later snapshot that
   names X clears it. Absences count toward the change cap.
3. Breaker: a change above `AUDIENCE_MAX_CHANGE_PCT` (6% vs a 5% cap, say) opens it and pauses writes. A 4% change is written.
4. Incremental pull uses `updated_since = lastIncrAsOf − 10 min` and stores `meta.as_of` from the first page;
   overlapping rows are harmless thanks to the seq rules (events strict `>`, list rows `≥`).
5. Pull client: https only; host must be in `CMS_FEED_ALLOWED_HOSTS`; `redirect: 'error'`; 30 s timeout; 429/5xx
   retried ×3 with jitter. Signed per **contract v1.1+** (`X-Push-Timestamp`, `X-Push-Signature`, signed `nonce`
   query parameter, canonical query) and pinned to `docs/cms-signature-vectors.md`. This overrides §5.2's
   older `X-CMS-Event-Id` text.
6. Fake Mailercloud, both behaviours (§10.3): the writer converges to the desired tags; a repeated tick sends
   nothing; a flapping member collapses to one write; `appliedTags` is unchanged after a non-2xx.
7. **No request body ever contains `contact_type`.** This is asserted across every writer test. The one exception
   is the lift path, and only with `AUDIENCE_RESUBSCRIBE_WRITES` on. **No DELETE request is ever made.** This is
   asserted too.
8. A suppressed member (by address hash or account id) is never added; its removal and No-marketing tag are still written.
9. A FATAL error stops only that member and raises `audience_writer_fatal` once; a RETRYABLE error follows
   +1/+5/+15 then hourly.
10. With `AUDIENCE_SYNC_WRITE_MAILERCLOUD` off: zero Mailercloud requests, and the dry-run count line is logged. With
    `AUDIENCE_SYNC_ENABLED` off: the crons do nothing and boot still prints `[audience] disabled …`.
11. Drift check: a count mismatch, or a sampled member whose tags differ, marks those members for re-sync.
12. EXPLAIN of the writer's selection query and the pull's upsert path on **85k fixture rows**: index scans, no
    sequential scan of `AudienceMember`. Paste the plans in the REPORT.
13. tsc clean, lint clean, full suite green. The last recorded figure was 1,392/1,392 at `68d57e4`, so state the new total.

## Files
- From the stash: `prisma/schema.prisma` and `prisma/migrations/20261024170000_audience_pull/`, `src/lib/env.ts`,
  `src/routes/cmsEvents.ts`, `src/services/audience/{boot,ingest,rules,alerts,breaker,cmsClient,mcContacts,pull,writer}.ts`,
  `src/services/digest/alerts.ts`, `src/services/suppression.ts`, `src/__tests__/audience{FakeCms,FakeMailercloud,Pull}.test/ts`.
- New tests as needed (e.g. `src/__tests__/audienceWriter.test.ts`).
- `docs/CMS_AUDIENCE_SYNC_DESIGN.md`: §11 Built notes only.

## Constraints
- The migration stays **additive** and keeps the name `20261024170000_audience_pull`. The owner's local dev DB
  already recorded that name, so don't rename it. If its SQL must change, say so in the REPORT.
- All flags default off. The secrets and Mailercloud key read from env are never logged (add them to
  `logSecrets()` if new).
- Error logs go through `safeErrorLog` (`src/lib/httpErrors.ts`). A source-scan test fails on a bare `err`.
- Never write an email address to a log, an alert or an audit row: counts and hashes only.
- Prisma's interactive transaction timeout is 5 s. Keep batches small enough.

## Context the builder needs
- The design doc is the spec: §5 Ingest, §6 Mailercloud write model, §8.2 threat model, §10.1 flags, §10.3 test
  table (the "Gate | Blocks | Allows" rows are your test checklist), §11 Built notes for tasks 1–4 (decisions
  that already supersede older section text).
- The tasks 3–4 functions to reuse: `memberRole` (rules.ts), `applyAccountSnapshot` / `recomputeMembers`
  (ingest.ts), the strict parsers in `snapshot.ts`, `cmsSignature.ts`, and the single suppression matcher in
  `suppression.ts`.
- The Mailercloud API notes and the unverified behaviours (M-1…M-8) are in §6.4. Both fakes must model the
  uncertain cases both ways. Don't assume either answer.
