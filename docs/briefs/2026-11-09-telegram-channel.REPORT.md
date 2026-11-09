# REPORT: 2026-11-09-telegram-channel

- **Branch:** `build/telegram-channel` (base `origin/develop` 20def80)
- **Code commit:** `49023fb`
- **Built to the brief. Acceptance 1-9 all PASS** (1-8 by tests, 9 in a real browser). Ships **off**: nothing happens until all four variables are set. **No Telegram call was made by anything in this build** (every test injects the call or `fetch`; the global `fetch` is a trap that fails the suite if reached).

## For planning to read first

1. **Decisions I made where the brief was silent or ambiguous (each is a one-line change if you disagree):**
   - **The link in the post is an anchor, `<a href="tagged link">Read more</a>`, not a visible URL.** The tagged UTM link is ~150 characters of noise in a channel, and an anchor costs 9 characters of the 1024 caption instead of ~150. The tagged link is the href, and also the `link_preview_options.url` on a text post. To show the bare URL instead, change the last line of `buildHtml()` in `src/services/telegram/post.ts`.
   - **A 401 (token revoked) and a 400 "not enough rights" are channel stops, like 403 and "chat not found".** The brief names only 403 and chat-not-found; retrying a revoked token or a missing Post-messages right can never work and would otherwise leave one FAILED row per push. Everything else 4xx is FAILED with no retry, as briefed.
   - **429: the wait is `max(retry_after, the usual +1/+5/+15 min step)`** (retry_after capped at 6 h), then FAILED after the 4th attempt. With `retry_after` 30 the first retry is at +60 s (not before 30 s, as the acceptance says); with 600 it is at +600 s.
   - **A photo refused with a 400 falls back to a text post only for HTTP 400**, not for any 4xx (404/413 on a photo are FAILED). A 400 that is "chat not found" / "not enough rights" is a stop, not a picture problem.
   - **The row that meets a stop stays PENDING and due, its attempt not counted**, so it posts after Resume (nothing lost). New pushes make no row while stopped; Compose skip rows are still written (DB only). The once-a-day alert memory (`telegram:alert:<page>`) is separate from the stop and is NOT cleared by Resume, so Resume then an immediate re-stop the same IST day sends no second email.
   - **`error` holds a fixed code only** (`telegram_<http status>[_chat_not_found|_not_enough_rights|_bot_removed|_photo_refused|_cannot_parse|_too_long]`, `network_error`, `timeout`, `unknown_outcome`, `link_not_allowed`, `image_dropped`, ...). Telegram's free text is never stored or shown.
   - **No gap and no daily cap** (the brief gives only `MAX_PER_TICK` = 3). Telegram allows far more than ~20 posts a day; a 429 is honoured.
   - **The route and the menu are gated on the channel being ACTIVE** (flag and all four variables valid), not just on the flag: a half-configured channel answers 404 and shows nothing.
2. **I touched two shared files to harden the token (not in the brief's file list):** `src/lib/redact.ts` (`redactText` now also masks a `/bot<digits>:<secret>` path, which no `token=` marker would catch) and `src/lib/httpErrors.ts` (`logSecrets()` includes the configured Telegram token). Reason: a thrown error whose message quotes the Bot API URL would otherwise print the token through `safeErrorLog`; a test that threw exactly that caught it. Both layers have their own test and a mutation check.
3. **One visible side effect on every admin user at 1430-1499 px, even with Telegram off:** the desktop nav now collapses to the hamburger below **1500 px** (was 1430). With four SOCIAL links (production's state once Telegram is on) the single row wrapped to two rows and scrolled between 1430 and ~1460 px (`ui-developer` measured it, simulating LinkedIn with a clone of the Facebook link). Four media queries in `admin/src/styles/app.css` share the constant. If you would rather keep 1430 while Telegram is off, say so: it would need the breakpoint to follow the menu.
4. **The first live post is the real test of three things I could not exercise offline** (no real Telegram call is allowed): (a) **whether Telegram can fetch the picture URLs** (`push.taxscan.in/social-images/...` and `documents.taxscan.in`): if Cloudflare or the host blocks Telegram's fetcher, every `sendPhoto` returns a 400 and the post goes out as text with a link preview (`image=dropped` in the log, `image_dropped` on the row), which is safe but not the intended look; (b) the exact wording of Telegram's 403/400 descriptions: my code maps them with regexes from the Bot API's documented behaviour, and anything unrecognised becomes a plain `telegram_<status>` (a 403 and a 401 always stop whatever the text); (c) `link_preview_options` (`prefer_large_media`) needs a current Bot API (7.0+, Dec 2023), which the hosted API is. Suggest watching the first push after switch-on, then **Check connection** on the Telegram screen (it only proves the token and the channel; the admin right is proved by a post).
5. **`image_dropped` and `no_message_id` are stored on a POSTED row but not shown on the screen** (the route returns `error` only for FAILED / PENDING rows, as Facebook does). The log line carries `image=dropped`. Say if you want a small "posted without the picture" note on the row; it is a one-field addition.

## What it does

Every push from `TELEGRAM_POST_FROM` posts once to the channel (a repeat again); eligibility is the shared `isAllPushesCampaign()` (so `SOCIAL_ANY_LINK_FROM` applies to site pages, test-segment-only and off-list links never post), the row key is the push's own `push:<id>:<ms>`, no age limit, Compose `telegram:taxscan` honoured. Post = `<b>headline</b>`, a short line (CMS excerpt for articles, else the push body, <= 160), a tagged "Read more" link; picture = Compose picture, else the CMS cover, else the page's og:image (all host-allowlisted); `sendPhoto` with a picture, `sendMessage` with the preview on without one, one text fallback if the photo is refused with a 400. The worker ticks every minute, 3 attempts at most, due retries first. Errors, the stop and Resume as in point 1. Full description: `docs/TELEGRAM_POSTING.md`.

## Files changed

- Backend: `src/lib/env.ts` (`parseTelegramEnv`, `env.telegram`), `src/services/telegram/{client,pages,post,worker}.ts` (new), `src/routes/telegram.ts` (new), `src/app.ts`, `src/index.ts`, `src/routes/auth.ts` (`features.telegramPosting`), `src/services/social/pages.ts` (Post-to key `telegram:<page>`, label "Telegram · Taxscan"), `src/services/metrics.ts` (Channels `telegram` mark + details, one batched query, none when off), `src/lib/redact.ts`, `src/lib/httpErrors.ts`.
- Schema: `prisma/schema.prisma` (`TelegramPost`, `TelegramPostStatus`, audit action `TELEGRAM_POSTING_RESUMED`), migration below.
- Admin (`ui-developer`): `views/Telegram.vue` (new), `composables/telegramErrors.ts` (new, plain-words readings of the codes), `router.ts`, `composables/useAuth.ts`, `components/NavBar.vue`, `views/Campaigns.vue` (the "tg" mark), `views/Activity.vue` (action label + filter entry), `views/Compose.vue` (picture wording names Telegram only while `features.telegramPosting`), `styles/app.css` (nav breakpoint, point 3).
- Docs: `docs/TELEGRAM_POSTING.md` (new), `.env.example`, `docs/BACKUPS.md` (restore rule), `docs/Taxscan-Push-Admin-Guide.html` (**v2.33**: new section 14 "The Telegram channel", SOCIAL / Post-to / Channels-mark / picture wording; the last two sections are now 15 and 16).
- Tests: `src/__tests__/telegramPost.test.ts` (new, 42), `src/__tests__/telegramWorker.test.ts` (new, 45); two existing pins updated (`socialEveryLink.test.ts` call-site scan 9 -> 12 calls in 9 files, because the new Telegram worker, route and Channels mark are callers, each covered by a Telegram test; `whatsappQueue.test.ts` `/api/auth/me` features gained `telegramPosting`).

## Migrations

`20261109094540_telegram_post`: `CREATE TYPE "TelegramPostStatus"`, `ALTER TYPE "AuditAction" ADD VALUE 'TELEGRAM_POSTING_RESUMED'`, `CREATE TABLE "TelegramPost"` (+ unique `(page, pushKey)`, indexes on `(status, nextAttemptAt)` and `campaignId`). **Additive only**; code that does not know the table is unaffected through a rolling deploy.

## Flags / env added

`TELEGRAM_POSTING_ENABLED` (default off), `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHANNEL` (`@taxscan_in` or `-100...`), `TELEGRAM_POST_FROM` (strict ISO time, never earlier than the switch-on). **All four are needed**; otherwise one boot line and nothing else (`[telegram] disabled (...)` / `[telegram] not active, no posts: <variables named, no values>`). No Railway change is made by this build.

## Test results (verbatim)

- `npx tsc -p tsconfig.json --noEmit`: no output. `npm run lint`: clean. `cd admin && npx vue-tsc --noEmit`: exit 0. `cd admin && npm run build`: `✓ built in 4.11s` (dist removed afterwards).
- Telegram suites: `telegramPost.test.ts` `Tests: 42 passed, 42 total`; `telegramWorker.test.ts` `Tests: 45 passed, 45 total`.
- **Full suite (the brief asks for it: schema + config/env), on the final tree: `Test Suites: 115 passed, 115 total` / `Tests: 2773 passed, 2773 total`** (157 s, `maxWorkers: 2`). The first full run had exactly the two expected pin failures above (the isAllPushesCampaign call-site scan and the `/api/auth/me` features list); both were updated and the whole suite re-run.
- **The new tests bite** (mutation checks, each restored byte-for-byte): headline not escaped -> 3 failed; no photo fallback -> 2 failed; stop treated as a plain failure -> 7 failed; every kind of link posts (eligibility removed) -> 2 failed; `retry_after` ignored -> 1 failed; Compose skip ignored -> 2 failed; token not masked in logs (path layer) -> 1 failed; exact-token layer removed -> 1 failed; alert on every stop -> 1 failed; caption limit 1124 -> 3 failed. (Two first attempts did not compile and counted as 0 tests; they were redone in compiling form.)

## Acceptance tests

1. **PASS.** Unset / partly set / invalid variables: `parseTelegramEnv` cases (flag not exactly `true`, each variable missing, several invalid at once, bad channel / token / date shapes, no value ever printed); the worker prints exactly the two boot lines, schedules no cron, throws nothing; a tick with no configuration makes no row and no call; while off `/api/telegram/*` answers 404 before auth, `features.telegramPosting` is false, Post-to has no Telegram, Campaigns carry no `telegram` key. Other pages unchanged (the whole existing suite passes).
2. **PASS.** An article push -> one `sendPhoto` to the channel with the escaped caption, the cover and the tagged link (UTMs asserted); a course, a product and (with `SOCIAL_ANY_LINK_FROM`) a site-page push each post and the page does not before it; an exact repeat posts again (two rows) and never twice; test-segment-only, before go-live, draft, off-list host never post; exactly at go-live posts; no age limit.
3. **PASS.** Compose picture beats the cover (and the cover is used when the picture setting is off); article og:image and course og:image fallbacks (a non-allowlisted image is not offered); no picture -> `sendMessage` with `link_preview_options.is_disabled=false` and the tagged link; a photo refused with a 400 -> exactly one `sendMessage` fallback (row POSTED, `image_dropped`, log `image=dropped`); a non-400 photo error is FAILED; a fallback that also fails is FAILED with its own code.
4. **PASS.** `socialSkip: ['telegram:<page>']` -> a SKIPPED `compose_skip` row under the push's own key, no call, other pushes (including a repeat of the same URL) still post, written once; a skip for another page's key does nothing; the Post-to list (and `GET /api/social/pages`) shows "Telegram · Taxscan" only while active, after LinkedIn / Facebook and before WhatsApp.
5. **PASS.** 429 `retry_after` 30 -> next attempt >= 30 s (not due at +30 s) and 600 -> >= 600 s; 429 then success posts; 5xx -> due at +1, +6, +21 min then FAILED after the 4th attempt, no further tick retries it, Retry on the screen posts it; network failure retried; retries wait out quiet hours (22:59 -> 07:00 IST); other 4xx -> FAILED, one call, no stop.
6. **PASS.** 403, 400 chat-not-found, 401 -> no further attempt, the push kept PENDING and due, one alert email, banner payload; one alert per IST day (a Resume + re-stop the same day is silent, the next IST day alerts); the stop is in Postgres (a "restart" leaves it) and Resume posts the kept push with its attempt count intact; Resume ADMIN only (PUBLISHER 403, not-stopped 409), audited (`TELEGRAM_POSTING_RESUMED`, metadata `{page}` only); while stopped Retry is refused (`stopped`) and Compose skip rows are still written; a second channel keeps posting while the first is stopped; no `facebook:` / `linkedin:` state is touched.
7. **PASS.** After a run with a thrown error whose message holds the full Bot API URL and token, a 5xx, a stop, a Check, a Resume and a Retry: the token (and its secret half) is in no log line, `TelegramPost` column, `DigestSetting` row, audit entry, alert email or API reply. Also: the client returns fixed codes only (no provider text), `redactBotToken` / `redactText` mask a `/bot<token>/` path, and `safeErrorLog` masks the bare configured token.
8. **PASS.** A headline with `<`, `&`, `"` (and `>`) renders literally (`&lt; &amp; &quot; &gt;`), a link cannot leave its attribute, a caption over 1024 is cut at a word with an ellipsis (visible length <= 1024, no stray `&`, no half entity, tags balanced, never inside a surrogate pair), a text post has the 4096 limit, the short line is dropped when it would be a stub.
9. **PASS** (`ui-developer`, real Chromium, desktop 1560 px and a real 375 px viewport, ADMIN and PUBLISHER, API served from the worktree with a fake sender and the built admin, a fetch trap logging 0 outbound requests): SOCIAL -> Telegram after Facebook; 12 seeded rows across every status; the red stop banner (above the intro, first on a phone), Retry hidden while stopped, ADMIN-only Resume with a confirm (Cancel focused; a stale Resume gets 409 and reloads), PUBLISHER sees "Ask an administrator..." and no buttons; Retry / Skip / Check connection (ok, refused, offline); Activity shows the resume; phone cards with no horizontal overflow and tap targets >= 40 px; the Campaigns Channels column shows the "tg" mark with tooltips and click-through (and is unchanged with Telegram off, `/telegram` redirects to the dashboard); Compose lists "Telegram · Taxscan". Not tested: a real device or iPhone Safari. Screenshots are in the session scratchpad, not the repo.

## Agents run

- `ui-developer` (one, background): Telegram screen, nav, Campaigns mark, Activity entry, Compose picture wording, real-browser check. Its seeded rows / users / audit rows were removed and its server stopped; no code of the backend was changed by it.
- No other agents. Never touched the main checkout, production, the stash, `develop` or `main`.

## Deviations from the brief

- The "short error code" is a fixed-word code, not the HTTP status alone (point 1).
- The two shared-file hardenings (point 2) and the nav breakpoint (point 3) are outside the brief's file list.
- Resume has a confirm dialog on the Telegram screen (Facebook's does not); the "Campaigns mark" is `tg` (two letters like WA / in / fb), not "T".
- The brief's Compose "Post to" needed no Compose change; the Compose picture label / note that said "LinkedIn and Facebook" now say "LinkedIn, Facebook and Telegram" only while the channel is active (the backend does use the Compose picture for Telegram).

## Worth remembering

- A test that writes a Date into a raw SQL parameter for a `timestamp without time zone` column is shifted by the DB session zone (`Asia/Kolkata` on this Mac); set the column through Prisma instead.
- `telegram` rows use `pushKey` (always `push:<id>:<ms>`), not `articleKey`, so there is no "today's rule" for this channel and a restore needs only `TELEGRAM_POST_FROM` moved to the restore time (`docs/BACKUPS.md`).
- Switch-on order (planning, after the Release check and the owner's yes): token via `railway variable set TELEGRAM_BOT_TOKEN="$(pbpaste)"`, then `TELEGRAM_CHANNEL`, `TELEGRAM_POST_FROM` = the switch-on moment, then `TELEGRAM_POSTING_ENABLED=true`; Check connection; watch the first push (point 4).

## Clean-up (planning runs this after merging)

```
cd /Users/bestdoc/Documents/taxscan-push
git worktree remove ../taxscan-push-worktrees/telegram-channel
dropdb taxscan_push_build_telegram-channel && dropdb taxscan_push_build_telegram-channel_shadow
git branch -d build/telegram-channel   # after the merge
```
