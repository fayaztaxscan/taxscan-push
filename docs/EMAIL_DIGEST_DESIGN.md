# Automatic daily email digest: design (phase 1)

Status: **DESIGN, not built.** Written 2026-10-22 for owner review. Nothing in this document is
enabled; every behaviour below sits behind flags that default OFF.

Owner rulings this design is bound by (all 2026-10-22):

- At most **one digest per audience per day**. A digest is **never re-sent** and **never sent late on a
  later day**.
- Content is **frozen at the morning build**. It covers stories since the previous digest's build. A
  late retry the same day sends the same frozen version.
- Retries run at **+1, +5 and +15 min after the first failure, then every hour until 17:00 IST**. After
  17:00 the day is **skipped**, and its 2–3 top stories roll into tomorrow's digest (excluding anything
  already sent).
- **Non-retryable errors** alert admins at once and are not retried: quota or funds (Email API 9002), a
  bad key (401), a validation error (400). If someone fixes the cause before 17:00, the health check or
  "Retry now" sends that day's digest.
- **Partial send:** recipients who were reached are done. Recipients who were not reached get the
  roll-forward stories in tomorrow's digest.
- Alerts go through a **different channel** from the one that failed (ElasticEmail, which already sends
  our report emails), plus a banner in the admin.
- **No ad slot is ever empty.** Premium readers never see the subscription ad. They get a substitute ad
  in that slot.
- Templates go **Draft → Active → Archived**, with **one ACTIVE template per audience**. Every template is
  responsive at all sizes.
- **Expired members get the free digest** once a grace period has passed. This comes in a later phase:
  phase 1 has no CMS feed.

---

## 1. Goal, scope, non-goals

**Goal.** Each morning, build one digest of taxscan.in's best new stories, ranked the way the push
pipeline already ranks them. Send it to two audiences through the Mailercloud API without anyone having
to assemble it by hand. Fix the known defects of today's hand-made digest along the way:

Every defect found in two of today's digest copies (22 Oct 2026, sent identically to both audiences) has a
fix here. Each fix is either enforced by code (the template validator or the renderer refuses to proceed)
or is a gate in the rollout (§10), so none of them can quietly come back.

| # | Defect in today's digest | Fix in this design | Enforced by |
|---|---|---|---|
| 1 | No RFC 8058 one-click unsubscribe (List-Unsubscribe is `mailto:` only) | Campaign sends carry Mailercloud's own unsubscribe headers, which we cannot set through the campaign API. **Rollout gate:** a live send to staff must show `List-Unsubscribe` with an https URL **and** `List-Unsubscribe-Post: List-Unsubscribe=One-Click` before stage 3 (§10). If it is missing, stage 3 stops and the owner decides (account setting, or sending through the Email API, which lets us set both headers) | Rollout gate |
| 2 | HTML ~98 KB, close to Gmail's ~102 KB clip | Size budget: warn at 80 KB, **refuse at 90 KB** of HTML, checked when a template is saved and on every build | Validator + renderer |
| 3 | Stale visible date ("Oct 15 2026" on a 22 Oct mail; inconsistent case) | Date is generated from `runDate` in IST, one fixed format ("22 October 2026") | Renderer |
| 4 | Subject is not the lead story | Subject = the lead story's headline (≤ 90 chars) | Renderer |
| 5 | All-or-nothing unsubscribe ("opt out of all type of emails") | Campaigns are created with Mailercloud's `mailing_preference` on, so the footer offers **manage preferences** as well as unsubscribe; footer wording no longer says "all types". Service mail to paid members (later phase) uses the Email API stream, so a digest unsubscribe never blocks it | Template footer block + campaign payload |
| 6 | No postal address | A footer block the template cannot remove | Validator |
| 7 | Empty preheader (inbox shows "Oct 15 2026 View this email in your browser") | Preheader generated: "Plus N more: <2nd headline>…", sent as `email_preheader` and as hidden preview text | Renderer + validator |
| 8 | 26 images, all `alt=""` | Every image needs alt text; article thumbnails get the headline as alt | Validator + renderer |
| 9 | `noreply@` From and Reply-To | **Monitored reply address** on the verified sending subdomain (owner-approved) | Config (refuses a `noreply` address) |
| 10 | 15 items per mail (rulings + ICAI + explainers + job ads) | **Cap 12**, minimum 5; phase 1 takes only queue-approved items, so unreviewed explainers and job posts stay out (owner-approved) | Builder |
| 11 | No visible premium benefit; both groups get the same copy | Separate **Premium** variant: its own active template (premium header label), no subscription ad, its own ad pool | Builder + ad picker |
| 12 | Paid members shown "Subscribe now — ₹2,599/year" | Ad picker filters by audience, plus a hard guard that refuses a subscription ad in a Premium send; the slot is filled from the pool, never left empty | Ad picker (fails closed) |
| 13 | Ad text and "Buy now" exist only inside images | Every ad has a live-text headline + a real CTA button + alt text | Ads screen validation |
| 14 | Ad images heavy (1080×1080, ~200–225 KB each, shown at 300 px), plus a desktop/mobile copy swap | **One scalable creative per ad** (≤ 1200 px wide, ≤ 150 KB); no `display:none` swaps. **Total image weight budget per email: 600 KB**, with a warning on build | Ads validation + renderer |
| 15 | "46% off" with no end date; the same ads every day | Every ad has start/end dates (expired offers drop out on their own) and rotates by priority within its slot | Ad picker |
| 16 | No conversion attribution (Mailercloud conversions = 0) | UTM on every article and ad link; each ad placement recorded per send for later order matching | Renderer |
| 17 | Generic header banner from April; copy-of-copy campaign names ("Copy (85) … (Copy)") | Header comes from the active template; campaign names are generated ("Taxscan Digest · 22 Oct 2026 · Free") | Template + runner |
| 18 | Not designed for every screen or for dark mode | Fluid single column, works without media queries, Outlook fallback, ≥ 16 px body, ≥ 44 px taps; **dark-mode check** in the template preview (logos and colours readable on dark backgrounds) | Template validator + preview |

**In scope (phase 1):**

- Pick the stories, rank them and freeze them.
- Render two variants: **Free** and **Premium**.
- Create, schedule and verify one Mailercloud campaign per variant.
- Run the retry and roll-forward state machine.
- Receive webhooks: unsubscribe, hard bounce and spam reports feed our suppression copy and reporting.
- Alerts and an admin banner.
- Three admin screens: **Digests**, **Templates** and **Ads**.

**Non-goals (phase 1). Each one leaves a seam:**

- **Lifecycle mail** (welcome, renewal due, expiry after the grace period, win-back). The seam: the
  `Sender` interface gains a `sendTransactional()` method, and `EmailSuppression` already exists for
  those sends to check.
- **CMS → contact-tag sync** (premium / free / expired, plus nightly reconciliation). The seam: audiences
  are referenced by Mailercloud list, segment or tag IDs held in config. When tags start being maintained
  automatically, the digest code does not change.
- **Per-reader frequency or overlap across push and email.** The seam: `EmailSuppression` and
  `EmailEvent` key readers by a normalised address or its hash.
- **Conversions to Academy or Shop orders.** The seam: every link carries UTM parameters, and every ad
  placement is recorded per send.
- Manual or promotional campaigns. These stay in Mailercloud's own UI.

---

## 2. Architecture and data flow

```
                      ┌────────────── existing push pipeline (unchanged) ──────────────┐
 taxscan.in RSS ──►   │ poller.ts → classify.ts → Campaign rows (sendQueue, authority,  │
 + sitemap reconciler │ categories, createdAt = capture time)                           │
                      └──────────────────────────────┬─────────────────────────────────┘
                                                     │ read-only SELECT, once a day
                                                     ▼
 node-cron (1/min, IST) ─► digest/runner.ts  advanceRun()   ◄── the ONE door (see §2.1)
        │                    │
        │   T−60 min         ├─► builder.ts   select + rank + dedupe + roll-forward
        │                    │                 → DigestRun + DigestItem rows (FROZEN)
        │                    ├─► ads.ts       fill every slot per audience → DigestAdPlacement
        │                    ├─► renderer.ts  active template × items × ads → html + text
        │                    │                 (size budget, UTM, footer) → DigestSend.html (frozen)
        │                    ├─► health.ts    Mailercloud client-details ──┐ on failure:
        │                    ├─► sender.createDraft()  (is_publish "0")     │ alerts.ts → ElasticEmail
        │                    │      → DigestSend.mcCampaignId persisted     │ + /api/digest/status banner
        │   T (07:30?)       ├─► gates: flag · quiet hours · approval · cutoff · one-per-day
        │                    ├─► sender.schedule(mcCampaignId, now)  ── same id on every retry
        │   T+10m … 17:00    └─► sender.status(id) / campaign_sent webhook → SENT | PARTIALLY_SENT
        │
 Mailercloud ──webhook──► POST /api/webhooks/mailercloud/:token ─► webhook.ts
   (unsubscribe, hard_bounce, spam, campaign_sent, campaign_error)   → EmailEvent (no address)
                                                                      → EmailSuppression
 Admin SPA: Digests · Templates · Ads ──► /api/digest/* (cookie or bearer, role-gated)
```

Our own components do all the selection, ranking, rendering and bookkeeping. Mailercloud does the
actual sending, list hygiene and its own unsubscribe handling. Because the request path never calls
Mailercloud for ordinary screens, a Mailercloud outage leaves those screens working. (The exceptions are
"test send" and the actions that are explicitly retries.)

### 2.1 The doors: every way a digest can leave

There is one canonical function: **`src/services/digest/runner.ts → advanceRun(runId, trigger)`**. It
takes a run one step forward (build → create → schedule → verify) and enforces every gate *inside*
itself:

- the flag
- quiet hours, checked against the send instant
- the 17:00 cut-off
- approval
- max one per audience per day
- frozen content: the stored html is what gets sent and is never re-rendered
- fail-closed audience config

No other code calls `sender.schedule()`.

| Door | `file → function` | Behaviour |
|---|---|---|
| Morning cron + retry tick | `digest/scheduler.ts → tick()` | Calls `advanceRun(today, 'cron')` when `nextAttemptAt <= now`. |
| Admin "Retry now" | `routes/digest.ts → POST /runs/:id/retry` | `advanceRun(id, 'retry')`. Skips the wait (`nextAttemptAt`) and nothing else. |
| Admin "Send now" (ConfirmPush) | `routes/digest.ts → POST /runs/:id/send-now` | `advanceRun(id, 'send_now')`. Moves the send instant earlier. Refused once a variant is SCHEDULED, SENT or SKIPPED. |
| Health-check recovery | `digest/health.ts → onRecovered()` | After a FATAL failure, a passing check calls `advanceRun(today, 'health')`, before 17:00 only. |
| Bearer `ADMIN_TOKEN` curl | the same routes | The same function and the same gates. |
| Test send (Digests or Templates) | `digest/testSend.ts → sendTest()` | **Exempt by design.** It creates a separate `TEST-…` draft and calls only `sender.testSend()`. It has no reference to `schedule()`. Recipients must be active app users or be listed in `DIGEST_TEST_RECIPIENTS`. |
| Mailercloud's own UI | (outside our code) | Someone could duplicate or send our campaign by hand there. We cannot gate that. Our campaign names carry a `TS-DIGEST-` prefix, and the Guide says not to touch them. |

---

## 3. Data model (Prisma)

Migration: **`2026MMDDhhmmss_email_digest`**. It contains only new tables, plus new values on the
`AuditAction` enum (`ALTER TYPE … ADD VALUE`, which takes a momentary lock). No existing table is
altered or backfilled, and `Event`/`Campaign` are untouched. The digest never writes to push's `Event`,
so `campaignStats()` and the push retention rule are not affected.

```prisma
enum DigestAudience   { FREE PREMIUM }
enum DigestBuild      { BUILDING BUILT BUILD_FAILED SKIPPED }
enum DigestApproval   { NOT_REQUIRED PENDING APPROVED HELD }
enum DigestSendState  { PENDING CREATED SCHEDULED SENT PARTIALLY_SENT FAILED SKIPPED }
enum SenderErrorKind  { RETRYABLE FATAL AMBIGUOUS }

/// One per IST calendar day. The unique (portal, runDate) IS the "max one per day" rule.
model DigestRun {
  id               String         @id @default(cuid())
  portal           String         @default("taxscan")
  runDate          DateTime       @db.Date          // IST date
  windowStart      DateTime                         // = previous run's builtAt (cap 72 h)
  builtAt          DateTime?                        // freeze instant = next run's windowStart
  build            DigestBuild    @default(BUILDING)
  skipReason       String?        // too_little_news|cutoff_passed|not_approved|held_by_editor|
                                  // build_failed|config_invalid|sanity_hold_expired
  approval         DigestApproval @default(NOT_REQUIRED)
  approvedByUserId String?
  approvedAt       DateTime?
  candidateCount   Int            @default(0)       // for the re-platform sanity guard
  healthOk         Boolean?
  healthCheckedAt  DateTime?
  healthError      String?
  alerts           Json           @default("{}")    // {kind: sentAt}, so one alert per kind per run
  createdAt        DateTime       @default(now())
  sends            DigestSend[]
  items            DigestItem[]
  @@unique([portal, runDate])
}

/// One per (run, audience): each variant is its own Mailercloud campaign with its own state.
model DigestSend {
  id               String          @id @default(cuid())
  runId            String
  audience         DigestAudience
  state            DigestSendState @default(PENDING)
  templateId       String?
  subject          String
  preheader        String
  html             String?         // FROZEN at build; nulled after DIGEST_HTML_RETENTION_DAYS
  text             String?
  htmlBytes        Int
  mcCampaignName   String          @unique   // TS-DIGEST-2026-10-23-FREE-<runId>
  mcCampaignId     String?         @unique   // persisted the instant create returns
  sendAfter        DateTime                  // planned send instant (Send now moves it earlier)
  scheduledAt      DateTime?                 // when we called schedule
  sentConfirmedAt  DateTime?
  sentVia          String?                   // status_poll | webhook
  stepClaimedAt    DateTime?                 // DB claim; protects against two containers mid-deploy
  attempts         Int             @default(0)
  firstFailureAt   DateTime?
  nextAttemptAt    DateTime?
  lastError        String?                   // truncated, email-shaped substrings redacted
  lastErrorKind    SenderErrorKind?
  targeted         Int?                      // from the Mailercloud report
  reached          Int?
  opens            Int?                      // aggregate from the report API, trend only
  clicks           Int?
  rolledUnsub      Int             @default(0)   // EmailEvent rows folded by the sweeper
  rolledBounce     Int             @default(0)
  rolledSpam       Int             @default(0)
  run              DigestRun       @relation(fields: [runId], references: [id], onDelete: Cascade)
  placements       DigestAdPlacement[]
  @@unique([runId, audience])
  @@index([state, nextAttemptAt])
}

/// The frozen story list. Keyed by articleKey (taxscan's trailing id), NOT by GUID or Campaign id,
/// so a re-GUID'd or re-captured article still dedupes against earlier digests.
model DigestItem {
  id         String          @id @default(cuid())
  runId      String
  rank       Int
  section    String          // MAIN | ICYMI
  audience   DigestAudience? // null = both; ICYMI from a one-variant failure carries that audience
  articleKey String
  campaignId String?         // provenance; SetNull if the Campaign row goes
  title      String
  url        String
  authority  String?
  category   String          // reportCategory(), the coverage report's own rule
  excerpt    String?
  capturedAt DateTime
  run        DigestRun       @relation(fields: [runId], references: [id], onDelete: Cascade)
  @@unique([runId, articleKey, audience])
  @@index([articleKey])
}

model DigestTemplate {
  id               String         @id @default(cuid())
  name             String
  audience         DigestAudience
  status           String         // DRAFT | ACTIVE | SCHEDULED | ARCHIVED
  source           String         // MJML (if approved) or HTML, with our {{placeholders}}
  compiledHtml     String         // compiled at SAVE time; the send path never compiles
  layout           Json           // {maxItems, adSlots:[afterItem…], sections:[…]}
  subjectPattern   String         @default("{{lead.title}}")
  preheaderPattern String
  startsAt         DateTime?      // SCHEDULED overrides only, e.g. Budget week
  endsAt           DateTime?
  replacesId       String?        // the template it displaced, which one-click revert restores
  validation       Json           // last check: alt, unsubscribe, address, preheader, bytes
  createdByUserId  String?
  createdAt        DateTime       @default(now())
  updatedAt        DateTime       @updatedAt
  @@index([audience, status])
}
// Raw SQL in the migration: CREATE UNIQUE INDEX one_active_template_per_audience
//   ON "DigestTemplate"(audience) WHERE status = 'ACTIVE';   (the DB enforces "one ACTIVE")

model DigestAd {
  id              String    @id @default(cuid())
  name            String
  kind            String    // HOUSE | SUBSCRIPTION | RENEWAL; SUBSCRIPTION is never eligible for PREMIUM
  headline        String
  altText         String
  body            String?
  ctaText         String
  linkUrl         String    // must pass isAllowedPushUrl(); UTM is added at render, never stored
  imageId         String?
  audience        String    // ALL | FREE_ONLY | PREMIUM_ONLY ("exclude premium" = FREE_ONLY)
  topic           String?   // matched against the lead items' report category
  slots           Int[]     // empty = any slot
  priority        Int       @default(0)
  isSlotDefault   Boolean   @default(false)   // fallback for its slots
  startsAt        DateTime?
  endsAt          DateTime?
  status          String    // ACTIVE | PAUSED | ARCHIVED
  createdByUserId String?
  updatedAt       DateTime  @updatedAt
  @@index([status])
}

model DigestAdImage {               // a single scalable creative, 1200 px wide (shown at ≤600)
  id        String   @id           // sha256 of the bytes; served at /email-assets/<id>.<ext>
  mime      String
  width     Int
  height    Int
  bytes     Bytes                  // ≤ 150 KB, validated, not resized
  createdAt DateTime @default(now())
}

model DigestAdPlacement {           // reader: ad rotation (least recently used) + per-ad report
  id         String     @id @default(cuid())
  sendId     String
  adId       String
  slot       Int
  utmContent String
  createdAt  DateTime   @default(now())
  send       DigestSend @relation(fields: [sendId], references: [id], onDelete: Cascade)
  @@index([adId, createdAt])
}

/// Webhook events. NO email address stored here, only a hash for dedupe.
model EmailEvent {
  id           String   @id @default(cuid())
  provider     String   @default("mailercloud")
  type         String   // UNSUBSCRIBE | HARD_BOUNCE | SPAM | CAMPAIGN_SENT | CAMPAIGN_ERROR
  mcCampaignId String?
  sendId       String?
  emailHash    String?  // sha256(normalised address)
  dedupeKey    String   @unique   // provider retries must not double-count
  meta         Json?
  receivedAt   DateTime @default(now())
  @@index([sendId])
  @@index([receivedAt])
}

/// Our copy of who must not be mailed. Mailercloud enforces its own list for campaigns; this copy is
/// what future lifecycle sends check, and what restores opt-outs after a disaster.
model EmailSuppression {
  id          String   @id @default(cuid())
  email       String   @unique    // normalised lowercase; NEVER logged
  reason      String              // UNSUBSCRIBE | HARD_BOUNCE | SPAM | MANUAL
  source      String              // mailercloud_webhook | manual
  firstSeenAt DateTime @default(now())
  lastSeenAt  DateTime @default(now())
}
```

**One definition for the displayed run state.** The owner's vocabulary for a run is building, created,
scheduled, sent, partially_sent, failed and skipped. That state is *derived* by a single function,
`digestRunState(run, sends)`, from `DigestRun.build` and the `DigestSend.state` values. It is never
stored in a second place.

**Readers and lifecycle.** Every new table names who reads it and when its data goes.

| Table | Reader | Lifecycle |
|---|---|---|
| DigestRun / DigestSend | Digests history and banner | Kept (~365 + 730 rows/yr); `html`/`text` nulled after 30 days |
| DigestItem | Dedupe (90 days), roll-forward, history | Kept (~5k rows/yr) |
| DigestTemplate / Ad / AdImage | Builder, admin screens | Archived, never deleted |
| DigestAdPlacement | Rotation, per-ad report | Kept (~2k rows/yr) |
| EmailEvent | Per-send unsubscribe/bounce/spam counts, complaint-rate alert, webhook liveness | **90 days, then folded into `DigestSend.rolled*` and deleted.** Rolled + live: `digestSendStats()` is the single implementation. |
| EmailSuppression | Future lifecycle sends, suppression count on the Digests screen | **Never deleted automatically** (an opt-out persists) |

**Backup.** Add `DigestTemplate`, `DigestAd`, `DigestAdImage` and `EmailSuppression` to `backup.ts`.
Opt-outs and creative work cannot be re-derived after a restore.

**Query cost.** The builder reads `Campaign` by `portal` + `createdAt` range once a day. There is no
`createdAt` index today. Before deciding whether to add `@@index([portal, createdAt])`, run
`EXPLAIN (ANALYZE, BUFFERS)` on prod (read-only). A once-a-day sequential scan may well be fine.

---

## 4. Services and modules (`src/services/digest/`)

| Module | Responsibility |
|---|---|
| `sender.ts` | The **`DigestSender` interface** and the Mailercloud implementation (`mailercloud.ts`). Methods: `health()`, `createDraft(input) → {campaignId}` (always `is_publish: "0"`, so it cannot send), `schedule(id, 'now')`, `status(id) → {state, targeted, reached}`, `report(id) → {opens, clicks}`, `testSend(id, emails)`. Every failure is a typed `SenderError {kind, code, http}`: 429/5xx/timeout → RETRYABLE; 401, 400, 9002 → FATAL; a timeout *after* the request was sent on create/schedule → AMBIGUOUS. Auth goes in the `Authorization: <key>` header, **with no `Bearer ` prefix**. Backoff inside one call: exponential with full jitter on 429/5xx, at most 3 tries, 10 s timeout each. There is no Retry-After header to honour. Uses zero-dependency `fetch`. Tests inject `FakeSender`. |
| `builder.ts` | Picks candidates and freezes them (§4.1). |
| `ads.ts` | `pickAds(slots, audience, items, at)`. For each slot, the eligible ads are those that are ACTIVE, inside their date window, match the audience, allow the slot and are not already used in this email. They are ordered: topic match, then priority, then least recently placed. If none is eligible, the slot's default ad is used; if there is no default either, the build **fails closed** with `config_invalid` and an alert. **A second guard:** `kind = SUBSCRIPTION` is rejected for PREMIUM whatever its `audience` field says. |
| `renderer.ts` | Substitutes into the template's `compiledHtml` and escapes all text. It adds the visible date, the subject (= the lead headline, ≤ 90 chars), the preheader ("Plus N more: <2nd headline>", ≤ 110 chars), the non-removable footer (postal address and Mailercloud's unsubscribe tag) and the plain-text part. `withUtm(url, {campaign, content})` is the single UTM function: `utm_source=taxscan-digest&utm_medium=email&utm_campaign=digest-YYYYMMDD-free&utm_content=item3\|ad-<id>-slot2`. **Size budget:** rendered bytes + (number of links × 150 B for Mailercloud's tracking rewrite) must stay under `DIGEST_MAX_HTML_KB` (90). It warns at 75 KB. Over budget, the lowest-ranked MAIN items are dropped until the email fits, and the drop is logged. |
| `runner.ts` | `advanceRun()`, the state machine and the only door (§2.1). Each step first claims its row with a conditional update (`updateMany where state = X and (stepClaimedAt is null or older than 10 min)`), the same claim pattern as `Campaign.claimedAt`. |
| `retryPolicy.ts` | A pure function, `nextAttemptAt(firstFailureAt, attempts, cutoff)`: +1 m, +5 m, +15 m, then +1 h each, returning `null` at or past 17:00 IST. |
| `scheduler.ts` | node-cron `* * * * *` (tz Asia/Kolkata), guarded by an in-process lock. Creates today's run at T−60, then hands everything to `advanceRun`. Runs the cut-off sweep at 17:00. |
| `health.ts` | Calls `GET client-details` at T−75 and at T−15, then hourly while a FATAL error is open. Checks the webhook status once a day. |
| `webhook.ts` | Verifies the token, normalises the payload, writes EmailEvent (deduped) and upserts EmailSuppression. Answers 200 quickly for any event type it recognises or ignores. |
| `alerts.ts` | Sends one email per (run, kind) to active ADMIN users through the existing `defaultEmailSender` (ElasticEmail), and sends a matching "recovered" note. Never throws. The banner stays up even if the alert email itself fails. |
| `testSend.ts` | Creates a `TEST-` draft and calls `testSend` for allowed internal addresses only. |

### 4.1 Selection, ranking, freeze (builder)

1. **Window** = `(previous run.builtAt, now]`, whatever state the previous run ended in, so afternoon
   stories appear exactly once, the next day. The window is capped at 72 h. On the first-ever run it is
   the last 24 h.
2. **Candidates:**
   - `Campaign` rows for portal `taxscan`, whose `url` is a taxscan.in article (the reports'
     `isArticleUrl`), with `sendQueue` QUALIFIED or FALLBACK.
   - REVIEW items are excluded unless an editor approved them. Approval moves them to QUALIFIED. This
     also excludes job posts and anything the duplicate-headline guard held.
   - Status may be DRAFT, SENT or EXPIRED. Whether an item was pushed is irrelevant to email; EXPIRED is
     usually retention, not deletion.
3. **Dedupe** by `articleKey()` (reused from `reports.ts`). This collapses morning-backfill clones and
   re-captures. It also drops any key already in a SENT or PARTIALLY_SENT digest for that audience in
   the last 90 days. This is the defence against upstream changes: when the CMS re-GUIDs, re-captured
   stories do not reappear.
4. **Rank** with a digest comparator, `rankDigest`: QUALIFIED before FALLBACK, then
   `authorityTier()` (the single definition in `classify.ts`: SC → Bombay HC → other HC → regulatory),
   then newest first. We **deliberately do not reuse `rankQualified`**: its first key (today before
   yesterday) is a pacing rule. Inside a 24 h digest window it would push yesterday's Supreme Court
   ruling below a 06:00 regulatory note.
5. **Roll-forward first.** If the previous run was SKIPPED, or a variant was PARTIALLY_SENT, FAILED or
   SKIPPED, take up to `DIGEST_ROLLFORWARD_ITEMS` (3) of that run's top frozen items for that audience.
   Exclude any key that is in today's list or already in a sent digest. These go in an **"In case you
   missed it"** section *inside* the normal item cap.
6. **Link check** each selected URL. This is fail-open (only 404/410 drop an item) and reuses
   `isUrlDeadDefault`.
7. **Guards:**
   - If there are fewer than `DIGEST_MIN_ITEMS` (5) MAIN items, the run is SKIPPED with
     `too_little_news`. Its items still roll forward.
   - If there are more than `DIGEST_SANITY_MAX_CANDIDATES` (150; normal is ~25–35 a day), the run is held
     for an editor even in auto mode. This is the 2026-09-28 re-platform scenario.
8. **Freeze:** write `DigestItem` rows and `builtAt`. Render both variants. Store `html`, `text` and
   `subject`. **Nothing re-renders after this point.**

---

## 5. Flags, env vars, schedule

All flags default OFF. The owner sets them on Railway.

| Variable | Default | Purpose |
|---|---|---|
| `DIGEST_ENABLED` | `false` | Master switch. When off, the scheduler logs `[digest] disabled (set DIGEST_ENABLED=true to start)`. That line exists only in the new build, so it is the **marker that proves a backend-only deploy**. When on, the scheduler builds, renders, creates drafts, previews and checks health, but sends nothing to an audience unless the next flag is on. |
| `DIGEST_SEND_LIVE` | `false` | Allows `schedule()` to the configured audiences. When off, the run stops at CREATED and the history shows `preview only`. |
| `DIGEST_APPROVAL_REQUIRED` | `true` | An editor must approve before the send. |
| `DIGEST_WEBHOOKS_ENABLED` | `false` | When off, the webhook route answers 404. |
| `MAILERCLOUD_API_KEY` | — | Railway secret, set by the owner. Without it, the scheduler logs "not configured" and the banner says so. The app does not crash. |
| `MAILERCLOUD_WEBHOOK_TOKEN` | — | ≥32 random bytes (hex), used in the webhook URL path. |
| `MAILERCLOUD_SENDER_NAME` / `_SENDER_EMAIL` / `_REPLY_EMAIL` | — | `sender_email` must be a verified sender in Mailercloud. |
| `DIGEST_SEND_AT` | `07:30` | IST. **Refused at boot** (the scheduler is not started) if it falls inside 23:00–07:00 or after the cut-off. |
| `DIGEST_BUILD_LEAD_MINUTES` | `60` | Build and create the draft at T−60, so failures surface before the send time. |
| `DIGEST_CUTOFF` | `17:00` | Owner ruling. |
| `DIGEST_MAX_ITEMS` / `_MIN_ITEMS` / `_ROLLFORWARD_ITEMS` | `12` / `5` / `3` | |
| `DIGEST_SANITY_MAX_CANDIDATES` | `150` | |
| `DIGEST_FREE_LIST_IDS`, `DIGEST_FREE_EXCLUDE_LIST_IDS`, `DIGEST_FREE_EXCLUDE_TAG_IDS` | — | **Fail closed:** the Free campaign is never created without an exclude for premium. |
| `DIGEST_PREMIUM_LIST_IDS` / `_SEGMENT_IDS` / `_TAG_IDS` | — | |
| `DIGEST_TEST_RECIPIENTS` | — | Extra internal addresses allowed for test sends. |
| `DIGEST_POSTAL_ADDRESS` | — | Required. The build fails closed if it is empty. |
| `DIGEST_MAX_HTML_KB` / `_HTML_WARN_KB` | `90` / `75` | |
| `DIGEST_HTML_RETENTION_DAYS` / `EMAIL_EVENT_RETENTION_DAYS` | `30` / `90` | |

**Daily timeline** (IST, with the default 07:30 send):

| Time | What happens |
|---|---|
| 06:15 | Health check |
| 06:30 | Build, freeze, render, create both drafts. In approval mode, editors get a "ready for approval" email. |
| 07:15 | Health check |
| 07:30 | Schedule (send now) if approved |
| +10 m, +30 m, +60 m, then hourly | Verify the send (status poll, or the webhook marks it SENT earlier) |
| 17:00 | Cut-off sweep: anything not SCHEDULED or SENT is marked SKIPPED, and alerts go out |
| 03:45 | Nightly retention: fold EmailEvent rows, null old html |

We call `schedule` with **"now" at T** rather than passing a future `scheduled_at` when the draft is
created. This avoids the open question of which timezone `scheduled_at` uses, and it keeps the approval
gate on our side.

---

## 6. API endpoints

All routes live in a new `src/routes/digest.ts`, mounted at `/api/digest`. "Any user" means a cookie
session or the `ADMIN_TOKEN` bearer (`requireBearerOrUser()`). "Admin" means `requireBearerOrUser(['ADMIN'])`.

| Method and path | Gate | |
|---|---|---|
| `GET /status` | any user | Banner payload: today's derived state, last error, whether the webhook is alive, whether config is valid. |
| `GET /runs?days=14` · `GET /runs/:id` | any user | History; detail with items, variants and placements. |
| `GET /runs/:id/preview/:audience` | any user | The frozen HTML, served with `Content-Security-Policy: sandbox` and shown in a sandboxed iframe. |
| `GET /preview/today/:audience` | any user | Before the build: a **dry-run** preview that is not persisted and not frozen. |
| `POST /runs/:id/approve` · `/hold` · `/unhold` | any user (recommendation; see §12) | Audited. |
| `POST /runs/:id/retry` · `/send-now` | any user | Through `advanceRun` only. `send-now` requires `confirm: true`, which the SPA sends from ConfirmPush. |
| `POST /runs/:id/test-send` | any user | `{audience, to[]}`; every recipient must be an active user or in `DIGEST_TEST_RECIPIENTS`. |
| `GET/POST /templates`, `PUT /templates/:id`, `POST /templates/:id/{validate,preview,test-send,activate,schedule,archive}`, `POST /templates/revert/:audience` | admin | `activate` refuses a template that fails validation. |
| `GET/POST /ads`, `PUT /ads/:id`, `POST /ads/:id/archive`, `POST /ad-images` | admin | `ad-images` uses `express.raw({limit: '200kb'})` on that route only. The global JSON limit stays at 64 KB. |
| `GET /email-assets/:sha.(jpg\|png)` | **public** | `Cache-Control: immutable`, `Cross-Origin-Resource-Policy: cross-origin`. |
| `POST /api/webhooks/mailercloud/:token` | **public**, token, rate-limited | A wrong token gets 404. The token comparison is timing-safe. |

**New `AuditAction` values:**

- `DIGEST_APPROVED`, `DIGEST_HELD`, `DIGEST_SEND_NOW`, `DIGEST_RETRY`, `DIGEST_TEST_SENT`
- `DIGEST_SCHEDULED` (system), `DIGEST_SKIPPED` (system)
- `DIGEST_TEMPLATE_SAVED`, `DIGEST_TEMPLATE_ACTIVATED`, `DIGEST_TEMPLATE_ARCHIVED`, `DIGEST_TEMPLATE_REVERTED`
- `DIGEST_AD_SAVED`, `DIGEST_AD_ARCHIVED`

---

## 7. Admin screens (Vue SPA)

All three screens use the existing visual system, `stack` tables on phones and `useApi`.

- **Digests:**
  - A "Today" card with the derived state, the next attempt time, and the last error in plain words.
  - Free and Premium tabs, each previewing the frozen email (or the dry run before 06:30) at
    **phone 375, tablet 768 and desktop 1024** widths in sandboxed iframes, with the subject, preheader
    and size shown.
  - Buttons: **Approve**, **Hold**, **Test send to me**, **Send now** (ConfirmPush, worded "Send today's
    digest to ~N readers now?" with Cancel focused) and **Retry now**. Retry now is shown only on a
    FAILED variant before 17:00.
  - A 14-day history table: date, state per variant, items, reached, unsubscribes, spam reports,
    bounces, opens (marked "trend only").
  - The same amber banner pattern as the Reports email banner, also shown on the Dashboard while today's
    digest is not sent past T+30 m, or when config, health or the webhook is failing.
- **Templates:**
  - A list by audience, with status chips Draft / Active / Scheduled / Archived.
  - An editor with a source pane, a live preview using real recent data at three widths, and a
    validation checklist that blocks activation: alt text on every image, unsubscribe tag, postal
    address, preheader, and size at or under the budget (with a warning band).
  - Activate (confirm), Schedule for dates, Archive, **Revert to previous** (one click, audited), and
    Test send.
- **Ads:**
  - A list with each ad's status, window, audience, slots, priority and "default for slot N".
  - Upload one creative (JPEG/PNG, 1200 px wide, ≤150 KB) and enter headline/alt, body, CTA text and a
    link. The link is rejected if it is not on the allowlist. A preview shows the UTM that will be
    appended.
  - A per-slot coverage check: "Slot 3 — Premium: no eligible ad and no default ✗". This error stops
    the build, so it is shown on this screen, not discovered at 06:30.

**Phone rules (existing):** 16 px fields, the hamburger menu at ≤1024 px, and full-size confirm buttons.

---

## 8. Failure modes

| Failure | Detection | Behaviour | Alert |
|---|---|---|---|
| Health check fails at T−75 or T−15 | `health()` error | The run continues; the send attempt decides | Email + banner ("Mailercloud unreachable / key rejected") |
| Build throws (DB blip) | Exception in builder | `BUILD_FAILED`, retry policy, window recomputed on retry | After the 3rd failure |
| Too little news | MAIN < 5 | SKIPPED `too_little_news`; items roll forward | Banner info only (not an error) |
| Sanity guard (re-platform) | candidates > 150 | Hold for an editor; at cut-off SKIPPED `sanity_hold_expired` | Email at once |
| Slot unfillable, no postal address, no premium exclude | Config validation at build | `config_invalid`, **no create** | Email at once |
| Create: 429, 5xx or timeout before send | RETRYABLE | +1/+5/+15 m, then hourly to 17:00 | Email on the first failure, then on recovery |
| Create: ambiguous timeout | AMBIGUOUS | Never re-created blindly: look the draft up by its unique name (`findCampaignByName`) and adopt it, or create only if none exists. Without a lookup: FAILED until a human Retry now. `mcCampaignId` is persisted the moment a create returns. | Email (names the draft) |
| 401, 400, 9002 | FATAL | **No retry.** The health check polls hourly; on recovery before 17:00, `advanceRun` resumes the same frozen version | Email at once |
| Schedule fails | RETRYABLE / AMBIGUOUS | Check `status(id)` first; if it is already scheduled or sending, advance. Otherwise re-schedule the **same id**. A second campaign is never created. | Email |
| Scheduled, but not sent after 3 h | Status poll | FAILED → re-issue schedule on the same id, within the window | Email |
| Mailercloud stops partway | `campaign_error` webhook or status with `reached < targeted` | PARTIALLY_SENT; no re-send; top 3 go to tomorrow's ICYMI for that audience | Email + banner |
| Not approved by T | Approval PENDING | Wait; the tick re-checks every minute; at 17:00 SKIPPED `not_approved` | Banner from T; email at T+60 m |
| Cut-off passes in any non-sent state | 17:00 sweep | SKIPPED `cutoff_passed`; roll forward | Email |
| Our app down at T | Next tick after restart | It is just a late attempt; same version; before 17:00 | Banner |
| Two containers during deploy | Step claim (`stepClaimedAt`) | The second container sees the claim and does nothing | — |
| Webhook deactivated by Mailercloud | Daily webhook status check; or SENT by poll with no `campaign_sent` webhook within 2 h | Polling still verifies sends; suppression copy lags | Email + banner ("re-enable webhook") |
| Webhook replay or duplicate | `dedupeKey` unique | Ignored, 200 | — |
| ElasticEmail itself down | Alert send fails | Logged; the banner is the backstop | Banner |
| `DIGEST_SEND_AT` set inside quiet hours | Boot validation | Scheduler not started | Boot log + banner `config_invalid` |
| Complaint rate > 0.3% on a send | Webhook counts / reached | Hold tomorrow's run for approval even if approval is off | Email |

---

## 9. Security and privacy

- **Links:** every article and ad link must pass `isAllowedPushUrl()`, the same allowlist and the same
  function push uses. This is checked when an ad is saved *and* again at render, where a non-allowlisted
  item is dropped. UTM parameters are added at render only.
- **Roles:** Templates and Ads are ADMIN-only. Templates hold raw HTML, so all previews render in
  `sandbox` iframes with a CSP sandbox header and never in the SPA's own origin context. Every approve,
  hold, send-now, retry, test send, template change and ad change writes an audit row.
- **Webhook:** Mailercloud offers no signature, so the URL carries a 256-bit secret token. The route
  is public but rate-limited, compares the token in constant time, and is off unless
  `DIGEST_WEBHOOKS_ENABLED`. Because the token is in a URL path, it may appear in edge access logs. To
  rotate it: set a new value on Railway, then update the webhook URL in Mailercloud. Accepting the old
  and new tokens for a while makes the change painless.
- **Secrets:** `MAILERCLOUD_API_KEY` and `MAILERCLOUD_WEBHOOK_TOKEN` exist only as Railway secrets. The
  client never puts the key into an error message, a log line or `lastError`.
- **PII:**
  - Email addresses are **never logged**.
  - `EmailEvent` stores only a SHA-256 of the normalised address.
  - `lastError` and alert texts pass through a redactor that masks anything email-shaped.
  - `EmailSuppression` holds addresses because an opt-out must be matchable and exportable. It is shown
    as a count only in phase 1.
  - Test sends can reach only internal addresses.

---

## 10. Testing and rollout

**Unit and integration tests.** These use a `FakeSender` with scriptable failures per step, plus one
HTTP-level fake of Mailercloud: a local Express server on an ephemeral port that exercises the real
`mailercloud.ts`. The HTTP fake checks the auth header has no "Bearer", backoff with jitter on 429/5xx,
timeouts, and the mapping of 401/400/9002 to FATAL. Run these under the standing resource rule (one
suite run at a time, `maxWorkers: 2`).

Each gate is pinned **in both directions**:

| Gate | Blocks | Allows |
|---|---|---|
| Quiet hours | Send at 06:59 IST | 07:00 |
| Cut-off | 17:00 → SKIPPED | 16:59 still attempts |
| Approval | Unapproved → no schedule | Approved → schedule called once |
| One per day | Second `advanceRun` after SCHEDULED or SENT calls nothing | — |
| Same id on retry | Retry after a schedule failure never calls `createDraft` again | Stored id reused |
| Free audience | Free campaign without a premium exclude is never created | Payload carries the exclude |
| Premium ads | A SUBSCRIPTION ad never reaches PREMIUM, even with `audience: ALL` | It still reaches FREE |
| Allowlist | Off-host ad link rejected | Allowlisted host accepted |
| Webhook token | Wrong token → 404, no row | Right token → 200, row written once on replay |

Selection and failure-handling tests:

- **Re-GUID scenario:** a new Campaign row with the same trailing id as an item in yesterday's digest is
  excluded.
- **Roll-forward:** a skipped day's top 3 appear in ICYMI tomorrow, and never if already sent.
- **Partial send:** ICYMI goes to the affected audience only.
- `nextAttemptAt` is checked against a table of cases, including attempts that land on the 17:00
  boundary.
- **Size:** the 12 longest headlines from fixtures plus 3 ads plus link overhead stay under 90 KB.
- `digestRunState()` gives the same answer for every combination of states.

**Mutation checks:** each of these edits must make at least one test fail.

- Flip the quiet-hours comparison
- Change `<` to `<=` at the cut-off
- Delete the `mcCampaignId` reuse branch
- Remove the premium exclude
- Remove the SUBSCRIPTION guard
- Drop the 90-day dedupe
- Let a test send call `schedule`

**Rollout (each stage is a deliberate flag or config change on Railway):**

1. **Shadow week:** `DIGEST_ENABLED=true`, `DIGEST_SEND_LIVE=false`. The digest builds, renders and
   creates drafts daily; nothing reaches readers. Editors compare it with the hand-made digest. Verify
   the boot marker, health checks, size and alerts (force a 401 with a bad key on a test run).
2. **Internal list:** `DIGEST_SEND_LIVE=true`, with both audiences pointed at an internal Mailercloud
   list of about 10 staff addresses, and approval required. One week. On a **real delivered** email
   (not a test send), check: RFC 8058 one-click headers, Gmail not clipping, and rendering in Gmail web
   and app, Apple Mail iOS, Outlook desktop and web, and Yahoo. Exercise the webhook with an
   unsubscribe from a staff address.
3. **Engaged pilot:** Free = a segment of ~1,000 recent openers; Premium = ~200 members. Approval stays
   on for 1–2 weeks. **These people must be excluded from the hand-made daily digest in Mailercloud**,
   or they get two digests a day. Watch spam complaints (<0.1%), unsubscribes and bounces per send.
4. **Full:** Free ≈ 10,066 and Premium ≈ 2,700. The hand-made daily digest stops for these lists.
   Whether approval stays on is the owner's choice (§12).

---

## 11. Load estimate

- **Recipients:** at most ~12,766 a day (10,066 Free + ~2,700 Premium). That is ≈ 3.83 lakh emails a
  month, all sent by Mailercloud.
- **Our calls to Mailercloud:** about 20–40 a day (2 health checks, 2 creates, 2 schedules, ~10 status
  polls, report pulls, occasional test sends). That is far under 50 req/s.
- **Webhooks in:** at ~0.1–0.3% unsubscribes plus bounces and spam reports, roughly 20–60 a day, plus 2
  `campaign_sent`.
- **Database growth:** about 15 DigestItem, 2 DigestSend, 6 placement and ~50 EmailEvent rows a day.
  Frozen html is ~2 × 50 KB a day, kept 30 days, so about 3 MB. Negligible next to `ArticleReadStat`'s
  2.2 MB a day.
- **CPU:** rendering is string substitution. MJML, if approved, runs only when a template is saved.

---

## 12. Decisions

**Approved by the owner (2026-10-22):**

- **Provider: to be confirmed by the owner when the API is set up.** This document details the Mailercloud
  campaign-v2 route. All provider calls sit behind the `DigestSender` interface (`health`, `createDraft`,
  `schedule`, `status`, webhook parsing), so a different sending API can be plugged in by writing another
  implementation of that interface; the builder, renderer, runner, retry rules, templates, ads and
  admin screens do not change. Task 2 (§13) waits for this confirmation; task 1 does not depend on it.
- **Send time: 07:30 IST** (the build runs at 06:30; the cut-off at 17:00 IST). **All digest times are IST**,
  computed by our own scheduler; Mailercloud is only ever told to send "now", so its `scheduled_at`
  timezone does not matter.
- **Pilot:** an internal list, then a small engaged segment. If approval is missing at send time, the
  digest **holds until the cut-off**, then skips. Auto-send is decided before going to full.
- **MJML** approved, on condition that one Railway build is verified on a branch first.
- **Roles:** publishers may approve, hold, Send now and Retry (like Push now); Templates and Ads are admin-only.
- **Item cap 12**, minimum 5. **Content:** queue-approved items only (no unreviewed explainers or job posts).
- **Reply address:** a monitored address on the verified sending subdomain, replacing `noreply@`.
- **Ad images:** validated (≤ 1200 px wide, ≤ 150 KB), not resized; hosted at `push.taxscan.in/email-assets`.
- **ICYMI after a partial send:** accepted (readers already reached may see 2–3 stories again, labelled).
- **Grace period before "expired"** (later phase): a setting, default 7 days.

**Still open (owner checks in the Mailercloud account; do not ask Mailercloud support):**

1. Are API access and the Email API included in the current plan, or billed separately?
2. Do **live** campaign sends carry RFC 8058 one-click unsubscribe? (Also a rollout gate; §1 defect #1.)
3. Before stage 2: the exact unsubscribe merge tag; that `mailing_preference` shows a preference link;
   whether a v2 draft (`is_publish "0"`) can be scheduled through v1 `schedule/{id}`; that re-scheduling a
   scheduled or sent campaign is rejected or a no-op, never a second send; the campaign status values;
   whether there is a webhook-status read endpoint.
4. Can a batch upsert re-subscribe an unsubscribed contact? Tested on internal addresses before any contact
   sync (later phase). Phase 1 never writes contacts.
5. Pilot membership: the internal addresses and the engaged segment. **Pilot readers must be removed from
   the hand-made Mailercloud digest**, or they get two digests a day.

---

## 13. Task breakdown (build order)

Each task is small, lands on `develop` behind the flags, and is Developer → QA. No pushes or merges by
agents.

1. **Flags and skeleton.** Add the env parsing for §5, the migration (DigestRun, DigestSend, enums, the
   audit values) and a `scheduler.ts` that only logs.
   *Accept:* with flags OFF the boot log shows `[digest] disabled …`. With `DIGEST_ENABLED=true` and no
   key, it logs "not configured" and does not crash. A send time inside quiet hours is refused at boot.
2. **Mailercloud client behind `DigestSender`.** Implement `health`, `createDraft` (`is_publish "0"`),
   `schedule`, `status`, `report` and `testSend`, with error classification, jittered backoff and the
   HTTP fake.
   *Accept:* tests prove there is no Bearer prefix, that 429→retry→success works, that 401/400/9002 are
   FATAL with no retry, and that a timeout on create or schedule is AMBIGUOUS. The key never appears in
   errors.
3. **Retry policy and runner state machine** (with FakeSender and fixed placeholder content).
   *Accept:* the both-direction tests for quiet hours, cut-off and one-per-day pass; the stored id is
   reused; the step claim blocks a second runner; `digestRunState()` is checked against a table.
   *Built 2026-10-22 (`runner.ts`, `retryPolicy.ts`, `runState.ts`, `sender.ts`, TEMPORARY
   `placeholderContent.ts`; tests `digestRunner` + `digestRetryPolicy`). Resolutions of this document:*
   - **Governing rule: `schedule()`/`createDraft()` only when we can PROVE they were not already called
     for that variant.** Proof is a write-ahead marker (`DigestSend.scheduleAttemptedAt` /
     `createAttemptedAt`, migration `20261022135030_digest_step_markers`) set in the same atomic claim
     update, before the provider call. A set marker (ambiguous reply, crash, stale takeover, Retry now,
     Send now) means "ask the provider first": `status()` (accepted → SCHEDULED, DRAFT → schedule again,
     FAILED → terminal, unknown → no call + `schedule_unconfirmed` alert) or `findCampaignByName`
     (adopt, or create only if none exists). Every decision is taken from a row re-read after its claim.
   - **AMBIGUOUS create is never repeated blindly** (stricter than the §8 row): `DigestSender` gains an
     optional `findCampaignByName(name)`; task 2 should implement it. Without it, the variant goes FAILED
     with an `ambiguous_create` alert naming the draft; only a human Retry now / Send now creates again
     (worst case an inert orphan draft: only the saved id is ever scheduled). The create marker is cleared
     only when the provider provably did not act (FATAL, 429, or no HTTP reply); a 5xx keeps it.
   - Each step keeps its own retry sequence (`stepAttempts` / `stepFirstFailureAt`): +1, +5, +15, then
     +75, +135 … min from that step's first failure. Create out of time → SKIPPED (no id, nothing could
     send). Schedule out of time → no more calls; the 17:00 sweep asks the provider and skips only on DRAFT.
   - Quiet hours and the cut-off are re-checked on a fresh clock immediately before `schedule()`.
   - The cut-off sweep skips a variant only when it was provably never scheduled (marker null) or the
     provider says DRAFT; otherwise SCHEDULED/SENT, or FAILED `not_confirmed_by_cutoff` + alert. A
     SCHEDULED variant gets one last `status()`.
   - **A campaign the provider reports FAILED is terminal for the day** (Retry now / Send now / health
     return `refused` with the reason): re-scheduling waits for open question 3. A known reach > 0 is
     PARTIALLY_SENT; an unknown reach stays null. The §8 "re-issue schedule after 3 h" is not built.
   - Alerts are recorded as markers in `DigestRun.alerts` (`{kind: {raisedAt, sentAt: null, …}}`, one
     per kind per run, atomic SQL); task 6 sends them. Build retries on `BUILD_FAILED` are per tick until
     task 4 adds the build schedule. `lastError` redaction masks plain and %40 addresses, key/token/
     Authorization parameters and the configured API key value.
   - No cron calls `advanceRun` yet; `scheduler.ts` is still log-only.
4. **Builder.** Window, candidates, `rankDigest`, `articleKey` dedupe (90 days), link check, minimum and
   sanity guards, roll-forward, freeze (DigestItem).
   *Accept:* the re-GUID, roll-forward, too-little-news and sanity tests pass. `EXPLAIN (ANALYZE,
   BUFFERS)` of the candidate query on prod (read-only) is recorded in the PR.
5. **Renderer v0** with one built-in default template in code. Subject, preheader, date, footer
   (address and unsubscribe tag), plain text, `withUtm`, size budget.
   *Accept:* the fixture of the worst case stays under 90 KB, every link is on the allowlist and carries
   UTM, and the output has no image without alt text.
6. **Alerts and status.** `alerts.ts` (ElasticEmail, one per kind per run), `GET /api/digest/status`,
   and the Dashboard banner.
   *Accept:* a forced 401 produces exactly one email and the banner; recovery clears both.
7. **Digests screen and routes.** Preview at 3 widths, approve, hold, test send, Send now (ConfirmPush),
   Retry now, 14-day history.
   *Accept:* verified in a real browser at phone and desktop widths; audit rows written; a test send
   refuses a non-internal address.
8. **Webhooks.** Route, token, EmailEvent (hashed), EmailSuppression, dedupe, liveness check.
   *Accept:* replaying a payload is counted once; a wrong token gets 404; no address appears in the logs
   or in `EmailEvent`.
9. **Ads.** Model, image upload and the `/email-assets` route, `pickAds` with defaults and the
   SUBSCRIPTION guard, the Ads screen, and slot coverage.
   *Accept:* Premium never receives a SUBSCRIPTION ad (both directions); an unfillable slot fails the
   build closed; an off-allowlist link is rejected.
10. **Templates.** Model with the partial unique index, compile at save (MJML if approved), validation
    checklist, scheduled overrides (`resolveTemplate(audience, at)`, the single definition), revert, the
    Templates screen.
    *Accept:* a second ACTIVE template per audience is rejected by the DB; an override wins inside its
    window and lapses after it; activation is blocked while validation fails.
11. **Retention and backup.** Nightly fold of EmailEvent into `rolled*` plus `digestSendStats()`, html
    nulled after 30 days, and the new tables added to `backup.ts`.
    *Accept:* counts are identical before and after the fold, and a backup and restore rehearsal
    includes EmailSuppression.
12. **Documentation and pilot runbook.** Guide section, flag table, the Mailercloud checks in §12.14 as
    a checklist, and the stage 1–4 runbook. Updating `CLAUDE.md`/`NEXT_STEP.md` is the owner's call.
    *Accept:* the owner signs off on the runbook before stage 2.
