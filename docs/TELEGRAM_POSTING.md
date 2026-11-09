# Telegram channel posting (t.me/taxscan_in)

Built 9 Nov 2026 (brief `docs/briefs/2026-11-09-telegram-channel.md`). It mirrors the Facebook posting
(`docs/FACEBOOK_POSTING.md`) and changes nothing of it. Code: `src/services/telegram/{client,pages,post,worker}.ts`,
`src/routes/telegram.ts`, admin screen `admin/src/views/Telegram.vue`. Table `TelegramPost` (**not in the R2 backup**).
The official **Telegram Bot API** over plain `fetch`; no SDK, no new dependency.

## What posts
**Every push**, from `TELEGRAM_POST_FROM` (the go-live, which is also the every-push time): taxscan.in articles, `academy.taxscan.in`
courses, `shop.taxscan.in` products and, from `SOCIAL_ANY_LINK_FROM`, any other allowed page (a collection, the pricing page, the home page).
One post per push; **an exact repeat posts again**. Never a test-segment-only send, never a link off `ALLOWED_PUSH_HOSTS`, never anything
pushed before `TELEGRAM_POST_FROM` (a push exactly at it posts). Who sent the push never matters (pacer, Compose, Push now, Breaking, a
backfill clone). **There is no age limit and no filtering against the channel's other posts** (owner's standing rule, 4 Nov: every social
page posts every push). The channel already gets posts from another source; those continue and are not looked at.
Eligibility is the shared rule `isAllPushesCampaign()` (`src/services/social/allPushes.ts`); the row key is the push's own,
`push:<campaign id>:<send time ms>` (`TelegramPost.pushKey`, unique per `page`), so a skip row can never block another push.
Not covered by LinkedIn's quota guard (Telegram has no such quota).

## Switching on
All four must be valid; otherwise the channel is **off**: no worker, no rows, no failures, the menu item hidden, `/api/telegram/*` answers
404, Compose's "Post to" has no Telegram, Campaigns has no Telegram mark, and the app still starts. One boot line says why, in fixed words
that name the variables and never print a value:

| Variable | Meaning |
| --- | --- |
| `TELEGRAM_POSTING_ENABLED` | exactly `true` |
| `TELEGRAM_BOT_TOKEN` | the bot's token, `<digits>:<secret>`. Set it ONLY in Railway, never in chat, a file or a URL |
| `TELEGRAM_CHANNEL` | `@taxscan_in`, or a numeric `-100…` id |
| `TELEGRAM_POST_FROM` | a strict ISO time (`2026-11-10T04:00:00Z`; `Nov 4` or `04/11/2026` are refused). Set it to the switch-on moment and **never move it earlier** |

Boot lines: `[telegram] disabled (set TELEGRAM_POSTING_ENABLED=true to start)`; `[telegram] not active, no posts: TELEGRAM_BOT_TOKEN is not
set; …`; `[telegram] worker started (every push from <ISO time>)`. Parsed by `parseTelegramEnv()` in `src/lib/env.ts` (pure, tested).

### One-time setup (the owner)
1. In Telegram, talk to **@BotFather**: `/newbot`, a name and a username (already done: `@taxscan_telegram_bot`). Keep the token to yourself.
2. Open the channel → Administrators → Add administrator → the bot, with **only "Post messages"** switched on (no edit/delete, no invite,
   no admins). A bot that is not an administrator of a channel cannot post to it.
3. Set the token without typing it into chat: copy it, then in the repo shell
   `railway variable set TELEGRAM_BOT_TOKEN="$(pbpaste)"`. Planning sets `TELEGRAM_CHANNEL=@taxscan_in`, `TELEGRAM_POST_FROM` = the
   switch-on moment, then `TELEGRAM_POSTING_ENABLED=true` last.
4. Open **SOCIAL → Telegram** as an ADMIN and press **Check connection** (`getChat`: proves the token works and the channel exists, posts
   nothing). The admin right is only proven by a post: watch the first push.

## The post (HTML parse mode, every field escaped)
```
<b>headline</b>

the short line (<= 160 characters)

<a href="the tagged link">Read more</a>
```
- Headline = the push title, whitespace collapsed. Short line = the CMS article API's `excerpt` for an article, the push body otherwise
  (`shortLine()`, dropped when it only repeats the headline). The CMS call is fail-open: CMS down = no excerpt and no cover, never a delay.
- Escaping: `&` `<` `>` `"` become `&amp;` `&lt;` `&gt;` `&quot;` (the four named entities the Bot API accepts), applied ONCE, after the
  text is cut, so an entity or tag can never be cut in half. The link is escaped inside the attribute.
- Limits (visible characters, after parsing): **caption 1024** with a picture, **text 4096** without. The headline is cut at a word with
  "…" when it does not fit; the short line is dropped when fewer than 24 characters of it would fit. The link costs only "Read more".
- **Picture**, first that exists: the Compose picture (`campaignPicture`, needs `SOCIAL_PICTURE_ENABLED`, served from
  `https://push.taxscan.in/social-images/<id>.<ext>`), else the article's cover image (CMS API `cover_image_url`), else the page's
  `og:image` (article pages: `documents.taxscan.in` only, as the digest; course / product / other pages: `og:image:secure_url` /
  `og:image`, https only). Cover and page pictures must pass the image-host allowlist (`isAllowedImageUrl`: https, taxscan hosts).
  Telegram fetches the picture itself (URL up to 5 MB).
  With a picture → **`sendPhoto`** `{chat_id, photo, caption, parse_mode: "HTML"}`; without → **`sendMessage`**
  `{chat_id, text, parse_mode: "HTML", link_preview_options: {is_disabled: false, url: <tagged link>, prefer_large_media: true}}`.
- A picture Telegram refuses (**400 on `sendPhoto`** that is not a channel problem) is repeated **once** as `sendMessage`; the row is
  POSTED with `error = image_dropped` and the log says `image=dropped`.
- **UTMs** (the shared helper SETS them, never duplicates; an old `utm_*` on the push is replaced): `utm_source=taxscan-telegram`,
  `utm_medium=social`, `utm_campaign=telegram-channel`, `utm_content=<article id | slug>` for an article (as WhatsApp), the slug for a
  course or product, the path joined by `-` (`home` for the root) for any other page.

## Pacing and retries
A 1-minute tick; at most **`MAX_PER_TICK` = 3** attempts per tick, due retries first, then new pushes oldest first (merged by send
time). No gap and no daily cap: Telegram's own limits (about one message a second to a chat, about 20 a minute to a channel) are far above
~20 posts a day, and a 429 is honoured.
- **429** → wait at least Telegram's `parameters.retry_after` (capped at 6 h) and never less than the usual delay; then **+1, +5, +15
  minutes**, then FAILED after the 4th attempt. **5xx / network / timeout** → the same +1 / +5 / +15. Retries never fall in quiet hours
  (23:00–07:00 IST; they wait for 07:00).
- **Any other 4xx** → FAILED, no retry. Retry and Skip are on the screen.
- The row is created BEFORE the call (unique `(page, pushKey)`: two overlapping ticks cannot post a push twice). A row in flight with no
  result for 10 minutes, or an attempt that dies without a verdict, is FAILED `unknown_outcome` and **never re-posted automatically**: on
  the screen Retry says to check the channel first.

## The channel stop
A `401` (token revoked), a `403` (bot removed, blocked, not an admin) or a `400` "chat not found" / "not enough rights" cannot be fixed by
retrying, so the **channel stops** (`DigestSetting` `telegram:stop:<page>`, so it survives a restart):
- no further attempt is made; the row that met it stays PENDING and due, with its attempt not counted, and **posts after Resume**;
  new pushes make no row meanwhile; Compose skip rows are still written (they touch no one);
- **one alert email per IST day** to the active ADMINs (`telegram:alert:<page>` remembers the day and is NOT cleared by Resume, so a
  Resume followed by a new stop the same day is silent; the next IST day alerts again);
- a red banner on the Telegram screen, with Retry hidden / refused (`409 stopped`);
- **ADMIN Resume** (`POST /api/telegram/resume`, audit action `TELEGRAM_POSTING_RESUMED`, metadata `{page}` only) clears it. Fix the bot
  first (re-add it as an admin with Post messages, or set a new token), then Resume.
Other pages (LinkedIn, Facebook, WhatsApp) are not affected by a Telegram stop, and the reverse.

## The bot token
It sits in the Bot API URL path (`https://api.telegram.org/bot<token>/<method>`), so it is guarded in depth:
- the client keeps **no URL, body or thrown message**: the verdict carries a fixed code (`telegram_403`, `telegram_400_chat_not_found`,
  `telegram_429`, `network_error`, `timeout`, …) chosen from a small list; Telegram's free text is never stored;
- the `error` column, the API replies, the audit entry, the alert email and the log line hold only those codes and ids;
- `redactText()` masks any `/bot<digits>:<secret>` path, and `logSecrets()` includes the configured token, so even an unexpected
  error that quotes the URL cannot print it; every `console.*` of an error goes through `safeErrorLog`.
Tests: `telegramPost.test.ts`, `telegramWorker.test.ts` (a scan of logs, columns, replies, audit and email after a thrown error that
carries the URL). **No test may reach api.telegram.org**: the worker's `call`/`fetch` are injected and the global `fetch` is a trap.

## Screen and API
SOCIAL → **Telegram** (appears only while active; `features.telegramPosting` on `/api/auth/me`). `GET /api/telegram/posts?date=` (IST day,
14 days back), `POST …/posts/:id/retry`, `…/skip`, ADMIN `POST …/check` and `…/resume`. Rows: WAITING, RETRYING, POSTED (link
`https://t.me/<name>/<id>`; a `-100…` channel links `https://t.me/c/<id>/<id>`, members only), FAILED, SKIPPED (**Skipped in Compose**
when the sender unticked "Telegram · Taxscan", reason `compose_skip`), NOT_POSTED (before go-live). **Campaigns → Channels** has a
Telegram mark (`channels.telegram`, present only while active). **Compose → Post to** lists `telegram:taxscan` "Telegram · Taxscan"
while active; an unticked key writes a SKIPPED `compose_skip` row under the push's own key and makes no call.

## When a page stops: status, alerts and Pause (brief 2026-11-09-social-page-alerts-pause)

One definition, `src/services/social/pageStatus.ts` (`getPageStatus` / `listPageStatuses`), read by the workers, the screens and the alert emails:

| Status | Meaning |
| --- | --- |
| `ok` | nothing to say |
| `paused` | an ADMIN paused the page (below) |
| `stopped` | the existing channel stop (401 / 403 / chat not found, above: only an ADMIN's Resume restarts it) (its own banner, alert and Resume, unchanged) |
| `held` | not used on Telegram (it is LinkedIn's daily limit only) |
| `failing` | the page's last **2** finished posts are FAILED with no POSTED after them (an "already posted" duplicate is neither a failure nor a recovery; SKIPPED and in-flight rows are not finished posts) |

When several are true the one that explains why nothing posts wins: paused, then stopped, then held, then failing. Each status carries a fixed
reason code, a since-time, a resumes-at time when known and `message`, the banner's sentence in words (also used by the email). A failure is
reduced to a short reason code (`HTTP 422`, `telegram_400`, `network error`): the provider's own words are never shown or mailed.

**Alert email** (ElasticEmail, the active ADMINs, only when email is configured): when a page enters `held` or `failing`, ONE email per page
per kind per IST day with the page, the reason in words, since when, when it resumes (if known) and what to do. Remembered in `DigestSetting`
(`social:alert:<channel>:<page>:<kind>` = `{ day }`); a page that recovers (a POSTED row) stops being `failing`. It is sent right after the attempt
that failed or set the hold (`alertIfNeeded` in `pageAlerts.ts`), never from a timer. The existing stop alerts are NOT repeated from here, and a
paused page is not alerted (nobody is posting on purpose). No alert for `quota_headroom`, `compose_skip` or WhatsApp.

**Pause / Resume (ADMIN only, no Railway change).** `POST /api/telegram/page-pause` `{ page?, note? }` and `POST /api/telegram/page-resume`
`{ page? }` (the screen's button; 403 for a PUBLISHER; 409 `already_paused` / `not_paused`; `note` is optional free text up to 200 characters).
Stored in `DigestSetting` `social:pause:telegram:<page>` (who, when, note); audited as `SOCIAL_PAGE_PAUSED` / `SOCIAL_PAGE_RESUMED`. While paused
the worker makes **no API call**: every push for that page gets its row SKIPPED with the reason `page_paused` (a manual immediate push included),
rows already waiting for a retry are skipped too, and **nothing is ever posted later** (a late post of an old push is worse than none: the same
rule as `compose_skip` / `quota_headroom`). It is checked before the stops, the pacing and the quota guard, so none of them can hold a push back to
be posted after the pause. Resume posts from the next push; nothing missed is backfilled. It survives restarts and never touches the env go-live
times. The screen shows the banner and the button; Compose's "Post to" shows a paused page unticked and disabled with "(paused)" (a send with or
without its key is accepted and posts nothing there); the Campaigns Channels mark reads "skipped — page paused". `DigestSetting` is in the R2
backup, so a restore brings a pause back with it.

## Log
`[telegram] page=taxscan campaign=<id> outcome=<posted|failed|skipped> image=<ok|none|dropped>` (plus `kind=article|course|product|page`
on a post; `outcome=retry class=… next=<ISO>` and `outcome=stop status=…` for the other verdicts). Never a token, URL or body.

## Restore, rollback
`TelegramPost` is deliberately not in the export (see `docs/BACKUPS.md`). **After a restore keep `TELEGRAM_POSTING_ENABLED` off and set
`TELEGRAM_POST_FROM` to the restore time before switching it on again**, or every push since go-live would be posted a second time.
To stop posting: unset `TELEGRAM_POSTING_ENABLED` (or any one of the four); nothing is reposted when it comes back, because rows exist
for what was handled and `TELEGRAM_POST_FROM` is absolute. Removing the bot from the channel is the owner's emergency brake (it becomes a
stop on the next post).

## Not built (by design)
Reading the channel, comments, polls, hashtags, editing or deleting sent posts, any filtering against the channel's other posts, a second
channel (the code keys by page, only `taxscan` is configured).
