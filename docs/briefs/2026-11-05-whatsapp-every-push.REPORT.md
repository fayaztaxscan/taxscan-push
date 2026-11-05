# REPORT: WhatsApp queue, every push gets a row (`WHATSAPP_ALL_PUSHES_FROM`)

- **Brief:** `docs/briefs/2026-11-05-whatsapp-every-push.md` (on `origin/develop` at `f284494`)
- **Branch:** `build/whatsapp-every-push` (base `origin/develop` `f284494`)
- **Code commit:** `a41e60e`
- **Switch:** `WHATSAPP_ALL_PUSHES_FROM` is unset by default. Nothing was switched on; nothing touched Railway, production, `main`, `develop` or the stash. No migration.

## What was built
From the time in `WHATSAPP_ALL_PUSHES_FROM`, SOCIAL → WhatsApp lists **every push** (taxscan.in article, academy course, shop product): one row per push, repeats
included (backfill clone, resend, another campaign row with the same link), on the **IST day of that push**, keyed `push:<campaign id>:<lastSentAt ms>` (the
LinkedIn / Facebook key, from `pushKey()`). A push before the time follows today's rule for good, so switching on lists nothing from the past. Unset or invalid:
today's queue exactly. Posting stays manual (Copy, Share, Posted, Skip).

- **Eligibility** reuses `isAllPushesCampaign()` unchanged (home / section / non-course academy page / shop collection / draft / test-segment-only make no row).
- **Queue** (`queue.ts`): `getQueue(portal, day, opts?)` splits the read at the time. Before it: today's grouping (one row per article, "pushed again" counts only
  pre-time pushes, so a repeat after the time never touches the old row). At or after it: one row per push whose `lastSentAt` is in the day. The two kinds are merged
  by push time (sorted only when there are new-rule rows, so with the time unset the order is exactly today's). New-rule rows carry `rule: 'push'` and
  `kind: 'article' | 'course' | 'product'`; old-rule rows are byte-for-byte as before (no new field).
- **Text** (`pushText.ts`, new): `buildPushPostText`. Articles = `buildPostText` unchanged. Course / product = `*<title via cleanHeadline>*`, blank line, body via
  `shortLine`, blank line, link. Link = the push's own URL through `withWhatsAppUtm(url, slug)` (one set of UTMs, the push's own `utm_*` gone, other query params kept).
- **Marks** (`markArticle`, route): a push at or after the time is marked under its own push key. The route accepts an optional `articleKey: 'push:<id>:<ms>'`
  (regex-validated); when sent it must be that push's current key. A campaign eligible under neither rule, a wrong key, or a key on an old-rule push → `not_found`.
- **Channels** (`metrics.ts`): while the time is set, a new-rule push shows the status of its own row (its key joins the same batched query); a course/product gets one.
  With the time unset the query and output are exactly today's.
- **Nudge:** unchanged logic; `waiting=` is `getQueue`'s TODO rows, so it counts the new rows. Its title says "posts" instead of "articles" once a course or product is
  among them (`nudgeTitle`, exported, pure).
- **Boot line** (`logWhatsAppAllPushes`, called from `src/index.ts`): "all pushes on … (from <ISO>)" or "all pushes off: <VAR> is not set | is not a valid ISO time (today's
  rule: one row per article)". Printed only when `WHATSAPP_QUEUE_ENABLED` is on; never prints a value.
- **UI** (`ui-developer`): `WhatsApp.vue` labels new-rule rows (Article / Course / Shop pill, only on those rows), keys rows by `articleKey` (a repeat shares its
  campaign id), sends `articleKey` on Posted / Skip / undo for new-rule rows, and reloads with a plain note on a 404.
- **Docs:** admin guide WhatsApp section + admin box ("never move the time earlier; after a restore set it to the restore time"), **version 2.24, 5 Nov 2026**;
  `.env.example`; `docs/BACKUPS.md` restore note.

## Files changed
- `src/lib/env.ts`: `WHATSAPP_ALL_PUSHES_FROM_VAR` + `env.whatsapp.allPushesFrom` (parsed with the shared `parseAllPushesFrom`).
- `src/services/whatsapp/pushText.ts` (new): `buildPushPostText`, `pushKindOf`.
- `src/services/whatsapp/queue.ts`: new-rule rows, day assignment, per-push marks, care for handed-back marks, boot line.
- `src/routes/whatsapp.ts`: optional `articleKey`, injectable time for tests.
- `src/services/metrics.ts`: Channels for new-rule pushes.
- `src/services/whatsapp/nudge.ts`: `nudgeTitle`.
- `src/index.ts`: the boot line call.
- `admin/src/views/WhatsApp.vue`: kind pill, per-row key, `articleKey` on marks, 404 note.
- `docs/Taxscan-Push-Admin-Guide.html`, `docs/BACKUPS.md`, `.env.example`: docs above.
- `src/__tests__/whatsappAllPushes.test.ts` (new, 21 tests).
- `docs/briefs/2026-11-05-whatsapp-every-push.shots/`: 4 screenshots (real titles).

## Migrations / flags
- **Migrations:** none (`WhatsAppPost.articleKey` already holds a string, unique per portal).
- **Env:** `WHATSAPP_ALL_PUSHES_FROM`, unset by default.

## Results (verbatim)
- `npx tsc -p tsconfig.json --noEmit` → `tsc exit 0`
- `npm run lint` → `lint exit 0`
- `npm run build:admin` → `✓ built in 2.89s`, `admin exit 0`
- New tests: `whatsappAllPushes.test.ts` → `Tests: 21 passed, 21 total`; with `whatsappQueue.test.ts` (UI agent's run): `Test Suites: 2 passed, 2 total`, `Tests: 33 passed, 33 total`.
- Area tests before the new file existed (`whatsapp*`, `campaignChannels`, `socialAllPushes`, `linkedin*`, `facebook*`): `Test Suites: 11 passed, 11 total`, `Tests: 506 passed, 506 total`, **all existing tests unchanged**.
- **Full suite (Full suite: yes, touches env/config):** `Test Suites: 101 passed, 101 total`, `Tests: 2348 passed, 2348 total`, `Time: 99.963 s`. The usual "worker failed to exit gracefully" line appears, as in earlier runs.

## Acceptance tests
1. **Unset / invalid — PASS.** No `kind`/`rule` field or new row; "pushed again" as today; invalid values (`04/11/2026`, `tomorrow`, `2026`) parse to off with the fixed words; boot line checked; every existing WhatsApp test passes unchanged.
2. **No flood — PASS.** Pre-time clone, course and product make no row; the pre-time article keeps its row and its POSTED mark.
3. **Repeats — PASS.** Same article twice = two rows; same course, same wording, twice = two rows; a clone of a posted article = a new row (different key).
4. **Article before + repeat after — PASS.** One new row for the repeat; the old row, its mark and its "pushed again" (pre-time clone only) untouched.
5. **Shop product + academy course — PASS.** One row each; the shop text asserted byte for byte (title with the double space collapsed, body, link with one UTM set, `utm_content=<slug>`).
6. **Not eligible — PASS.** Non-course academy page, shop collection, home, section page, draft, test-segment-only: no row, and marking them gives `not_found`.
7. **UTMs — PASS.** Exactly one of each `utm_*`; the push's own gone; other query params kept; `taxscan-whatsapp / social / whatsapp-channel / <slug|id>`.
8. **Text — PASS.** Emoji kept; `* _ ~ \`` removed from the title; line breaks flattened by `shortLine`; an over-long body cut to ≤ 160 with `…`, title kept; an empty body or one equal to the title adds no paragraph.
9. **Marks — PASS.** Posted / Skip / undo on one repeat leave the other untouched; a double press leaves one row; non-eligible campaign, wrong key, key on an old-rule push → 404; a malformed key → 400.
10. **Days — PASS.** A 23:59 IST push stays on its day, a 00:05 push and a repeat on a later day sit on theirs; 15 days back → 400 `invalid_date`.
11. **Nudge — PASS, with a caveat.** The queue's TODO rows (what the nudge counts) equal the screen's Todo count with the time set, and the title says "N posts waiting" when a course is among them. I did **not** run the nudge's own tick from the new test file: it keeps a shared watermark row (`NUDGE_KEY`) that `whatsappNudge.test.ts` also uses, so two files could clobber it across parallel workers. The nudge tests are unchanged and pass.
12. **Channels — PASS.** A new-rule push shows its own row (a repeat does not share it); a course gets a status; with the time unset the output is today's (article-key mark shared by the article's pushes, a course has none).
13. **LinkedIn / Facebook tests — PASS, unchanged** (inside the 506 and the full suite).
14. **Screen in a real browser — PASS (with limits).** Desktop 1280 and 390 / 375 px (same-origin iframe; no horizontal overflow): 7 mixed rows with the real titles ("📘  Zero to AI (2026) | COD AVAILABLE", "🔥 Reconcile Right…", "📘 Looking for a Complete Guide to TDS & TCS Compliance?") in push order, one old-rule row without a label, Copy put the exact server text on the clipboard, Share (stubbed) got the same text, Posted / Skip / undo on one repeat left the other alone, chip counts correct. Not verified: the real Web Share sheet on a phone; Copy/Share/marks were clicked on desktop only (same code at 390 px); the 404 banner text was not forced through the screen (the API 404 was checked).

## Agents run
- `ui-developer` (one, foreground): `WhatsApp.vue`, the guide section, browser check, screenshots. It changed no backend file. Its throwaway user (`wa-ui-throwaway@example.test`) is left **deactivated** in the build DB (it cannot be deleted: its login audit rows are append-only); seeded campaigns and marks are removed.

## Deviations and decisions to review
- **`WHATSAPP_ALL_PUSHES_FROM` has its own constant, not a key in `ALL_PUSHES_FROM_VARS`.** The LinkedIn / Facebook tests pin and iterate that object, so adding a key would have broken them (acceptance 13).
- **Care for handed-back marks (brief's Context, "removing a switch must not re-list"):** a push marked under the new rule that later follows today's rule (time removed or moved later) shows that mark in the queue instead of "waiting" again (so the nudge cannot re-announce it), and undo on that row clears it. **This is on even when the variable is unset.** In **Channels** the same care applies only while the time is set: an existing test (`socialAllPushes.test.ts` item 13, "WhatsApp never changes… its query only ever sees article keys") pins that, with the time unset, Channels never reads `push:` keys. So in the removed-time state Channels can say TODO for an article the queue shows POSTED. Cosmetic; say if you want the test changed instead.
- **A resent campaign row loses its earlier row.** `Campaign` keeps only the latest `lastSentAt`, so when the SAME campaign row is sent again its previous push has no way to be listed (its mark, if any, stays in the table, unlisted). A backfill clone, a Compose copy or a second campaign with the same link are separate rows and are fine. If "same row sent again" happens in practice, the fix is a stored row per push (like LinkedIn / Facebook), which this brief does not do.
- **Course / product text:** an empty body, or a body equal to the title, drops its paragraph (as for articles). The brief did not say.
- **Marking without a key** on a campaign at or after the time marks that push's own key (so an older client cannot mark an article-key by accident).
- **Nudge title** changes to "posts" when a course/product is waiting (brief said "no change to pacing, tag or opt-in"; title wording only).
- **Undo on a today's-rule row** also reads recent campaigns (28 days) to find the article's other pushes and clear their push-key marks. One read, only on undo.

## Worth remembering
- Row identity on the screen is `articleKey`, not `campaignId`: a row of the new rule is one push, and `campaignId` alone would not tell two pushes of related rows apart in the UI's busy and copied state.
- The time must never be moved earlier once set (the guide's admin box and `.env.example` say so); after a restore set it to the restore time (`docs/BACKUPS.md`).
- `kind` is on new-rule rows only, so a screen that wants an "Article" label on today's rows would need the server to add it.

## Clean-up (planning runs this after merging)
```sh
git worktree remove ../taxscan-push-worktrees/whatsapp-every-push
dropdb taxscan_push_build_whatsapp-every-push; dropdb taxscan_push_build_whatsapp-every-push_shadow
git branch -D build/whatsapp-every-push; git push origin --delete build/whatsapp-every-push
```
