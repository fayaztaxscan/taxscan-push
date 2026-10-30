# REPORT: 2026-10-30-digest-subject-edit

- **Branch:** `build/digest-subject-edit`. **Code commit:** `581579c`. Report commit follows.
- **Base — deviation:** the brief says to build after `digest-old-format` is merged into `develop`. It was not merged yet and you asked for this build, so the branch is **stacked on `origin/build/digest-old-format` (`7c52abd`)**, not on `develop`. Merge old-format first, then this one (the diff here is only the subject edit). Both migrations are additive.
- **Migration:** `20261030140000_digest_subject_edited_audit` — `AuditAction.DIGEST_SUBJECT_EDITED` only. No flags.

## What was built
- `DigestSender.updateSubject(campaignId, subject)`; Mailercloud client: `PUT /v1/campaign/{id}` with body `{ subject }` only, one attempt, same error classes (RETRYABLE / FATAL / AMBIGUOUS), subject and key never in an error. Mock sender and the test FakeSender implement it.
- `src/services/digest/subjectEdit.ts`: `subjectLock` (the one lock rule, also feeding the screen), `checkSubject`, `editSubject`.
- `POST /api/digest/runs/:id/subject/:audience` (cookie ADMIN or PUBLISHER; bearer refused).
- Screen payload: `variants[].subjectEdit = { editable, reason }`. Digests.vue: Edit subject → inline 16 px input, counter, warning above 90, Save/Cancel, lock reason line. Activity list: the new action is in the filter and has a plain sentence.
- Admin guide v2.9 (one paragraph on Digests).

## Decisions / things to know
- **Extra `from` field (not in the brief):** the screen sends the subject the editor saw. If it is no longer current the server answers 409 `changed`. This is what makes "two editors at once" deterministic; without it a second request that simply arrives later would overwrite quietly. `from` is optional for API callers.
- **PENDING version:** the update is conditional on `createAttemptedAt` being null, so a create already in flight cannot build the draft from the old subject; if it is in flight the answer is 409 `changed` (shown as "someone else just changed it — reload").
- **Held run:** still editable (only approval locks), as the brief's "not approved" reads.
- **AMBIGUOUS provider failure** (timeout after send) also reverts the row and says Mailercloud may or may not have applied it — check the draft.
- **Audit** carries audience, old and new **lengths** and whether the draft was updated — no text. No existing digest audit row carries headlines, so that was the precedent.
- `<title>` of the frozen HTML keeps the automatic subject (documented in the code comment).
- **Unverified:** whether Mailercloud accepts a PUT on a **draft**. Proven only against the fake and a mocked fetch; planning verifies on a real staff draft after deploy.

## Acceptance
1. PENDING stores subject; createDraft receives it — **PASS**
2. CREATED: row + exactly one `updateSubject(id, subject)`; screen payload shows it — **PASS**
3. Provider failure RETRYABLE and FATAL: reverted, 502 plain reason, no audit — **PASS**
4. Locked: approved, schedule attempted, SENT, past cut-off, not today, not BUILT → 409 with codes — **PASS**
5. Validation: empty, 151, newline, tab → 400; `{{x}}` defused; same subject 200 no-op with no provider call or audit — **PASS**
6. Concurrency: one 200, one 409 `changed`, one provider call; stale `from` 409 — **PASS**
7. Roles: ADMIN and PUBLISHER 200; bearer 401/403; signed out 401 — **PASS**
8. Audit row on success only — **PASS**
9. UI in a real browser — **PASS at phone width only.** Seeded a sample run (cut-off moved to 23:30 for the check, since it was past 17:00 IST). Verified: Edit subject opens a pre-filled input, counter "95 / 150", the >90 warning, Save updates the inbox preview line, after Approve it reads "Locked — approved", after Hold it is editable again. The browser window would not go wider than 614 px here, so the desktop width was **not** seen; the new block is a plain stacked form with no width-dependent rules. Screenshots: `/var/folders/6p/7cdddtbx7690lgfqzd2ykhrr0000gn/T/claude-chrome-screenshots-ur1AGN/screenshot-1793360683485-7.jpg`, `…screenshot-1793360698451-8.jpg`, `…screenshot-1793360715661-9.jpg`.
10. tsc, lint, vue-tsc, admin build clean. Full suite 83 suites, 1,706 tests. Two full runs each had a few failures that passed when re-run alone and were different each time (createSession, two audience change-cap tests, metrics warmer, EmailEvent fold) — load-dependent. One was real and fixed: the Activity filter test needs every new AuditAction listed. Final run: 1,705 of 1,706, the one failure passing alone.

## Agents run
None.

## Clean-up (planning)
`git worktree remove ../taxscan-push-worktrees/digest-subject-edit`; `dropdb taxscan_push_build_digest_subject_edit`; `dropdb taxscan_push_build_digest_subject_edit_shadow`; `git branch -D build/digest-subject-edit`; `git push origin --delete build/digest-subject-edit`. Same four for `digest-old-format` when it is merged.
