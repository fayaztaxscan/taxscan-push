# REPORT: linkedin-page-posting (main brief + follow-up 1)

- **Branch:** `build/linkedin-page-posting` (base `origin/develop`, brought up to date with the brief edits and the social-menu brief). **Code commit:** `5e2cf9f`.

## Files changed
- `prisma/schema.prisma` + `prisma/migrations/20261102090826_linkedin_post/` — enum `LinkedInPostStatus` (PENDING/POSTED/FAILED/SKIPPED) + table `LinkedInPost` (unique `page+articleKey`, index `status+nextAttemptAt`). **Additive.**
- `src/services/social/utm.ts` (new, shared `withSocialUtm`), `src/services/whatsapp/utm.ts` (now uses it; same output).
- `src/services/social/publicCampaign.ts` (new) — **`isPublicArticleCampaign()`** (taxscan.in article + not a test-segment-only target), used by the LinkedIn worker, the LinkedIn screen API AND the WhatsApp queue (`queue.ts`: `getQueue`, `markArticle`).
- `src/services/linkedin/pages.ts` (page keyed config, `PORTAL_TO_PAGE`, LinkedIn UTM helper), `post.ts` (little-text escaping, hashtag rules, CMS fetch, `buildPost`), `client.ts` (`fetch` to the Posts API; verdicts posted/retry/auth/failed; token scrubbing), `worker.ts` (tick, retries, quiet hours, stale recovery, login stop + once-per-IST-day alert, `retryNow`, `skipPost`, cron start).
- `src/routes/linkedin.ts`, `src/app.ts` — `GET /api/linkedin/posts`, `POST …/:id/retry`, `POST …/:id/skip` (ADMIN/PUBLISHER/bearer; flag off → 404 before auth). `src/index.ts` starts the worker. `src/routes/auth.ts` — `/me` `features.linkedinPosting`.
- `src/lib/env.ts`, `.env.example` — `LINKEDIN_POSTING_ENABLED`, `LINKEDIN_POST_FROM`, `LINKEDIN_API_VERSION`, `LINKEDIN_TAXSCAN_ORG_URN`, `LINKEDIN_TAXSCAN_ACCESS_TOKEN`.
- `admin/src/views/LinkedIn.vue` (new), `router.ts`, `NavBar.vue`, `useAuth.ts` — the screen (PUSH menu after WhatsApp, hidden unless the flag), by ui-developer.
- `docs/Taxscan-Push-Admin-Guide.html` — new section 12 "The LinkedIn page", renumbering, screens-table row; **guide 2.14 → 2.15**. `docs/LINKEDIN_POSTING.md` (new: design, rules, env, switch-over), `docs/BACKUPS.md` (LinkedInPost not backed up; post-restore rule).
- Tests: `src/__tests__/linkedinPost.test.ts` (13+1), `linkedinWorker.test.ts` (24), fixtures `src/__tests__/fixtures/linkedin/cms-*.json` (the three real 2 Nov CMS responses, trimmed to title/slug/keywords/courts/category_name); `whatsappQueue.test.ts` (+ test-segment cases, `/me` features).

## Migrations / flags
`20261102090826_linkedin_post` (additive). Flags: `LINKEDIN_POSTING_ENABLED` default off; `LINKEDIN_POST_FROM` required when enabled.

## Results (verbatim)
- `npx tsc -p tsconfig.json --noEmit`: clean. `npm run lint`: clean. `npm run build:admin`: clean (vue-tsc + vite).
- New + WhatsApp tests: `Test Suites: 4 passed, 4 total` / `Tests: 60 passed, 60 total`.
- **Full suite (ran: new migration, env, auth `/me`, a new cron):** `Test Suites: 88 passed, 88 total` / `Tests: 1782 passed, 1782 total`.

## Acceptance tests
1. Commentary exact string for `CBDT Sets Cost Inflation Index at 384 for FY 2026-27 [Read Notification]` (`\[Read Notification\]`, hashtag templates, blank line): PASS.
2. Hashtags from the three recorded CMS fixtures come out exactly as the brief writes them (`#ITATPanaji #IncomeTax #NFAC #LandAcquisitionAct #Section57 #taxscan`; `#ICAI #CashFlowStatement #CharteredAccountant #RevaluationReserve #taxscan`; `#TelanganaHighCourt #GST #GSTArrest #Section69CGST #DGGIInvestigation #taxscan`); max 6, unique, letters+digits, no `#TaxNews`; a CMS timeout / 404 / 500 / junk / oversized body → fallback and the post is still built: PASS.
3. UTM link: one each of `taxscan-linkedin` / `social` / `linkedin-taxscan` / `<id|slug>` for both URL shapes; push UTMs replaced, other params and fragment survive: PASS.
4. Worker (LinkedIn mocked): posts SENT taxscan articles after `LINKEDIN_POST_FROM` in `lastSentAt` order, 3 per tick; never before go-live (nor a re-push of a pre-go-live article), academy/shop, drafts, other portals, or a second push of the same article: PASS.
5. Crash safety: in-flight row > 10 min → FAILED "unknown — check the page" and not re-posted; an exception inside the call → the same; two overlapping ticks post each article once: PASS.
6. 429 → retries at +1/+5/+15 then FAILED (4 calls); a retry due in quiet hours waits until 07:00 IST while a 02:00 first attempt posts; 401/403 → `auth_stop`, no calls until restart/new token, one alert email per IST day, banner data on the API, clears on a successful post with a new token: PASS.
7. Token never in logs, the `error` column, alert emails or any API response (a test greps captured logs + rows + the DigestSetting row + mails + the list response); the client scrubs it from LinkedIn's own message: PASS.
8. Flag off → cron not scheduled, all three endpoints 404, `/me` features false; flag on without `LINKEDIN_POST_FROM` (or without the page vars) → `[linkedin] refusing to start: …`, no cron: PASS.
9. Screen (ui-developer; headless Chromium over DevTools — claude-in-chrome unavailable; server was a scratchpad script with a **mock LinkedIn poster**, no call to api.linkedin.com): PASS — every status renders (Not posted, Waiting, "Waiting — retry HH:MM", Posted + "View on LinkedIn", Failed + reason, Skipped); Retry confirm "Post to LinkedIn now?" and, for an unknown row, "Check the LinkedIn page first — it may already be posted." (Cancel focused); Retry turns Failed → Posted against the mock; Skip works; the amber banner; menu only with the flag (flag off: redirect + 404); date picker limits; 375 px cards stack, `scrollWidth` 375, 44 px targets. Screenshots in `/private/tmp/claude-501/-Users-bestdoc-Documents-taxscan-push/b1b9efaf-a625-451b-a08e-6776335abfdb/scratchpad/` (`d1-all.png`, `d2-confirm-unknown.png`, `d3-confirm-normal.png`, `d4-after-retries.png`, `d5-empty.png`, `m1.png`, `m2-confirm.png`, `m3-menu.png`). One late CSS rule (Refresh 44 px on phones) was built but not re-screenshotted.
10. tsc, lint, new tests, WhatsApp tests (shared UTM helper + predicate), full suite: PASS. Migration applied on a fresh empty DB (the build DB, all migrations from scratch).
- **Follow-up 1:** H1 PASS (pacer send, Compose send with `createdByUserId`/target All, Compose send to a topic, scheduled Compose send all post in `lastSentAt` order); H2 PASS (test-segment-only target → not posted and not on the WhatsApp list, `markArticle` → 404; a target that also names a real topic still posts; `TEST_SEGMENT_TOPIC` is honoured; non-article Compose URLs and academy/shop stay excluded); H3 PASS (WhatsApp tests pass with the shared predicate).

## Agents run
ui-developer, once: the LinkedIn screen, route/menu, guide section and browser checks. The backend was built by the builder.

## Decisions / deviations
- **Hashtag form: `{hashtag|\#|Tag}`** (LinkedIn's documented HashtagTemplate, checked on the *little Text Format* page, 2 Nov 2026). Plain `#Tag` also parses as a HashtagElement, but the template is the documented, unambiguous form and avoids `#` being read as a reserved character.
- **Hashtag rules where the brief's examples needed a precise reading:** a bench keyword is exactly two words, the first the court acronym and the second a capitalised name (`ITAT Panaji`; `ICAI disciplinary proceedings` is not a bench); a keyword containing anything but letters, digits, spaces or hyphens (apostrophes, brackets: `Bank's Auditor`, `CIT(A)`) is dropped rather than stripped — that is what makes the ICAI example come out as written. Section tags take digits plus up to 3 trailing letters (`270A`, `145A`, `57` from `57(iv)`).
- **Attempts:** the first attempt plus three retries (+1/+5/+15 min) = four calls, then FAILED.
- **Login-stop state** is in memory (clears on restart or a changed token). The banner and the once-per-IST-day alert marker are persisted in the existing `DigestSetting` table under `linkedin:auth:<page>` (no extra table; included in the existing backup, harmless if restored).
- **Retry/Skip on the API:** Skip also works on a row waiting for a retry (the screen offers it). Retry runs `attempt()` once; if that fails with a retryable error the row goes back to automatic retries.
- The retry/new-article ordering in a tick is: due retries first, then new articles, 3 in total.
- The screen shows the first mapped page; a second page would add a page switch (design noted in `docs/LINKEDIN_POSTING.md`).
- `articleKey()` for a no-id URL is the whole URL, so `LinkedInPost.articleKey` holds URLs for today's articles.

## Worth remembering
- The CMS article API returns the article object at the top level (`keywords`, `courts[]`, `category_name`); fixtures are the real responses of 2 Nov.
- Two suites share the build DB if run at once (the ui-developer's seeded in-flight row was flipped to "unknown" by a worker test tick once). Nothing in prod shares a DB like that; note it only for parallel local runs.
- Real LinkedIn: nothing was sent to api.linkedin.com in this build (mocked everywhere). The first real post is the owner's switch-over step (`docs/LINKEDIN_POSTING.md`): token with `w_organization_social`, same-sitting switch-off of the automation repo's `sheet_to_linkedin`, `LINKEDIN_POST_FROM` = now.
- The CMS article API is hit once per post (no cache needed: ~20 a day).
- Brief `2026-11-02-social-menu-channels-nudge` is queued behind this one: it needs this branch merged into `develop` first.

## Clean-up (planning session, after merge)
```sh
git worktree remove ../taxscan-push-worktrees/linkedin-page-posting
dropdb taxscan_push_build_linkedin_page_posting; dropdb taxscan_push_build_linkedin_page_posting_shadow
git branch -D build/linkedin-page-posting; git push origin --delete build/linkedin-page-posting
```
