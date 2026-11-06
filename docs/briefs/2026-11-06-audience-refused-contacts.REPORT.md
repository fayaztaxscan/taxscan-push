# REPORT: audience-refused-contacts

- Code commit: `bf49bb4`; branch `build/audience-refused-contacts` (base origin/develop eb9b8df).

## Files changed
- `src/services/audience/writer.ts` — collects each FATAL (op, http, redacted reason ≤120 chars) per tick, logs one line per distinct reason with count; new `retryRefused()` (FATAL + email not null → due now, attempts 0, kind null; audit with counts). Optional `onlyHashes` is for tests only.
- `src/services/audience/mcContacts.ts` — `ContactError.op`; provider text is now redacted BEFORE the 120-char cut (an address cut in half would have escaped the email regex).
- `src/services/audience/adminView.ts` — `refused: {premium, former}` (FATAL, email not null) in the ADMIN payload only.
- `src/routes/digest.ts` — `POST /api/digest/audience/retry-refused` (ADMIN; 409 when sync is off).
- `admin/src/components/AudienceCard.vue` — lines, "Retry refused" + ConfirmPush (ui-developer).
- `admin/src/views/Activity.vue` — new action in the action list.
- `prisma/schema.prisma` + migration `20261106010243_audience_refused_retried` — one `AuditAction` value (additive).
- `docs/Taxscan-Push-Admin-Guide.html` — one paragraph, version 2.24 → 2.25.
- Tests: `audienceWriter.test.ts` (+3), new `audienceRefused.test.ts` (card, service, route, gates), `audienceFakeMailercloud.ts` (`failCreate`).

## Flags/env: none.

## Results
- tsc: clean. lint: clean (eslint src, 0 problems).
- New + writer tests: 42 passed, 42 total.
- Full suite (schema change): Tests: 2359 passed, 2359 total (102 suites).

## Acceptance
1 PASS · 2 PASS (address in text, cut at 120, API key) · 3 PASS · 4 PASS · 5 PASS · 6 PASS · 7 PASS (403/401, bearer alone 401) · 8 PASS · 9 PASS (open gates written; send window and breaker wait) · 10 PASS · 11 PASS — headless Playwright at 1280 and 390 px against a stubbed API (not a real Chrome, not the real backend): hidden at 0; lines, button and confirm ("Try these 92 readers again?", Cancel focused) above 0; no horizontal overflow. Error path of the POST not browser-tested.

## Agents
ui-developer: AudienceCard.vue and the browser check.

## Deviations
None. Added the Activity.vue action name (otherwise the new audit row would not be filterable).

## Worth remembering
- Log format: `[audience] writer refused op=createContact http=400 count=N reason="HTTP 400: …"`. Reason text is the provider's, redacted. Other FATAL ops (getContact, putTags, listTags failure path) log the same way; a tag-catalogue failure still goes through the old alert path only.
- Retry count on the card includes only rows with an address; "other" roles (NONE) are retried but not shown on the card (audit meta has premium/former/other/total).
- Retry is global to all FATAL rows, so in a shared dev DB it also touches other test files' FATAL rows; the new tests isolate with `onlyHashes`, the route test does not (its assertions are relative).
- A credit lapse (401 unpaid) also lands in FATAL, so the button recovers it too — but all rows then fail again until the credit is back.
- Writes pause 07:10–08:00 IST; a retry press then waits.

## Clean-up
```sh
git worktree remove ../taxscan-push-worktrees/audience-refused-contacts
dropdb taxscan_push_build_audience-refused-contacts; dropdb taxscan_push_build_audience-refused-contacts_shadow
git branch -D build/audience-refused-contacts; git push origin --delete build/audience-refused-contacts
```
