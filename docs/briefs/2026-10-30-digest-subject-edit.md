# Brief: editors can change a digest version's subject line before approval

- **Date / name:** 2026-10-30-digest-subject-edit  →  branch `build/digest-subject-edit`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first)
- **Order:** build AFTER `2026-10-30-digest-old-format` is merged to `develop` (both touch the digest screen/renderer
  area) — base on the `develop` that contains it.

## Goal
On Digests, each version (Free / Premium) of today's run has an **Edit subject** box. Between the 06:30 build and
the run's approval, an ADMIN or PUBLISHER can replace the automatic subject (the lead headline). Saving updates the
Mailercloud draft and our record together, and is audited.

## Why (owner, 30 Oct)
> Abdullah: "we should be able to update the heading of the newsletter manually if required" — owner confirmed the
> heading = the email subject line ("go").

Today `renderer.ts:547` sets `subject = trimWords(main[0].title, SUBJECT_MAX)` at the 06:30 build; it is frozen on
`DigestSend.subject` and sent in `createDraft`. Nothing can change it. The old hand-made newsletter's subject was a
headline an editor chose.

## Mailercloud (public docs, read 30 Oct)
`PUT https://cloudapi.mailercloud.com/v1/campaign/{id}` — body fields incl. `subject` (1–150 chars),
`email_preheader`, `html`, `name`, … Not stated whether a **draft** can be updated (only that a *sending* campaign's
lists/rules can't). The build has no live key: implement against the documented shape, prove it with the fake
sender, and the planning session verifies on a real staff draft after deploy. Send only `{ subject }` in the body —
never lists, sender, schedule or html.

## Scope
**In:**
- `DigestSender` gains `updateSubject(campaignId, subject): Promise<void>`; Mailercloud client implements the PUT
  (same error classification as the other calls: RETRYABLE / FATAL, never logs the subject or key); mock sender
  implements it and records calls.
- `POST /api/digest/runs/:id/subject/:audience` with `{ subject }` — `requireUser(['ADMIN','PUBLISHER'])` (cookie
  session; not the bearer). Rules, checked in this order:
  1. run is today's IST run, build BUILT, run **not approved** (approval is per run — once approved, subjects are
     locked; a Hold clears approval as today), not past the 17:00 cut-off;
  2. the version is `PENDING` or `CREATED` with `scheduleAttemptedAt` null (never after a schedule attempt);
  3. subject: trimmed, 1–150 chars, no newline/control chars, merge-tag-defused exactly like the automatic subject
     (`defuseMergeTags`); identical to the current subject → 200 no-op, no audit.
  - Version still `PENDING` (no draft yet): update `DigestSend.subject` only; `createDraft` then uses it.
  - Version `CREATED` (draft exists): conditional DB update first (`where state CREATED, scheduleAttemptedAt null,
    subject = <old>`) storing the new subject, then `updateSubject`; on provider failure revert the row to the
    old subject (same conditional) and answer 502 with the provider's plain reason. Two editors at once: the
    conditional update makes the second one 409 `changed` ("someone else just changed it — reload").
  - Audit `DIGEST_SUBJECT_EDITED` (additive enum value) with run id, audience, old + new subject length only
    (no text needed — subjects are headlines, but keep the audit row small; include the new subject text if the
    existing digest audits already carry headlines — follow their precedent and say which in the REPORT).
- The HTML `<title>` keeps the automatic subject (not re-rendered); document that in the code comment.
- Digests screen (`admin/src/views/Digests.vue`): per version, next to the inbox preview subject: **Edit subject**
  → inline input pre-filled, character counter, warning above 90 ("may be cut off on phones"), Save / Cancel; locked
  with a one-line reason when not editable ("Locked — approved", "Locked — already scheduled"). After save the inbox
  preview shows the new subject. Phone ≤ 720 px works (16 px field).
- Admin guide: the Digests page gets one paragraph; bump minor version.

**Out (do not build):**
- No editing of headlines inside the email, story order, preheader or HTML.
- No subject editing after approval or on past runs. No change to the automatic subject rule.

## Acceptance tests
Each one must PASS in the REPORT.
1. PENDING version: edit stores the subject; the later `createDraft` call receives it (fake sender).
2. CREATED version: DB updated + exactly one `updateSubject(id, subject)` call; inbox preview payload shows it.
3. Provider failure (RETRYABLE and FATAL): row reverted to the old subject, 502 with plain reason, no audit row.
4. Locked cases → 409 with a code: approved run, schedule attempted, past cut-off, not today's run, build not BUILT.
5. Validation: empty, 151 chars, newline → 400; `{{x}}` defused as the automatic subject is; same subject → 200 no-op.
6. Concurrency: two saves from the same old subject → one 200, one 409 `changed`; one provider call.
7. Roles: PUBLISHER + ADMIN 200; bearer-only 401/403; signed-out 401.
8. Audit row `DIGEST_SUBJECT_EDITED` written on success only.
9. UI in a real browser (desktop + 375 px): edit, counter, >90 warning, locked message; screenshots in the REPORT.
10. `tsc`, lint, admin `vue-tsc`, full suite green (known flaky "metrics warmer" may be re-run alone).

## Files
- `src/services/digest/sender.ts`, `mailercloud.ts`, `mockSender.ts`, `src/routes/digest.ts`,
  `src/services/digest/screen.ts` (editable flag + lock reason per version), `prisma/schema.prisma` + migration
  (`AuditAction` value only, prefix `20261030…`), `admin/src/views/Digests.vue`, admin guide.
- Tests: digest route + runner/sender tests.

## Constraints
- Flag: none — the action is manual and only exists before approval; the staff list is the only audience today.
- Migrations: additive (`AuditAction.DIGEST_SUBJECT_EDITED`).
- Never call Mailercloud on a GET. Never log the API key or the subject text in error logs (`safeErrorLog`).
- The night rule doesn't apply (no send happens).

## Context the builder needs
- Restore safety: drafts are named `TS-DIGEST-<date>-<AUDIENCE>`; do NOT change the name on update.
- `subject` lives on `DigestSend` (schema ~line 565); the run's approval fields on `DigestRun`.
- Post-deploy (planning): edit a staff draft's subject between 06:30 and approval, confirm in Mailercloud's UI.
