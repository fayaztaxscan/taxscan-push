# Facebook page posting (facebook.com/taxscan)

Built 3 Nov 2026 (brief `docs/briefs/2026-11-03-facebook-page-posting.md`). It mirrors the LinkedIn posting
(`docs/LINKEDIN_POSTING.md`) and does not change it. Code: `src/services/facebook/{client,pages,post,worker}.ts`,
`src/routes/facebook.ts`. Table `FacebookPost` (not in the R2 backup).

## What posts
(This is **today's rule**, the one the page follows until `FACEBOOK_ALL_PUSHES_FROM` is set; see "Every push posts" below.)
Every taxscan.in article the push system SENT, whoever sent it (pacer, Compose, Queue/Review Push now, Breaking), by the same
rule as WhatsApp and LinkedIn (`isPublicArticleCampaign()`): not a test-segment-only send, not the home page / a section /
academy / shop. One post per article (`articleKey()`), so a re-push or the morning-backfill clone never posts again, nor does a
re-push of an article first pushed before go-live (looked for up to 14 days before it). Only pushes at or after
`FACEBOOK_POST_FROM`, and **there is no age limit** (brief 2026-11-04-social-no-age-limit): an article that has no row yet posts
however long ago it was pushed, paced by the gap, the daily cap and the stops below. The CMS hashtag/keyword fetch is LinkedIn's (fail-open).

**Optionally, from a time the owner sets (`FACEBOOK_ALL_PUSHES_FROM`), the page posts EVERY push**, like the push notification itself:
articles, `academy.taxscan.in` courses and `shop.taxscan.in` products, one post per push, repeats included. See "Every push posts"
below; unset, everything in this section is exactly how the page behaves.

The post: `POST https://graph.facebook.com/<FACEBOOK_GRAPH_VERSION>/<page-id>/feed`, form-encoded `message`, `link`,
`access_token` (the token is in the body, never in a URL). `message` = headline, blank line, at most 4 plain `#Tags`
(`#taxscan` last). `link` = the article with `utm_source=taxscan-facebook&utm_medium=social&utm_campaign=facebook-taxscan&utm_content=<id|slug>`;
Facebook builds the link card itself (og:title / og:image). No image upload. The screen links `https://www.facebook.com/<id>`.

## Every push posts (brief 2026-11-04-academy-store-posts)
`FACEBOOK_ALL_PUSHES_FROM`: a strict ISO date or time, validated like `LINKEDIN_ACADEMY_POST_FROM` (`parseAllPushesFrom()` in
`src/lib/env.ts`). Unset or invalid = today's rule (one post per article), with one boot line saying why:
`[facebook] all pushes off: FACEBOOK_ALL_PUSHES_FROM is not set (today's rule: one post per article)`; on, `[facebook] all pushes on for
FACEBOOK_ALL_PUSHES_FROM (from <ISO time>)`.
- **Why a time is essential.** Today's rows are keyed by article, so past repeats and every course or product push have no row. Without a
  time, switching on would post all of them. **A push with `lastSentAt` before the time follows today's rule for good; a push at or after it
  follows the new rule; nothing older ever becomes eligible.** A pre-time article with no row yet still gets its one post by today's rule.
  Set the variable to the moment you switch on. It never reaches back before `FACEBOOK_POST_FROM` (`newRuleFrom()`).
- **What qualifies** (`isAllPushesCampaign()` in `src/services/social/allPushes.ts`, a new rule beside `isPublicArticleCampaign()`, which is
  unchanged for the WhatsApp queue): a SENT campaign with `lastSentAt` set, not test-segment-only, on `ALLOWED_PUSH_HOSTS`, whose URL is a
  taxscan.in article, `https://academy.taxscan.in/course/<slug>` or `https://shop.taxscan.in/products/<slug>`. Home pages, section pages,
  collections and every other page do not.
- **One post per push.** The row key is `push:<campaignId>:<lastSentAt ms>` in `FacebookPost.articleKey`; a resend of the same campaign row
  has a new `lastSentAt`, so it posts again, while two overlapping ticks cannot post the same push twice. Under the new rule the 14-day
  look-back and "first push of the article" logic do not apply. Both rules' candidates are merged by send time, oldest first.
- **Articles** are built as before. **Course and product posts:** `message` = the push title, a blank line, the push body (its own lines
  as single line breaks), a blank line, `#taxscan`; `link` = the push's link with `utm_source=taxscan-facebook&utm_medium=social&utm_campaign=facebook-taxscan&utm_content=<slug>`
  (the push's own `utm_*` replaced). Plain text, nothing escaped, no CMS fetch, no picture upload: Facebook builds the card from the page's
  og tags, as for articles. Log: `outcome=posted hashtags=fixed kind=course|product`.
- **Same pacing, no new caps.** One post per tick, `FACEBOOK_MIN_GAP_MINUTES`, `FACEBOOK_DAILY_CAP` (every kind of post counts; the
  rest spill to the next IST day), the auth stop, the policy stop (it holds every kind of post until an ADMIN presses Resume).
- **A repeat Facebook refuses** (code 506) is FAILED *"Facebook says this was already posted"*: no retry, no stop, no alert; the next push
  posts on the next tick (`reason=duplicate` in the log).
- **Turning it off is safe.** Remove the variable (or move it later than those pushes) and the page is back on today's rule, and
  **nothing is reposted**: today's rule skips an article any of whose pushes already has a `push:` row on the page (the campaign id is in
  the key, so the worker's one read of the page's keys supplies the ids), whatever status the row has. A new article posts once; an article
  that never got a `push:` row still gets its one post; set the variable again later and every push from that time posts, the past does
  not. To stop all posting instead, set `FACEBOOK_POSTING_ENABLED=false`.
- Screens: SOCIAL -> Facebook lists one row per push under the new rule (a repeat is its own row, with its own Retry and Skip) and one row
  per article before the time; **Campaigns -> Channels** shows a new-rule push the status of its own row. Both are exactly as before while the
  variable is unset.

## Other pages (brief 2026-11-07-social-every-link)
Off by default. `SOCIAL_ANY_LINK_FROM` (one strict ISO time for all four channels; the rule, the qualifying test and the switch-on are in
`docs/LINKEDIN_POSTING.md`, "Other pages") makes a push to any OTHER page on a host named in `ALLOWED_PUSH_HOSTS` (a shop collection, the
pricing page, the home page) post here too, **only if it was sent at or after that time and the page already follows the all-pushes rule at
that send time** (`FACEBOOK_ALL_PUSHES_FROM`). A push one second before it makes no row. The check is inside `isAllPushesCampaign()`, which
the worker, the screen and the Campaigns Channels mark all call.
- **The post** (`buildFacebookPagePost()` in `post.ts`) is built exactly like a course / product post: the push title, a blank line, the push
  body, a blank line, `#taxscan`; the link is the push's own URL with the Facebook UTMs (`utm_content` = the path segments joined by `-`,
  `home` for the root; the push's own `utm_*` replaced, other query parameters kept). Facebook builds the card from the page's og tags
  itself, so there is **no page fetch** here and nothing to fail. Log lines carry `kind=page`.
- Same pacing, stops and key (`push:<campaignId>:<lastSentAt ms>`) as every other push. Removing the setting reposts nothing; rows keep their
  status. After a restore see `docs/BACKUPS.md`.

## Pacing (account safety)
- At most **one post attempt per 1-minute tick**, and at least `FACEBOOK_MIN_GAP_MINUTES` (10) between two posts.
- At most `FACEBOOK_DAILY_CAP` (30) posts per IST day; the rest wait for the next day, however old they are by then.
- The row is created before the call; an in-flight row older than 10 min becomes FAILED "unknown - check the page" and is never
  re-posted automatically.

## Errors (by Graph `error.code` and HTTP status)
| Class | Trigger | Behaviour |
|---|---|---|
| Policy stop | code 368; `type` says spam/blocked/restricted; `error_user_title` on another 4xx | Row FAILED. Posting STOPS and is **persisted** (`DigestSetting` key `facebook:policy:<page>`); survives restarts. ADMINs e-mailed at once. Red banner. Retry refused (409 `policy_stop`). Only an ADMIN **Resume** (audited `FACEBOOK_POSTING_RESUMED`) clears it. |
| Auth stop | code 190, 10, 200-299; HTTP 401/403 | Stop until the token changes in Railway or the app restarts; one e-mail per IST day; amber banner. |
| Rate limit | code 4, 17, 32, 613; HTTP 429 | Retry +15 min, +60 min, then FAILED. |
| Transient | 5xx, network, timeout, code 1 / 2 | Retry +1, +5, +15 min, then FAILED. |
| Duplicate | code 506 | FAILED "Facebook says this was already posted", no retry, no stop, no alert (every push posts, so an identical repeat can happen). |
| Other 4xx | | FAILED at once. |
Retries never fall in quiet hours (23:00-07:00 IST: wait to 07:00). Log line:
`[facebook] page=taxscan campaign=... outcome=posted|retry|failed|auth_stop|policy_stop hashtags=cms|fallback|fixed` (a course or product post
adds `kind=course|product`).
The token never appears in a URL, log, `error` column, API response or e-mail.

## API (ADMIN or PUBLISHER unless noted; flag off = 404)
`GET /api/facebook/posts?date=YYYY-MM-DD` (IST day, 14 days back) -> `{date, page, rows[], counts, login, policy}`;
`POST /api/facebook/posts/:id/retry`; `POST /api/facebook/posts/:id/skip`; `POST /api/facebook/check` (ADMIN: one
`GET /<version>/<page-id>?fields=name`, token in the Authorization header, posts nothing); `POST /api/facebook/resume` (ADMIN).
`/api/auth/me` -> `features.facebookPosting`. Campaigns list: `channels.facebook` + `channelDetails.facebook` (only while the flag is on).

## Flags
| Variable | Default | Meaning |
|---|---|---|
| `FACEBOOK_POSTING_ENABLED` | off | Worker, routes, menu. |
| `FACEBOOK_POST_FROM` | - | ISO time, REQUIRED when on: nothing pushed before it is posted. |
| `FACEBOOK_ALL_PUSHES_FROM` | - | **Every push posts** from this time (strict ISO); a push before it keeps today's rule for good. Unset or invalid = today's rule (one boot line). Never earlier than `FACEBOOK_POST_FROM`. Set it to the moment you switch on. |
| `SOCIAL_ANY_LINK_FROM` | - | **One time for all four channels** (strict ISO): from it on, a push to any OTHER allowed page (shop collection, pricing page, home page) also posts here, if `FACEBOOK_ALL_PUSHES_FROM` is on for that push. A push before it never does. Unset or invalid = off. See "Other pages" |
| `FACEBOOK_TAXSCAN_PAGE_ID` | - | Numeric page id. |
| `FACEBOOK_TAXSCAN_PAGE_TOKEN` | - | Page access token (Railway only). A page token made from a long-lived user token does not expire on a timer; no renewal machinery. |
| `FACEBOOK_GRAPH_VERSION` | `v25.0` | |
| `FACEBOOK_MIN_GAP_MINUTES` | 10 | |
| `FACEBOOK_DAILY_CAP` | 30 | per IST day |
The worker refuses to start (`[facebook] refusing to start: ...`) without a valid `FACEBOOK_POST_FROM`, page id and token.

## Switch-on (owner, after deploy)
1. Create the Meta app from the long-standing page-admin account (planning sends the steps).
2. Railway: `FACEBOOK_TAXSCAN_PAGE_ID`, `FACEBOOK_TAXSCAN_PAGE_TOKEN` (use `railway variable set NAME="$(pbpaste)"`).
3. ADMIN: SOCIAL -> Facebook -> **Check connection** ("Connected to page: ...").
4. Set `FACEBOOK_POST_FROM` = now and `FACEBOOK_POSTING_ENABLED=true`.
5. Watch the first `outcome=posted` and check the post in a logged-out browser.

### Switching "every push posts" on (any time after the page works)
Set `FACEBOOK_ALL_PUSHES_FROM` to **the current time** (UTC ISO) in Railway and redeploy. Pushes sent before that time keep today's rule;
nothing in the past is posted. Look for `[facebook] all pushes on for FACEBOOK_ALL_PUSHES_FROM (from …)` in the boot log, then for
`outcome=posted hashtags=fixed kind=course|product` after the next course or product push.

## Backups and restores
`FacebookPost` is **not** in the R2 export. After a restore keep `FACEBOOK_POSTING_ENABLED` **off** and set `FACEBOOK_POST_FROM` to the restore time
before switching it back on: with the rows gone and no age limit, everything pushed since go-live would otherwise post a second time. **Set
`FACEBOOK_ALL_PUSHES_FROM` to the restore time too** (or unset it): the `push:` rows are gone with the rest, and an old value would post every
push since then, repeats included. See `docs/BACKUPS.md`.
