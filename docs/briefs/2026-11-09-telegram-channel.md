# Brief: Post every push to the Taxscan Telegram channel

- **Date / name:** 2026-11-09-telegram-channel  →  branch `build/telegram-channel`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first). UI parts go to `ui-developer`.
- **Order:** after `build/digest-notice-list` is merged (one build at a time).

## Goal
Every push from a go-live time posts to the public Telegram channel **@taxscan_in** (https://t.me/taxscan_in, ~4.7k
subscribers) through the official Telegram Bot API, like the LinkedIn and Facebook pages: same eligibility, one post per
push, a picture when there is one, tagged links, Retry / Skip, a per-channel stop with an alert. Off until configured.

## Why (owner's words)
> "can we bring in pushing to our telegram page just like we did all other pages?" (9 Nov 2026), then "https://t.me/taxscan_in. Is a public one"

Standing rule (owner, 4 Nov): every page posts **every push** (articles, courses, products, collections, site pages, exact
repeats), with no filtering against manual posts. The channel already gets frequent posts today from another source (no UTMs);
those continue and are not our concern.

## Scope
**In:**
- **Env:**
  - `TELEGRAM_POSTING_ENABLED` (default off)
  - `TELEGRAM_BOT_TOKEN` (never logged or returned; it sits in the Bot API URL path, so redact `/bot<token>/` from every error and log line)
  - `TELEGRAM_CHANNEL` (`@taxscan_in`, or a numeric `-100…` id)
  - `TELEGRAM_POST_FROM` (a strict ISO time, same parser as the others; it is also the every-push time; nothing pushed before it is ever posted)

  The channel is active only when all of these are valid. Otherwise: one boot line naming the variables, no rows, no refusal to start.
- **Table** `TelegramPost` (additive migration), modelled on `FacebookPost`: `page` (`taxscan`), `campaignId`, unique push key
  (as the every-push rows of LinkedIn/Facebook), status (PENDING/POSTED/FAILED/SKIPPED), attempts, nextAttemptAt, `messageId`,
  a short error code (never a token or a full provider message), timestamps. Not in the R2 backup. The restore rule goes into
  `docs/BACKUPS.md`: set `TELEGRAM_POST_FROM` to the restore time.
- **Worker** (1-minute tick, oldest first, `MAX_PER_TICK` = 3), eligibility shared with the other pages:
  `isAllPushesCampaign()` + `SOCIAL_ANY_LINK_FROM`, never test-segment-only, Compose `socialSkip` key **`telegram:taxscan`**
  honoured (SKIPPED `compose_skip`, as the other pages). The row is created before the API call, as LinkedIn/Facebook do.
  Not covered by the LinkedIn quota guard (Telegram has no such quota).
- **Post content (HTML parse mode, every field escaped):** `<b>headline</b>`, then the short line (≤ 160 chars; the CMS
  article API's excerpt for articles, the push body otherwise), then the tagged link. Picture: the Compose picture
  (`campaignPicture`), else the article's cover image (CMS API), else the page's og:image. With a picture → `sendPhoto`
  (photo URL + caption ≤ 1024 chars). Without one → `sendMessage` with the link preview on. A photo the API refuses (400 on the
  photo) → one fallback to `sendMessage`, logged as `image=dropped`.
- **UTMs** via the shared helper: `utm_source=taxscan-telegram`, `utm_medium=social`, `utm_campaign=telegram-channel`,
  `utm_content=<id|slug>` (as WhatsApp).
- **Errors:**
  - 429 → honour `parameters.retry_after`, then the usual +1 / +5 / +15 min, then FAILED.
  - 5xx / network → the same retries.
  - **403** (bot removed or not an admin) and **400 "chat not found"** → a channel stop: no more attempts, one alert email per IST
    day, a banner, ADMIN **Resume** (audited), as the per-page LinkedIn/Facebook stops.
  - Any other 4xx → FAILED with no retry.
- **Compose "Post to":** `activeSocialPages()` adds `telegram:taxscan` "Telegram · Taxscan" while active.
- **Screen:** SOCIAL → **Telegram** (`ui-developer`): rows, status, Retry / Skip, the stop banner + Resume, "Skipped in Compose"
  wording. Campaigns **Channels** gets a Telegram mark alongside the others.
- **Log:** `[telegram] page=taxscan campaign=<id> outcome=<posted|failed|skipped> image=<ok|none|dropped>`.
- **Docs:** new `docs/TELEGRAM_POSTING.md` (setup: BotFather, add the bot as channel admin with **Post messages** only; flags; errors),
  `.env.example`, admin guide (SOCIAL + Compose) with a version bump.

**Out (do not build):**
- Reading the channel, comments, polls, hashtags, editing or deleting sent posts.
- Any filtering against the channel's other posts (owner's rule).
- A second channel (the code may key by page, but configure only `taxscan`).

## Acceptance tests
Each one must PASS in the REPORT. All Telegram calls are mocked; never call api.telegram.org from a test.
1. Unset / partly set / invalid variables → no rows, one boot line, other pages unchanged.
2. Active: an article push → one `sendPhoto` to the channel with the escaped caption, cover picture and tagged link. A course,
   a product and (with `SOCIAL_ANY_LINK_FROM`) a site-page push each post. An exact repeat posts again. A test-segment-only push
   never posts. A push before `TELEGRAM_POST_FROM` never posts.
3. Compose picture wins over the cover. No picture anywhere → `sendMessage` with the preview on. A photo refused with a 400 → one
   `sendMessage` fallback.
4. Compose `socialSkip: ['telegram:taxscan']` → a SKIPPED `compose_skip` row, no call. The Post-to list shows Telegram only when active.
5. 429 with `retry_after` 30 → the next attempt is not before 30 s. 5xx → retries then FAILED. Other 4xx → FAILED with no retry.
6. 403 / chat-not-found → the stop, one alert per IST day, banner. Resume (ADMIN, audited) clears it. Other pages unaffected.
7. The token never appears in any log line, error, API reply, audit entry or screen (scan test, including a thrown fetch error
   whose message contains the URL).
8. Caption escaping: a headline with `<`, `&` and `"` renders literally, and a caption over 1024 chars is cut cleanly.
9. Screen + Channels mark (real browser, desktop + 375 px).

## Files
- `src/lib/env.ts`, `prisma/schema.prisma` + one additive migration
- `src/services/telegram/` (client, worker, post builder), `src/services/social/pages.ts` (Post-to list)
- `src/routes/telegram.ts`, `src/app.ts`, `src/services/metrics.ts` (Channels), `admin/src/views/Telegram.vue`, nav
- Docs as above, `docs/BACKUPS.md`. Tests: new `telegram*.test.ts`, plus the Post-to and Channels tests.

## Constraints
- Flag: `TELEGRAM_POSTING_ENABLED` default off, and all four variables are needed.
- Migrations: additive only.
- Full suite: yes — schema + config/env.
- Never log or return the bot token. Never call Telegram from a test.

## Context the builder needs
- Copy the shape of `src/services/facebook/` (worker, stop + Resume, alert, screen) and the every-push rules of
  `docs/briefs/2026-11-04-academy-store-posts.md`. Compose skip: `docs/briefs/2026-11-09-compose-skip-pages.md`.
- Bot API: `POST https://api.telegram.org/bot<token>/sendPhoto` {chat_id, photo (URL), caption, parse_mode: "HTML"};
  `sendMessage` {chat_id, text, parse_mode, link_preview_options}. Replies are `{ok, result: {message_id}}` or
  `{ok:false, error_code, description, parameters?.retry_after}`.
- Switch-on (planning, after the Release check and the owner's yes): the owner creates the bot (@BotFather) and makes it a channel
  admin with Post messages only, then sets the token with `railway variable set TELEGRAM_BOT_TOKEN="$(pbpaste)"` (never typed into
  chat). Planning sets `TELEGRAM_CHANNEL=@taxscan_in`, `TELEGRAM_POST_FROM`=the switch-on moment, and the flag.
