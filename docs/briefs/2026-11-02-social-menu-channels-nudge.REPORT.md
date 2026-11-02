# REPORT: social-menu-channels-nudge

- **Branch:** `build/social-menu-channels-nudge` (base `origin/develop` 2af5266, LinkedIn already merged). **Code commit:** `3b8b414`.

## Files changed
- `prisma/schema.prisma` + `prisma/migrations/20261102094240_staff_push_kinds/` — `StaffPushSubscription.kinds String[] @default(["digest"])` (Postgres `TEXT[] DEFAULT ARRAY['digest']`; existing rows take the default). **Additive.**
- `src/services/staffPush.ts` — `StaffPushKind` ('digest'|'whatsapp'); `activeStaffDevices(kind='digest')` (still ADMIN/PUBLISHER + active user); `upsertStaffDevice(…, kind)` (a new device holds only its kind, an existing one gains it); `pushToActiveStaff(…, {kind})`. `src/services/digest/alerts.ts` passes `kind: 'digest'`.
- `src/routes/staffPush.ts` — optional `kind` on subscribe / check / remove / test (remove of one kind keeps the device while another remains: `{removed:true,kept:true}`; no kind = whole device, as before); `publicDevice` returns `kinds`; `GET /status` returns `whatsappNudge` (queue flag + nudge flag + kill switch).
- `src/services/whatsapp/nudge.ts` (new) + `src/index.ts` — the 5-minute tick `startWhatsAppNudge()`.
- `src/services/metrics.ts` — `listCampaigns`: `channels`, `channelDetails`, `channelDay` per row (`channelsFor()`: one batched query per channel for the page; `campaignSelect` gains `portal`, `target`, `lastSentAt`).
- `src/lib/env.ts`, `.env.example` — `WHATSAPP_NUDGE_ENABLED` (default off).
- `admin/src/components/NavBar.vue`, `admin/src/views/Campaigns.vue`, `admin/src/views/WhatsApp.vue`, `admin/src/views/LinkedIn.vue` (reads `?date=`), `admin/src/components/WhatsAppNudgeCard.vue` (new), `admin/src/composables/useStaffPush.ts` (`useStaffPush(kind='digest')`), `admin/src/styles/app.css` — by ui-developer.
- `docs/Taxscan-Push-Admin-Guide.html` — **guide 2.15 → 2.16** (menu says SOCIAL; Channels paragraph under Campaigns; "Get notified on your phone" in the WhatsApp section).
- Tests: `whatsappNudge.test.ts` (12), `campaignChannels.test.ts` (6), `staffPushKinds.test.ts` (6); `staffPushIsolation.test.ts` — added `src/services/whatsapp/nudge.ts` to the list of files allowed to import the staff-push service.

## Migrations / flags
`20261102094240_staff_push_kinds` (additive). Flag `WHATSAPP_NUDGE_ENABLED` default off (needs `WHATSAPP_QUEUE_ENABLED`; also honours the existing `DIGEST_STAFF_PUSH_ENABLED` kill switch). Menu and Channels follow the existing switches.

## Results (verbatim)
- tsc clean; lint clean; `npm run build:admin` clean.
- **Full suite (ran: migration, staff push / digest alerts, a new cron):** `Test Suites: 91 passed, 91 total` / `Tests: 1806 passed, 1806 total`. The staff-push, digest-alert and WhatsApp test files are inside that run.

## Acceptance tests
1. Menu — PASS in a real browser (headless Chromium, desktop 1400 px and 375 px): both on → SOCIAL lists WhatsApp, LinkedIn; one on → just that one; both off → no SOCIAL label; PUSH no longer lists them; `data-group="social"` active on /whatsapp and /linkedin; hamburger order Push → Social → Email → Admin. **No SPA test runner exists, so no NavBar component test was added (no new dependency); covered in the browser.**
2. `channels` on the Campaigns API — PASS: WhatsApp POSTED/SKIPPED/TODO, LinkedIn POSTED/FAILED/PENDING; re-pushes share their article's marks; a test-segment-only campaign, academy link, draft and home page → both null; pushed before `LINKEDIN_POST_FROM` → LinkedIn null; a switch off → that channel null everywhere, both off → the fields are absent; the query count is constant (one `whatsAppPost.findMany` and one `linkedInPost.findMany` for a 5-row and a 50-row page).
3. Channels column — PASS (browser): marks with `title` = `aria-label` ("WhatsApp: posted by <user> at …", "LinkedIn: failed — <reason>"), click → `/whatsapp?date=…` or `/linkedin?date=…` on the right day, column hidden with both switches off, phone cards one line (56×44 px marks, `scrollWidth` 375).
4. Staff kinds — PASS: an existing device (migration default) gets digest alerts and no nudges; a WhatsApp-only device gets nudges and no digest alerts (also through the real `pushDigestAlerts` pass); both kinds → both.
5. Nudge timing (fake clock) — PASS: a new To-do at 10:00 → one nudge; another at 10:04 → none at 10:05/10:09, one at 10:10 with N=2; all Posted → none; 23:30 → none; 07:00 with a waiting night article → one; a restart (nothing in memory) does not repeat (the watermark is in `DigestSetting` `whatsapp_nudge_watermark`); an article already told about the evening before is not nudged at 07:00.
6. Never to an inactive user or a non-ADMIN/PUBLISHER, 410 device pruned — PASS.
7. Flags off — PASS: no tick scheduled; on without the queue flag → `refusing to start` log; the card renders nothing about nudges when `whatsappNudge` is false (browser).
8. tsc, lint, build:admin, new tests, staffPush/digest tests, full suite — PASS. Migration applied on an empty DB.

## Agents run
ui-developer, once: SOCIAL menu, Channels column, WhatsApp card, composable, guide, browser checks.

## Deviations — PLEASE DECIDE
- **Nav breakpoint moved 1200 → 1350 px (ui-developer, not in the brief).** With SOCIAL on, the single-row desktop nav overflowed: at 1200 px it wrapped to two rows and the page scrolled sideways (up to 1367 px wide); at 1500 px with both channels on the page was 1602 px wide. The fix is in `admin/src/styles/app.css`: the hamburger starts below 1350 px (was 1200), the "tight" band is 1350–1699 with 4 px link padding, and the email column is hidden until 1800 px (was 1600). Measured at 1350/1366/1700/1800/1920 px: one row, no overflow. **Side effect: 1280 px laptops now get the hamburger where they had the full row.** The alternative (not built) is a `nav--social` class applying the wider breakpoint only when a SOCIAL link shows; in production both channels are expected on, so the result would be the same.
- Marks use green/red fills but the text (WA ✓ / in ✕ …) carries the meaning, so colour is not the only signal.

## Decisions / worth remembering
- A device first enabled from the WhatsApp card holds `['whatsapp']` only; the Digests card now passes `kind:'digest'` on check / remove / test, so turning one off never kills the other.
- The nudge's watermark is the `pushedAt` of the newest article told about; with no stored watermark yet, what is waiting since 23:00 the evening before counts as new. With **no opted-in device** nothing is sent and the watermark is not burned, so the first opt-in is told about what is waiting (no log line in that case, to avoid spam every 5 minutes).
- The nudge counts today's To-do list plus yesterday's list after 23:00 (a Breaking push at 23:30 lives on yesterday's list). It reads the queue's own `getQueue`, never Event.
- A re-push's mark links to the re-push's own IST day, but the article is listed on its FIRST push's day (`channelDay` is the row's own push day). Fine for the usual same-day case; a next-day backfill clone links to a day where the article is not listed.
- The nudge reuses `pushToStaffDevice` (prunes 404/410, never throws) and `/admin/sw-staff.js` unchanged (`safeAdminUrl` accepts `/admin/whatsapp`).
- Not verifiable here: a real push subscription on a phone and the actual notification (headless browsers have no push service). The real check is Anagha/the owner opting in on a phone once `WHATSAPP_NUDGE_ENABLED` is on.
- Shared-database hazard in tests: the nudge tests inject a device list restricted to their own users because other suites create staff devices at the same time.

## Clean-up (planning session, after merge)
```sh
git worktree remove ../taxscan-push-worktrees/social-menu-channels-nudge
dropdb taxscan_push_build_social_menu_channels_nudge; dropdb taxscan_push_build_social_menu_channels_nudge_shadow
git branch -D build/social-menu-channels-nudge; git push origin --delete build/social-menu-channels-nudge
```
