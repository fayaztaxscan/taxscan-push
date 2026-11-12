# Facebook page posting (facebook.com/taxscan)

Built 3 Nov 2026 (brief `docs/briefs/2026-11-03-facebook-page-posting.md`). It mirrors the LinkedIn posting
(`docs/LINKEDIN_POSTING.md`) and does not change it. Code: `src/services/facebook/{client,pages,post,worker}.ts`,
`src/routes/facebook.ts`. Table `FacebookPost` (not in the R2 backup). Since 12 Nov 2026 a second page, **Shopscan**
(facebook.com/shopscan.in), can post every push too: see "The Shopscan page" below (off unless its three variables are set).

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

## The Compose picture (brief 2026-11-08-social-picture)
- Behind `SOCIAL_PICTURE_ENABLED` (default off). A push with a Compose picture (`Campaign.socialImageId`) posts to
  `POST /<page-id>/photos` with `url` = the picture's public URL (`https://push.taxscan.in/social-images/<sha256>.<jpg|png>`: no login,
  immutable; Facebook fetches it) and `caption` = today's message with the tagged link on its own line before the hashtags. The answer's
  `post_id` (the feed post) is stored, else its `id`.
- A photo post refused with a plain 4xx (`failed`: e.g. Facebook could not read the picture) is repeated **once**, in the same attempt,
  as today's `/feed` link post; the row is POSTED with `error` = `posted as a link post: Facebook could not use the Compose picture
  (rejected_<status>[_code_<n>])`. Every other answer (rate, transient, auth, policy, duplicate) is handled exactly as today.
- No picture, or the setting off: today's `/feed` call, unchanged. Pacing, the policy stop and the 30/day cap are unchanged (the
  fallback is part of the same attempt). After a restore the picture may be gone (`SocialImage` is not in the backup): today's link post.

## Compose: untick the page for one push (brief 2026-11-09-compose-skip-pages)
Compose's **Post to** list (`GET /api/social/pages`) offers `facebook:<page>` for every Facebook page with a valid id and token while
`FACEBOOK_POSTING_ENABLED` is on, from the ONE list `portalPages()` (Taxscan, then Shopscan while it is active: "Facebook · Shopscan"); a later
Facebook page (Academy) joins the list by its own name with no change to Compose.
Unticking it means the page gets nothing for THIS one push; the pacer, Push now and the backfill post as ever. The worker reads
`Campaign.socialSkip` and writes ONE `FacebookPost` row, status SKIPPED, error `compose_skip`, attempts 0, **no Graph call**; the row is written at
once whatever the page is waiting for (the gap between posts, the daily cap, a stop), because it is a database write that makes no post, and it
costs the tick's one attempt nothing. Its key is always the push's own (`push:<id>:<ms>`) and the push is taken out of the page's candidates, so
under today's rule a later push of the same URL still posts (see `docs/LINKEDIN_POSTING.md`, "Compose: untick a page for one push", for why).
The screen shows it as SKIPPED with `skipReason: "compose_skip"` ("Skipped in Compose") and no Retry or Skip.

## The Shopscan page (brief 2026-11-12-facebook-shopscan-page)
Every push that posts to the Taxscan Facebook page also posts to the **Shopscan** page (facebook.com/shopscan.in), with the same text, hashtags and
Compose picture. It is a **shared page**: not a portal's own page but a second page that receives the `taxscan` portal's pushes, with a page id, token
and go-live of its own. Code: `portalPages()` and `isSharedPage()` in `src/services/facebook/pages.ts` (LinkedIn's `portalPages()` is the model);
the worker, the screen's API, Compose "Post to" and the page status all read that ONE function, so Shopscan appears in every one of them at once and in
none while it is off.

- **Active only when all three are valid** (and `FACEBOOK_POSTING_ENABLED` is on): `FACEBOOK_SHOPSCAN_PAGE_ID` (digits), `FACEBOOK_SHOPSCAN_PAGE_TOKEN` (the
  **Page** access token from `me/accounts`, not a user or system-user token; Railway only) and `FACEBOOK_SHOPSCAN_POST_FROM` (a strict ISO time). Anything else
  (none, some, any one invalid) = off: no rows, no failures, and **it never stops the worker from starting** (only the Taxscan page's own config does).
  ONE boot line says which: `[facebook] shopscan page on (every push from <ISO>)` or
  `[facebook] shopscan page off: not configured (it needs FACEBOOK_SHOPSCAN_PAGE_ID, FACEBOOK_SHOPSCAN_PAGE_TOKEN and FACEBOOK_SHOPSCAN_POST_FROM)` /
  `… <VARIABLE> is missing or not digits | not a valid page token | not a valid ISO time` (names only, never a value).
- **Every push from its own go-live.** `FACEBOOK_SHOPSCAN_POST_FROM` is both its go-live and its every-push time (there is no `…_ALL_PUSHES_FROM` of its own): it posts
  every push the Taxscan page would post under "Every push posts" (articles, courses, products, and, with `SOCIAL_ANY_LINK_FROM`, other allowed pages), one post
  per push, repeats included, and **nothing pushed before its go-live is ever posted there**, whatever `FACEBOOK_POST_FROM` says. The Taxscan page's own rules,
  go-live and times are untouched.
- **Everything else is per page:** a tick handles Taxscan first, then Shopscan (a busy tick only delays Shopscan), each with at most one attempt; the gap
  (`FACEBOOK_MIN_GAP_MINUTES`) and the daily cap (`FACEBOOK_DAILY_CAP`) are counted on each page's own rows; a token stop or a policy stop (code 368) on Shopscan
  stops Shopscan only (its own alert email, banner and ADMIN Resume of `shopscan`; Taxscan keeps posting), and the other way round; Pause / Resume and the held /
  failing alerts work for `facebook:shopscan`; rows are `FacebookPost.page = 'shopscan'`.
- **Picture, UTM, Compose:** a Compose picture is a photo post on both pages, with the same one fallback to a link post, on the page that was refused only. The link is
  tagged `utm_source=taxscan-facebook&utm_medium=social&utm_campaign=facebook-shopscan`. Compose "Post to" lists "Facebook · Shopscan" while it is active; unticking it
  writes SKIPPED `compose_skip` for Shopscan only.
- **The Channels mark on Campaigns** still means the Taxscan page only.

## Pacing (account safety)
- At most **one post attempt per page per 1-minute tick**, and at least `FACEBOOK_MIN_GAP_MINUTES` (10) between two posts on a page.
- At most `FACEBOOK_DAILY_CAP` (30) posts per IST day **per page**; the rest wait for the next day, however old they are by then.
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
`GET /api/facebook/posts?date=YYYY-MM-DD&page=<key>` (IST day, 14 days back) -> `{date, page, rows[], counts, login, policy, pageStatus}`; `page` is one of the
ACTIVE pages (`taxscan`, or `shopscan` while it is active), default the first; anything else is 400 `invalid_page`; `pages` (the active list, Taxscan first) is in the
answer only while there are two or more, so with Shopscan off the answer is exactly what it always was;
`POST /api/facebook/posts/:id/retry`; `POST /api/facebook/posts/:id/skip` (by row id: a Shopscan row never touches a Taxscan one); `POST /api/facebook/check`
`{ page? }` (ADMIN: one `GET /<version>/<page-id>?fields=name` with that page's own token in the Authorization header, posts nothing); `POST /api/facebook/resume`
`{ page? }` (ADMIN: clears that page's policy stop only; 400 `invalid_page`).
`/api/auth/me` -> `features.facebookPosting`. Campaigns list: `channels.facebook` + `channelDetails.facebook` (only while the flag is on).

## Flags
| Variable | Default | Meaning |
|---|---|---|
| `FACEBOOK_POSTING_ENABLED` | off | Worker, routes, menu. |
| `FACEBOOK_POST_FROM` | - | ISO time, REQUIRED when on: nothing pushed before it is posted. |
| `FACEBOOK_ALL_PUSHES_FROM` | - | **Every push posts** from this time (strict ISO); a push before it keeps today's rule for good. Unset or invalid = today's rule (one boot line). Never earlier than `FACEBOOK_POST_FROM`. Set it to the moment you switch on. |
| `SOCIAL_PICTURE_ENABLED` | off | A picture uploaded on Compose goes on the Facebook (photo post) and LinkedIn posts. See "The Compose picture" |
| `SOCIAL_ANY_LINK_FROM` | - | **One time for all four channels** (strict ISO): from it on, a push to any OTHER allowed page (shop collection, pricing page, home page) also posts here, if `FACEBOOK_ALL_PUSHES_FROM` is on for that push. A push before it never does. Unset or invalid = off. See "Other pages" |
| `FACEBOOK_TAXSCAN_PAGE_ID` | - | Numeric page id. |
| `FACEBOOK_TAXSCAN_PAGE_TOKEN` | - | Page access token (Railway only). A page token made from a long-lived user token does not expire on a timer; no renewal machinery. |
| `FACEBOOK_SHOPSCAN_PAGE_ID` | - | The Shopscan page's numeric id. With the next two, ALL THREE valid = the Shopscan page is on. |
| `FACEBOOK_SHOPSCAN_PAGE_TOKEN` | - | Its **Page** access token (from `me/accounts`; Railway only). |
| `FACEBOOK_SHOPSCAN_POST_FROM` | - | Its own go-live, a strict ISO time = also its every-push time. Set it to the moment of switch-on, never earlier. |
| `FACEBOOK_GRAPH_VERSION` | `v25.0` | |
| `FACEBOOK_MIN_GAP_MINUTES` | 10 | |
| `FACEBOOK_DAILY_CAP` | 30 | per IST day |
The worker refuses to start (`[facebook] refusing to start: ...`) without a valid `FACEBOOK_POST_FROM`, page id and token **for the Taxscan page**; the Shopscan page
is optional and never causes that refusal.

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

### Switching the Shopscan page on (owner, on the owner's yes, after deploy)
1. Railway: `FACEBOOK_SHOPSCAN_PAGE_ID` and `FACEBOOK_SHOPSCAN_PAGE_TOKEN` (`railway variable set NAME="$(pbpaste)"`; the **Page** token from `me/accounts`, NOT the
   system-user token). Then `FACEBOOK_SHOPSCAN_POST_FROM` = **the moment of switch-on** (UTC ISO), never earlier. Redeploy.
2. Boot log: `[facebook] shopscan page on (every push from …)` (or `… off: …` naming what is missing).
3. ADMIN: SOCIAL -> Facebook -> the **Shopscan** tab -> **Check connection** ("Connected to page: …").
4. Watch the next push: two `outcome=posted` lines, `page=taxscan` then `page=shopscan`, and the post on facebook.com/shopscan.in in a logged-out browser.
To switch it off again, remove any one of the three variables (and redeploy; a deleted variable needs a redeploy): nothing is reposted or deleted.

## When a page stops: status, alerts and Pause (brief 2026-11-09-social-page-alerts-pause)

One definition, `src/services/social/pageStatus.ts` (`getPageStatus` / `listPageStatuses`), read by the workers, the screens and the alert emails:

| Status | Meaning |
| --- | --- |
| `ok` | nothing to say |
| `paused` | an ADMIN paused the page (below) |
| `stopped` | the existing Facebook token stop (code 190 / permission / 401 / 403) and the policy stop (code 368 or a spam / blocked answer: only an ADMIN's Resume restarts it) (its own banner, alert and Resume, unchanged) |
| `held` | not used on Facebook (it is LinkedIn's daily limit only) |
| `failing` | the page's last **2** finished posts are FAILED with no POSTED after them (an "already posted" duplicate is neither a failure nor a recovery; SKIPPED and in-flight rows are not finished posts) |

When several are true the one that explains why nothing posts wins: paused, then stopped, then held, then failing. Each status carries a fixed
reason code, a since-time, a resumes-at time when known and `message`, the banner's sentence in words (also used by the email). A failure is
reduced to a short reason code (`HTTP 422`, `telegram_400`, `network error`): the provider's own words are never shown or mailed.

**Alert email** (ElasticEmail, the active ADMINs, only when email is configured): when a page enters `held` or `failing`, ONE email per page
per kind per IST day with the page, the reason in words, since when, when it resumes (if known) and what to do. Remembered in `DigestSetting`
(`social:alert:<channel>:<page>:<kind>` = `{ day }`); a page that recovers (a POSTED row) stops being `failing`. It is sent right after the attempt
that failed or set the hold (`alertIfNeeded` in `pageAlerts.ts`), never from a timer. The existing stop alerts are NOT repeated from here, and a
paused page is not alerted (nobody is posting on purpose). No alert for `quota_headroom`, `compose_skip` or WhatsApp.

**Pause / Resume (ADMIN only, no Railway change).** `POST /api/facebook/page-pause` `{ page?, note? }` and `POST /api/facebook/page-resume`
`{ page? }` (the screen's button; 403 for a PUBLISHER; 409 `already_paused` / `not_paused`; `note` is optional free text up to 200 characters).
Stored in `DigestSetting` `social:pause:facebook:<page>` (who, when, note); audited as `SOCIAL_PAGE_PAUSED` / `SOCIAL_PAGE_RESUMED`. While paused
the worker makes **no API call**: every push for that page gets its row SKIPPED with the reason `page_paused` (a manual immediate push included),
rows already waiting for a retry are skipped too, and **nothing is ever posted later** (a late post of an old push is worse than none: the same
rule as `compose_skip` / `quota_headroom`). It is checked before the stops, the pacing and the quota guard, so none of them can hold a push back to
be posted after the pause. Resume posts from the next push; nothing missed is backfilled. It survives restarts and never touches the env go-live
times. The screen shows the banner and the button; Compose's "Post to" shows a paused page unticked and disabled with "(paused)" (a send with or
without its key is accepted and posts nothing there); the Campaigns Channels mark reads "skipped — page paused". `DigestSetting` is in the R2
backup, so a restore brings a pause back with it.

## Backups and restores
`FacebookPost` is **not** in the R2 export. After a restore keep `FACEBOOK_POSTING_ENABLED` **off** and set `FACEBOOK_POST_FROM` to the restore time
before switching it back on: with the rows gone and no age limit, everything pushed since go-live would otherwise post a second time. **Set
`FACEBOOK_ALL_PUSHES_FROM` to the restore time too** (or unset it): the `push:` rows are gone with the rest, and an old value would post every
push since then, repeats included. **Set `FACEBOOK_SHOPSCAN_POST_FROM` to the restore time as well** (it is that page's go-live AND its every-push time; an old value would
post every push since then on Shopscan). See `docs/BACKUPS.md`.
