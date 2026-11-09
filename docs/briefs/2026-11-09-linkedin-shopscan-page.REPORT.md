# REPORT: 2026-11-09-linkedin-shopscan-page

- **Branch:** `build/linkedin-shopscan-page` (base `origin/develop` 3a39823, which has the main brief, Follow-up 1 and Follow-up 2)
- **Code commit:** `1fe5198` (one commit: the main brief + Follow-up 1 + Follow-up 2, as asked: both follow-ups reached me before I committed)
- **Built to the brief. Acceptance 1-11 and 4a-4g all PASS.** Points for planning are in the next section; the first two matter before a release.

## For planning to read first

1. **The guard is live for Academy the moment this deploys.** Follow-up 1 gives Academy a default of 75, with no flag and no dependence on
   Shopscan's variables, so the first deploy starts holding Academy at 75 create attempts a day, as the owner decided, even if Shopscan is never
   switched on. To soften it without a code change: `LINKEDIN_ACADEMY_DAILY_HEADROOM` up to 100 (the highest valid number; 100 holds only at 100 or more).
2. **The count is read ONCE per tick, before anything in the tick posts.** Acceptance 4a ("74 creates today → all three pages post") cannot
   hold with a live count: Taxscan's own post would make 75 and hold Academy in the same tick. A tick makes at most 3 posts, so a page can pass
   its number by at most 2 (Academy to 77, Shopscan to 87). Documented in `docs/LINKEDIN_POSTING.md` "The daily quota guard".
3. **What "creates today" is** (nothing new is stamped, no schema change): `postsCreatedToday(now)` = the sum of `LinkedInPost.attempts` over rows
   whose `updatedAt` falls on the IST day of `now`, across ALL pages (SKIPPED `quota_headroom` rows have attempts 0 and add nothing). It counts
   attempts, not calls: a Compose picture posted as an image and then repeated as a link post is one attempt and two calls (under-counts), and a row
   retried across midnight counts all its attempts (over-counts). The 15 to 25 left below LinkedIn's 100 absorb both. One unindexed aggregate per
   tick while any held-able page is in the list (the table grows ~66 rows a day; revisit with an index on `updatedAt` only if it passes tens of thousands).
4. **Not guarded, on purpose (the brief says "before it creates a post"):** the retries of a row that already exists (at most three more calls per
   row) and the screen's manual **Retry**. If you want them held too, it is a few lines in the retry loop; say so and I add it as Follow-up 3.
5. **How a manual immediate push is told apart (Follow-up 2): `Campaign.createdByUserId` set AND `scheduledAt` empty** (`isManualImmediatePush`).
   It IS reliably distinguishable without a schema change, and I checked it through the real doors, not by seeding fields:
   - Compose Send now and Breaking (`dispatchCampaign`), Queue Push now and Review Push now (the real routes, with a logged-in session): all four leave
     `createdByUserId` = the user and `scheduledAt` null.
   - Not manual, so still held: the pacer and RSS captures (no `createdByUserId`); the morning-backfill clone (`cloneForResend` copies neither
     field, so even the clone of a manual push is held); a **scheduled** Compose send and a Compose send the **night rule deferred** to 07:00 (both
     keep their `scheduledAt` after `executeCampaign` sends them); and **a bearer / curl send, even by the owner** (no `req.user`, so no
     `createdByUserId`). A Queue/Review Push now made with the bearer instead of a session is likewise held. All documented.
6. **No existing test was edited.** Academy's parse wording, boot lines and tests are unchanged; the Academy headroom lives in a separate
   `env.linkedin.dailyHeadroom` (not on the shared-page object) precisely so Academy's `parseLinkedInAcademyEnv` result is byte-identical.
7. **Docs I did not edit (outside the brief's list):** `docs/BACKUPS.md:139` (the restore rule names `LINKEDIN_ACADEMY_POST_FROM`; it should also name
   `LINKEDIN_SHOPSCAN_POST_FROM`, which is Shopscan's go-live AND every-push time: after a restore it must be set to the restore time or Shopscan
   posts everything pushed since). `docs/LINKEDIN_POSTING.md` already says so under "Backups and restores". CLAUDE.md / NEXT_STEP are yours.

## Files changed
- `src/lib/env.ts` - `parseSharedLinkedInPage(src, prefix)` (one parser; `parseLinkedInAcademyEnv` calls it with `'ACADEMY'`, same words),
  `parseLinkedInShopscanEnv`, `LINKEDIN_HEADROOM_VARS` / `_DEFAULTS` (75 / 85) / `LINKEDIN_DAILY_LIMIT`, `parseLinkedInHeadroom` (whole number 1-100, else
  the default + a note), `env.linkedin.sharedPages` now carries `shopscan` when active, new `env.linkedin.dailyHeadroom` (read at call time).
- `src/services/linkedin/pages.ts` - `PAGE_SHOPSCAN`, `SHARED_PAGES`, `shopscanActive`, `portalPages()` = Taxscan, Academy, Shopscan (each only while active),
  `pageAllPushesFrom('shopscan')` = its post-from while active, `pageHeadroom(page)`, `postFromVarOf(page)`.
- `src/services/linkedin/worker.ts` - `postsCreatedToday`, `isManualImmediatePush`, `QUOTA_HEADROOM`; the count read once per tick; the held-page branch
  (SKIPPED `quota_headroom` rows, attempts 0, no call, no budget, all waiting pushes in that tick); one log line per held page per IST day; the
  extra columns (`createdByUserId`, `scheduledAt`) are read only for a held page; startup message names the right go-live variable; boot lines (below).
- `src/routes/linkedin.ts` - `skipReason: 'quota_headroom'` on a held row only; comments for `shopscan`.
- `admin/src/views/LinkedIn.vue` (ui-developer) - Shopscan label, the held-row wording, wording that works for two or three pages.
- `docs/LINKEDIN_POSTING.md`, `docs/Taxscan-Push-Admin-Guide.html` (v2.29 -> **v2.30**, 9 Nov), `.env.example` - as the brief lists.
- `src/__tests__/linkedinShopscan.test.ts` (new, 61 tests). `image.ts` unchanged: uploads were already under each page's own org URN.

## Migrations
None (`LinkedInPost.page` is a plain string; nothing new is stamped).

## Flags / env added (all default off or default number)
- `LINKEDIN_SHOPSCAN_ORG_URN`, `LINKEDIN_SHOPSCAN_POST_FROM` - unset = no Shopscan page. Both valid = on (the switch; `LINKEDIN_POSTING_ENABLED` still governs everything).
- `LINKEDIN_ACADEMY_DAILY_HEADROOM` (default **75**), `LINKEDIN_SHOPSCAN_DAILY_HEADROOM` (default **85**) - whole number 1-100; anything else = the default + a boot note.
- Boot lines (names, never values): `[linkedin] shopscan page off: <reason>` / `… page on (post from <ISO>; every push from then)`;
  `[linkedin] daily quota guard: Academy held at 75, Shopscan held at 85 posts a day, counted across all pages (Taxscan never held)` (active pages only;
  page names capitalised so Academy's existing one-line boot test is untouched); `[linkedin] quota guard: <VARIABLE> is not a whole number from 1 to 100 (using N)`;
  and per held page per IST day `[linkedin] page=<page> quota_headroom skipped=N`.

## Test results (verbatim)
- `npx tsc -p tsconfig.json --noEmit` - no output, exit 0
- `npm run lint` - `eslint "src/**/*.ts"`, no output (clean)
- `cd admin && npm run build` (vue-tsc + vite) - `✓ built in 2.14s`
- New file: `Test Suites: 1 passed, 1 total` / `Tests: 61 passed, 61 total`
- Area (`linkedin*`, `social*`, `facebook*`, `whatsapp*`, `campaignChannels`, `env*`): `Test Suites: 15 passed, 15 total` / `Tests: 668 passed, 668 total` (this ran before the UI edit and the docs; no source file it covers changed afterwards)
- **Full suite (brief: `Full suite: yes`; config/env touched), once, `NODE_OPTIONS=--max-old-space-size=1536`, under `nice`:** `Test Suites: 109 passed, 109 total` / `Tests: 2573 passed, 2573 total` / `Time: 81.861 s`
  - The log has one `A worker process has failed to exit gracefully…` line. Neither `linkedinShopscan.test.ts` nor `linkedinAcademy.test.ts` shows it when run alone; I did not trace which file does (not asked to).
- **The new tests bite** (checked by temporarily changing the worker, then restoring it byte-for-byte): without the manual-push exemption `Tests: 6 failed, 55 passed, 61 total`; with the count forced to 0 (no guard) `Tests: 16 failed, 45 passed, 61 total`.

## Acceptance tests
1. Variables unset / one set / invalid time / invalid URN: off, one boot line naming the variable, no startup problem, Academy's wording unchanged; a tick without the page makes Taxscan + Academy rows only and no line mentions Shopscan - **PASS**
2. Active: one push = three rows and three calls in the order Taxscan → Academy → Shopscan, with `linkedin-shopscan` on Shopscan's link (private page names in the tick; the real-name UTM and `buildPost` checked directly) - **PASS**
3. Every push from go-live: an Academy course, a shop product, a site page (`SOCIAL_ANY_LINK_FROM` set) and exact repeats each post to Shopscan; a push before its go-live never does, at any later age; one exactly AT it does - **PASS**
4a. 74 → all three post; 75 → Academy SKIPPED `quota_headroom` (no call), Taxscan + Shopscan post - **PASS**
4b. 85 → Academy and Shopscan SKIPPED, Taxscan posts; 84 → Shopscan still posts; 150 → Taxscan still posts; a new IST day resets both and yesterday's skipped push is not posted late; one log line per page per IST day; all waiting pushes skipped in the tick - **PASS**
4c. Both variables override their defaults (the held number is the number: exactly at it is held, one below is not); invalid (`0`, `101`, `-5`, `7.5`, `many`, `1e1`, `0x10`, `+5`) → default + boot note - **PASS**
4d. With Shopscan inactive the Academy guard still works (74 posts, 75 holds); with no held-able page in the list the count is not even read - **PASS**
4e. With 90 creates: Compose Send now, Queue Push now, Review Push now and Breaking each post on all three pages; a pacer push the same minute posts on Taxscan only (Academy + Shopscan SKIPPED); the exemption is per push inside one tick, in either order - **PASS** (Compose + Breaking via `dispatchCampaign`, Queue/Review via the real routes with a session)
4f. A scheduled Compose send firing at 90 creates is held; so are the backfill clone of a manual push and a bearer send (all three run through the worker). A Compose send the night rule deferred to 07:00 is shown to keep its `scheduledAt` after it is sent, so `isManualImmediatePush` is false for it (checked on the recorded fields, not run through the worker) - **PASS**
4g. A manual push that gets a real 429 follows the existing retry path (+1 min then posts; with four straight 429s FAILED after four attempts); a manual post counts toward the day's total - **PASS**
5. A 403 on Shopscan stops Shopscan only; Taxscan and Academy post in the same and later ticks; one alert per page per IST day; the alert names the owner's token variable; a 403 on Academy alone does not hold Shopscan back - **PASS**
6. Retry / Skip on a Shopscan row leaves the other pages' rows untouched (ids, statuses and `updatedAt` identical); a `quota_headroom` row answers `not_failed` / 409 and `not_skippable` / 409 - **PASS**
7. Renewal: one `LinkedInToken` row, one renewal call, none for either shared page; all three pages post with the new token on the next tick; one renewal ends all three stops and banners - **PASS**
8. `GET /api/linkedin/posts?page=shopscan`: its rows and banner when active; 400 `invalid_page` when inactive or unknown; default still the first page; `skipReason` only on a held row - **PASS**
9. Screen, real browser, desktop and 375 px (`ui-developer`, Playwright Chromium, no worker, no LinkedIn call): no Shopscan switch when inactive; switch with Shopscan; rows and banner follow the page; held-row wording; no Retry/Skip on a held row; no overflow at 375 px - **PASS**. Screenshots (not in the repo), all under `/private/tmp/claude-501/-Users-bestdoc-Documents-taxscan-push/963246c2-195c-4c4d-94e1-55b004759fb2/scratchpad/ui-check/`: `a-desktop-3pages-shopscan.png`, `a2-desktop-3pages-academy.png`, `b-375-3pages-shopscan.png`, `b2-375-3pages-shopscan-viewport.png`, `b3-375-3pages-academy.png`, `c1-desktop-taxscan-shopscan-only.png`, `c2-desktop-taxscan-only.png`, `d-desktop-stop-banner-and-token-3pages.png`. I looked at `a-` and `b2-` myself: they show what the agent reported. They use SAMPLE rows seeded for the check, not production content.
10. Compose picture: a push with a picture uploads it under each active page's own org URN (Taxscan, Academy, Shopscan) with the shared token, and each post carries its own image - **PASS**. Compose itself needed no change (its text names no page count).
11. Facebook, WhatsApp, Campaigns Channels and Academy tests pass unchanged - **PASS** (in the 668-test area run and the full suite)

## Agents run
- `ui-developer` (one, background): the LinkedIn screen and its real-browser check. It served the real API through a throwaway `createApp` script (no worker, dummy tokens) and cleaned up its seeded rows and the login audit rows it wrote, in the private build DB only. Its script and server log stay in the scratchpad `ui-check/` folder.
- Nothing else; the backend and tests I wrote myself (no second agent in parallel).

## Deviations from the brief
- None in behaviour. Two choices the brief left open: the count is read once per tick (needed for 4a), and Academy's number sits in `env.linkedin.dailyHeadroom` rather than on the shared-page object (keeps Academy's parse output unchanged).
- Retries / manual Retry are not guarded (point 4 above): the brief's wording is "before Shopscan creates a post".

## Worth remembering (for planning to turn into record, or not)
- `Campaign.lastSentAt` is stamped by `executeCampaign` with the REAL time and `LinkedInPost.updatedAt` by the database, so a test with an injected clock cannot "make" creates today: the new tests use a day that is not today (20 Nov 2026) and seeded rows with an explicit `updatedAt`.
- `tsc -p tsconfig.json` does not cover `src/__tests__`; ts-jest does, so a test file's type error only shows when jest runs it.
- A held page skips ALL its waiting pushes in one tick and spends no budget, so on a heavy day Academy goes from posting to skipping a whole backlog in a minute; that is the owner's rule, but the screen will show a run of "Skipped" rows at once.
- The `ui-developer` noticed, and did not change: a Retrying row's reason renders red although its class says muted (existing CSS specificity); the Campaigns Channels mark for LinkedIn reads just "LinkedIn: skipped" and was not checked for Academy/Shopscan state (it still means the Taxscan page only, by design).
- `docs/LINKEDIN_POSTING.md` now has a section "The daily quota guard"; the old "Quota note" paragraph points at it.

## Clean-up (planning runs this after merging)
```sh
git worktree remove ../taxscan-push-worktrees/linkedin-shopscan-page
dropdb taxscan_push_build_linkedin-shopscan-page; dropdb taxscan_push_build_linkedin-shopscan-page_shadow
git branch -D build/linkedin-shopscan-page; git push origin --delete build/linkedin-shopscan-page
```
(The earlier build's worktree and databases, `audience-alert-fixes`, are still in place; planning has merged that branch.)
