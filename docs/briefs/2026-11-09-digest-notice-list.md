# Brief: Signed daily list for the CMS's "your digest isn't reaching you" notice

- **Date / name:** 2026-11-09-digest-notice-list  →  branch `build/digest-notice-list`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first). UI parts go to `ui-developer`.

## Goal
The CMS pulls, once a day, a signed list of **paid** accounts whose daily digest cannot reach them, with a reason
(`bad_address` | `unsubscribed`), and shows each one a signed-in notice on taxscan.in. We build the list and the door
(door **N**). The CMS builds the banner (their brief, from the contract below).

## Why (owner's words)
> 9 Nov: "go with recommendation". The choices were: copy A ("We can't deliver your Taxscan daily digest to <email>.
> Contact us to update it.", linking to the CMS support desk); **the CMS pulls a signed daily list from us**; the CMS
> stamps a fresh `newsletter_opt_in_at` on every "turn it back on" tap; a marketing desk list of the bad addresses inside
> the CMS admin, fed by the same list.

Facts (prod, 9 Nov): 2,608 paid; 1,918 got the last paid digest. Mailercloud refuses **78** paid addresses (FATAL in our
writer; its own import screen says "hard bounced in the past and is inactive"). About **260** are hard-bounced and **338**
unsubscribed **inside Mailercloud**. Its API exposes no per-contact status (`GET /v1/contacts/{email}` has none), and our
`EmailSuppression` (fed by Mailercloud webhooks since 29 Oct) holds only **1** paid unsubscribe. So the list needs a
one-time import of Mailercloud's own status export. After that the webhooks keep it current.

## Scope
**In:**
1. **The list (one function, the single definition):** `digestNoticeList(portal, now)` in `src/services/audience/notices.ts`.
   It returns `{ accountId, reason }[]`, one row per CMS account, built from:
   - accounts with `CmsAccount.status = 'active'`, not deleted / erased / out of scope, `emailHash` present;
   - joined by `emailHash` to `AudienceMember` (`desiredRole = 'PREMIUM'`) and to `EmailSuppression` (by `emailHash`, or by
     `accountId` for a suppression that follows the account);
   - **bad_address**: the member is FATAL in the writer (`lastErrorKind = 'FATAL'`), or its suppression reason is
     `HARD_BOUNCE`;
   - **unsubscribed**: suppression reason `UNSUBSCRIBE` (and not bad_address, which wins);
   - **excluded always**: `SPAM`, `MANUAL` or `ACCOUNT_DELETED` suppression, `noMarketing` (consent = false), and any
     account whose role is not PREMIUM.
   Sorted by `accountId` so the ETag is stable.
2. **Door N:** `GET /api/integrations/cms/digest-notices` (contract below). Behind `DIGEST_NOTICES_ENABLED` (default off →
   **404**, as if the door did not exist). Signed by the CMS with the existing scheme (`src/lib/cmsSignature.ts`, the same
   string as doors L/V, mirrored): headers `X-CMS-Timestamp` + `X-CMS-Signature`, a SIGNED `nonce` query parameter (32
   lower-case hex, single use for 10 minutes), ±300 s skew, current or previous secret `CMS_FEED_NOTICES_SECRET`
   (+ `_PREVIOUS`). IP fence `CMS_FEED_ALLOWED_IPS` through `requestClientIp` (never `req.ip`). Every auth failure → the
   same **401**, nothing logged but a reason code. Rate limit: 30 requests/hour.
3. **Freshness:** the response is built on request from Postgres. **503 `not_ready`** if there has been no COMPLETE full
   CMS load in the last 48 h, or the audience breaker is open. The CMS keeps its last copy on any non-200.
4. **One-time import of Mailercloud's status export (ADMIN):** Digests → Audience card → "Import Mailercloud statuses"
   (`POST /api/digest/audience/import-statuses`, CSV upload ≤ 5 MB). Accepted columns: email + status (match the header names
   of Mailercloud's own contacts export; the builder documents which names are accepted). `Unsubscribed` → UNSUBSCRIBE,
   `Hard bounce`/`Bounced` → HARD_BOUNCE, `Spam`/`Complained` → SPAM; every other status is ignored.
   - Upsert `EmailSuppression` with `source = 'mailercloud_export'`, applying the existing escalation rule (SPAM > HARD_BOUNCE
     > UNSUBSCRIBE, MANUAL never rewritten, never downgraded).
   - Addresses are normalised and hashed, and **never logged or returned**. The reply gives counts only (read, matched per
     reason, ignored, invalid). Audit entry `AUDIENCE_STATUSES_IMPORTED` with counts. Re-importing the same file changes nothing.
   - The REPORT must state exactly what a new suppression row changes in the audience writer and the digest send (expected:
     nothing about who receives the paid digest, because Mailercloud already excludes these contacts). If it would change
     anything, stop and say so.
5. **Re-subscribe is unchanged:** a CMS `account.updated` with `marketing_consent {value: true, at}` later than an
   UNSUBSCRIBE suppression lifts it (existing rule), so the account leaves the list on the next build. Don't add anything new.
6. **Audience card (ADMIN):** one line, "Digest notices: N bad address · M unsubscribed (list as of …)", plus the import button.
7. **Docs:** a contract section in `docs/CMS_AUDIENCE_SYNC_DESIGN.md` (door N, copied from below), `.env.example`, and the
   admin guide (Digests → Audience) with a version bump.

**Out (do not build):**
- Any email to these readers. Any banner on our side. Any write to the CMS.
- Self-service email change (the CMS's call; the owner chose "contact us").
- A recurring Mailercloud status sync (the API has none). After the import, webhooks keep it current.
- Changing who receives the paid digest.

## Contract for door N (send this to the CMS verbatim after merge; planning does that)
```
GET https://push.taxscan.in/api/integrations/cms/digest-notices?nonce=<32 hex>
X-CMS-Timestamp: <unix seconds>
X-CMS-Signature: sha256=<hex HMAC-SHA256(CMS_FEED_NOTICES_SECRET, "<ts>.GET./api/integrations/cms/digest-notices.<canonical query>")>
If-None-Match: "<etag from your last 200>"   (optional)

200  ETag: "<sha256 of the items>"
{ "as_of": "<ISO time the list was built>", "portal": "taxscan",
  "count": N,
  "items": [ { "account_id": "…", "reason": "bad_address" | "unsubscribed" } ] }
304  unchanged since your ETag (no body)
401  any auth failure (same body every time)
404  the door is switched off on our side: keep your current copy
503  {"error":"not_ready"}: we can't vouch for the list right now; keep your current copy
```
- A 200 with `count: 0` / `items: []` means **no one should see a notice**. "No data" is never sent as empty; it is a 503 or 404.
- Pull once a day **after 05:30 IST** (our 04:30 load and the writer are done by then). Replace your copy whole: an account
  absent from the list stops seeing the notice.
- `bad_address` wins over `unsubscribed` for the same account. Spam complainers and consent=false accounts never appear.
- We need from the CMS: the egress IP the pull comes from (for `CMS_FEED_ALLOWED_IPS`) and a new 48-char secret
  `CMS_FEED_NOTICES_SECRET`, generated on the CMS box like W/L/V.

## Acceptance tests
Each one must PASS in the REPORT.
1. List rules: FATAL → bad_address; HARD_BOUNCE → bad_address; UNSUBSCRIBE → unsubscribed; FATAL + UNSUBSCRIBE → bad_address;
   SPAM / MANUAL / ACCOUNT_DELETED / noMarketing / non-PREMIUM / non-active account → absent; suppression by `accountId` only → counted.
2. Two accounts sharing one email both appear; one account appears once.
3. Door: a valid signature → 200 with the payload shape exactly; a wrong secret, skew > 300 s, a reused nonce, a missing
   nonce, a body on GET, or an IP outside the fence → 401 (same body); the previous secret is accepted.
4. ETag: the same list → same ETag; `If-None-Match` → 304; one row changes → new ETag.
5. Flag off → 404. No complete full load in 48 h, or breaker open → 503 `not_ready`.
6. Empty list → 200, `count: 0`.
7. Import: a CSV fixture shaped like Mailercloud's export → correct counts. Escalation holds (an existing SPAM row is not
   downgraded by an "Unsubscribed" row; MANUAL is untouched). Re-import → no changes. No address appears in the logs, the
   reply or the audit entry (scan test). Non-ADMIN → 403. A file > 5 MB or without an email column → 400.
8. A CMS opt-in dated after an imported UNSUBSCRIBE lifts it, and the account leaves the list (existing rule, end to end).
9. Audience card shows the counts and the import (real browser, desktop + 375 px).

## Files
- `src/services/audience/notices.ts` (new), `src/routes/cmsNotices.ts` (new) or next to `cmsEvents.ts`, `src/lib/cmsSignature.ts` (a verify helper for GET door N)
- `src/lib/env.ts` (`DIGEST_NOTICES_ENABLED`, `CMS_FEED_NOTICES_SECRET`, `_PREVIOUS`)
- import route + Audience card (`admin/src/…` Digests view)
- Tests: new `audienceNotices.test.ts`, `cmsNoticesDoor.test.ts`, the import tests
- Docs as above.

## Constraints
- Flag: `DIGEST_NOTICES_ENABLED` default off (the door 404s). The import works with the flag off (an ADMIN action).
- Migrations: none expected (`EmailSuppression.source` is a string). If one is needed, additive only.
- Full suite: yes — touches config/env and auth (a new signed door).
- Never log, return or audit an email address. Never call Mailercloud or the CMS from a test.

## Context the builder needs
- Signing: `src/lib/cmsSignature.ts` header comment (one rule, both directions); doors L/V show the signed-nonce pattern.
- Fence and client IP: `requestClientIp` (Railway two-hop XFF; memory `project_taxscan_push_runtime`).
- Roles: `memberRole()` in `src/services/audience/rules.ts` is the single definition. Suppression escalation is in the webhook ingest.
- After merge, planning sends the contract to CMS planning (cms-platform-29), and the owner sets the secret and the IP. Anagha
  exports statuses from Mailercloud's contacts screen for the import.
