# Email digest: pilot runbook (stages 1 to 4)

For the owner. Plain checklists, one per stage. Tick each box as you go.
Design: `docs/EMAIL_DIGEST_DESIGN.md` (§10 rollout, §12 open questions).
Every setting is listed in §5 of the design.

Written 23 Oct 2026. Nothing here is switched on yet.

**Owner sign-off on this runbook (needed before stage 2):**

> Approved by: ____________________  Date: ____________
> Changes asked for: ______________________________________

---

## 0. Not built yet: stage 1 cannot start until these exist

Read this first. These are development tasks, not settings.

- [ ] **The morning tick.** `src/services/digest/scheduler.ts` is still
  the task-1 skeleton. It checks the settings and logs one line, nothing
  more. Today nothing builds the digest at 06:30 or sends it at 07:30.
  No run exists, so Digests shows "No digest has been built today yet".
  Stage 1 needs a 1-minute tick that creates today's run and calls
  `advanceRun` with the real story picker (`selectDigest`).
  It also needs the 17:00 cut-off sweep.
- [ ] **Health checks** (`health.ts`). Planned: a Mailercloud check at
  06:15 and 07:15, hourly while Mailercloud keeps rejecting, and a daily
  check that the webhook is still switched on. Until it is built, watch
  the Digests banner and the alert emails instead.
- [ ] **Complaint-rate hold.** The design holds the next day's digest
  for approval when a send's spam rate passes 0.3%. Not built. Until it
  is, check the Complaints column yourself after every send
  (stages 3 and 4).
- [ ] **"Not approved by 07:30" email.** Not built. The banner shows it
  from 07:30, but no email is sent.

Ask the developer to tick these off. Then start at section 1.

---

## 1. Prerequisites (in this order)

### 1.1 Deploy and migrations

- [ ] PR `develop` → `main` merged. Railway deploys `main`.
- [ ] Dashboard shows today's backup as fine *before* the deploy.
  The new migrations add tables; a fresh backup is the way back.
- [ ] Migrations run by themselves at start (`prisma migrate deploy`).
  In the deploy log, check all nine digest migrations are applied.
  They are `20261022124755_email_digest` up to
  `20261023114942_digest_retention`. They add new tables and
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

### 1.6 Switch-on order

1. [ ] `DIGEST_WEBHOOKS_ENABLED=true` (done in 1.5).
2. [ ] Check `DIGEST_SEND_LIVE` is unset or `false`.
3. [ ] Check `DIGEST_APPROVAL_REQUIRED` is unset or `true`.
4. [ ] Set `DIGEST_ENABLED=true`. The deploy log should show
   `[digest] ready … approval=required sendLive=off webhooks=on`.
   `config_invalid` means a setting is wrong; the line says which.
5. [ ] Later, any time: `DIGEST_RETENTION_ENABLED=true`, after one
   `npm run digest-retention` dry run.

---

## 2. Mailercloud checks (tick list)

Check these in the Mailercloud account yourself. Don't ask Mailercloud
support (design §12). Each one says when it must be done by.

### 2.1 Unsubscribe link: merge tag (by the end of stage 1)

- We guessed `{{unsubscribe_link}}`.
- **How:** in stage 1, "Test send to me", then click Unsubscribe in
  the footer. It must open Mailercloud's unsubscribe page. Raw
  `{{unsubscribe_link}}` text or a broken link means it is wrong. Use a
  staff address you can add back.
- **If wrong:** stop. The developer changes the tag in the renderer
  and every template is checked again. No stage 2 until it works.
- [ ] Checked. Result: __________

### 2.2 Does the list search include drafts? (by the end of stage 1)

- The runner looks up today's campaign name before it creates one.
  That lookup is what stops a second digest after a crash or a
  restore.
- **How:** in stage 1, after the 06:30 build, the developer runs a
  read-only name lookup for `TS-DIGEST-<today>-FREE`. It must return
  the same campaign id as "View Free" on Digests.
- **If wrong:** a crashed create can leave a spare draft. That is
  harmless: only the saved id is ever sent. But after a restore, the
  check in section 4 must be done by eye. Note it on that step.
- [ ] Checked. Result: __________

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
- [ ] Whether Mailercloud has a "webhook status" read endpoint.

---

## 3. The stages

### Stage 1: shadow week

- **Switched on:** `DIGEST_ENABLED=true`. `DIGEST_SEND_LIVE` stays off.
- **Who receives it:** nobody. Drafts are made in Mailercloud but
  never sent. Only test sends reach staff.
- **How long:** 7 days in a row.
- **Every day:**
  - [ ] By 06:45: Digests shows both versions built, no banner.
  - [ ] An editor compares it with the hand-made digest: stories,
    order, ads, subject.
  - [ ] Preview at Phone, Tablet and Desktop, light and dark.
- **Once in the week:**
  - [ ] 2.1 (unsubscribe tag) and 2.2 (draft search) done.
  - [ ] Alert test: put a wrong `MAILERCLOUD_API_KEY` on Railway
    for one build. Expect exactly **one** "Mailercloud rejected the
    digest" email to admins and the amber banner. Put the right key
    back, press Retry now. Expect the draft to be created and the
    banner gone. (The "Resolved" email comes only once a digest is
    actually sent, so stage 1 never shows one. Repeat this test once
    in stage 2 to see it.)
  - [ ] A version with an empty ad slot: banner names the slot; fix
    it; Retry now builds it.
- **Go / no-go:**
  - 7 of 7 days built before 07:00 with no unexplained banner.
  - Size under **75 KB** for both versions every day. Never over
    90 KB: the build refuses above that.
  - Ad coverage green all week.
  - The alert test worked both ways.
  - 2.1 and 2.2 ticked.
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
  - [ ] Send now once, at about 08:00 on a day not yet sent. It
    asks first, then sends at once.
  - [ ] Hold once. Leave it held past 17:00. Expect a skip, and its
    top stories in the next day's "In case you missed it".
  - [ ] Night rule: after 23:00, Send now is greyed out with
    "quiet hours". Only look; don't try to get round it.
- **Go / no-go:**
  - **Zero** double sends.
  - All four checks (2.3, 2.4, 2.6, 2.7) ticked.
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
- **After every send, check on Digests (Last 14 days):**
  - Spam complaints: **under 0.1%** of delivered. That is 1 or fewer
    per 1,000. *(Design target.)*
  - Unsubscribes: **under 0.5%** per send. *(Proposed; owner to
    confirm.)*
  - Hard bounces: **under 2%** per send. Recent openers should be
    far lower. *(Proposed; owner to confirm.)*
  - Size under 75 KB; delivered close to targeted.
  - Any single send over **0.3%** complaints: Hold the next day's
    digest and look at why. The automatic hold is not built
    (section 0).
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
2. [ ] In Mailercloud, search `TS-DIGEST-` for **today's date**. Note
   whether each of `…-FREE` and `…-PREMIUM` exists and its status.
   Delete any spare draft.
3. [ ] Switch the flags back on. The system finds today's campaigns
   by name and adopts them. It never sends a second copy. Expect an
   "already in Mailercloud" alert.
4. [ ] If a campaign was renamed or copied by hand, leave
   `DIGEST_SEND_LIVE` off for the rest of the day.

### Known unverified items

- The unsubscribe merge tag (2.1).
- Whether the list search includes drafts (2.2).
- Status names and reach fields (2.3, 2.4).
- Quota error codes (2.5).
- Webhook payload field names (2.6).
- One-click unsubscribe headers on campaign sends (2.7).
- Whether a second schedule is refused (2.8).
- The section-0 items, which are not built yet.
