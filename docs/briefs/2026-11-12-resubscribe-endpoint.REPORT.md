# REPORT: resubscribe-endpoint

- **Brief:** `docs/briefs/2026-11-12-resubscribe-endpoint.md` (planning, taxscan-push-64; base `origin/develop` 7e7b70a)
- **Branch:** `build/resubscribe-endpoint`
- **Code commit:** `f3e2a85` — `feat(audience): re-subscribe through Mailercloud's POST /v1/contacts/resubscribe (brief 2026-11-12-resubscribe-endpoint)`
- **Date:** 2026-11-12 (IST night). Full suite: **no** (the brief says area tests; see "Full suite" below). No subagents.

## In one paragraph
The writer's lift path now re-subscribes through Mailercloud's `POST /v1/contacts/resubscribe` instead of the PUT `{contact_type:"active"}` that Mailercloud never honoured.
`McContactClient.resubscribe(email, {source, at})` sends exactly `{email, consent_source, consent_at}` and returns `subscribed | already | pending_confirmation`; a 404 / 409 / 422 is a new final
kind `NOT_RESUBSCRIBABLE` (counted, never retried, no alert); 429 / 408 / 5xx / network stay RETRYABLE; 401 / 403 stay FATAL. The writer sends the latest `consentAt` of the member's live
consent-true accounts, and makes **no call** when that time is missing, in the future or older than 90 days. Still behind `AUDIENCE_RESUBSCRIBE_WRITES` (off): off, nothing changes. `contact_type`
no longer appears anywhere in `src/services/audience` and a source scan pins that. **All 10 acceptance tests pass; 29 new tests, 17 audience-area suites / 454 tests green.**

## What changed
| File | What / why |
|---|---|
| `src/services/audience/mcContacts.ts` | `resubscribe(email, {source, at})` → `POST /contacts/resubscribe` (refused before any request without the flag or with an invalid time); `ResubscribeOutcome`; new `ContactErrorKind` `NOT_RESUBSCRIBABLE` (404 / 409 / 422 on this op only); `safeConsentSource()` + `RESUBSCRIBE_CONSENT_SOURCE` (`taxscan account settings`); `refusalCodes()` keeps ONLY lower-case snake_case code tokens from Mailercloud's error body (never free text), so a message is e.g. `HTTP 409 contact_not_resubscribable (bounced)`. Header comment rewritten (no `contact_type` anywhere). |
| `src/services/audience/writer.ts` | `resubDue` block: `liveConsent()` (count + latest `consentAt` of the member's non-deleted, in-scope, `consentValue: true` accounts), the 90-day / future rule (`RESUBSCRIBE_CONSENT_MAX_AGE_MS`), the outcomes → counters, `NOT_RESUBSCRIBABLE` caught in the block (the member finishes OK: handled, not retried). `FlushReport` + `emptyFlush` + the `[audience] writer …` line gain `resubscribeAlready`, `resubscribePending`, `resubscribeRefused`, `resubscribeConsentTooOld` (counts only). |
| `src/services/audience/ingest.ts`, `src/lib/env.ts` | **Comment-only** (they said "sends `contact_type`" / "`contact_type=active` lift path"). |
| `src/__tests__/audienceFakeMailercloud.ts` | Models reality: a status in a PUT is ignored (answer carries `warnings:[{code:"status_not_changed"}]`); the documented `POST /v1/contacts/resubscribe` (200 changed true/false, 202 with `doubleOptIn`, 404, 409 bounced/spam + `current_status`, 422 for a bad source / future / >90 days / not after `unsubscribedAt`), a `clock`, a `resubscribeAnswer` hook. |
| `src/__tests__/audienceWriter.test.ts` | Only the deliberate PUT → POST change: the lift-path `describe` (5 tests) + the header comment. |
| `src/__tests__/audienceResubscribe.test.ts` (new, 29 tests) | Acceptance 1–9. |
| `docs/CMS_AUDIENCE_SYNC_DESIGN.md`, `.env.example` | §6.2 rule 1, §6.3 (new "Re-subscribing in Mailercloud" block: endpoint, body, the consent rules, an answers table, limits, what is not changed, how to switch it on), the stale mentions (§ table rows, flag table, test table, task 6 "Built" note), a comment above the flag. |

- **Migrations:** none. **Flags/env added:** none (`AUDIENCE_RESUBSCRIBE_WRITES` stays the only switch, default off).

## Verification
- `npx tsc -p tsconfig.json --noEmit` → exit 0. `npm run lint` → exit 0.
- New tests: `Tests: 29 passed, 29 total` (`audienceResubscribe`).
- **Area tests** (`npx jest audience cmsEvents cmsNoticesDoor`, i.e. every audience suite, which run under the DB lock): `Test Suites: 17 passed, 17 total` / `Tests: 454 passed, 454 total` / `Time: 87.606 s`.
- **Mutation checks** (each reverted from a backup, files identical afterwards): drop the 90-day / future rule → 2 new tests fail; 422 no longer `NOT_RESUBSCRIBABLE` → 3 fail; earliest instead of latest `consentAt` → 1 fails; an extra `list_id` in the body → 2 fail.

### Acceptance tests
1. **Flag off → throws before any request; a lifted member counted `resubscribeSkipped`, no call — PASS.** (Client: flag off, and an invalid consent time, make no request. Writer: `resubscribeSkipped: 1`, no request, the lift handled.)
2. **200 `changed:true` → POST with `{email, consent_source, consent_at}` only; counted `resubscribed`; pending cleared — PASS.** The key set is asserted exactly (`consent_at`, `consent_source`, `email`), `contact_type` appears in no recorded request, the contact is active, a second tick sends nothing.
3. **200 `changed:false` → `resubscribeAlready`; 202 → `resubscribePending`, cleared, no second call next tick — PASS.**
4. **404 / 409 / 422 → handled, never retried, `resubscribeRefused`, no alert storm — PASS.** Cases: a bounced and a spam contact (409), a consent not after the unsubscribe (422), and endpoint answers 404 / 409 / 422 forced after our own GET: each is one request, `fatal: 0`, `retry: 0`, the row gone, no `audience_writer_fatal`, no per-member `writer refused` line.
5. **429 / 5xx / timeout → RETRYABLE on the existing schedule — PASS.** Writer: 429, 500, 503 leave the member pending with `attempts: 1`, `lastErrorKind: RETRYABLE`, `nextAttemptAt = now + retryDelayMin(1)`; the next due tick goes through. Client: 502, a refused connection and a silent server (own timeout) are RETRYABLE; 401 and 403 `quota_exceeded` are FATAL (the writer test: `fatal: 1`, the member stops, still pending).
6. **`consent_at` = latest `consentAt` of the live consent-true account(s), RFC 3339; older than 90 days / future → no call, `consent_too_old` — PASS.** The latest of five accounts is used (later ones on a deleted, out-of-scope or consent-false account are ignored; milliseconds are cut, never rounded up). 91 days, +1 minute and a missing time → no request, `resubscribeSkipped` + `resubscribeConsentTooOld`, handled; 89 days and exactly 90 days → sent. No live consent-true account at all is still the plain skip (not `consent_too_old`); a suppressed member is skipped.
7. **`consent_source` helper — PASS:** brackets, quotes, control characters and accents are REMOVED, the allowed set survives whole, cut to 100 (then trimmed), an empty result becomes the fixed source, idempotent, and the client applies it even to an unsafe caller value.
8. **Source scan — PASS:** across EVERY file in `src/services/audience` (code and comments) `contact_type` appears nowhere; `/contacts/resubscribe` appears in code only in `mcContacts.ts`, once, after `async resubscribe(` and before `async listTags(` (`audienceWriter.test.ts`'s scan also updated).
9. **No address and no key in logs or errors — PASS:** Mailercloud's text is never copied for a refusal; with a fake that echoes the address and the key in its error bodies, no error message contains either (a free-text `current_status` is dropped); the `[audience] writer …` lines for six different outcomes carry only counts.
10. **Existing audience writer / ingest tests pass unchanged apart from the deliberate PUT → POST change — PASS:** 17 suites / 454 tests. The only edits to existing tests are the lift-path `describe` and header comment of `audienceWriter.test.ts` and the fake (above).

## Deviations / decisions (all small)
1. **`consent_at` is sent to the whole second** (`2027-03-01T10:00:00Z`), not with `.000Z` milliseconds: the plainest RFC 3339, and flooring can never make it later than the real time. Not tried against the live API (the live test of 12 Nov did not say which form it used) — worth confirming on the first real lift.
2. **`consent_too_old` is its own counter** (`resubscribeConsentTooOld`) as well as incrementing `resubscribeSkipped`, because the report holds numbers, not reasons.
3. **A contact that does not exist in Mailercloud** (our own GET said 404) is still skipped before any call, counted `resubscribeSkipped` — as it was before (`&& contact`). A 404 from the endpoint itself (the contact vanishing between the GET and the POST) is `NOT_RESUBSCRIBABLE` / refused.
4. `src/lib/env.ts` was touched, **comment only** (a stale "`contact_type=active`" description); I did not run the full suite for that (nothing behavioural changed; `audienceConfig` is in the area run).
5. **The brief's "runbook line":** no runbook in the repo names the old PUT or this flag (`docs/DIGEST_PILOT_RUNBOOK.md` does not mention it, and there are no `docs/email_*` notes). The switch-on steps are in the design doc §6.3 and a comment above the flag in `.env.example`. `NEXT_STEP.md` line 16 still says the flag "stays OFF": the record is yours.

## Worth remembering (planning decides what becomes record)
- **The 90-day window can silently lose a lift.** A lift that is deferred (the daily lift cap, a long outage, the writer paused in the send window) and processed more than 90 days after the reader's opt-in is skipped as `consent_too_old` and handled: the reader stays unsubscribed and is not retried. At today's volume (a few hundred unsubscribed paid readers, 20 lifts a day) a backlog clears well inside 90 days, but a long writer outage could age lifts out. Counted in the writer line (`consentTooOld=`).
- **"After the contact unsubscribed" is Mailercloud's check, not ours.** If a reader's opt-in predates their Mailercloud unsubscribe (our `EmailSuppression.lastSeenAt` normally comes from Mailercloud's own event, so this should be rare) Mailercloud answers 422: counted `resubscribeRefused`, handled, never retried.
- **202 (double opt-in) is "handled".** If the API ever has double opt-in on, the reader gets Mailercloud's confirmation e-mail and we never repeat the request (counted `resubscribePending`); a reader who ignores the e-mail stays unsubscribed.
- The writer line now reads `… resubscribed=N already=N pending=N resubRefused=N resubSkipped=N consentTooOld=N …` (counts only) — use it for the first live check after switch-on.
- The fake used by the writer tests now ignores a status in a PUT (as Mailercloud does), so any future code that sent one would fail its test instead of passing against the old, wrong fake.

## Agents run
None.

## Clean-up (planning runs this after merging)
```sh
git worktree remove ../taxscan-push-worktrees/resubscribe-endpoint
dropdb taxscan_push_build_resubscribe-endpoint; dropdb taxscan_push_build_resubscribe-endpoint_shadow
git branch -D build/resubscribe-endpoint; git push origin --delete build/resubscribe-endpoint
```
