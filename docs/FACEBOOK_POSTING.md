# Facebook page posting (facebook.com/taxscan)

Built 3 Nov 2026 (brief `docs/briefs/2026-11-03-facebook-page-posting.md`). It mirrors the LinkedIn posting
(`docs/LINKEDIN_POSTING.md`) and does not change it. Code: `src/services/facebook/{client,pages,post,worker}.ts`,
`src/routes/facebook.ts`. Table `FacebookPost` (not in the R2 backup).

## What posts
Every taxscan.in article the push system SENT, whoever sent it (pacer, Compose, Queue/Review Push now, Breaking), by the same
rule as WhatsApp and LinkedIn (`isPublicArticleCampaign()`): not a test-segment-only send, not the home page / a section /
academy / shop. One post per article (`articleKey()`), so a re-push or the morning-backfill clone never posts again, nor does a
re-push of an article first pushed before go-live (looked for up to 14 days before it). Only pushes at or after
`FACEBOOK_POST_FROM`, and **there is no age limit** (brief 2026-11-04-social-no-age-limit): an article that has no row yet posts
however long ago it was pushed, paced by the gap, the daily cap and the stops below. The CMS hashtag/keyword fetch is LinkedIn's (fail-open).

The post: `POST https://graph.facebook.com/<FACEBOOK_GRAPH_VERSION>/<page-id>/feed`, form-encoded `message`, `link`,
`access_token` (the token is in the body, never in a URL). `message` = headline, blank line, at most 4 plain `#Tags`
(`#taxscan` last). `link` = the article with `utm_source=taxscan-facebook&utm_medium=social&utm_campaign=facebook-taxscan&utm_content=<id|slug>`;
Facebook builds the link card itself (og:title / og:image). No image upload. The screen links `https://www.facebook.com/<id>`.

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
| Duplicate | code 506 | FAILED "Facebook says this was already posted", no retry. |
| Other 4xx | | FAILED at once. |
Retries never fall in quiet hours (23:00-07:00 IST: wait to 07:00). Log line:
`[facebook] page=taxscan campaign=... outcome=posted|retry|failed|auth_stop|policy_stop hashtags=cms|fallback`.
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
