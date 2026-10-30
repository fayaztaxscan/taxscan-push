# Email digest: pilot runbook (stages 1 to 4)

For the owner. Plain checklists, one per stage. Tick each box as you go.
Design: `docs/EMAIL_DIGEST_DESIGN.md` (§10 rollout, §12 open questions).
Every setting is listed in §5 of the design.

Written 23 Oct 2026; section 0 updated the same day for task 13.
Nothing here is switched on yet.

**Owner sign-off on this runbook (needed before stage 2):**

> Approved by: ____________________  Date: ____________
> Changes asked for: ______________________________________

---

## 0. What is built, and what is not

Read this first. Updated 23 Oct 2026 (task 13). **Nothing here blocks
stage 1 any more.**

Built (task 13), so stage 1 can start once section 1 is done:

- [x] **The morning tick.** Every minute (IST) the system moves the day
  along by itself: at **06:15** it opens today's run, checks the last
  send's spam-complaint rate and checks Mailercloud; at **06:30** it
  builds the digest and makes both drafts; at **07:15** it checks
  Mailercloud again; at **07:30** it sends once approved (or by itself
  when approval is off); it checks the send at +10, +30, +60 minutes and
  then hourly; at **17:00** it skips whatever did not go out. A day the
  app was down for at 17:00 is tidied up on the next tick, and is never
  sent late.
- [x] **Health checks.** Mailercloud is checked at 06:15 and 07:15, and
  every hour while it keeps rejecting the key or the plan. When it
  answers again, a version stopped by that error is picked up again by
  itself (same frozen email), and admins get an "answering again" note.
  With `MAILERCLOUD_WEBHOOK_ID` set (1.5), the webhook's on/off status is
  also read once a day.
- [x] **Complaint-rate hold.** If the last send's spam-complaint rate
  was **above 0.3%**, the next day's digest is held: it is built as
  usual but needs an **Approve**, even with auto-send on, and admins get
  an email naming the rate. If the rate is unknown (Mailercloud has not
  confirmed that send through the webhook) nothing is held, but the
  banner says so.
- [x] **"Ready for approval" email** at 06:30 (in stage 1: "ready to
  review"), and a **"still waiting for approval" email** at 08:30 if
  nobody has approved by then. Both go to admins and publishers, once a
  day each, with a link to Digests.
- [x] **The same two as notifications** (task 14) on every phone or
  computer where an approver tapped **Notify me on this device** on
  Digests. Once a day each; tapping opens Digests. Kill-switch:
  `DIGEST_STAFF_PUSH_ENABLED=false` (the emails carry on).
- [x] **Retry now works while sending is off.** In stage 1 it re-makes a
  failed version's draft (and nothing more: it never sends). Send now
  stays greyed out until `DIGEST_SEND_LIVE` is on.
- [x] **Read-only name lookup** for check 2.2:
  `npm run digest:lookup -- --date YYYY-MM-DD`. It only reads; it
  refuses to run with a client that could write.
- [x] **Two campaigns with the same name** in Mailercloud now get their
  own notice ("delete the extra one"), not "Mailercloud is not
  answering".

Still not built (none of these blocks a stage; each says what to do
meanwhile):

- [ ] **Opens and clicks** are never read from Mailercloud's report, so
  the Clicks column on Digests stays "—". Use Mailercloud's own
  campaign report.
- [ ] **"Scheduled but not sent after 3 hours → schedule again"**
  (design §8). Deliberately not built until 2.8 shows a second schedule
  can never send twice. Meanwhile such a version is checked hourly and,
  if still not confirmed at 17:00, reported as "not confirmed sent".
- [ ] **A run record for the nightly retention sweep**: a failed night
  shows only in the log, not on a screen.
- [ ] **Test send from the Templates screen**: test a template through a
  Digests run instead.
- [ ] Later phases, by design: re-subscribe from the CMS feed, expired
  members to the Free digest, contact-tag sync, conversions.

---

## 1. Prerequisites (in this order)

### 1.1 Deploy and migrations

- [ ] PR `develop` → `main` merged. Railway deploys `main`.
- [ ] Dashboard shows today's backup as fine *before* the deploy.
  The new migrations add tables; a fresh backup is the way back.
- [ ] Migrations run by themselves at start (`prisma migrate deploy`).
  In the deploy log, check all twelve digest migrations are applied.
  They are `20261022124755_email_digest` up to
  `20261023170000_digest_create_sent_marker`. They add new tables and
  columns only. Adding the audit values takes a very short lock.
- [ ] The deploy log shows
  `[digest] disabled (set DIGEST_ENABLED=true to start)`.
  Only the new build prints it, so it proves the new code is live.
- [ ] Push still works: the next pacer send goes out as normal.

### 1.2 Settings (while `DIGEST_ENABLED` is still off)

Set these on Railway. Values come from you; whoever runs the platform
can type them in.

- [ ] `MAILERCLOUD_SENDER_NAME`, `MAILERCLOUD_SENDER_EMAIL` (must be a
  verified sender in Mailercloud), `MAILERCLOUD_REPLY_EMAIL` (a real,
  monitored inbox; a "noreply" address is refused).
- [ ] `DIGEST_POSTAL_ADDRESS` (the footer address; required).
- [ ] `DIGEST_FREE_LIST_IDS` and at least one of
  `DIGEST_FREE_EXCLUDE_LIST_IDS` / `DIGEST_FREE_EXCLUDE_TAG_IDS`
  (the premium exclude: without it the Free digest is never created).
- [ ] `DIGEST_PREMIUM_LIST_IDS` (or `_SEGMENT_IDS` / `_TAG_IDS`).
- [ ] `DIGEST_TEST_RECIPIENTS`: the staff login addresses allowed to
  use "Test send to me".
- [ ] For stages 1 and 2, all list ids point at **internal staff
  lists**, never the real readers. Stage 3 changes them.

### 1.3 Secrets (you, directly in Railway)

- [ ] `MAILERCLOUD_API_KEY`. Paste it straight into Railway. Never put
  it in chat, a document, or a screenshot.
- [ ] `MAILERCLOUD_WEBHOOK_TOKEN`. On your own computer run
  `openssl rand -hex 32` (64 characters) and paste the result
  straight into Railway. Anything shorter than 32 characters is
  treated as unset.

### 1.4 Ads and templates (work while the digest is off)

- [ ] Admin → Ads: at least **three different ads** (or slot defaults)
  for Free and three for Premium. The coverage check must be **all
  green** for both. An empty slot holds that version back.
- [ ] Every offer ad has an end date.
- [ ] Templates: optional. With none active, the built-in template is
  used.

### 1.5 Webhook (this order matters)

If Mailercloud calls us before our side is listening, every call fails.
Mailercloud switches a webhook off after about 20 failed calls.

1. [ ] Set `DIGEST_WEBHOOKS_ENABLED=true`. Wait for the deploy.
2. [ ] In Mailercloud, add a webhook with this URL:
   `https://push.taxscan.in/api/webhooks/mailercloud/<the token>`
3. [ ] Tick **only these five events**: unsubscribe, hard_bounce,
   spam, campaign_sent, campaign_error.
   **Never** opened, clicked or soft bounce. Those would be
   hundreds of thousands of calls a day.
4. [ ] If Mailercloud offers a test ping, use it. Our side answers
   200 and stores nothing.
5. [ ] The webhook covers the whole account, so unsubscribes from the
   hand-made digest arrive too. That is fine: they are added to our
   "do not mail" copy.
6. [ ] Optional: copy the webhook's id from Mailercloud into
   `MAILERCLOUD_WEBHOOK_ID` on Railway. The system then reads whether
   the webhook is still switched on, once a day. Without it, a silent
   webhook is still noticed, about 2 hours after a send.

### 1.6 Switch-on order

1. [ ] `DIGEST_WEBHOOKS_ENABLED=true` (done in 1.5).
2. [ ] Check `DIGEST_SEND_LIVE` is unset or `false`.
3. [ ] Check `DIGEST_APPROVAL_REQUIRED` is unset or `true`.
4. [ ] Set `DIGEST_ENABLED=true`. The deploy log should show
   `[digest] ready (tick every minute) … approval=required sendLive=off webhooks=on`
   (ending `webhookStatus=daily` with `MAILERCLOUD_WEBHOOK_ID`, else
   `webhookStatus=liveness-only`).
   `config_invalid` means a setting is wrong; the line says which.
   From then on the log has one `[digest] <date> run=…` line each time
   the day's digest changes state, and nothing on quiet minutes.
5. [ ] Later, any time: `DIGEST_RETENTION_ENABLED=true`, after one
   `npm run digest-retention` dry run.

---

## 2. Mailercloud checks (tick list)

Check these in the Mailercloud account yourself. Don't ask Mailercloud
support (design §12). Each one says when it must be done by.

### 2.1 Unsubscribe link: Mailercloud's own footer (CLOSED 30 Oct 2026)

- We guessed `{{unsubscribe_link}}`; Mailercloud does **not** expand it. The first
  real staff send (29 Oct) showed our "Unsubscribe from this digest" link arriving dead.
- **Decision:** the digest draws **no unsubscribe link of its own**. Mailercloud appends
  its own working footer to every campaign ("Manage preferences | If you wish to opt out
  of all type of emails, click Unsubscribe. | Report Abuse", links on `hello.taxscan.in`),
  exactly as the old hand-made newsletter relied on. A template containing
  `{{unsubscribe_link}}` is refused by the checklist.
- **Still to look at in a test send:** Mailercloud's footer's Unsubscribe link opens its
  unsubscribe page (it did in the 30 Oct hand-made send). Use a staff address you can add back.
- [x] Closed. Result: Mailercloud's footer is the unsubscribe (brief 2026-10-30-digest-old-format).

### 2.2 Does the list search include drafts? (by the end of stage 1)

- The runner looks up today's campaign name before it creates one.
  That lookup is what stops a second digest after a crash or a
  restore.
- **How:** in stage 1, after the 06:30 build, run the read-only lookup
  in the Railway service (`railway ssh`, or wherever
  `MAILERCLOUD_API_KEY` is set):
  `npm run digest:lookup -- --date <today> --audience FREE`.
  It prints `TS-DIGEST-<today>-FREE: id=… list-status=Draft state=DRAFT`.
  The id must be the same campaign id as "View Free" on Digests.
  "not found in Mailercloud" means the search does **not** include
  drafts. "DUPLICATE" means two campaigns have that name: delete the
  extra one in Mailercloud.
- **Then again in stage 2, after a real send:** the same command must
  still find that day's campaign once Mailercloud shows it as
  Finished (`list-status=Finished state=SENT reach=…`). This is the case a restore depends on: if the search skips
  sent campaigns, a restored system would create and send a second
  digest.
- **If wrong:** a crashed create can leave a spare draft. That is
  harmless: only the saved id is ever sent. But after a restore, the
  check in section 4 must be done by eye. Note it on that step. If the
  search misses **sent** campaigns, tell the developer before stage 3.
- [ ] Checked (draft, stage 1). Result: __________
- [ ] Checked (sent, stage 2). Result: __________

### 2.3 Campaign status names (stage 2)

- Our map: Draft; Scheduled / Rescheduled / Queued / Processing;
  Sending / Paused; Finished; Aborted / Failed.
- **How:** follow each stage-2 send in the Digests timeline. A status
  we don't know shows as "could not confirm" in an alert.
- **If wrong:** nothing is sent twice (an unknown status is never
  treated as "not sent"). The developer adds the name.
- [ ] Checked. Result: __________

### 2.4 Reach numbers (stage 2)

- We read `queued_total` as "targeted" and `sent` as "delivered".
- **How:** after a stage-2 send, compare Digests → Last 14 days →
  Delivered with the campaign report in Mailercloud.
- **If wrong:** a full send could show as "partly delivered", or the
  other way round. The developer fixes the mapping before stage 3.
- [ ] Checked. Result: __________

### 2.5 Quota or funds errors (any time, from the docs or the plan page)

- We treat code 9002 and quota wording as "do not retry; alert at
  once".
- **How:** check the plan page and the API docs for the error a
  campaign call returns when credits run out. Never use up the quota
  to test it.
- **If wrong:** the digest retries hourly until 17:00 instead of
  alerting at once. That is harmless (same draft every time) but slow
  to notice. The developer adds the code.
- [ ] Checked. Result: __________

### 2.6 Webhook payload fields (stage 2, the first live webhook)

- The field names are guesses (`PAYLOAD_FIELDS` in `webhook.ts`).
- **How:** unsubscribe one staff address from a real stage-2 email.
  Within minutes, that day's Unsubscribes on Digests should read 1,
  not "—". There must be no "arrived without a readable address"
  banner. About 2 hours after the send, there must be no "webhook is
  silent" banner, which proves `campaign_sent` arrived and linked.
- **If wrong:** Mailercloud still honours its own unsubscribes. Only
  our copy lags. The developer adjusts the field names from the real
  request. No stage 3 until our copy works.
- [ ] Checked. Result: __________

### 2.7 One-click unsubscribe headers (stage 2; gates stage 3)

- **How:** open a **real delivered** stage-2 email in Gmail (not a test
  send). Use ⋮ → Show original. Look for both:
  - `List-Unsubscribe:` with an `https://` address
  - `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
- **If missing:** stage 3 stops and you decide. Either an account
  setting turns them on, or the digest moves to Mailercloud's Email
  API, which lets us set both headers.
- [ ] Checked. Result: __________

### 2.8 Also from the open questions (design §12)

- [ ] API access and the Email API are in the current plan (or the
  extra cost is known).
- [ ] The footer shows a "manage preferences" link
  (`mailing_preference` on).
- [ ] A draft made through API v2 can be sent through v1 `schedule`
  (the first stage-2 send proves it).
- [ ] Scheduling a campaign that is already scheduled or sent is
  refused, or does nothing. It must never send twice. The code never
  does this on purpose; the answer decides whether a FAILED campaign
  could ever be retried.
- [ ] Whether Mailercloud's webhook status read
  (`GET /v1/webhooks/detail/{id}`) answers as we expect: with
  `MAILERCLOUD_WEBHOOK_ID` set, Digests must show no "webhook is
  switched off" notice while the webhook is on. If it does, unset
  `MAILERCLOUD_WEBHOOK_ID` and tell the developer (the 2-hour liveness
  check still watches the webhook).

---

## 3. The stages

### Stage 1: shadow week

- **Switched on:** `DIGEST_ENABLED=true`. `DIGEST_SEND_LIVE` stays off.
- **Who receives it:** nobody. Drafts are made in Mailercloud but
  never sent. Only test sends reach staff.
- **How long:** 7 days in a row.
- **Before day 1:**
  - [ ] Each approver opens Digests on their phone (and computer, if
    wanted) and taps **Notify me on this device**, then **Allow**; on an
    iPhone, from the Home Screen app first (Safari → Share → Add to
    Home Screen, iOS 16.4+). **Send a test** arrives. Users shows each
    approver with a device count. (`DIGEST_STAFF_PUSH_ENABLED` defaults
    on — the owner's decision; nothing is pushed while `DIGEST_ENABLED` is
    off.) After any VAPID key rotation each approver taps **Notify me on
    this device** once more (the card shows *Off* and says the key
    changed); see `docs/BACKUPS.md`.
- **Every day:**
  - [ ] By 06:45: Digests shows both versions built, no banner.
  - [ ] An editor compares it with the hand-made digest: stories,
    order, ads, subject.
  - [ ] Preview at Phone, Tablet and Desktop, light and dark.
- **Once in the week:**
  - [ ] 2.1 (unsubscribe tag) and 2.2 (draft search) done.
  - [ ] Alert test: put a wrong `MAILERCLOUD_API_KEY` on Railway
    before 06:15 one day. Expect exactly **one** "Mailercloud rejected
    the health check" email (06:15) and **one** "Mailercloud rejected the
    digest" email (06:30) to admins, and the amber banner. Put the right
    key back (Railway redeploys). At the next hourly check the system
    says "Mailercloud answering again" (one email) and makes the missing
    draft by itself — or press **Retry now**, which in stage 1 makes the
    draft and sends nothing. The banner clears.
  - [ ] A version with an empty ad slot: banner names the slot. Fix the
    slot on Ads, press **Retry now**: that version is built and its
    draft made the same day (nothing is sent).
  - [ ] The "ready to review" email arrives at about 06:30 each day, to
    admins and publishers, and the "Today's digest is ready to review"
    notification on every device turned on (one per device, once).
    Tapping it opens Digests.
- **Go / no-go:**
  - 7 of 7 days built before 07:00 with no unexplained banner.
  - Size under **75 KB** for both versions every day. Never over
    90 KB: the build refuses above that.
  - Ad coverage green all week.
  - The alert test raised exactly one email of each kind, the recovery
    made the draft, and the next day built cleanly.
  - 2.1 and 2.2 (draft) ticked.
- **Roll back:** `DIGEST_ENABLED=false`. Spare drafts in Mailercloud
  cannot send by themselves; delete them when convenient.
- **Signs off:** the owner, with the editorial lead.

> **Stop here.** The owner signs off on this runbook (top of the page)
> before stage 2.

### Stage 2: internal list

- **Switched on:** `DIGEST_SEND_LIVE=true`. Approval stays on.
  Both audiences still point at internal staff lists, about 10
  addresses. The Free exclude must still be set: use a small internal
  "premium staff" list.
- **Who receives it:** the ~10 staff only.
- **How long:** one week.
- **Every day:**
  - [ ] An editor approves before 07:30. It goes out at 07:30, and
    Digests shows "sent" within about 10 minutes.
  - [ ] Mailercloud shows **one** campaign per version for the day.
- **Once in the week:**
  - [ ] 2.3, 2.4, 2.6 and 2.7 done.
  - [ ] Gmail shows no "[Message clipped]".
  - [ ] Looks right in: Gmail web, Gmail app, Apple Mail on iPhone,
    Outlook desktop, Outlook web, Yahoo. Light and dark mode.
  - [ ] Send now once, **between 07:00 and 07:30** on a day that is
    approved but not yet sent (after the night rule ends, before the
    automatic 07:30 send). It asks first, then sends at once; at 07:30
    nothing more goes out.
  - [ ] Hold once. Leave it held past 17:00. Expect a skip, and its
    top stories in the next day's "In case you missed it".
  - [ ] The recovery checks again, now with sending on: the wrong-key
    test with Retry now (expect the "Resolved — digest sent" email once
    it sends), and an empty ad slot fixed the same day.
  - [ ] Leave one day unapproved until 08:30: the "still waiting for
    approval" email arrives once, and the "Digest still waiting for
    approval" notification replaces the 06:30 one on each device.
    Approve it then; it goes out.
  - [ ] 2.2 again, after a real send (the lookup finds the sent
    campaign).
  - [ ] Night rule: on a day that is **already approved**, between the
    06:30 build and 07:00, Send now is greyed out with "It is quiet
    hours (23:00–07:00 IST); nothing is sent at night." On a day not
    yet approved, the reason shown first is "Approve it first." — the
    approval gate is checked before the night rule — so approve early
    that morning to see the quiet-hours reason. (After 17:00 Send now
    is not shown at all: the day is past its cut-off.) Only look; don't
    try to get round it.
- **Go / no-go:**
  - **Zero** double sends.
  - 2.2 (sent), 2.3, 2.4, 2.6 and 2.7 ticked.
  - One-click headers present (if not, see 2.7: stage 3 waits for
    your decision).
  - Delivered matches Mailercloud's report.
- **Roll back:** `DIGEST_SEND_LIVE=false`. The next run stops at
  drafts. An email already sent can't be recalled.
- **Signs off:** the owner.

### Stage 3: engaged pilot

- **Before switching:**
  - [ ] Free list → a segment of about **1,000 recent openers**.
    Premium → about **200 members**. Change the list/segment ids
    on Railway.
  - [ ] **Remove these same people from the hand-made digest in
    Mailercloud**, or they get two digests a day.
- **Switched on:** same flags; approval stays on.
- **How long:** 1 to 2 weeks.
- **After every send, check on Digests (Last 14 days).** These
  thresholds are final (owner, 23 Oct 2026):
  - Spam complaints: **under 0.1%** of delivered. That is 1 or fewer
    per 1,000.
  - Unsubscribes: **under 0.5%** per send.
  - Hard bounces: **under 2%** per send. Recent openers should be
    far lower.
  - Size under 75 KB; delivered close to targeted.
  - Any single send over **0.3%** complaints: the next day's digest
    is **held automatically** (it needs an Approve, even with auto-send
    on; admins get an email naming the rate). Look at why before
    approving it.
  - A "complaint rate is unknown" notice means Mailercloud has not
    confirmed that send through the webhook, so the automatic hold
    cannot work: check the webhook (2.6) the same day.
- **Go / no-go:** every send inside the numbers above for the whole
  pilot, with no double sends.
- **Roll back:** `DIGEST_SEND_LIVE=false`, and put the pilot readers
  back into the hand-made digest the same day.
- **Signs off:** the owner.

### Stage 4: full

- **Before switching:**
  - [ ] Free → the full Free audience (about **10,066**). Premium →
    all members (about **2,700**).
  - [ ] Decide: approval stays on, or `DIGEST_APPROVAL_REQUIRED=false`
    (auto-send). Your call (design §12).
- **The hand-made digest:** stop it for these lists only once the
  first full automatic digest shows "sent". Not before: a day with
  neither is worse than a day with both.
- **Ongoing:** the stage-3 numbers after every send. Look at the
  Digests banner each morning.
- **Roll back:** `DIGEST_SEND_LIVE=false` and restart the hand-made
  digest.
- **Signs off:** the owner.

---

## 4. Always true (every stage)

### The night rule

Nothing is sent between **23:00 and 07:00 IST**, on any button or
door. A send time inside those hours is refused when the app starts.
Breaking-style overrides don't exist for the digest.

### At most one a day, never late

Each version goes out at most once a day. A missed day is never sent
the next day; its top stories go into the next digest instead. The cut-off is 17:00 IST.

### Don't touch TS-DIGEST- campaigns in Mailercloud

Don't send, copy, rename or edit them by hand. A copied campaign is
the one way a reader could get two digests. The system cannot see what
is done inside Mailercloud.

### After any database restore

The 02:20 backup never contains that morning's digest. Full steps are
in `docs/BACKUPS.md` → "After ANY restore". In short:

1. [ ] Before the app starts on the restored database, set
   `DIGEST_ENABLED=false` and `DIGEST_SEND_LIVE=false`.
2. [ ] In Mailercloud, search `TS-DIGEST-` for **today's date** (or
   run `npm run digest:lookup -- --date <today>`). Note whether each of
   `…-FREE` and `…-PREMIUM` exists and its status.
   **Delete today's draft in Mailercloud before switching sending back
   on**: it may hold content from before the restore. (Leave a
   scheduled, sending or finished one alone.)
3. [ ] Switch the flags back on. The system finds today's campaigns
   by name and adopts them. It never sends a second copy. Expect an
   "already in Mailercloud" alert. If a draft was left, it is adopted
   but **held for an Approve** (even with auto-send on): check it in
   Mailercloud first, or delete it there and a fresh one is made. (A
   restored database never tried to create today's versions, so this
   always applies after a restore. On a normal day, a draft found after
   our own create's reply was lost is ours and is NOT held.)
4. [ ] If a campaign was renamed or copied by hand, leave
   `DIGEST_SEND_LIVE` off for the rest of the day.

### Known unverified items

- The unsubscribe merge tag (2.1).
- Whether the list search finds drafts and sent campaigns (2.2).
- Status names and reach fields (2.3, 2.4).
- Quota error codes (2.5).
- Webhook payload field names (2.6).
- One-click unsubscribe headers on campaign sends (2.7).
- Whether a second schedule is refused (2.8).
- The webhook status read's answer format (2.8), used only with
  `MAILERCLOUD_WEBHOOK_ID`.
- The items still listed as not built in section 0.
