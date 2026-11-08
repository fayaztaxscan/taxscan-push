# REPORT: free-cms-readers

- **Code commit:** `0a5f651` on `build/free-cms-readers` (base `origin/develop` effeb72)
- **Built by:** build session taxscan-push-57; UI part by the `ui-developer` agent

## Files changed
- `src/lib/env.ts`: `AUDIENCE_FREE_READERS`, `AUDIENCE_FREE_ADMIT_PER_DAY`, `AUDIENCE_MC_TAG_FREE`, `AUDIENCE_PULL_PAGE_PAUSE_MS`; new `nonNegIntFrom` so `0` is a real value (the existing `intFrom` treats 0 as unset).
- `src/services/audience/rules.ts`: `FREE` in `MemberRole`; `RuleOptions.freeReaders` (absent = off); header comment.
- `src/services/audience/ingest.ts`: `recomputeMembers` passes the flag to `memberRole`; new `countsAsRoleChange()` (FREE counts as NONE for the change cap).
- `src/services/audience/pull.ts`: equal-seq exception for a row that would make a new FREE member; `mailedBefore` leaves FREE out; page pause (injectable `PullDeps.pause`).
- `src/services/audience/writer.ts`: Free-reader tag; queue order; admission step (`admitFree`, `freeAdmittedToday`); a suppressed FREE member no longer wants the Free tag; the drift sample leaves waiting members out; `TagIds` type with `free` optional.
- `src/services/audience/boot.ts`: `freeConfigProblems()` + a warning line; the boot line names the free-readers state and the page pause.
- `src/services/audience/adminView.ts`: `free` block on the ADMIN card payload (only when the flag is on).
- `admin/src/components/AudienceCard.vue`: the Free readers line; Retry refused now also shows for FREE refusals (see Deviations).
- `prisma/schema.prisma` + migration: `AudienceMember.admittedAt`.
- `src/__tests__/audienceFreeReaders.test.ts`: new, 18 tests (acceptance 1–13 plus extras).
- `src/__tests__/audiencePull.test.ts`, `audiencePullAcceptance.test.ts`: the cfg sets `AUDIENCE_PULL_PAGE_PAUSE_MS: '0'` (the 2 s default made them 70 s instead of 26 s; the pause has its own tests).
- Docs: `docs/CMS_AUDIENCE_SYNC_DESIGN.md` (8 Nov ruling at the top, §4 rule + member row, §5.2 page pause, §10.1 settings, new §6.4a admission); `docs/DIGEST_PILOT_RUNBOOK.md` (new "Free to CMS free readers, in daily batches" section, with roll back); `docs/EMAIL_DIGEST_DESIGN.md` §5 (four rows); `docs/Taxscan-Push-Admin-Guide.html` (one paragraph, v2.27 → **v2.28**, header + footer).

## Migrations
- `20261108043339_audience_free_admitted_at`: `ALTER TABLE "AudienceMember" ADD COLUMN "admittedAt" TIMESTAMP(3)` + `CREATE INDEX "AudienceMember_admittedAt_idx"`. Additive.

## Flags / env
| Name | Default |
|---|---|
| `AUDIENCE_FREE_READERS` | off |
| `AUDIENCE_FREE_ADMIT_PER_DAY` | `0` |
| `AUDIENCE_MC_TAG_FREE` | unset |
| `AUDIENCE_PULL_PAGE_PAUSE_MS` | `2000` (**behaviour change on deploy**: both pulls pause 2 s between CMS pages, as the brief asks) |

## Test results (verbatim)
- tsc: `npx tsc -p tsconfig.json --noEmit`: no output (pass)
- lint: `npm run lint`: no output (pass)
- admin build: `✓ built in 2.43s`
- New tests: `audienceFreeReaders.test.ts`: `Tests: 18 passed, 18 total`
- Area tests (every `src/__tests__/audience*`, before the new file): `Tests: 249 passed, 249 total`; pull files after the pause change: `Tests: 41 passed, 41 total`
- **Full suite** (ran because the brief says `Full suite: yes`: schema/migration + config/env): `Tests: 2470 passed, 2470 total` (106 suites, 120 s). The known flaky test did not fail.

## Acceptance tests
1. Flag off: today's rule, `free` = NONE: **PASS** (and every existing rules/ingest test passes unchanged)
2. Flag on: null/true → FREE; false → NONE + noMarketing; free+ended → FORMER; free+active → PREMIUM; deleted / out of scope → NONE: **PASS**
3. Full load at equal seq creates FREE rows with the address, no Mailercloud call: **PASS** (the pull has no Mailercloud client; a repeat load skips them again as unchanged)
4. Cap 3, 5 waiting: day 1 admits 3, the two Mailercloud already holds first (they sort LAST by hash, so hash order alone would not pick them); day 2 admits 2: **PASS**
5. Cap 0: no admission, no request about any FREE address; PREMIUM and FORMER written: **PASS**
6. Waiting FREE → PREMIUM (through the real ingest) written at once, no cap, never the Free tag: **PASS**
7. FREE → NONE / unsubscribed / deleted: Free tag removed at once, cap 0: **PASS**
8. Flag on with 1,000 new FREE members: no breaker, roleChanges 0; 101 then turn Premium → `change_too_large`: **PASS**
9. 1,000 waiting FREE members leave the guard's `pendingPremium` unchanged: **PASS**
10. `audienceTarget` Free with two segment ids targets both; refuses an id shared with Premium: **PASS** (no code change)
11. Flag on + tag unset: boot warning names `AUDIENCE_MC_TAG_FREE`; FREE skipped, Premium written: **PASS**
12. Card: FREE block with the flag on (counts only, no `@`), absent off; PUBLISHER unchanged: **PASS** (API test). The SPA line was checked in a real browser (headless Playwright Chromium against the local API and the build DB) at 1280 px and 375 px: normal, cap 0 + tag unset, and flag off. The admin has no SPA test setup, so there is no component test.
13. 3-page full pull waits twice for 2000 ms; 1 page never; `0` never; the incremental pull waits too: **PASS**

## Agents run
- `ui-developer`: the Audience card line, the guide paragraph and version, and the browser check at desktop and 375 px. It found and fixed a run-together sentence ("…added.The Free tag…") before reporting.

## Decisions and deviations
- **Admission order:** waiting members get a GET first (lookup only, no write, which records `mcState`). Those Mailercloud holds are admitted first, in `emailHash` order. The absent ones go only once no waiting member is still unlooked-up, also in `emailHash` order. Lookups and admissions share the tick's budget (200), so day 1 spends its first ticks on lookups: ~74k GETs at the 5 rps pace is about 6 h of ticks before absent readers start. These are GETs only, and nothing happens while the cap is 0. A FATAL GET marks the member ABSENT, so one bad address can't block the rest; a RETRYABLE one stops lookups for that tick.
- **Change-cap counting:** FREE counts as NONE, so NONE ⇄ FREE never counts. FREE ⇄ PREMIUM/FORMER still counts. My first version excluded every FREE move, and test 8 caught that a mass FREE → PREMIUM went uncounted. A Premium member that becomes FREE is still a Premium removal (`premium_removals`). I read the brief's "never trip premium_removals" as being about new FREE members, not lapsing Premium.
- **Unsubscribed FREE loses the Free tag** (test 7). This differs from FORMER, which today keeps its tag when suppressed. It is done in `desiredTags` for FREE only; FORMER is unchanged.
- **Already-tagged FREE members skip admission:** e.g. FORMER → FREE swaps tags at once, without the cap, and `admittedAt` stays null. The card counts them under "tagged", not "admitted".
- **Tag unset with the flag on** is a boot warning (`[audience] config problem: …`), not a `problems` entry. A `problems` entry would stop the whole sync (`config_invalid`), but the brief asks only that FREE writes be skipped.
- **Retry refused** (`retryRefused`) already retries FREE (counted as `other` in its result and audit row; shape unchanged). On the card, the button showed only for Premium/Former refusals, so I added `free.refused` to that block (one more "N Free readers were refused" line and the button). This is a small UI change beyond the agent's brief, made to keep "Retry refused … include FREE" true on screen. **Not re-checked in a browser after this change:** it follows the existing Premium/Former line exactly, and the admin build passes.

## Worth remembering
- Turning `AUDIENCE_FREE_READERS` **off** later does not demote FREE members by itself. A member is recomputed only when a CMS change to its account arrives (an equal-seq unchanged row is skipped). Roll back with cap 0 and by taking the Free-reader segment out of `DIGEST_FREE_SEGMENT_IDS` (written in the runbook).
- The first full load after the switch applies ~74k rows through transactions instead of skipping them. Expect that 04:30 run to take noticeably longer than usual, plus 2 s per page.
- `intFrom` in env.ts treats `0` as unset. Use `nonNegIntFrom` for any setting where 0 means "none".
- The build DB holds an inactive throwaway admin `ui-check@localhost.test` from the browser check (AuditLog is append-only). It goes when the DB is dropped.

## Clean-up
```sh
git worktree remove ../taxscan-push-worktrees/free-cms-readers
dropdb taxscan_push_build_free-cms-readers; dropdb taxscan_push_build_free-cms-readers_shadow
git branch -D build/free-cms-readers; git push origin --delete build/free-cms-readers
```
