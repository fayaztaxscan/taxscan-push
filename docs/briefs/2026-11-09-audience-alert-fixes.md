# Brief: Audience alert emails — IST date + honest "refused" advice

- **Date / name:** 2026-11-09-audience-alert-fixes  →  branch `build/audience-alert-fixes`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first)

## Goal
Audience-sync alert emails carry the IST date in their subject and first line (as digest alerts already do), and the
"Mailercloud refused a contact write" alert tells the reader what that refusal almost always is, instead of sending them
to check keys and quotas.

## Why (owner's words)
> 9 Nov: "write the brief for the two alert fixes" — after (1) the 8 Nov 04:31 IST "Audience sync paused" email said
> **2026-11-07**, and (2) the 8 Nov 22:02 IST "Mailercloud refused a contact write" email advised checking
> `MAILERCLOUD_SYNC_API_KEY`, ids and quota, when the cause was one reader whose address had hard-bounced in the past.

Evidence: Anagha imported 3 of the 79 refused paid readers by hand in Mailercloud's web screen (8–9 Nov) and got
"The email address has hard bounced in the past and is inactive". The API answers the same block with
`createContact 400 "Invalid email"` (log line `[audience] writer refused op=createContact http=400 … reason="HTTP 400: Invalid email"`).

## Scope
**In:**
1. **Date bug.** `src/services/audience/alerts.ts:100` calls `buildAlertEmail(kind, m, now, cfg)` with the current
   instant; `buildAlertEmail` formats it with `runDateKey()`, which expects a runDate (00:00 UTC of the IST day). Any
   audience alert raised 00:00–05:29 IST is therefore dated the previous day. Pass `istDateOf(now)`
   (`src/services/digest/retryPolicy.ts`) instead. The digest callers (`alerts.ts:770`, `:927`) already pass
   `run.runDate` — leave them alone.
2. **Copy for `audience_writer_fatal`** (`src/services/digest/alerts.ts`, case `'audience_writer_fatal'`). Keep `short`
   and `did`. New `what` / `todo`, plain words, count-aware:
   - `what`: `Mailercloud refused ${n} contact write(s) with an error that retrying will not fix (${reason}).`
     (unchanged) **plus** `Usually this is an address Mailercloud blocks because it hard-bounced in the past (its API calls it "Invalid email").`
   - `todo` when `n` ≤ 10: `Nothing to do: that reader cannot be emailed until they give a working address. ADMIN can see the refused counts on Admin → Digests (Audience card).`
   - `todo` when `n` > 10: `Many refusals at once: check the sync key (MAILERCLOUD_SYNC_API_KEY), the tag/list ids and the contact quota in Mailercloud, then press Retry refused on Admin → Digests (Audience card).`
   - Threshold as a named constant `WRITER_FATAL_MANY = 10` next to the copy.
   - Email only: audience alerts send no staff push, and `staffPushCopy` is separate — leave it alone.

**Out (do not build):**
- No change to when alerts fire, the once-per-kind-per-IST-day rule, recipients, or the writer's FATAL handling.
- No change to the `truncated_load` / other alert texts.
- No change to Retry refused, the Audience card, or `runDateKey()` itself (many callers rely on it).
- No reader-facing anything.

## Acceptance tests
Each one must PASS in the REPORT.
1. An audience alert raised at **2026-11-07T23:01:00Z** (= 8 Nov 04:31 IST) produces subject
   `[Taxscan digest] Audience sync paused — needs review — 2026-11-08` and first line `Daily email digest, 2026-11-08`.
2. The same alert at **2026-11-08T16:32:00Z** (22:02 IST) is dated `2026-11-08`; at **2026-11-08T18:31:00Z** (00:01 IST
   9 Nov) it is dated `2026-11-09`.
3. A digest alert built from a run with `runDate` 2026-11-09 is still dated `2026-11-09` (regression).
4. `audience_writer_fatal` with `count: 1` → text contains "hard-bounced in the past" and "Nothing to do", and does
   **not** contain `MAILERCLOUD_SYNC_API_KEY`.
5. `audience_writer_fatal` with `count: 11` → text contains `MAILERCLOUD_SYNC_API_KEY` and "Retry refused".
6. `count: 10` → the "Nothing to do" variant (boundary).
7. No email text or log line contains an email address (existing redaction tests still pass).
8. tsc + lint clean.

## Files
- `src/services/audience/alerts.ts` — pass `istDateOf(now)` to `buildAlertEmail`.
- `src/services/digest/alerts.ts` — `audience_writer_fatal` copy + `WRITER_FATAL_MANY`.
- Tests: `src/__tests__/digestAlerts.test.ts` (copy, regression 3), the test that covers `services/audience/alerts.ts`
  (today exercised from `src/__tests__/audiencePull.test.ts`; a small new `audienceAlerts.test.ts` is fine) for the date.

## Constraints
- Flag: none — wording and a date in internal admin emails only; nothing a reader sees, no behaviour change.
- Migrations: none.
- Full suite: no — area tests: `digestAlerts`, `audiencePull`, `audienceWriter`, plus any new test file.
- Docs that ship with it: none (the admin guide does not quote alert text; check with a grep for "refused a contact write" and update if it does).
- Never put a provider message or an address into the email — `reason` stays the code (`contact_write`) via `safeDetail`.

## Context the builder needs
- `istDateOf(now)` returns 00:00 UTC of the IST calendar day — exactly the shape `runDateKey()` expects.
- The marker's `day` (`istDayKey(now)` in `audience/alerts.ts`) is already IST; only the email date was wrong.
- The refused count per day is `m.count` on the marker (refreshed when the same kind is raised again that IST day);
  treat a missing count as 1, as today.

## Follow-up 1 (planning, 9 Nov — from the build's REPORT)
`audience_writer_fatal` is also raised by the tag lookup (`src/services/audience/writer.ts` ~line 298, reason
`tags_<http>` or `tag_ids`, count always 1). That is a bad sync key or bad tag ids, never a reader's address, so it
must keep the old advice. Same branch, same REPORT (add a Follow-up 1 section to it).

**In:**
- In the `audience_writer_fatal` copy, when `m.reason` is `tag_ids` or starts with `tags_`:
  - `what`: `Mailercloud refused our tag lookup (${reason}), so no contact was written this time.`
  - `todo`: `Check the sync key (MAILERCLOUD_SYNC_API_KEY) and the tag ids (AUDIENCE_MC_TAG_*) in Mailercloud.`
  - No "hard-bounced" sentence, no "Nothing to do".
- Every other reason (today only `contact_write`) keeps the count-aware copy from the main brief.

**Out:** no change to where or when the alert is raised, and no new alert kind.

**Acceptance tests (add to the 8):**
9. `reason: 'tags_401'`, `count: 1` → text contains `MAILERCLOUD_SYNC_API_KEY` and `AUDIENCE_MC_TAG_`, and does **not**
   contain "hard-bounced" or "Nothing to do".
10. `reason: 'tag_ids'`, `count: 1` → same as 9.
11. `reason: 'contact_write'`, `count: 1` → still the "Nothing to do" variant (regression).
