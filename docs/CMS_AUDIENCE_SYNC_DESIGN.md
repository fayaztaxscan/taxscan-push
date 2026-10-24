# CMS audience sync: design

Status (24 Oct 2026): **design only, nothing built.** For owner review, then Developer → QA, one task at a time (§11).
Every behaviour sits behind flags that default OFF.

**Owner rulings this design is bound by:**

- **2026-10-24 — owner accepted every recommendation in §12.1** (Q1 ended → Former tag; Q2 null consent stays in Free;
  Q3 Premium = service email, unsubscribe wins; Q4 CMS deletion → Mailercloud erase capped 20/day once the CMS confirms
  deletion = erasure; Q5 email change: Premium follows, old address keeps hand-list membership; Q6 CMS builds Feed 1
  first; Q7 guard numbers as proposed, tune after the first clean week) **and CMS Q10 (v1.2) = YES**.
- **2026-10-24 — `account.deleted` ≠ erasure** (CMS: it fires whenever an account leaves the feed's scope — deleted,
  deactivated (reversible), turned staff, or a future DPDP erasure). Owner: **YES to CMS v1.2 `"erasure": true|false`**.
  `erasure: true` → erase in Mailercloud (cap 20/day); `false` → remove from every audience + suppress by account_id,
  keep the record; `account.created` with `reactivated: true` restores eligibility (unsubscribes/complaints never
  lifted automatically). This replaces Q4's "once the CMS confirms deletion = erasure" condition.

- **2026-10-24 (later; supersedes the "9 hand lists" ruling below wherever they differ).** The Free digest goes to
  **one list only: `TaxscanNewsletterSubscribers`** (~14.8k), which the CMS fills **automatically from marketing
  consent**. The other 8 lists stay on the hand-made Mailercloud digest for now. A reader who no longer wants it
  uses the **unsubscribe link** (one-click; Mailercloud unsubscribes them account-wide and our webhook copies it to
  `EmailSuppression`) — the list itself does not remove people when consent changes, and the CMS account page has no
  email-preference switch. Consequences for this design: `DIGEST_FREE_LIST_IDS` = that one list (+ the Former tag,
  Q1); the "consent=false propagation into the hand lists" job shrinks to keeping our suppression copy current; and
  the CMS's **Q10 (v1.2: withhold the email for free/ended readers with consent=false, send account_id only)** no
  longer costs us anything — recommended YES, awaiting the owner's explicit answer. Read every "9 hand lists"
  below as "the newsletter list".
- **2026-10-24.** Paid-member data comes **only from the CMS**. The Premium digest always reflects active
  subscriptions: members who lapse stop getting it, new members start getting it, and nobody keeps Mailercloud
  lists by hand. This is a **hard prerequisite before any real reader gets the new digest** (runbook stage 3).
- **2026-10-24 (supersedes the 22 Oct audience rule for Free).** The **Free digest reuses the existing Mailercloud
  lists**: today's 9 hand lists, ~23.8k recipients (iZooto newsletter, LInkedIn, Non Paid Data Taxscan, Registered
  User, Shopscan Abandonment cart, Tawkto, Academy Abandonment cart, TaxscanNewsletterSubscribers, txnsignup). The
  Free digest is **not** redesigned around the ~84k CMS accounts. The CMS feed does three jobs only:
  - it drives **Premium membership**;
  - it **keeps paid members out of Free**;
  - it **honours CMS consent, deletion and email changes** for the addresses in those lists that match a CMS account.
- **2026-10-22.** The Premium digest is a **service email**: every active or cancelled-but-still-paid member gets it,
  whatever their marketing consent. An **unsubscribe always wins**, including over the Premium digest.
- **2026-10-22.** The Free digest goes to free sign-ups and former members **unless they gave an explicit "no"** or
  unsubscribed. The consent rule is one setting, so it can be tightened later.
- **2026-10-23.** Suppressions escalate SPAM > HARD_BOUNCE > UNSUBSCRIBE. MANUAL is never rewritten. An explicit
  opt-in dated after a suppression lifts it; MANUAL is never lifted automatically (design §3).

**Contract.** The CMS session's authoritative Feed 1 contract (24 Oct; their Appendix A and their
external-data-exchange standard) is summarised in §2. Anything we assume beyond it is marked **[A-n]** and is listed
for the CMS in §12.2. Mailercloud behaviour we have not yet verified is marked **[M-n]** and is tested on internal
addresses before any write (§6.4).

---

## 1. Shape in one paragraph

**Scope.**

- The CMS decides **who is Premium**. Status active or cancelled is in; free or ended is out.
- The Free digest keeps going to the 9 existing hand lists. On those lists, the CMS can only ever **subtract** people
  (paid members, an explicit "no", erased accounts) or **add ended members** (owner Q1). It never touches an address
  that does not belong to a CMS account.

We keep two things.

- **A mirror of every CMS reader account**, holding status, consent and `seq` but **no email address** (`CmsAccount`).
- **A per-address projection** of who belongs in which digest (`AudienceMember`). Addresses are stored only for
  people who are in a mailed role.

Three inputs feed one function, `applyAccountSnapshot()`: signed CMS webhooks, an hourly incremental pull, and a
nightly full pull. Every event and every row carries the account's complete state plus a per-account `seq`, so the
rule is simply **higher seq wins**, whichever door it came through. **Exact rule (CMS, 24 Oct):** a webhook event
applies only if `seq` > stored (equal or lower = duplicate/stale, ignored); a nightly/incremental LIST row applies if
`seq` ≥ stored (an equal-seq row re-applies idempotently and repairs drift from a missed or half-applied event; a lower
seq is skipped so the list never rolls an account back).

A single background writer turns the projection into **Mailercloud tags**. It is paced, idempotent and fail-closed,
and it never re-subscribes anyone. The digest targets those tags. A **send guard** refuses the Premium send when the
sync is stale or does not add up, and holds the variant for the day instead of mailing the wrong people.

Neither a request handler nor the digest ever calls the CMS or Mailercloud for audience data. That is the same rule
as GA, Search Console and the RSS reconciler: crons mirror into Postgres, and everything else reads Postgres.

---

## 2. The CMS contract (as designed to)

**Status and dates.** Feed 1 is designed at the CMS but not started; its prerequisites are now live. Allowlist mode
(a handful of internal accounts, on **production**, because there is no staging feed) is planned for about 30–31 Oct,
and full production for 3–4 Nov at the earliest. We build against fixtures now.

**Signing** (owner's standard, 24 Oct):

- The signed string is `<ts>.<METHOD>.<path>.<raw body>`, signed with HMAC-SHA256.
- Headers are `X-CMS-Timestamp`, `X-CMS-Signature: sha256=<hex>` and `X-CMS-Event-Id` (a nonce, refused if it repeats
  within the window).
- Clock skew is limited to ±5 min.
- Two secrets are active during a rotation. There is **one secret per door, per direction and per environment**.
- Our endpoint is IP-fenced to the CMS's production egress addresses.
- **Our GET to their list is signed the same way.** We send no bare API key.

**Events.** There are eight: `account.created`, `account.updated`, `account.email_changed`, `account.deleted`,
`subscription.started`, `subscription.renewed`, `subscription.cancelled` and `subscription.ended`.

- Every event has the same keys: `event_id` (a ULID), `event`, `seq`, `occurred_at`, `account_id` (a string),
  `email`, `name`, `plan`, `status`, `period_start`, `period_end`, `marketing_consent {value: true|false|null, at}`
  and `reactivated`.
- **Every event is a full snapshot of the account**, not a diff. That is what makes "higher seq wins" sufficient.
- `status` is one of `free | active | cancelled | ended`.
  - **active or cancelled → Premium.** Cancelled means a monthly cancel intent; the member has still paid.
  - **free or ended → not Premium.** In our scope, `ended` → the Former tag (Q1). `free` changes nothing: free sign-ups
    reach the Free digest through the existing hand lists.
- **The CMS decides when a subscription has ended**, after any grace period, firm term, refund or seat removal.
  This supersedes our own "grace period setting, default 7 days" (digest design §12): we add no grace of our own.
- `account.deleted` carries `account_id` and `seq` only. Email and name are null and the status is `deleted`.
- `reactivated: true` appears only on `account.created` (no welcome email; it does not matter to the digest).
- Trials and hour passes stay `free` and produce no subscription events. Unknown plan codes are accepted, because
  the audience is decided by `status` alone.

**Nightly list.** `GET /api/v1/push-feed/subscribers?updated_since&cursor&limit`.

- `limit` defaults to 1,000; the maximum is 5,000.
- Without `updated_since` the endpoint returns the full in-scope list. Rows have the event shape (minus `event_id`,
  `event`, `occurred_at` and `reactivated`) plus `seq`, `deleted_at` and `updated_at`. The response carries
  `meta {next_cursor, as_of}`.
- It lists readers only, never staff.

**Sizes** (CMS, 24 Oct):

- About **84,600** reader accounts.
- About **2,700** with paid access.
- About **27** with an explicit "no" to marketing consent.
- A full load is about **17 pages of 5,000**.

---

## 3. The doors

### 3.1 Every way an account's audience state can change

**Canonical function:** `src/services/audience/ingest.ts → applyAccountSnapshot(tx, snapshot, source)`. It is one
conditional upsert, `WHERE seq < $new`. When the upsert changes something, it calls `recomputeMember(tx, emailHash)`
for the old address and the new one. Nothing else writes to `CmsAccount`.

| Door | `file → function` | Behaviour |
|---|---|---|
| CMS webhook | `routes/cmsEvents.ts → POST /api/integrations/cms/events` | Checks the IP fence, then the HMAC, the skew and the nonce. Then `applyAccountSnapshot(…, 'webhook')` |
| Hourly incremental pull | `audience/pull.ts → pullIncremental()` | Pages from `updated_since = lastAsOf − 10 min`. Each row goes through `applyAccountSnapshot(…, 'pull')` |
| Nightly full pull (04:30 IST) | `audience/pull.ts → pullFull()` | Same per-row path. Adds the **absence rule** (§5.3) once the load is proven complete |
| Mailercloud webhook (exists) | `digest/webhook.ts` | Writes `EmailSuppression`. This changes what may be **added** for an address (§6.2), never its role |
| Consent lift | inside `applyAccountSnapshot` | The digest design §3 re-subscribe rule. Also the only path that may set `contact_type` (§6.3) |
| Admin | none | **Deliberately, nobody can edit a reader's role by hand.** The only admin action is "Resume sync" after the circuit breaker trips (§8.2, Blast radius) |
| Restore | `scripts/restore-backup.ts` | Restores `CmsAccount` and `AudienceMember` **without addresses** (§9). The next full pull refills them |

### 3.2 Every way a Mailercloud contact is written

**Only `src/services/audience/writer.ts → flushPending()`** writes contacts.

- It uses a **separate client** (`audience/mcContacts.ts`) that can only:
  - get a contact,
  - create a contact,
  - add or remove our three tags,
  - read tag and segment counts,
  - (behind a flag) delete a contact.
- The digest's `DigestSender` has **no contact methods**, and the contact client has no campaign methods.
- A source-scan test pins both.

### 3.3 Every door the digest can leave by

All of them already go through `runner.ts → advanceRun()` (digest design §2.1). The new audience guard (§7.2) sits
inside `scheduleStep()`, so the cron tick, Retry now, Send now, health recovery and the bearer token all meet it.
Test send stays exempt, because it goes only to internal addresses.

---

## 4. Data model

**Migration:** `2026MMDDhhmmss_cms_audience_sync`.

- New tables only, plus new `AuditAction` values.
- `EmailSuppression` gains two **nullable** columns (`accountId`, `emailHash`). `email` becomes nullable, which is a
  catalogue-only change on a table of a few dozen rows.
- No existing large table is touched.

```prisma
/// Mirror of the CMS. NO address, NO name: the hash finds the member row.
model CmsAccount {
  accountId        String    @id                 // CMS account_id (string)
  portal           String    @default("taxscan")
  seq              BigInt                        // last applied; apply only if incoming > this
  status           String                        // free|active|cancelled|ended|deleted|<unknown kept verbatim>
  plan             String?
  periodEnd        DateTime? @db.Date
  consentValue     Boolean?                      // raw tri-state
  consentAt        DateTime?
  emailHash        String?                       // sha256(normalised email); null once deleted
  deletedAt        DateTime?                     // tombstone: blocks late lower-seq events
  lastSource       String                        // webhook|pull_incr|pull_full
  updatedAt        DateTime  @updatedAt
  @@index([emailHash])
  @@index([status])
}

/// One per ADDRESS (an address can belong to several accounts). The only place an address lives.
model AudienceMember {
  emailHash       String    @id
  email           String                         // normalised; NEVER logged; not in backups
  desiredRole     String    // PREMIUM|FORMER|NONE   (memberRole(), the single definition)
  noMarketing     Boolean   // any linked account said consent=false
  suppressed      Boolean   // EmailSuppression by address OR by any linked accountId
  appliedTags     String[]  // what Mailercloud has acknowledged; [] = nothing of ours
  mcState         String    // UNKNOWN|ABSENT|PRESENT (from our own GET)
  attempts        Int       @default(0)
  nextAttemptAt   DateTime?
  lastErrorKind   String?   // RETRYABLE|FATAL — never the message (it could echo the address)
  syncedAt        DateTime?
  @@index([nextAttemptAt])
}

model CmsEventReceipt {          // nonce + event_id dedupe; reader: ingest. 30 days, then deleted.
  eventId    String   @id        // ULID from X-CMS-Event-Id (must equal body event_id)
  event      String
  outcome    String              // applied|stale_seq|unknown_type|invalid
  receivedAt DateTime @default(now())
  @@index([receivedAt])
}

model AudienceSyncState {        // one row per portal; reader: send guard, Audience card, alerts
  portal            String    @id
  lastFullAsOf      DateTime?
  lastFullOkAt      DateTime?
  lastIncrAsOf      DateTime?
  lastIncrOkAt      DateTime?
  lastWebhookAt     DateTime?
  cmsCounts         Json      @default("{}")   // from the last COMPLETE full load: {active,cancelled,free,ended}
  breakerOpenAt     DateTime?                  // writes paused
  breakerReason     String?                    // change_too_large|truncated_load|erasure_cap|...
  pendingReview     Json?                      // counts only, shown to the ADMIN who resumes
}
```

**One function owns the audience rule:** `memberRole(accounts)` in `audience/rules.ts`. It works on all non-deleted
accounts that share an address:

- **PREMIUM** if any account is `active` or `cancelled`;
- otherwise **FORMER** if any is `ended`;
- otherwise **NONE**.

A plain `free` account is NONE: the Free digest reaches free sign-ups through the existing hand lists, not through us.

`noMarketing` is true if any of those accounts has `consentValue === false`.

**An `AudienceMember` row, and with it a stored address, exists only for an address that is:**

- PREMIUM;
- FORMER;
- `noMarketing` (~27 today);
- in the middle of an erasure or email-change clean-up.

That is about 3–5k addresses, not 84k.

The consent rule (null = included) is the setting `AUDIENCE_CONSENT_RULE=exclude_false` (owner confirm, Q2). An **unknown status** leaves the account's
previous role unchanged and counts as `unknown_status`, with an alert once a day. It never grants Premium.

**Readers and lifecycle:**

| Table | Reader | Lifecycle |
|---|---|---|
| CmsAccount | `memberRole`, counts, absence rule | Kept while the account exists. Tombstones are deleted 90 days after `deletedAt` |
| AudienceMember | Writer, send guard, counts | **The row is deleted** once `desiredRole = NONE` and `appliedTags = []`. No address is kept for anyone outside a mailed role |
| CmsEventReceipt | Dedupe | 30 days, by the existing nightly sweeper pattern |
| AudienceSyncState | Guard, card | One row |

**Size and cost.** About 85k `CmsAccount` rows is ~15 MB with indexes. The nightly full pull compares `seq` and only
writes rows that changed (normally tens). Before task 5 ships, measure one full load of 85k fixture rows locally with
`EXPLAIN (ANALYZE, BUFFERS)`. Remember that the 128 MB buffer cache is shared with `Event`.

---

## 5. Ingest

### 5.1 Webhook: `POST /api/integrations/cms/events`

This is the URL already given to the CMS. It is mounted under `/api/integrations` **before** the global
`express.json`, with `express.raw({type: '*/*', limit: '64kb'})`. HMAC needs the exact bytes, and body-parser errors
must never log a body. Checks run in this order, and each stops at the first failure:

1. `AUDIENCE_SYNC_ENABLED` is off → **404** (a JSON 404 that never echoes the path).
2. The client IP is not in `CMS_FEED_ALLOWED_IPS` → **404**.
   - The IP is derived the same way as the rate limiter's `req.ip` (with `trust proxy 1`).
   - An **empty allowlist rejects everything** (fail closed, with a boot warning).
3. `X-CMS-Timestamp` is missing or more than **300 s** from our clock → **401**. Failures are rate-limited at 60/min
   per IP; valid requests are not limited.
4. The signature is checked against `CMS_FEED_INBOUND_SECRET`, then `CMS_FEED_INBOUND_SECRET_PREVIOUS`.
   - Both sides are hashed and compared with `timingSafeEqual`.
   - The path in the signed string is the **constant `/api/integrations/cms/events`**, never the path the request
     claims to be on. A proxy rewrite therefore fails closed.
   - Failure → **401**, with no detail.
5. The body is parsed and validated against the snapshot schema. A **body `event_id` different from `X-CMS-Event-Id`**
   → **400**.
6. **In one transaction:**
   - Insert `CmsEventReceipt`. A conflict means a duplicate → **200 `{duplicate: true}`**, with nothing applied.
   - An unknown `event` type is stored as `unknown_type` and not applied → **200**. The nightly pull will carry the
     state anyway.
   - Otherwise `applyAccountSnapshot`. A lower or equal `seq` → `stale_seq` → **200**.
   - `recomputeMember` locks member rows in `emailHash` order, which prevents deadlocks.
7. A storage failure → **500**, so the CMS retries rather than losing an event.

**Logging.** One line per request: `[audience] event=<type> outcome=<…> ms=<n>`. It never contains an address,
name, account id, signature or body.

**Out of order and gaps.** Because each event is a full snapshot, a gap in `seq` is harmless: the newest snapshot is
the truth. A late older event is a no-op. A tombstone blocks resurrection by any `seq` at or below the deletion's. A
higher `seq` (for example `account.created` with `reactivated: true`) revives the account.

### 5.2 Outbound pull (signed)

- `audience/cmsClient.ts` uses zero-dependency `fetch`. It signs `<ts>.GET.<path?query>.` with
  `CMS_FEED_PULL_SECRET` and sends a fresh ULID as `X-CMS-Event-Id` **[A-2]**.
- The client:
  - accepts **https only**;
  - requires the host to be in `CMS_FEED_ALLOWED_HOSTS` (default `www.taxscan.in`);
  - uses `redirect: 'error'`, so a redirect can never carry a signed request to another host;
  - times out after 30 s;
  - retries 429/5xx with jittered backoff (×3).
- **Incremental pull**, hourly at :10 IST: `updated_since = lastIncrAsOf − 10 min` (an overlap that `seq` makes
  harmless), 5,000 rows a page. When it finishes it stores `meta.as_of` from the first page.
- **Full pull**, nightly at 04:30 IST: before the backup has aged and before the 06:30 build. It is also the
  **first load**.

### 5.3 Full-load acceptance and the absence rule

A full load is **complete** only when all of these hold:

- every page returned 200;
- the last page has no `next_cursor`;
- every row parsed;
- the row count is at least 90% of the previous complete load (the first load and the allowlist → all switch go to
  review, §8.2).

An incomplete load still applies its rows, because they are real snapshots with `seq`. It **never** applies the
absence rule, and it raises `audience_full_incomplete`. This mirrors "GA syncs fail instead of writing a truncated
response" (PR #74).

**Absence rule.** A complete load that no longer lists an account we hold (not deleted) means the account is out of
scope. We set its role to NONE, which removes our tags. Absences count toward the change cap (§8.2).

### 5.4 When the webhook and the nightly load disagree

The higher `seq` wins. If the `seq` is equal and the content differs, the CMS has broken its own contract: we keep
what we have, count `seq_conflict` and alert once a day. There is no separate reconciliation logic, because the
nightly load replays the same function as the webhook.

---

## 6. Mailercloud write model

### 6.1 Membership is tags, not lists

The Mailercloud API has **no call that removes a contact from a list**. The only removal is `DELETE /contacts/{id}`,
which deletes the contact everywhere. Deleting an unsubscribed contact would also **erase its unsubscribe**, so a
later re-add would come back as active. Tags, on the other hand, can be added (on create, or through
`PUT /contacts/{email}`) and removed (`POST /contact/tag/remove`). So **membership is three tags**, all with neutral
names:

| Tag (env holds the id) | Means | Used by |
|---|---|---|
| `TS Premium (auto)` → `AUDIENCE_MC_TAG_PREMIUM` | desiredRole = PREMIUM | Premium target (the only one); Free exclude |
| `TS Former member (auto)` → `AUDIENCE_MC_TAG_FORMER` | desiredRole = FORMER (ended, not suppressed; consent ≠ false) | Free target, added to the 9 lists (owner Q1) |
| `TS No marketing (auto)` → `AUDIENCE_MC_TAG_NO_MARKETING` | noMarketing, or an erased address while deletion is off | Free exclude |

- Contacts **we create** (a Premium member with no Mailercloud contact yet) go into one dedicated list,
  `TS Members (auto)` → `AUDIENCE_MC_LIST_ID`. A list is required to create a contact.
  - This list is **not** a Free target.
  - It gives us a roster we can read back for drift checks.
- **Why a tag and not a hand list for ended members.** `PUT /contacts/{id}` "can't update the list ID". Putting an
  *existing* contact on another list therefore needs upsert or batch with `list_id`, which is exactly the
  re-subscribe risk in §6.2. A tag gives the same effect with no list write.
  - If M-6 shows a campaign cannot combine lists with a tag, the fallback is to upsert into the designated list
    (Q1). That is allowed only once M-4 proves upsert never changes an existing contact's status.

### 6.1a What the CMS can do to the 9 existing Free lists, and what it cannot

The writer only ever writes an address that **came from a CMS snapshot**. It never iterates a Mailercloud list. So
newsletter-only, abandoned-cart, Tawk.to and LinkedIn contacts with no CMS account are **never read or written**. For
an address that does match a CMS account:

| CMS fact | Effect on the Free digest | Write | Feasible? |
|---|---|---|---|
| active / cancelled | Excluded from Free (gets Premium) | Premium tag (Free excludes it) | Yes |
| explicit consent `false` | Excluded from Free, even if the address sits in a hand list | No-marketing tag (an exclusion, always allowed) | Yes, if the address exists in Mailercloud. If not, there is nothing to exclude, and the row stays so a later create carries the tag |
| `account.deleted` | Gone | Tags removed. Then **DELETE the contact** (Q4) or, with deletion off, the No-marketing tag | Yes. **M-8:** does one DELETE remove the address from every list, or are contacts per list? |
| `account.email_changed` | Premium/Former follow the person to the new address | Old address: our tags removed. New address: recomputed (created if Premium and absent) | **Partly.** Mailercloud cannot rename a contact (`PUT` cannot change the email). The old address keeps any **hand-list** membership and may still get Free until it bounces or the person unsubscribes. We do not tag the old address No-marketing, because it may be a separate newsletter sign-up. Owner note (Q5) |
| `free` with consent true/null | Unchanged: they get Free only if already in a hand list | none | Deliberately nothing |
| ended (not suppressed, consent ≠ false) | Gets Free even if in no hand list (Q1) | Former tag; created in `TS Members (auto)` if absent | Yes (tag route) |

### 6.2 Never re-subscribe anyone: the write rules

The API documents `contact_type` on batch create with **`default: active`**. It does not document what an upsert
does to an existing unsubscribed contact (open question 4 in digest design §12). So:

1. **We never send `contact_type`.** The one exception is the lift path in §6.3, which has its own flag.
2. **We create only after our own `GET /contacts/{email}` returns 404.** That path uses single-contact create
   `POST /contacts`, never upsert. **[M-1]** If the create reports that the contact already exists (a race with the
   CMS newsletter box), we switch to the existing-contact path. We never retry it as an upsert.
3. **Existing contacts get tags through `PUT /contacts/{email}` carrying `tags` only.** **[M-2]** We must confirm
   that this leaves the subscription status alone. **[M-3]** If PUT *replaces* tags rather than appending them, the
   writer GETs the contact first and sends the union, so it never drops a tag someone added by hand.
4. **Add writes are skipped for any `suppressed` member.** A member is suppressed when `EmailSuppression` holds the
   address **or any linked `accountId`**. That covers an email change carrying an opt-out over to the new address.
   **Removals and exclusion tags are always allowed**, because they can only reduce mail.
5. **Batch (`POST /contacts/batch`, ≤ 50) is not used in phase 1.** It requires `list_id`, defaults `contact_type`
   to active, and its "updated" count shows it touches existing contacts. Volumes don't need it either: about 3k
   first-time writes, then tens a day. Batch becomes an optimisation only if test M-4 proves it never changes an
   existing contact's status.
6. **Pace.** At most `AUDIENCE_WRITE_RPS` (5) requests a second, through one token bucket. That is far under the
   50 req/s per IP shared with the digest. **No writes from T−20 to T+30 min around the digest send** (07:10–08:00),
   so the audience the guard approved is the audience Mailercloud resolves.

### 6.3 Removal, re-subscribe and erasure

| Change | Mailercloud write |
|---|---|
| PREMIUM → FORMER (ended) | remove the Premium tag; add the Former tag (skipped if suppressed) |
| Free/former → PREMIUM (started) | create if absent; add the Premium tag; remove the Former tag |
| consent → false | add the No-marketing tag (an exclusion, so always allowed) |
| consent false → true/null | remove the No-marketing tag |
| `account.email_changed` | old address: recompute, which usually removes our tags. New address: recompute, and the account-keyed suppression carries over |
| Absent from a complete full load | role NONE: remove our tags |
| **Re-subscribe** (`consent.value = true`, `at` > suppression `lastSeenAt`, `at` ≤ now + 5 min) | Our `EmailSuppression` row is deleted, and a `RESUBSCRIBE` `EmailEvent` is recorded by hash (digest design §3). **Only with `AUDIENCE_RESUBSCRIBE_WRITES=true`** does the writer also `PUT contact_type=active`. This is the only place that field is ever sent. Capped at 20 a day; MANUAL is never lifted |
| `account.deleted` (erasure) | Remove our tags. Null the address in `AudienceMember` and in `EmailSuppression`, keeping `emailHash` + `accountId` so the opt-out still matches. **With `AUDIENCE_ERASE_IN_MAILERCLOUD=true`** (Q4) the writer also `DELETE`s the contact. With it off, the address gets the No-marketing tag, so a hand-list copy stops receiving Free. Capped by `AUDIENCE_MAX_ERASURES_PER_DAY` (20); above the cap the breaker trips |

**A fix that lands with this work** (noted in digest task 8). A Mailercloud replay of an old opt-out after a lift
would re-create the suppression. The suppression upsert must run **only for `EmailEvent` rows that were newly
inserted** (`createManyAndReturn` already returns them).

### 6.4 Idempotency, retries, drift, outages

- **Desired state, not an outbox.** The writer selects members where the tags they should have differ from
  `appliedTags` and `nextAttemptAt` has passed (≤ 200 per tick). It computes the diff and stores `appliedTags` only
  from a 2xx. Repeating the work is harmless, and a flapping reader collapses to one write.
- **Errors** reuse the digest client's classification.
  - **RETRYABLE** (429, 5xx, timeout): +1, +5 and +15 min, then hourly, with no end date.
  - **FATAL** (401, contact quota, 400): that member stops, and a `audience_writer_fatal` alert goes out once.
  - Failing for more than 6 h → `audience_writer_failing`.
- **Mailercloud down.** Pending work simply grows; nothing is lost and the digest is not blocked. The send guard
  holds only Premium, and only when the backlog makes the Premium tag untrustworthy (§7.2).
- **Drift check** (nightly, after the full pull):
  - (a) Our applied Premium count against Mailercloud's own count for the Premium tag **[M-5]** (read from
    `tags/search`, or else from a segment "tag = TS Premium (auto)").
  - (b) A random sample of 50 members, each read back with GET and compared tag by tag.
  - A mismatch marks the affected members for re-sync and is reported on the card.
- **Test matrix (internal addresses only, before `AUDIENCE_SYNC_WRITE_MAILERCLOUD` is ever on):**
  - **M-1**: create on an existing address fails rather than upserts.
  - **M-2**: PUT with tags keeps an unsubscribed contact unsubscribed.
  - **M-3**: PUT tags append or replace.
  - **M-4**: batch on an existing unsubscribed contact.
  - **M-5**: tag or segment counts are readable.
  - **M-6**: a campaign targeting lists + tags + segments is a de-duplicated union, and excludes apply after it.
  - **M-8**: is a contact one record across lists? Do a tag and a DELETE on `/contacts/{email}` apply to the address in every list?
  - The results are written into this document before stage S2.

---

## 7. The digest's audience wiring

### 7.1 Targets: one definition, derived

With `DIGEST_AUDIENCE_FROM_CMS=true`, `runner.ts → audienceTarget()` **derives** the tag ids from the audience config
instead of reading `DIGEST_PREMIUM_TAG_IDS` / `DIGEST_FREE_EXCLUDE_TAG_IDS`. If either of those is also set, boot logs
`config_invalid` ("set one, not both"). Two constants for one fact are how PR #50 happened.

| Variant | Target | Excludes |
|---|---|---|
| Premium | the Premium tag. **Stage 3 only:** `DIGEST_PREMIUM_SEGMENT_IDS` = a Mailercloud segment "Premium tag AND pilot list". Lapsed members still drop out, because the segment is built on our tag | — (a service email; Mailercloud's own unsubscribe still applies) |
| Free | `DIGEST_FREE_LIST_IDS` = **the 9 existing hand lists** (owner, 24 Oct), plus the Former tag (Q1) | **Premium tag + No-marketing tag, always derived.** Neither can be removed by config |

### 7.2 The send guard: fail closed

`audience/guard.ts → audienceGuard(audience, now)` is called inside `scheduleStep()` before `schedule()`. It is a pure
function over `AudienceSyncState` plus counts.

**PREMIUM refuses when any of these is true:**

- the last complete full load is older than `AUDIENCE_MAX_STALE_HOURS` (26 h);
- no successful pull or webhook for 3 h;
- the breaker is open;
- members whose Premium tag is still pending number more than `max(1%, 10)`;
- Mailercloud's Premium count differs from our applied count by more than `max(AUDIENCE_PREMIUM_DEVIATION_PCT` 2%,
  25);
- the CMS's active + cancelled count differs from our desired Premium count by more than the same tolerance.

**FREE refuses only when** the Premium tag count is 0, or the sync is more than 72 h stale. In either case the
premium exclude cannot be trusted, and paid members would be shown the subscription ad.

**A refusal:**

- leaves the variant CREATED with `nextAttemptAt` = the next minute, so the guard clears by itself once sync catches
  up;
- raises the `audience_unverified` alert (email + banner, once per run) naming the failing check in plain words;
- at 17:00 becomes **SKIPPED `audience_unverified`**, and the variant rolls forward as usual.

**Approval does not override it.** Send now meets the same guard.

### 7.3 How the runbook stages change

| Stage | Change |
|---|---|
| 1 (shadow) / 2 (internal) | Unchanged. They run **in parallel** with sync stages S0–S3 (§10); internal lists only |
| **3 (engaged pilot)** | **New prerequisite: sync stage S4 signed off** (7 clean nights). Then `DIGEST_AUDIENCE_FROM_CMS=true`; Premium = the pilot segment on our tag; Free = the ~1,000-opener segment, with both derived excludes. Pilot readers are still removed from the hand-made digest |
| **4 (full)** | Premium = the Premium tag (unset the segment); Free = the 9 hand lists + the Former tag, with both derived excludes. The hand-made Premium list "Taxscan premium News Roundup" stops being a target; nobody edits it again |

---

## 8. Security

### 8.1 Why this is secure (plain words, for the owner)

1. Only the CMS can change who is a member. Every message it sends is signed with a secret only the CMS and Railway
   hold, must arrive within 5 minutes, can be used once, and must come from the CMS's own server address.
2. The feed can only *report* account state. It cannot send email, change templates or reach anything else, and no
   person in the admin can flip a reader to Premium either.
3. If something looks wrong (data too old, numbers that don't add up, or a sudden large change), the system
   **stops and asks an admin** instead of mailing the wrong people. A missed Premium digest is the worst case.
4. Email addresses are stored only for people we actually mail. They are never written to logs, alerts or backups,
   and the admin shows counts, never lists.
5. An unsubscribe or an explicit "no" always wins, and an account deletion at the CMS removes the person here too.

### 8.2 Threat model

| Threat | What could happen | Control |
|---|---|---|
| **Spoofed webhook** | A forged event grants Premium or removes members | HMAC over `ts.METHOD.path.body`. IP fence (an empty allowlist rejects everything). The path is pinned to our constant. 404 for the fence, 401 for the signature, no detail in either |
| **Replayed webhook** | A captured real event is re-sent | ±300 s skew; the `X-CMS-Event-Id` nonce is stored for 30 days (well beyond the window); body `event_id` must equal the header; and `seq` makes any old snapshot a no-op |
| **Spoofed pull response** | Someone answers our GET pretending to be the CMS | https only, the host allowlisted, `redirect: 'error'`, and TLS verification never disabled **[A-3: ask whether responses are signed too]** |
| **Stolen secrets** | Forging events, or reading the reader list | There are **three distinct secrets**: inbound (+ previous), outbound pull, and the Mailercloud sync key. They live **only in Railway** (owner pastes them; never in chat, a file, a URL, an audit row, an error or a log line; `redactText` gets every secret). Rotation: the CMS adds the new secret, we set `…_PREVIOUS` = old and the main var = new, and unset the old one after 24 h. The outbound secret rotates the other way round (the CMS accepts two). **Prerequisite:** the pending Postgres password window (Railway breach, 21 Oct) is completed **before the first full load** puts reader data in the database |
| **Tampering from inside** | An admin flips a reader, or mass-deletes | There is no role editor and no per-reader screen. The only action is "Resume sync" (ADMIN only, ConfirmPush, audited with counts). Audit rows are append-only at the database level |
| **Blast radius** | A CMS bug, a truncated load, or the allowlist → all switch moves thousands | **Circuit breaker.** Writes to Mailercloud pause (data still lands in Postgres) when any of these happen: one run would change roles for more than `max(AUDIENCE_MAX_CHANGE_PCT` 5%, 100) of mailed members; Premium removals in 24 h exceed `max(3%, 50)`; erasures exceed 20 a day; or a full load is truncated. The admin gets an alert with counts only. The send guard holds Premium meanwhile. **The first load is always reviewed** |
| **Data exposure at rest** | Addresses leak from the DB, logs or backups | Addresses exist only in `AudienceMember` (mailed roles) and `EmailSuppression`. `CmsAccount` holds hashes. Backups strip addresses (§9). R2 stays private. `lastError` stores a kind, never a provider message |
| **Data exposure in the admin** | Someone browses readers | **ADMIN sees counts; PUBLISHER sees one status line** ("Audience in sync, 2 h ago" or "Premium held: sync stale"). No lists, lookups or exports are built |
| **Transport** | Interception | https everywhere. The inbound route rejects plain http (Railway terminates TLS, so `X-Forwarded-Proto` is checked). Outbound is https only |
| **Least privilege** | One key does everything | A separate `MAILERCLOUD_SYNC_API_KEY`, revocable on its own (the account allows 10 keys; Mailercloud keys are not scoped **[M-7]**), used only by the contact client, which by construction cannot create or send a campaign. The CMS feed's only effect is account state |
| **Failure safety** | Stale or untrusted data mails the wrong people | Every doubt resolves to "don't send Premium today": the send guard, an unknown status kept as is, an incomplete load never removes anyone, the breaker. **Removals and exclusion tags stay allowed** while additions are blocked |
| **Consent / DPDP** | Mailing someone who said no; keeping data after erasure | Explicit `false` → the No-marketing exclusion on Free (an always-allowed write). Unsubscribes, bounces and spam are honoured from our copy *and* Mailercloud's. Opt-outs follow the account across an email change. `account.deleted` → tags removed, address nulled here (hash kept so the opt-out still holds), optional Mailercloud deletion (Q4). Re-subscribe needs an opt-in dated after the opt-out |

---

## 9. Backup, restore, retention

**Backup v3** adds `CmsAccount` and `AudienceMember` **with `email` stripped**, as an empty string with a header flag.

- Addresses are re-derivable from the CMS, and minimisation beats convenience in R2.
- `appliedTags` is kept, so a restored system still knows which Mailercloud tags exist and can remove them.
- `CmsEventReceipt` and `AudienceSyncState` are left out.
- `EmailSuppression` keeps its addresses, as in v2: an opt-out cannot be re-derived. Rows nulled by erasure stay
  hash-only.
- v1 and v2 files still restore.

**After a restore:**

- Members have no address and `AudienceSyncState` is empty. The send guard therefore **holds Premium** until a
  complete full load has run. Run `npm run audience:pull-full` by hand.
- Writes resume only after that load. A restore always counts as a "first load" and goes through review.
- This joins the "digest stays off until Mailercloud is checked" step in `docs/BACKUPS.md`. Unlike VAPID, nothing
  here is half of every restore: the CMS is the source.

**Retention:**

- receipts: 30 days;
- tombstones: 90 days;
- member rows: deleted when they leave every role;
- `AuditLog`: 90 days, as settled.

---

## 10. Flags, observability, tests

### 10.1 Rollout flags (all default OFF)

| Variable | Effect |
|---|---|
| `AUDIENCE_SYNC_ENABLED` | Webhook route + pulls write **Postgres only**. Off: the route 404s, and boot logs `[audience] disabled (set AUDIENCE_SYNC_ENABLED=true to start)`. That line is the **marker for a backend-only deploy** |
| `AUDIENCE_SYNC_WRITE_MAILERCLOUD` | Writer on. Off: the writer runs **dry**, logging `would_add= would_remove=` (counts only) |
| `DIGEST_AUDIENCE_FROM_CMS` | Derived digest targets + the send guard |
| `AUDIENCE_RESUBSCRIBE_WRITES` | The §6.3 `contact_type=active` path |
| `AUDIENCE_ERASE_IN_MAILERCLOUD` | DELETE on erasure (Q4) |

**Settings:**

- `AUDIENCE_FORMER_TO_FREE` = `true` (Q1; `false` means ended members get no Former tag);
- `AUDIENCE_CONSENT_RULE` = `exclude_false`;
- the thresholds named above.

**Secrets / config:**

- `CMS_FEED_INBOUND_SECRET` (+ `_PREVIOUS`), `CMS_FEED_PULL_SECRET`, `MAILERCLOUD_SYNC_API_KEY`;
- `CMS_FEED_BASE_URL`, `CMS_FEED_ALLOWED_HOSTS`, `CMS_FEED_ALLOWED_IPS`;
- `CMS_FEED_ALLOW_CUSTOM_PORT` (default off): a non-default port on `CMS_FEED_BASE_URL` is refused without it;
- `AUDIENCE_MC_LIST_ID`, `AUDIENCE_MC_TAG_*`.

Secrets must be at least 32 characters, or they are treated as unset.

**Sync stages** (each is a deliberate Railway change):

- **S0**: deploy dark.
- **S1**: ingest on, CMS in allowlist mode with internal accounts, Postgres only.
- **S2**: the M-tests on internal addresses, then writes on for them.
- **S3**: CMS goes to all. The first full load is reviewed, then two nights dry-run, then writes on.
- **S4**: 7 consecutive clean nights (complete load, drift 0, breaker closed). This **unlocks digest stage 3**.

### 10.2 Admin visibility

An **Audience card on Digests**. All of it comes from Postgres.

- **ADMIN** sees:
  - counts (Premium: CMS / ours / Mailercloud; Former; No-marketing; pending writes);
  - the last webhook, incremental and full pull;
  - errors in the last 24 h by kind;
  - the breaker with its reason and counts, and **Resume** (confirm, audited `AUDIENCE_SYNC_RESUMED`).
- **PUBLISHER** sees the one-line status.

**Alerts** go through the existing digest alerts (ElasticEmail + banner):

- `audience_unverified`
- `audience_breaker_open`
- `audience_full_incomplete`
- `audience_writer_failing` / `_fatal`
- `audience_webhook_silent` (no event for 48 h while the CMS is live)
- `unknown_status` / `seq_conflict` (daily)

**New `AuditAction` values:**

- `AUDIENCE_SYNC_RESUMED`
- `AUDIENCE_FULL_LOAD` (system, counts)
- `AUDIENCE_ERASURE` (system, count)
- `AUDIENCE_RESUBSCRIBED` (system, hash)

### 10.3 Tests (fixtures; a fake CMS; a fake Mailercloud)

- **Fixtures:** one per event type, plus a deleted account, a reactivated account, an email change, consent
  true/false/null, an unknown status, an unknown event, and two accounts sharing an address.
- **Fake CMS:** a local Express server serving the paged list (with cursor, `as_of`, truncation and 5xx on demand)
  and verifying **our** signature.
- **Fake Mailercloud:** contact semantics are switchable for M-1…M-4, so both behaviours are tested. It records every
  request.

**Gates pinned in both directions:**

| Gate | Blocks | Allows |
|---|---|---|
| Signature | wrong secret / body changed by 1 byte → 401, no row | current or previous secret → applied |
| Skew | 301 s → 401 | 299 s → applied |
| Nonce | second delivery → duplicate, nothing applied | first → applied |
| Seq | lower/equal seq → no change | higher seq → applied; a gap is fine |
| IP fence | non-listed or empty list → 404 | listed → continues |
| Tombstone | late lower-seq event after a delete → ignored | higher-seq re-create → revived |
| Absence | truncated load → nobody removed | complete load → absent account loses its tags |
| Breaker | 6% change → writes paused | 4% → written |
| Suppressed add | suppressed (by address or account) → no add | removal + No-marketing tag still written |
| contact_type | never present in any request body (all fakes) | only on the lift path with its flag |
| Guard | 27 h stale / 3% deviation / breaker → Premium held, then SKIPPED at 17:00 | 25 h, in tolerance → scheduled |
| Free guard | Premium tag count 0 → Free held | > 0 → sent, with both derived excludes in the payload |
| Lift | `at` ≤ `lastSeenAt` or MANUAL → nothing | `at` > `lastSeenAt` → row deleted + `RESUBSCRIBE` |

**Also tested:**

- No address appears in any log line, `lastError`, audit row, alert or backup file (asserted on the raw output).
- The backup v3 round trip.
- **Mutation checks:**
  - drop the IP fence;
  - use the request path in the HMAC;
  - `>=` for seq;
  - remove the suppressed-add skip;
  - send `contact_type` by default;
  - apply absence on a truncated load;
  - delete the guard call from `scheduleStep`.

---

## 11. Build plan (each task Developer → QA, on `develop`, flags off)

**Buildable now, against fixtures:**

1. **Schema + flags + boot marker.** The migration, env parsing (secret length, https, empty IP list = reject), and
   the `[audience] disabled` line.
2. **`src/lib/cmsSignature.ts`.** Sign and verify, both directions, two secrets, constant path, skew. Fixtures
   pinned to hex vectors that we then send to the CMS to cross-check.
3. **Rules + ingest core.** `memberRole`, `applyAccountSnapshot`, `recomputeMember`, tombstones, the consent lift,
   and the account-keyed suppression (with the replay fix from §6.3).
4. **Webhook route.** Raw body, ordering of checks, receipts, logging.
5. **Pull client + full/incremental + acceptance + breaker**, with the fake CMS. EXPLAIN on 85k fixture rows.
6. **Contact client + writer** (desired-state diff, pacing, send-window pause, drift check), with the fake
   Mailercloud in both behaviours.
7. **Digest wiring.** Derived targets, `audienceGuard` in `scheduleStep`, status/alerts.
8. **Audience card + Resume route.**
9. **Backup v3 and retention sweeps.**
10. **Docs:** this file's "Built" notes, the runbook (stages S0–S4, the stage-3 prerequisite), `BACKUPS.md`, and the
    Guide.

**Built notes.**

- **Task 1 — built 2026-10-24** (flags off). Migration `20261024100000_cms_audience_sync`: the four §4 tables, the
  four §10.2 `AuditAction` values, and on `EmailSuppression` nullable `emailHash` (unique) + `accountId` (indexed)
  with `email` made nullable. `parseAudienceEnv()` in `src/lib/env.ts` (`env.audience`): every §10.1 flag default
  off; secrets < 32 chars count as unset; the webhook and list secrets must differ; `CMS_FEED_BASE_URL` https only,
  no credentials/query, host on `CMS_FEED_ALLOWED_HOSTS`; `CMS_FEED_ALLOWED_IPS` plain IP literals, **empty =
  reject** (`isCmsIpAllowed`); `DIGEST_AUDIENCE_FROM_CMS` + explicit digest tag ids = "set one, not both".
  Problems name variables, never values. Boot: `src/services/audience/boot.ts` prints `[audience] disabled …`
  (or `config_invalid — not started: <names>`). The four secrets are in `logSecrets()`. Deviations from §4,
  driven by contract v1.1: `CmsEventReceipt.signedTs` (door W replay rule: same `event_id` + same timestamp = 401,
  newer timestamp = the CMS's retry → 2xx, not re-applied); `AudienceMember.email` nullable (§6.3 erasure);
  `CMS_FEED_ALLOWED_HOSTS` default `api.taxscan.in` (the contract's door L host, not `www`). Not done here, for
  task 3: backfilling `EmailSuppression.emailHash` and writing it on new suppressions.
- **Task 2 — built 2026-10-24.** `src/lib/cmsSignature.ts`, pinned to the CMS's A.6 vectors from **contract v1.2**
  (fixtures `src/__tests__/fixtures/cms-feed-v1.2/`: all ten A.5 bodies byte for byte, the A.7 list page, the A.6
  vectors; v1.1's POST vector `58e4dc92…` is withdrawn and asserted NOT to verify). Our outbound vectors for the CMS
  are in `docs/cms-signature-vectors.md`. v1.2's `erasure` key and withheld email/name are task 3's (a
  `CmsAccount.erasedAt`-style column, if needed, is a further additive migration). Contract v1.1 supersedes §5.2 on our GET: headers
  `X-Push-Timestamp` / `X-Push-Signature` and a **signed `nonce` query parameter** (32 lower-case hex), not
  `X-CMS-Event-Id`; the payload is the canonical query, not `path?query`.

- **Prep for task 3 — built 2026-10-24** (QA findings on tasks 1–2). Migration `20261024120000_email_suppression_hash`:
  a `BEFORE INSERT/UPDATE` trigger sets `EmailSuppression.emailHash = sha256(email)` whenever `email` is set (nulling
  the address keeps the hash), plus a backfill. The Mailercloud webhook now upserts on `emailHash` (a hash-only
  row is escalated, never duplicated, and keeps `email` null), writes suppressions **only for newly inserted
  `EmailEvent` rows** (§6.3: a replay cannot re-create a lifted suppression), stamps the one live `CmsAccount`
  onto the row and marks the `AudienceMember` suppressed (`afterSuppressionWrite`). `src/services/suppression.ts`
  is the single matcher (email OR hash OR accountId) and `restoreSuppressionRow` (address → hash → id; a restore
  never brings back an erased address). Config: problems print at boot while off; raw short secrets are in
  `logSecrets()`; `CMS_FEED_ALLOWED_IPS` compares canonical forms (`src/lib/clientIp.ts`); a non-default port
  on `CMS_FEED_BASE_URL` needs `CMS_FEED_ALLOW_CUSTOM_PORT=true`.

**Needs the CMS or Mailercloud:**

- the signature cross-check with real vectors (task 2);
- allowlist-mode round trip (S1, ~30–31 Oct);
- the M-tests on internal addresses (S2);
- the first full production load (S3, earliest 3–4 Nov).

S4 needs 7 clean nights, so digest stage 3 can start around **11–12 Nov at the earliest**.

---

## 12. Open questions

### 12.1 For the owner

1. **Ended (expired) paid members with consent not "no": add them to the Free digest?**
   **Recommendation: yes, through a "TS Former member (auto)" tag that the Free campaign targets alongside the 9
   lists.**
   - The tag does the same job as adding them to a designated list such as "txnsignup" or "Registered User", without
     the list write that risks re-subscribing someone (§6.1).
   - If Mailercloud cannot combine lists with a tag in one campaign, we fall back to "txnsignup". That needs your OK
     on which list.
2. **"Not stated" consent (null):** stays in the Free digest; only an explicit "no" excludes.
   **Recommendation: confirm** (your 22 Oct rule; only ~27 said no).
3. **Premium digest and unsubscribes.** Your rulings: Premium is a service email regardless of the consent flag, and
   an unsubscribe always wins (a Mailercloud unsubscribe stops the Premium digest too).
   **Recommendation: confirm both, and build no separate "service" channel now.**
4. **An account deleted at the CMS: also delete the contact in Mailercloud** (which removes it from the hand lists
   too)?
   **Recommendation: yes**, capped at 20 a day, once the CMS confirms that deletion always means an erasure request.
   Until then the address only gets the No-marketing tag.
5. **Email changes.** Mailercloud cannot rename a contact, so the *old* address stays on any hand list it was on and
   may keep getting Free until it bounces or unsubscribes.
   **Recommendation: accept this.** Premium moves to the new address automatically, and stopping the old address
   could cut off a genuine separate newsletter sign-up.
6. **CMS build order: nightly list + webhooks first, article views later.**
   **Recommendation: yes.** The digest already falls back to GA for reads.
7. **Guard numbers:** hold Premium if the data is over 26 h old or off by more than 2% (or 25 people); pause sync on
   a change above 5% (or 100 people).
   **Recommendation: accept these.** Tune them after S4.

**Note only (your call, no recommendation asked).** Risks of reusing the 9 hand lists for the automated Free digest:

- **Abandoned-cart lists** (Shopscan, Academy) are contacts from a purchase attempt, not a newsletter opt-in.
- **Tawk.to** (chat visitors), **LinkedIn** and **"Non Paid Data Taxscan"** have no recorded consent source that we
  know of, so they may include contacts who never asked for news by email.
- **The iZooto newsletter list's** consent was collected through a vendor that has stopped.
- Under DPDP these are the contacts most likely to complain. Today's Free send shows a low complaint and bounce
  count (13 hard bounces, 1 unsubscribe on 23.8k), and the 0.3% automatic hold still protects every send.
- The CMS feed can only clean these lists where an address matches a CMS account.

### 12.2 For the CMS team

1. **[A-1]** The production egress IP(s) for our fence: are they stable, is there IPv6, and how will a change be
   announced?
2. **[A-2]** The exact signed string for our GET. Does it include the query string, and with what encoding? Is the
   empty body `""`? Do you want `X-CMS-Event-Id` on our requests as a nonce?
3. **[A-3]** Are list **responses** signed too? (Optional; we rely on TLS + the host allowlist.)
4. The timestamp format (unix seconds?). Which response codes you retry, and on what schedule. Is it one event per
   POST? Is a 4xx retried?
5. Does `account.deleted` always mean erasure? Does the full list include deleted rows (`deleted_at`), and for how
   long?
6. Please add **`meta.counts {active, cancelled, free, ended}`** to full-list responses (our send guard compares
   against them) and the count of `ended` accounts today.
7. In allowlist mode, does the list return only the allowlisted accounts? Please tell us the moment it switches to
   all (our breaker will ask for review by design).
8. Can two accounts share an email address? Does a firm seat have its own account and address?
9. Is `seq` one sequence per account across events **and** list rows, including `account.deleted`?
10. When consent changes, is it sent as `account.updated` with `marketing_consent.at` = the moment of the change?
11. Any rate limit on the list endpoint, and is cursor paging stable while rows change?
12. Hex test vectors for the signature (a fixed secret, ts and body) so both sides prove the same bytes.
