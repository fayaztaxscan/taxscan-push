# Brief: See why Mailercloud refuses a contact, and retry refused contacts

- **Date / name:** 2026-11-06-audience-refused-contacts  →  branch `build/audience-refused-contacts`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first)

## Goal
When Mailercloud refuses a contact write, the log says why (never with an address), the Audience card shows how many
members are refused by role, and an ADMIN can make them due again with one audited press.

## Why (owner's decision, 6 Nov 2026)
First full tagging run: 54 of 2,622 Premium members (and 38+ Former, still rising) were refused when we created their
contact, so they get no Premium tag and no digest. Those rows stop for good and we kept no reason. Owner: send today
anyway, keep the hand-made paid digest going until these readers are fixed. Rediffmail is 29 of the first 84 refusals,
but other domains are refused too, so the cause is unknown. This brief finds the cause; it does not guess a fix.

## Scope
**In:**
- **Reason in the log.** `flushOnce` collects each FATAL's operation, HTTP status and provider text (already built by
  `McContactClient.call`, passed through `redactText`) and logs one line per distinct reason per tick, with a count:
  `[audience] writer refused op=createContact http=400 count=N reason="…"`. Cap the reason at 120 characters.
- **Count by role on the Audience card.** `audienceCard()` returns refused counts (`lastErrorKind = 'FATAL'`) for Premium
  and Former. The card shows them in plain words, e.g. "54 Premium readers were refused by Mailercloud and have no tag".
  Show the line only when a count is above 0. Same visibility as the existing card figures.
- **ADMIN retry.** `POST /api/digest/audience/retry-refused` with `requireUser(['ADMIN'])`: sets `nextAttemptAt = now`,
  `attempts = 0`, `lastErrorKind = null` for rows with `lastErrorKind = 'FATAL'` and `email` not null; returns the count.
  Writes a new audit action `AUDIENCE_REFUSED_RETRIED` with counts only. A "Retry refused" button on the card, using
  `ConfirmPush` like Resume, with the count in the question. The existing writer gates (send window, breaker, pull
  running) still apply.
- One line in the admin guide on the Audience card; bump the guide version.

**Out (do not build):**
- Any change to what counts as FATAL, or automatic retries. A credit lapse also lands in FATAL (401 "unpaid", quota); the
  button is the recovery for that too.
- Any special handling for a domain or a fix for the refusal itself. Planning decides that once the reason is logged.
- Storing the reason on the row, sending addresses anywhere, or listing refused addresses on screen or in an API reply.
- `contact_type`, upserts, or anything that could re-subscribe a contact. `writer.ts` rules at the top of the file stand.

## Acceptance tests
Each one must PASS in the REPORT.
1. A create answered 400 logs `op=createContact http=400` with the provider text and the right count.
2. Provider text that quotes the address logs `[email]`, never the address; the API key never appears.
3. Two members refused for the same reason in one tick log one line, count 2; two different reasons log two lines.
4. The card returns refused counts by role; a member with `lastErrorKind = 'RETRYABLE'` is not counted.
5. Retry makes only FATAL rows due and clears `attempts` and `lastErrorKind`; RETRYABLE and done rows are untouched.
6. Retry with an erased member (`email` null) leaves that row alone.
7. Retry refuses a PUBLISHER (403) and a signed-out request (401).
8. Retry writes one `AUDIENCE_REFUSED_RETRIED` audit row with counts and no address, and returns the count.
9. A retried member is written by the next tick when the gates are open, and not written inside the send window or
   while the breaker is open.
10. A member refused again after a retry returns to FATAL and counts on the card again.
11. Card checked in a real browser at desktop and 390 px: line hidden at 0 refused; line, button and confirm shown above 0.

## Files
- `src/services/audience/writer.ts` — collect and log reasons.
- `src/services/audience/mcContacts.ts` — only if `ContactError` needs a field for op or provider text.
- `src/services/audience/adminView.ts` — refused counts.
- `src/routes/digest.ts` — the retry route.
- `admin/src/components/AudienceCard.vue` — line + button (UI goes to `ui-developer`).
- `prisma/schema.prisma` + migration — the audit action.
- Admin guide — one line + version.
- Tests: `src/__tests__/audienceWriter.test.ts` and a route test next to the existing Resume test.

## Constraints
- Flag: none. Logging is harmless, and the retry only runs when an ADMIN presses it.
- Migrations: additive only, one new `AuditAction` value, name prefix `audience_refused_retried`.
- Full suite: yes — touches the Prisma schema.
- Docs that ship with it: admin guide line + version.
- Never log or return an address. Never log a raw Prisma message (`safeErrorLog`).

## Context the builder needs
- Classification lives in `McContactClient.call`; its FATAL message is `HTTP <status>: <provider text, 120 chars>`. The
  writer's catch currently drops it and raises only `contact_write`.
- A FATAL row has `nextAttemptAt = null` and a later snapshot only makes it due if its desired state changes (`ingest.ts`),
  so the nightly full load does not retry these rows.
- `lastErrorKind` stores a kind, never a message. Keep it that way.
- Resume on the card (`/api/digest/audience/resume`, `resumeBreaker`, `AudienceCard.vue`) is the pattern to follow.
- Production writes pause 07:10–08:00 IST; do not assume a retry lands at once.
