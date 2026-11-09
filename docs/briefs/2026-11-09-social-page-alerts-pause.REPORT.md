# REPORT: 2026-11-09-social-page-alerts-pause

- **Branch:** `build/social-page-alerts-pause` (base `origin/develop` 7830bf5)
- **Code commit:** `0df19aa`
- **Built to the brief. Acceptance 1-8 all PASS** (1-6 and 8 by tests, 7 in a real browser). **Flag: none.** The Pause does nothing until an admin presses it; **the alerts are on from deploy**, but they only fire when a page is `held` or `failing`. No platform call and no email was made by any test (calls and the email sender are injected; the global `fetch` is a trap in the pause suite).

## For planning to read first

1. **Decisions where the brief was silent:**
   - **Precedence** when several statuses are true: `paused`, then `stopped`, then `held`, then `failing` (the one that explains why nothing posts). On a screen both the new banner and the existing stop banner show when a page is paused AND stopped; no second stop banner is drawn.
   - **An "already posted" duplicate is neither a failure nor a recovery** for `failing` (LinkedIn / Facebook answer it for an exact repeat, and every push posts now: two in a row would otherwise raise a false alarm; the guide already calls it "nothing is broken"). SKIPPED and in-flight rows are not finished posts either. `failing` looks at the last 10 finished posts (newest `updatedAt`); its `since` is the oldest failure of the streak inside that window; the count in the banner / email is the streak ("Last 3 posts failed").
   - **Pause is checked BEFORE the login / policy / channel stop, the pacing (Facebook gap and daily cap) and the quota guard** in all three workers. Reason: a stop or a pacing wait would otherwise keep a push waiting, and it would be posted after the pause lifted, which breaks "never posted later". So a paused-and-stopped page still writes SKIPPED `page_paused` rows (and the push a stop had been keeping waiting is skipped too).
   - **A manual immediate push (Send now, Breaking, Push now) is not exempt from a pause** (the brief: every push for the page); say if you want an exemption like `quota_headroom` has.
   - **A Compose untick still wins the reason:** a push whose sender unticked the page gets `compose_skip` (written first), not `page_paused`; both are SKIPPED with no call.
   - **"Paused by <name>":** User has no name field, so it shows the part of the admin's email before the `@` ("anagha").
   - **The alert is event-driven**, sent right after the attempt that failed or set the hold (a small wrapper `attempt` -> `attemptOnce` in each worker), not from a timer; it computes the status then and sends if that kind has not gone out today (IST). If the email service is not configured, or there are no active admins, nothing is marked sent (it can still go out later).
   - **The held sentence says "until 05:30 IST tomorrow"** (the `ui-developer` noticed "on 2026-11-10" read badly): `istClock` says "05:30 IST" for today, "... tomorrow" for the next IST day, a date beyond that. Used by the banner and the email.
   - The `held` hold itself is still in memory only (small-fixes item 5), moved into its own module `services/linkedin/orgHold.ts` so the helper can read it without a cycle (the worker re-exports `ORG_DAILY_LIMIT`, `isOrgHeld`, `nextUtcMidnight`; its tests are unchanged). After a restart the status reads `ok` until the next 429 sets the hold again (one wasted call, one alert at most per IST day).
2. **Four existing tests were updated, not deleted** (all because the screens' answer now ALWAYS carries a new key `pageStatus`): `socialAllPushes.test.ts` (the LinkedIn and the Facebook "answer is exactly what it was" key lists, +`pageStatus`), `linkedinAcademy.test.ts` (the Academy-off key list, and the "DEFAULT wiring" test, which counted `linkedInPost.findMany` calls by position: the status helper adds one read with `where.status` set per answer, so that test now filters to the list's own reads). Nothing else changed.
3. **The Campaigns Channels LinkedIn mark is the Taxscan page only** (existing behaviour), so a paused Shopscan or Academy page never shows a "page paused" mark there; a paused Taxscan, Facebook or Telegram page does ("<Channel>: skipped — page paused"). The LinkedIn screen shows it for every page.
4. **`DigestSetting` is in the R2 backup**, so a restore brings pauses (and the once-a-day alert markers) back with it. The post rows and the go-live rule are unchanged (the restore rules in `docs/BACKUPS.md` still apply). Recorded in the three posting docs.
5. **Migration `20261109122249_social_page_pause`** adds two enum values in ONE file (`SOCIAL_PAGE_PAUSED`, `SOCIAL_PAGE_RESUMED`); Prisma writes the "PostgreSQL 11 cannot add more than one value" comment, prod is 18.6 and the dev DB applied it clean. Additive only.
6. Not tested: the real ElasticEmail send (mocked), real iOS Safari / touch, and a real LinkedIn / Facebook / Telegram call.

## What it does

- **`src/services/social/pageStatus.ts`** (new, the single definition): `getPageStatus(channel, page)` / `listPageStatuses()` for every active page (LinkedIn taxscan / academy / shopscan, Facebook, Telegram): `ok | paused | stopped | held | failing`, each with a fixed `reason`, `since`, `resumesAt`, `by` / `note` (paused), `detail` (a SHORT reason code such as `HTTP 422`, never provider text), `failures`, and `message` (the banner sentence in IST). It reads the existing stop markers by key (pinned to the workers' own key functions by a test), the LinkedIn hold, the pause, and the last finished rows.
- **`src/services/social/pause.ts`** (new): the pause store in `DigestSetting` `social:pause:<channel>:<page>` (who, when, note up to 200). **`src/services/social/pageAlerts.ts`** (new): `alertIfNeeded` and the email (ElasticEmail, active ADMINs): one per page per kind (`held` / `failing`) per IST day, `social:alert:<channel>:<page>:<kind>` = `{ day }`; the existing stop alerts are never repeated, a paused or stopped page is not alerted.
- **Workers** (LinkedIn, Facebook, Telegram): read the pause once per page per tick; while paused no call at all, every push gets its row SKIPPED `page_paused` (attempts 0), rows waiting for a retry are skipped, nothing is posted later, Resume posts from the next push. The `attempt` wrapper triggers the alert after a failed / held attempt.
- **Routes:** `POST /api/{linkedin|facebook|telegram}/page-pause` `{ page?, note? }` and `/page-resume` (shared `src/routes/socialPause.ts`; ADMIN only, PUBLISHER 403, 409 `already_paused` / `not_paused`, 400 `invalid_page` / `note_too_long` / `invalid_note`; audited `SOCIAL_PAGE_PAUSED` / `SOCIAL_PAGE_RESUMED`). The three screens' list answers carry `pageStatus` and `skipReason: 'page_paused'` on a paused row; `GET /api/social/pages` marks `paused: true` on a paused page (a paused key is still a known page: `/api/send` accepts it); the Channels mark detail carries `skipReason: 'page_paused'`. The existing `/resume` endpoints (stops) are unchanged.
- **Admin (`ui-developer`):** a banner on each Social screen for paused / held / failing (navy = a person chose it, amber = clears by itself, red = needs a person), an ADMIN-only "Pause this page" / "Resume posting" button with a confirm dialog and an optional note (counter, 200), "Skipped — page paused" rows (no Retry/Skip), the Campaigns tooltip, Compose shows a paused page unticked, disabled, "(paused)" (never sent in `socialSkip`, never in the "Not posted to:" line), Activity entries for both actions.

## Files changed

- Backend: `src/services/social/{pageStatus,pause,pageAlerts}.ts` (new), `src/services/linkedin/orgHold.ts` (new), `src/routes/socialPause.ts` (new), `src/services/{linkedin,facebook,telegram}/worker.ts`, `src/routes/{linkedin,facebook,telegram,socialPages}.ts`, `src/services/social/pages.ts` (Post-to with pause), `src/services/metrics.ts` (Channels mark detail), `prisma/schema.prisma` + migration.
- Admin: `admin/src/components/PageStatusBanner.vue`, `PagePauseControl.vue` (new), `ConfirmPush.vue` (additive: optional title and a slot), `admin/src/composables/socialPages.ts` (new), `views/{LinkedIn,Facebook,Telegram,Compose,Campaigns,Activity}.vue`.
- Docs: `docs/LINKEDIN_POSTING.md`, `FACEBOOK_POSTING.md`, `TELEGRAM_POSTING.md` (a "When a page stops" section each; LinkedIn's also documents `org_daily_limit`, which `small-fixes` had not), admin guide **v2.36** (a banners / emails / Pause block in sections 12, 13 and 14, Compose "Post to", the Channels mark, the LinkedIn Skipped row).
- Tests: new `socialPageStatus.test.ts` (22) and `socialPause.test.ts` (25); the four pins above.
- Screenshots (committed, ~80-150 KB, fake data): `docs/briefs/2026-11-09-social-page-alerts-pause.shots/`.

## Migrations / flags

One additive enum migration (two values). No flag (see the top). No env.

## Test results (verbatim)

- `npx tsc -p tsconfig.json --noEmit`: no output. `npm run lint`: clean. `cd admin && npx vue-tsc --noEmit`: exit 0. `npm run build:admin`: `✓ built in 2.80s` (dist removed).
- New suites: `socialPageStatus.test.ts` + `socialPause.test.ts`: `Tests: 47 passed, 47 total`.
- **Full suite, final tree: `Test Suites: 119 passed, 119 total` / `Tests: 2842 passed, 2842 total`** (122 s, `maxWorkers: 2`, no "failed to exit gracefully" warning). The first full run had the four existing-pin failures above (the exact-key lists and one call-index pin); fixed, re-run.
- **The new tests bite** (mutation checks, each restored byte-for-byte): LinkedIn pause ignored -> 6 failed; LinkedIn waiting retry kept -> 2; stop before pause (LinkedIn / Facebook / Telegram) -> 1 each; Facebook pacing before pause -> 1; skip rows not written (Facebook) -> 3; Telegram waiting retry kept -> 1; status "paused not first" -> 9; failing after 1 failure -> 6; duplicates counted as failures -> 3; alert sent every time -> 3; PUBLISHER may pause -> 3; pause audit missing -> 3. One mutant (alert also on paused) survives because it is behaviourally equivalent: the email builder refuses a non-held / non-failing status anyway.

## Acceptance tests

1. **PASS** (`socialPageStatus`). Each of ok / paused / stopped / held / failing from fixtures on all three channels (stopped from the LinkedIn token, Facebook token and policy, Telegram channel markers; held from LinkedIn's hold, with `since` and `resumesAt`); `failing` clears after a POSTED row; `held` clears exactly at its resume time (00:00 UTC); `quota_headroom` is not a hold; SKIPPED rows and "already posted" duplicates do not count; precedence; the reason is a short code and no provider text is carried; the stop keys are pinned to the workers' own key functions.
2. **PASS.** `held` (LinkedIn org limit, through a real worker tick) and `failing` (2 FAILED in a row, Telegram) each send ONE email per page per kind; a second occurrence the same IST day sends nothing (also after a simulated restart); the next IST day sends again; a POSTED row clears `failing`; the LinkedIn token stop, the Facebook policy stop and the Telegram channel stop each still send their own ONE email and no "held" / "failing" one; a paused or stopped page is not alerted; no email service or no admins = nothing marked, no throw.
3. **PASS.** Pause on Shopscan: the next push makes SKIPPED `page_paused` rows (attempts 0) with NO call to Shopscan while Taxscan posts (a manual immediate push too); a waiting retry is skipped; Resume then the next push posts and nothing earlier is posted; a paused-and-login-stopped page still skips every push.
4. **PASS.** ADMIN only (no login 401, PUBLISHER 403 on pause and resume for all three channels, nothing changes), audited with who (`userId`), the page and the note, the stored state records who / when / note; a repeat is 409 `already_paused` / `not_paused`; a note over 200 characters, a non-string note and an unknown page are refused and store nothing; it survives a restart (new app + forgotten worker memory: still paused, the worker still skips).
5. **PASS.** Facebook (no call even inside the 10-minute gap, waiting retry skipped, resume posts the next push only, a policy-stopped paused page skips) and Telegram (same, and paused beats the channel stop) behave the same way.
6. **PASS.** `GET /api/social/pages`: `paused: true` only on the paused page, the old answer exactly when none is; a paused key is still known (`unknownSocialKeys` empty); `POST /api/send` with and without the paused key is accepted (200) and the worker, on the real clock, skips both with no call (`page_paused`; `compose_skip` for the one that named the key).
7. **PASS** (`ui-developer`, real Chromium, 1440 px and 375 px, ADMIN and PUBLISHER): the three banners and their helper lines, "Pause this page" / "Resume posting" through the real endpoints on LinkedIn Shopscan, Facebook and Telegram (note in the audit entry, Taxscan LinkedIn unaffected by pausing Shopscan), PUBLISHER sees banners but no button, "Skipped — page paused" rows with no Retry/Skip, the Campaigns tooltip, Compose ("(paused)", disabled, never in `socialSkip`, checked by intercepting `/api/send`), Activity entries and filter, a stale Pause / Resume (409), a 500, `note_too_long`, a dropped connection, Esc and Enter in the dialog; no horizontal overflow, 44 px phone buttons. Screenshots in the shots folder.
8. **PASS.** After pauses, resumes, failures and holds across all three channels: the three tokens (and the Telegram secret half) appear in no audit entry, stored marker, API reply, log line or alert email; the failing email carries `HTTP 422` and never the provider text it was given.

## Agents run

- `ui-developer` (one, background): the banners, the Pause / Resume control, the Compose and Campaigns and Activity changes, and the real-browser check. Its seeded rows and users were removed (re-checked: 0 left), its server stopped, no jest by it. Never touched the main checkout, production, the stash, `develop` or `main`.

## Deviations from the brief

- Pause is checked before the stops / pacing / quota guard (point 1); duplicates are neutral for `failing`; the held sentence says "tomorrow"; four existing test pins updated for the new `pageStatus` key.
- Compose: one extra line under the "Post to" group while a page is paused ("A paused page is skipped until an administrator resumes it."); `ConfirmPush` got an optional title and a slot (additive); the Activity Resource column shows the full `social_page · linkedin:shopscan`.
- The Dashboard health strip, alerts for `quota_headroom` / `compose_skip` / WhatsApp and any Shopscan priority are not built, as the brief says.

## Worth remembering

- `pageStatus` is now ALWAYS in the three screens' list answers: any test that pins their exact keys, or counts `findMany` calls by position, must allow for it (and for the one extra read per answer).
- The alert wrapper is at the `attempt` level of each worker, so every path that ends an attempt in a failure (a tick or a manual Retry) can raise it; it never throws.
- A restart forgets LinkedIn's hold (by design), so a deploy right after a limit costs one more refused call.

## Clean-up (planning runs this after merging)

```
cd /Users/bestdoc/Documents/taxscan-push
git worktree remove ../taxscan-push-worktrees/social-page-alerts-pause
dropdb taxscan_push_build_social-page-alerts-pause && dropdb taxscan_push_build_social-page-alerts-pause_shadow
git branch -d build/social-page-alerts-pause   # after the merge
```
