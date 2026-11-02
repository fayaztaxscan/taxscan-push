# Brief: SOCIAL menu group, channel marks on Campaigns, WhatsApp "waiting" nudge for staff

- **Date / name:** 2026-11-02-social-menu-channels-nudge  →  branch `build/social-menu-channels-nudge`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first). UI parts go to **ui-developer**.
- **⚠️ Start only after `build/linkedin-page-posting` is merged into `develop`.** This builds on its `LinkedInPost`
  table, its `features.linkedinPosting` switch and its shared `src/services/social/` predicate. If `origin/develop` has
  no `LinkedInPost` model yet, stop and write a REPORT saying so.

## Goal
Three admin improvements now that articles go to push, WhatsApp and LinkedIn:
1. **SOCIAL menu group:** WhatsApp and LinkedIn move out of PUSH into their own group.
2. **Channel marks on Campaigns:** each article row shows at a glance whether it was posted to WhatsApp and LinkedIn.
3. **WhatsApp nudge:** staff who opt in on a device get a staff notification when articles are waiting to be posted to
   WhatsApp, so the manual channel doesn't depend on someone remembering to check.

## Why (owner's words)
> 2 Nov: "Have you thought how our user experience is shaping up with new updates?" Planning listed the drift (one
> article spread over three screens, PUSH holding non-push items, nothing telling the team WhatsApp work is waiting)
> and proposed 1–3. Owner: "do 1,2 and 3."

## Scope
**In:**

### 1. SOCIAL menu group (`admin/src/components/NavBar.vue`)
- Menu becomes `Dashboard │ PUSH (Compose, Review, Queue, Campaigns) │ SOCIAL (WhatsApp, LinkedIn) │ EMAIL (Digests, Ads,
  Templates) │ Reports │ Admin ▾`.
- Each SOCIAL item shows only when its feature switch is on (`features.whatsappQueue`, `features.linkedinPosting` from
  `/api/auth/me`). If neither is on, the whole group is hidden. The active route emphasises the SOCIAL label like the
  other groups (`data-group="social"`).
- Below 1200 px (hamburger) the group appears in the same order. Routes and URLs don't change.
- Admin guide: the menu description (section 1 / the screens table) says SOCIAL.

### 2. Channel marks on Campaigns
- `listCampaigns` (and its API response) gains `channels` per row:
  `{ whatsapp: 'TODO' | 'POSTED' | 'SKIPPED' | null, linkedin: 'PENDING' | 'POSTED' | 'FAILED' | 'SKIPPED' | null }`.
  - `null` when the channel's switch is off, or the row isn't eligible (use the SAME shared predicate the WhatsApp
    queue and LinkedIn worker use: SENT, portal, taxscan article URL, not test-segment-only). For LinkedIn, `null`
    also covers rows pushed before `LINKEDIN_POST_FROM`.
  - WhatsApp: `WhatsAppPost` by (portal, articleKey); no row → `TODO`.
  - LinkedIn: `LinkedInPost` by (page 'taxscan', articleKey); no row yet → `PENDING`.
  - Both lookups are **one batched query each** for the page of rows (`articleKey IN (…)`), never one per row, and
    never touch `Event` (the rolled+live rule is about stats; this needs none).
  - A re-push and its original share an articleKey, so they show the same marks.
- Campaigns table: a **Channels** column after the push columns, shown only when at least one switch is on. Small
  labelled marks, not colour alone: `WA ✓` / `WA –` (skipped) / `WA …` (to do); `in ✓` / `in ✕` (failed) / `in …`
  (waiting). Each has a `title`/aria-label with the full meaning ("WhatsApp: posted by Anagha at 10:42"; "LinkedIn:
  failed — <reason>"). Click a mark → that channel's screen for the row's IST day.
- Phones (`class="stack"`): the marks get `data-label="Channels"` and sit in one line.
- Admin guide: one paragraph in the Campaigns section explaining the marks.

### 3. WhatsApp "waiting" nudge (staff push, opt-in per device)
- **Opt-in per device and kind.** Additive column `StaffPushSubscription.kinds String[] @default(["digest"])`, so
  existing devices keep getting digest alerts exactly as today.
  - On the WhatsApp screen, a small card: "Notify me on this device when articles are waiting". It reuses the staff
    push enable flow from the Digests card (same `/admin/sw-staff.js`, same permission handling) and adds/removes
    `'whatsapp'` in that device's `kinds`.
  - A device enabled first from the WhatsApp card gets `['whatsapp']` only.
  - Digest alerts must then go only to devices whose `kinds` contains `'digest'`: update `activeStaffDevices()`
    callers (pass a kind; keep the ADMIN/PUBLISHER + active filter).
- **When it fires:** a 5-minute tick (flag `WHATSAPP_NUDGE_ENABLED`, default off; requires `WHATSAPP_QUEUE_ENABLED`).
  - Count today's (IST) To-do WhatsApp articles via the queue's own logic.
  - If a To-do article was pushed after the last nudge, send ONE notification to every opted-in device:
    title "WhatsApp: N articles waiting", body = the newest waiting headline (≤ 100 chars), url `/admin/whatsapp`,
    tag `whatsapp-queue` (so a new one replaces the old on the phone, not stacking).
  - At most one nudge per 10 minutes; nothing between 23:00 and 07:00 IST (`isQuietHours`).
  - The 07:00 tick nudges once if anything from the night (Breaking) is waiting.
  - The watermark (last nudged `lastSentAt`) is stored in `DigestSetting` under key `whatsapp_nudge_watermark`. Reuse
    the table, no new one, so it survives restarts. A restart must not re-nudge the same articles.
- Uses `pushToStaffDevice()` (prunes 404/410, never throws). One log line per nudge:
  `[whatsapp-nudge] waiting=N devices=M delivered=K`.
- Admin guide: section 11 gains "Get notified on your phone" (how to opt in, what the notification says, quiet hours).

**Out (do not build):**
- Any change to what posts where, the LinkedIn worker, the push send path, or reader-facing pushes.
- Nudges for LinkedIn (it's automatic; its failures already email admins).
- A per-user settings page. Opt-in stays on the device, from the WhatsApp card.
- Reads-by-channel reporting (needs CMS counts; later).

## Acceptance tests
Each one must PASS in the REPORT.
1. Menu: switches both on → SOCIAL shows WhatsApp, LinkedIn; one on → just that one; both off → no SOCIAL label. PUSH
   no longer lists WhatsApp. Active-route emphasis works for /admin/whatsapp and /admin/linkedin. (Component test +
   real browser at desktop and 375 px.)
2. `channels` on the Campaigns API: seeded rows covering POSTED/SKIPPED/TODO (WhatsApp) and POSTED/FAILED/PENDING
   (LinkedIn), a re-push sharing marks with its original, a test-segment-only campaign → both `null`, an academy link
   → both `null`, a switch off → that channel `null` everywhere. The query count for a 50-row page is constant (assert
   via a Prisma query counter or by mocking).
3. The Campaigns Channels column renders the marks with accessible labels. Clicking a mark goes to the right screen and
   day. The column is hidden when both switches are off.
4. Staff kinds: an existing device (migration default) gets digest alerts and no nudges. A device opted into
   WhatsApp only gets nudges and no digest alerts. Both kinds → both.
5. Nudge timing (fake clock): a new To-do article at 10:00 → one nudge. Another at 10:04 → no nudge until 10:10, then
   ONE with N=2. Marking all Posted → no further nudge. 23:30 → nothing; 07:00 with a waiting Breaking article → one
   nudge. A restart between ticks doesn't repeat a nudge (watermark).
6. A nudge never goes to an inactive user or a non-ADMIN/PUBLISHER, and a 410 device is pruned.
7. Flags off (`WHATSAPP_NUDGE_ENABLED` unset) → no tick started, the card shows nothing about nudges.
8. `tsc`, lint, `build:admin`, new tests, the staffPush/digest alert tests and the full suite pass. Migration applies
   cleanly.

## Files
- `admin/src/components/NavBar.vue`, `admin/src/views/Campaigns.vue`, `admin/src/views/WhatsApp.vue`, guide.
- `src/services/metrics.ts` or wherever `listCampaigns` lives: the `channels` field.
- `src/services/staffPush.ts` (kinds), digest alert callers, `src/services/whatsapp/nudge.ts` (new), route for the
  device kind toggle (extend the existing staff-push router).
- `prisma/schema.prisma` + one migration `2026110x…_staff_push_kinds`.
- `src/lib/env.ts`, `.env.example`.
- Tests: `src/__tests__/whatsappNudge.test.ts`, `campaignChannels.test.ts`, NavBar test, staffPush kind tests.

## Constraints
- Flags: `WHATSAPP_NUDGE_ENABLED` default off. Menu and Channels follow the existing switches.
- Migrations: additive only (one column with a default).
- Full suite: yes — migration, staff push (digest alerts), a new cron.
- `public/sw.js` (readers' worker) stays untouched. Only `/admin/sw-staff.js` is used, and its click handler already
  opens `data.url` (check `safeAdminUrl` accepts `/admin/whatsapp`).
- Docs that ship with it: admin guide (menu, Campaigns marks, WhatsApp notifications) + version bump; `.env.example`.

## Context the builder needs
- Staff push today: `StaffPushSubscription`, `activeStaffDevices()`, `pushToStaffDevice()` in `src/services/staffPush.ts`.
  The Digests card enable flow is in `admin/src/views/Digests.vue`, and the worker is `/admin/sw-staff.js`.
- The WhatsApp queue: `src/services/whatsapp/queue.ts` (`getQueue`, IST day helpers). Reuse it for the count.
- "Recently pushed" reads `Campaign.lastSentAt`, never `Event`.
