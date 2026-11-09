# REPORT: 2026-11-09-small-fixes

- **Branch:** `build/small-fixes` (base `origin/develop` b372fbe)
- **Code commit:** `197e333`
- **Built to the brief. Acceptance 1-6 all PASS.** No flag, no migration. **Item 5 (LinkedIn daily limit) changes production behaviour of the LinkedIn worker** (the rest is wording, a log line and test-only changes); the full suite ran once, as item 4 needs.

## For planning to read first

1. **Item 5, what it does and what it does not (live-urgent, Shopscan):**
   - A create call answered **HTTP 429 with a message containing `Organization post creation limit reached`** (case-insensitive; only a 429) is a new verdict `org_limit` in the client. Every other 429 (other message, no JSON) is still `retry`: +1 / +5 / +15 min, then FAILED.
   - The row that met it is **SKIPPED `org_daily_limit` after ONE call** (its `attempts` stays 1, so that call still counts toward the Academy/Shopscan headroom guard; the 3 wasted calls per push no longer happen). The page is **held until the next 00:00 UTC** after the answer (05:30 IST): in memory only, so a restart (a deploy) forgets it and the next such 429 sets it again (one more wasted call, one more log line).
   - While held, **every further push to that page** is SKIPPED `org_daily_limit` with **no API call, no image upload and no picture work** (rows are written in the same tick, so none is left to post after midnight: a late post of an old push is never made). A retry that was waiting for its turn is SKIPPED the same way. After 00:00 UTC only pushes sent from then on post.
   - **A manual immediate push is NOT exempt** (unlike `quota_headroom`): the brief says every further push is skipped, and LinkedIn would refuse it too. Say if you want an exemption (it would waste one call per such push).
   - Other pages are unaffected (tested for Academy refused while Shopscan and Taxscan post). One log line per hold: `[linkedin] page=<page> org_daily_limit held until <ISO>`.
   - **Not retroactive:** Shopscan rows that already went FAILED today under the old 4-attempt path stay FAILED. Retry on one of them makes ONE call, gets the limit answer, becomes SKIPPED and holds the page again; it does not post.
   - The LinkedIn screen reads **"Skipped — LinkedIn's daily limit for this page"** on those rows (no Retry, no Skip, counted under Skipped; `skipReason: 'org_daily_limit'` on the API row). The Campaigns LinkedIn mark reads "LinkedIn: skipped" for this reason and for `quota_headroom` alike, and "skipped in Compose" for a Compose untick (no raw code ever shows; unchanged, see point 5).
2. **Item 4: three test-side leaks found, none in production code.** `--detectOpenHandles` (the whole suite in-band) named exactly three open handles: `whatsappNudge.test.ts:199`, `facebookWorker.test.ts:651` and `linkedinWorker.test.ts:867`. Each test spied on `cron.schedule` with `jest.spyOn` (which calls through) and then called the real `startWhatsAppNudge()` / `startFacebookWorker()` / `startLinkedInWorker()` to prove the success path, so a real 1-5 minute cron timer stayed alive. All four such spies in the two worker files and the nudge test now `mockImplementation` (the same assertions, `toHaveBeenCalledWith('* * * * *', ...)`, still hold). A full run now prints **no** "failed to exit gracefully" line (it did on every run before: also on my first full run of this build). The `campaignChannels.test` leftover was the home-page campaign (`https://www.taxscan.in/`: its URL has no run id, so the URL-based delete missed it); it is now deleted by id and the afterAll asserts none remain. Proof: the original file left `Chan home|https://www.taxscan.in/` behind (1 row); the fixed one leaves 0.
3. **Item 1 has no automated test** (the admin SPA has only Playwright e2e, and none covers this tooltip). `ui-developer` checked the exact strings in a real browser; see acceptance 1. Say if you want an e2e line for it.
4. A copy of the ORIGINAL `campaignChannels.test.ts` run under another file name failed all 6 tests in my check (the real file passes in every full run); I did not investigate, as the run only served to show the leftover row.

## What it does, per item

- **1. Channels tooltip** (`admin/src/views/Campaigns.vue`): a small pure `channelsHelp(features)` builds "Whether this push was also posted to <channels on>. Click a mark to open that screen." from `user.features` (WhatsApp, LinkedIn, Facebook, Telegram, in that order, "A, B and C" / "A and B" / a single one). The two hard-coded strings are gone. The only other "the article" help text there was this heading.
- **2. Nudge** (`src/services/whatsapp/nudge.ts`): `nudgeTitle()` always counts posts: `WhatsApp: 3 posts waiting` (`1 post waiting` for one). The body (newest waiting headline) is unchanged. Code comments and the staff-push route / composable comments that said "articles waiting" are updated; the guide line quotes the new title.
- **3. Boot line:** `socialAnyLinkBootLine()` (pure, in `src/services/social/allPushes.ts`) printed from `src/index.ts` right after the WhatsApp every-push line, whichever channels are on: `[social] any allowed link posts (from <ISO>)` or `[social] any-link rule off: SOCIAL_ANY_LINK_FROM is not set | is not a valid ISO time`. A bad value is never printed.

## Files changed

- Backend: `src/services/linkedin/{client,worker}.ts` (item 5), `src/routes/linkedin.ts` (`skipReason`), `src/services/whatsapp/nudge.ts`, `src/routes/staffPush.ts` (comment), `src/services/social/allPushes.ts`, `src/index.ts`.
- Admin (`ui-developer`): `admin/src/views/Campaigns.vue`, `admin/src/views/LinkedIn.vue`; one comment in `admin/src/composables/useStaffPush.ts` (mine).
- Docs: `docs/Taxscan-Push-Admin-Guide.html` (**v2.35**: the nudge title; the LinkedIn Skipped row gains the daily-limit reason).
- Tests: new `src/__tests__/linkedinOrgLimit.test.ts` (18) and `src/__tests__/socialBootLine.test.ts` (4); updated (not deleted) `whatsappNudge.test.ts` and `whatsappAllPushes.test.ts` titles; test-only fixes in `whatsappNudge.test.ts`, `facebookWorker.test.ts`, `linkedinWorker.test.ts`, `campaignChannels.test.ts`.

## Migrations / flags

None.

## Test results (verbatim)

- `npx tsc -p tsconfig.json --noEmit`: no output. `npm run lint`: clean. `cd admin && npx vue-tsc --noEmit`: exit 0. `npm run build:admin`: `✓ built in 3.40s` (dist removed).
- New suites: `linkedinOrgLimit.test.ts` `Tests: 18 passed, 18 total`; `socialBootLine.test.ts` 4 passed; the nudge and all-pushes suites pass with the new titles.
- **Full suite, final tree: `Test Suites: 117 passed, 117 total` / `Tests: 2795 passed, 2795 total`** (170 s, `maxWorkers: 2`, **no "failed to exit gracefully" warning**). The first full run (all green, 2795) still printed the warning; the second, after the three mocks, did not. (Before this build: 115 suites / 2773 tests; +22 = the two new files.)
- **The item-5 tests bite** (mutation checks, each restored byte-for-byte): 429 org-limit not recognised -> 1 failed (the client unit test); any 429 treated as the org limit -> 2 failed; no hold set -> 9 failed; later pushes still call -> 5 failed; waiting retry not skipped -> 1 failed; hold lasts two days -> 4 failed; hold never ends -> 2 failed; hold shared across pages -> 3 failed. (Two first attempts were invalid, one did not compile and one named the real page instead of the test pages; both were redone.)

## Acceptance tests

1. **PASS** (real browser, `ui-developer`; no automated test, point 3). The Channels heading's `title`, hovered / read as the attribute: all four on: `Whether this push was also posted to WhatsApp, LinkedIn, Facebook and Telegram. Click a mark to open that screen.`; WhatsApp + LinkedIn: `...posted to WhatsApp and LinkedIn....`; WhatsApp + LinkedIn + Facebook (Telegram off): `...posted to WhatsApp, LinkedIn and Facebook....`; only Telegram: `...posted to Telegram....`; WhatsApp + Telegram: `...WhatsApp and Telegram....`; LinkedIn only: `...LinkedIn....` (the old text named Facebook even while it was off).
2. **PASS.** `nudgeTitle` for 3 waiting rows of any kinds (article / course / product / page / no kind): `WhatsApp: 3 posts waiting`; `1 post waiting` for one; the three existing nudge assertions and the all-pushes assertions were updated, not deleted; the real-queue nudge test still sends the newest headline as the body.
3. **PASS.** `socialBootLine.test.ts`: set (UTC, +05:30 offset, date-only) -> `[social] any allowed link posts (from <ISO>)`; unset / blank -> `[social] any-link rule off: SOCIAL_ANY_LINK_FROM is not set`; invalid (`soon`, `Nov 7`, `07/11/2026`, `2026`, `2026-13-45`, epoch digits) -> `... is not a valid ISO time` with the bad value never printed; the default reads `process.env`.
4. **PASS.** The full run shows **no** "failed to exit gracefully" warning (point 2); `campaignChannels.test` leaves no rows: Campaign rows titled `Chan %` before = 0, after the fixed run = 0 (the original left 1), and its afterAll asserts none of its ids remain.
5. **PASS.** tsc, lint, vue-tsc and the admin build are clean.
6. **PASS** (`linkedinOrgLimit.test.ts`). 429 + `Organization post creation limit reached` on Shopscan: the row is SKIPPED `org_daily_limit`, attempts 1, **one** call (not four), Taxscan and Academy post normally; a backlog of three: one call, the rest SKIPPED with no call in the same run; the next Shopscan push the same UTC day (later ticks too) makes no call while Taxscan / Academy post it; one second before 00:00 UTC still held, at 00:00 UTC Shopscan posts again and what was skipped is never posted later; a plain 429 (other body) retries at +1 min, sets no hold, the next push still calls the page, and four attempts still end FAILED (+1, +5, +15); one log line per hold with the exact text, none for other pages, one more after a restart; a waiting retry is SKIPPED when the page is held; a manual immediate push is skipped too; Academy refused holds only Academy; a skipped row has no Retry/Skip (`skipPost` false, `retryNow` `not_failed`); the screen API carries `skipReason: 'org_daily_limit'` on that row only and counts it under Skipped. Client: `isOrgDailyLimitAnswer` true only for a 429 with that message; the token never reaches the verdict.

## Agents run

- `ui-developer` (one, background): the Channels tooltip and the LinkedIn row wording, real-browser check (ADMIN, desktop and 375 px; all channel combinations). Seeded rows / users removed, server stopped; no jest run by it. Never touched the main checkout, production, the stash, `develop` or `main`.

## Deviations from the brief

- A manual immediate push is not exempt from the org-limit hold (point 1; the brief says every further push).
- The leak was in three test files, not the suspected metrics warmer or `campaignChannels` (point 2); `campaignChannels` had only the leftover-row problem.
- I added the daily-limit reason to the guide's LinkedIn Skipped row (the brief only named the nudge line).

## Worth remembering

- A `jest.spyOn(cron, 'schedule')` calls through unless it has a `mockImplementation`: any test that then calls a real `start*()` leaves a live timer and prints the "failed to exit gracefully" warning. Always mock it (the Telegram tests already do).
- `--detectOpenHandles` runs the suite in-band and, once it has printed its report, the process stays alive on the very handle it found (that is how I confirmed the leak); stop it by PID.
- LinkedIn's per-page limit resets at 00:00 UTC (05:30 IST), which is inside quiet hours: nothing posts then by itself, because the skipped pushes are never posted later and new pushes arrive by day.

## Clean-up (planning runs this after merging)

```
cd /Users/bestdoc/Documents/taxscan-push
git worktree remove ../taxscan-push-worktrees/small-fixes
dropdb taxscan_push_build_small-fixes && dropdb taxscan_push_build_small-fixes_shadow
git branch -d build/small-fixes   # after the merge
```
