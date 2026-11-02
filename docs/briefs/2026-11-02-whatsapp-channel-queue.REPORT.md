# REPORT: whatsapp-channel-queue

- **Branch:** `build/whatsapp-channel-queue` (base `origin/develop` 48bbb39). **Code commit:** see `git log` (first commit on the branch).

## Files changed
- `prisma/schema.prisma` + `prisma/migrations/20261102072305_whatsapp_post/` — enum `WhatsAppPostStatus` (POSTED/SKIPPED) + table `WhatsAppPost` (unique `portal+articleKey`, FK `actedByUserId → User` ON DELETE SET NULL). **Additive.**
- `src/services/whatsapp/utm.ts` — the three constants + `withWhatsAppUtm` (SET, drops any existing `utm_*` case-insensitively, keeps other params + fragment).
- `src/services/whatsapp/postText.ts` — `buildPostText`, `cleanHeadline`, `shortLine` (≤160 incl. "…", word boundary), `articleIdOf` (taxscan.in / www only). Null for non-article, other hosts, or off-allowlist final link.
- `src/services/whatsapp/queue.ts` — `getQueue` (IST day, one row per article, first push position, "pushed again"), `markArticle`, date validation (≤14 days back, not future).
- `src/routes/whatsapp.ts`, `src/app.ts` — `GET /api/whatsapp/queue`, `POST /api/whatsapp/queue/:campaignId`; ADMIN/PUBLISHER/bearer; flag off → 404 before auth.
- `src/lib/env.ts`, `.env.example` — `WHATSAPP_QUEUE_ENABLED` (default false).
- `src/routes/auth.ts` — `/api/auth/me` gains `features: { whatsappQueue }` so the SPA can hide the menu item.
- `admin/src/views/WhatsApp.vue` (new), `admin/src/router.ts`, `admin/src/components/NavBar.vue`, `admin/src/composables/useAuth.ts` — the screen, route gate, PUSH-group menu item after Campaigns (hidden unless the flag is on).
- `docs/Taxscan-Push-Admin-Guide.html` — new section 11 "The WhatsApp channel", renumbered Quick reference/FAQ, screens-table row; **guide 2.12 → 2.13** (cover + footer). No test pins the version.
- `docs/BACKUPS.md` — `WhatsAppPost` deliberately excluded from the R2 export.
- Tests: `src/__tests__/whatsappPostText.test.ts`, `src/__tests__/whatsappQueue.test.ts` (18 tests).

## Migrations / flags
`20261102072305_whatsapp_post` (additive). Flag `WHATSAPP_QUEUE_ENABLED`, default off.

## Results (verbatim)
- `npx tsc -p tsconfig.json --noEmit`: clean. `npm run lint`: clean. `npm run build:admin`: clean (vue-tsc + vite).
- New tests: `Tests: 18 passed, 18 total`.
- **Full suite ran** because the build touches the Prisma schema/migration, config/env loading and auth (`/me`). Last run: `Test Suites: 1 failed, 85 passed, 86 total` / `Tests: 2 failed, 1734 passed, 1736 total`; the 2 failures are `digestTick.test.ts` (complaint-rate hold, "UNKNOWN…" and "17:00 cut-off" cases), **not touched by this build**: re-run alone twice → `Tests: 33 passed, 33 total` both times. An earlier full run (same code, before one test fix) showed 1735 passed, digestTick green. So `digestTick` looks flaky under parallel load — worth a look (planning's flaky-test list).

## Acceptance tests
1. Post text exact (bold headline, ≤160-char line, UTM link; `*_~` and backticks stripped; empty / equal body drops the line): PASS (`whatsappPostText`).
2. Exactly one each of the four UTMs; replaces `utm_source=taxscan-push`; other params + fragment survive: PASS.
3. Queue for a seeded IST day: only SENT taxscan.in articles of that day, 00:00 and 23:59 IST inside, neighbours out, `lastSentAt` order, academy/draft/other-portal/non-article excluded: PASS.
4. Backfill clone appears once at the first push's position with "pushed again": PASS (same-day clone; a next-day push shows as "pushed again" on the first day's row).
5. POSTED shows with user + time; TODO deletes the row; marking via the clone's id is the same article; a later push of a Posted article stays Posted: PASS.
6. Roles/flag: ADMIN + PUBLISHER read and mark; no session 401; flag off 404 on both endpoints; `/me` carries the flag: PASS. Menu hidden with the flag off: PASS (browser).
7. ui-developer, real browser (headless Chromium via DevTools; claude-in-chrome tools unavailable), desktop + 375 px: PASS. Copy puts the exact server `text` on the clipboard and the row stays To do; Share absent on desktop, present with `navigator.share` stubbed and called with the same text; cards stack at 375 px, `scrollWidth` 375, 16 px fields / 44 px targets; date input min today-14; empty state; Posted/Skip/Undo counts. Screenshots in `/private/tmp/claude-501/-Users-bestdoc-Documents-taxscan-push/b1b9efaf-a625-451b-a08e-6776335abfdb/scratchpad/` (`desktop-todo.png`, `desktop-all.png`, `desktop-final.png`, `phone-todo.png`, `phone-share.png`, `phone-menu.png`).
8. tsc, lint, new tests pass. Migration applies cleanly on an **empty DB** (the build DB was built from scratch, all 47 migrations): PASS. **"On a copy of develop's schema": not run separately** — the build DB is exactly develop's migrations plus this one; no prod/dump copy was used (no production access by rule).

## Agents run
ui-developer, once: screen, route gate, menu, guide section, browser checks. (backend by the builder.)

## Deviations / decisions
- An article is listed on the IST day of its **first** push (looked up over the 14 days before the day), so a clone pushed on a later day never reappears as To do on that later day; it only sets "pushed again" on the original row.
- Only `taxscan.in` / `www.taxscan.in` URLs with a trailing numeric id (≥4 digits) are articles; `academy.`/`shop.` and homepage/section links are excluded. `articleKey()` itself treats any `*.taxscan.in` as taxscan, so the host check is in `articleIdOf`.
- No audit-log rows for Posted/Skipped (brief asks only "who and when on the row"; adding actions would change the `AuditAction` enum).
- `/api/auth/me` response gained `features` (the brief says the menu item is hidden when the flag is off but not how the SPA learns it).
- Date picker: today / yesterday buttons plus a date input (min today−14).

## Worth remembering
- The list is read-only on `Campaign` + `WhatsAppPost` (no `Event`). It fetches ≤ 14 + 1 days of SENT campaigns (select-only, `lastSentAt` indexed) per request — ~400 rows.
- Two throwaway users (`admin@waq.test`, `pub@waq.test`) from the browser check remain in the **build DB** as inactive (their AuditLog login rows are append-only and reference them). They vanish with `dropdb`.
- `ReportFindings`-style hint for planning: the dark-mode build and this one both ran the full suite; `digestTick` flaked once under parallel load.
- Real WhatsApp app sharing (phone share sheet → WhatsApp) not tested; the real check is the team using it from their phones, and GA4 showing `taxscan-whatsapp / social` after the first posts.
- Turning it on in production = set `WHATSAPP_QUEUE_ENABLED=true` on Railway (a migration applies on deploy).

## Clean-up (planning session, after merge)
```sh
git worktree remove ../taxscan-push-worktrees/whatsapp-channel-queue
dropdb taxscan_push_build_whatsapp_channel_queue; dropdb taxscan_push_build_whatsapp_channel_queue_shadow
git branch -D build/whatsapp-channel-queue; git push origin --delete build/whatsapp-channel-queue
```

---

# Follow-up 1 (live bug: today's taxscan.in links have no trailing id → empty list)

- **Branch:** `build/whatsapp-channel-queue` fast-forwarded to `origin/develop` (the first build was already merged), then one code commit `1664874`.

## Files changed
- `src/services/whatsapp/postText.ts` — `articleIdOf` replaced by `articleContentOf(c)`: host `taxscan.in`/`www.taxscan.in` (http/https) and a path with ≥ 2 segments, or a trailing numeric id (≥ 4 digits). Returns `utm_content`: the numeric id when present, else the last path segment cut to 100 characters (`UTM_CONTENT_MAX`). Home page, section index pages (`/income-tax`), academy/shop and other hosts → null.
- `src/services/whatsapp/utm.ts` — second argument renamed `content` (the id or the slug); SET behaviour unchanged.
- `src/services/whatsapp/queue.ts` — `getQueue` and `markArticle` use `articleContentOf`. Identity is still `articleKey()` (the id, else the URL); `articleKey` itself untouched.
- Tests: `whatsappPostText.test.ts` (G2, G4 added), `whatsappQueue.test.ts` (G1 fixtures in both URL shapes, G3 clone collapse, mark a no-id article; the home fixture is now the real home page, plus a section page).

## Results (verbatim)
- tsc clean; lint clean.
- Area tests (`whatsapp*`, `reports*`): `Test Suites: 4 passed, 4 total` / `Tests: 59 passed, 59 total`.
- No full suite (brief: area tests only; the release check covers the rest). No migration, no new flag, no schema/auth/env change.

## Acceptance
- G1 PASS (both URL shapes listed in push order and markable Posted / Skipped / undo). G2 PASS (no-id → `utm_content=<slug>`, ≤ 100 chars; id URL keeps the id). G3 PASS (two pushes of the same no-id URL → one row, "pushed again 19:30"). G4 PASS (`/`, `/income-tax`, `/income-tax/`, `taxscan.in/gst`, academy, shop, other hosts, ftp excluded). G5 PASS.

## Worth remembering
- A no-id article's `articleKey` is its full URL (query string included), so the same slug with a different query string is a different row; fine for push URLs, which don't carry one.
- Any two-segment taxscan.in path counts as an article (e.g. a `/tag/gst` page would, if the pacer ever pushed one). The pacer only pushes feed articles, so none is expected.
- Rows already marked under `article:<id>` keys are unaffected; no-id articles get their URL as the key (no row existed for them, as the list was empty).
- Not browser-checked: no UI change. Prod already has the flag on; the fix applies on deploy.
