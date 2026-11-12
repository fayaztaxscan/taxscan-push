# Brief: Re-subscribe through Mailercloud's new endpoint

- **Date / name:** 2026-11-12-resubscribe-endpoint  →  branch `build/resubscribe-endpoint`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first)
- **Order:** build AFTER `build/facebook-shopscan-page` is merged to `develop` (owner, 12 Nov: "go with recommendation").

## Goal
When a reader turns the digest back on in the CMS, our writer re-subscribes them in Mailercloud with the new
`POST /v1/contacts/resubscribe` (which works) instead of `PUT /contacts/{email} {contact_type:"active"}` (which never did).
Still behind `AUDIENCE_RESUBSCRIBE_WRITES` (unset/off in prod); off, nothing changes.

## Why (owner's words + facts)
> "go with recommendation" (12 Nov 2026) — brief now, build third.

- Mailercloud ticket #46846 (12 Nov): their API had no re-subscribe; `contact_type:"active"` was silently ignored (contact reverted
  to Unsubscribed, our live test 9 Nov). PUT now returns `warnings:[{code:"status_not_changed",…}]`. New endpoint added.
- **Live test passed 12 Nov 17:20 IST** (owner's yes) on a test contact: 200 `{status:"subscribed", consent_recorded:true,
  changed:true-implied}`; the web screen showed status Unknown (mailable) + "Contact resubscribed". A first call with brackets in
  `consent_source` got **422**. A real paid reader already re-subscribed by hand answered 200 `{changed:false}`.

## The endpoint (apidoc.mailercloud.com/api-reference/contacts/resubscribe-contact, read 12 Nov)
`POST https://cloudapi.mailercloud.com/v1/contacts/resubscribe`, `Authorization: <key>` (no Bearer), JSON body:
- `email` (≤200) **or** `contact_id` — never both. We send `email`.
- `consent_source` **required**: 1–100 chars of letters, digits, spaces and `. , : - _ / @ +` only.
- `consent_at` **required**: RFC 3339, not in the future, **within the last 90 days**, **after the contact unsubscribed**.
- optional `list_id`, `consent_ip`, `consent_text` (≤500) — we send none of them.
Answers: **200** `{contact_id, status:"subscribed", resubscribed_at, consent_recorded, changed}` (`changed:false` = already
subscribed) · **202** `{status:"pending_confirmation"}` (double opt-in for API on; a repeat within 24 h sends no 2nd email) ·
401 · **403** `quota_exceeded` · **404** `contact_not_found` · **409** `contact_not_resubscribable` + `current_status`
(bounced / spam / abuse / suppressed — never re-subscribable) · **422** `invalid` (bad consent, consent_at not after the
unsubscribe, bad source) · **429** `rate_limited`. Limits: 60/min, 5,000/day per account.

## Scope
**In:**
- `src/services/audience/mcContacts.ts`: `resubscribe(email, consent: { source: string; at: Date })` calls the new endpoint and
  returns an outcome `subscribed | already | pending_confirmation` (200 changed:true / 200 changed:false / 202). Still refused
  before any request unless built with `resubscribeWrites: true`. The client header comment + source-scan test change: the client
  no longer sends `contact_type` ANYWHERE (pin that); `/contacts/resubscribe` is sent only by `resubscribe()`.
- **Classification for this call:** 409 `contact_not_resubscribable`, 422, 404 → a new final kind (e.g. `NOT_RESUBSCRIBABLE` /
  FATAL with the code) — the writer marks the lift handled, never retries, counts it; 429/408/5xx/network → RETRYABLE; 401/403 →
  FATAL as today. Error text redacted as today (never an address, never the key).
- **Consent values** (writer, `src/services/audience/writer.ts`, the `resubDue` block): `consent_at` = the latest `consentAt` of the
  member's current, live, `consentValue: true` CMS account (the same rows the existing count reads); if that is missing, in the
  future, or older than 90 days → do not call, count `resubscribeSkipped` with reason `consent_too_old` (lift handled).
  `consent_source` = a fixed safe string, e.g. `taxscan account settings` (sanitise to the allowed set anyway; one helper, tested).
- **Report/log:** writer report gains `resubscribeAlready`, `resubscribePending`, `resubscribeRefused` counts beside
  `resubscribed` / `resubscribeSkipped`; the `[audience]` writer line prints them (counts only).
- **Pacing:** at most the existing daily lift cap (`MAX_LIFTS_PER_DAY`); stays far under 60/min, 5,000/day — add nothing else.
- **Docs:** `docs/CMS_AUDIENCE_SYNC_DESIGN.md` §6.3 (new endpoint, outcomes, the 90-day rule), the runbook line for switching
  `AUDIENCE_RESUBSCRIBE_WRITES` on, `docs/email_*`-style notes only if they exist in the repo.

**Out (do not build):**
- Switching the flag on (planning + owner, after a live check).
- Any change to when a lift happens (`liftOnConsent` in `ingest.ts` stays as is: an explicit opt-in dated after our
  `EmailSuppression` row). Note for the record: a reader unsubscribed only in Mailercloud (no row in our table) is not lifted —
  the Mailercloud status import (Digests → Audience) fills our table; that is an operations step, not this build.
- Sending `list_id`, `consent_ip` or `consent_text`; using `contact_id`.
- Hard-bounce re-activation (Mailercloud: never possible).

## Acceptance tests
Each one must PASS in the REPORT. All HTTP mocked.
1. Flag off: `resubscribe()` throws before any request (as today); a lifted member is counted `resubscribeSkipped`, no call.
2. Flag on, 200 `changed:true` → POST to `/v1/contacts/resubscribe` with `{email, consent_source, consent_at}` only, no
   `contact_type` anywhere; counted `resubscribed`; `resubscribePending` cleared.
3. 200 `changed:false` → `resubscribeAlready`, cleared. 202 → `resubscribePending` count, cleared (no second call next tick).
4. 409 `contact_not_resubscribable`, 422, 404 → handled, never retried, `resubscribeRefused`; no FATAL alert storm (one counted
   refusal, like today's refused rows).
5. 429 / 5xx / timeout → RETRYABLE, retried on the existing schedule.
6. `consent_at` = latest consentAt of the live consent-true account, RFC 3339; consentAt older than 90 days or in the future → no
   call, `consent_too_old`.
7. `consent_source` helper strips/blocks anything outside the allowed set and caps at 100 (brackets → removed).
8. Source scan: `contact_type` appears nowhere in `src/services/audience/`; `/contacts/resubscribe` only inside `resubscribe()`.
9. Logs and errors contain no address and no key.
10. Existing audience writer / ingest tests pass unchanged (other than the deliberate PUT→POST change).

## Files
- `src/services/audience/mcContacts.ts`, `src/services/audience/writer.ts`
- `docs/CMS_AUDIENCE_SYNC_DESIGN.md` (+ runbook if it names the PUT)
- Tests: the mcContacts + writer test files (and the source-scan test)

## Constraints
- Flag: `AUDIENCE_RESUBSCRIBE_WRITES` stays the switch, default off. No new flag.
- Migrations: none.
- Full suite: no — area tests: `audience` (`mcContacts`, `audienceWriter*`, source-scan).
- Never log an address or the key. Never call real Mailercloud from a test.

## Context the builder needs
- Today's lift path: `liftOnConsent()` (`src/services/audience/ingest.ts` ~278) → `resubscribePending` on the current hash →
  writer `resubDue` block (`writer.ts` ~545) → `client.resubscribe(email)`.
- The contact client uses `MAILERCLOUD_SYNC_API_KEY` (separate from the digest key) — keep it.
- After release, planning runs one live check with a test contact and tells the CMS (planning session) that its
  "turn it back on" switch may go on; until then the CMS keeps it OFF.
