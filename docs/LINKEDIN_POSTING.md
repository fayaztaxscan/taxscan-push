# LinkedIn page posting

Every taxscan.in article the push system sends is posted, automatically and a few minutes later, to the **Taxscan LinkedIn
page**: headline, hashtags and a link-preview card whose link carries our LinkedIn UTMs. One post per article, in push order.
It replaces the `sheet_to_linkedin` job in the separate `fayaztaxscan/taxscan-automation` repo (which posts every feed
article). Brief: `docs/briefs/2026-11-02-linkedin-page-posting.md` (incl. follow-up 1).

## What posts
A `Campaign` with `status = SENT`, a mapped `portal` (`taxscan` → page `taxscan`), a taxscan.in **article** URL
(`articleContentOf()`: `/<section>/<slug>`, or a trailing numeric id; never the home page, a section page, academy or shop)
and `lastSentAt ≥ LINKEDIN_POST_FROM` and within the last 24 hours. **Whoever sent it does not matter**: the pacer, Compose
"Send now", a scheduled Compose send marked SENT by the sweeper, Queue/Review "Push now" and Breaking all post. The one
exclusion is a **test send**: a campaign whose target is ONLY the test-segment topic (`TEST_SEGMENT_TOPIC`, default `test`).
The predicate is shared with the WhatsApp queue: `isPublicArticleCampaign()` in `src/services/social/publicCampaign.ts`.

One post per **article** (`articleKey()`): a re-push or the morning-backfill clone never posts again, nor does a clone of
an article first pushed before go-live or more than 24 h ago.

## How it runs
`src/services/linkedin/worker.ts`: a 1-minute `node-cron` tick, started only when `LINKEDIN_POSTING_ENABLED=true` **and**
`LINKEDIN_POST_FROM` + the page's two variables are valid (otherwise it logs `[linkedin] refusing to start: …` and does not
run). It reads `Campaign` rows only; the push send path is untouched, and the request path never calls LinkedIn (only the
worker, and the screen's Retry, which makes one post and answers).

- At most **3 posts per tick**, oldest push first.
- The `LinkedInPost` row (PENDING, in flight) is created **before** the API call; unique (`page`, `articleKey`) means a
  crash or an overlapping tick can't post twice.
- An in-flight row older than **10 minutes** with no result becomes FAILED *"unknown — check the page"* and is **never
  re-posted automatically** (the call may have gone through). Retry on such a row asks the editor to check the page first.
- **429 / 5xx / network / timeout**: retried at +1, +5, +15 minutes (four calls in all), then FAILED. A retry that would
  fall in quiet hours (23:00–07:00 IST) waits until 07:00. A first attempt goes out at any hour (a push already obeyed the
  night rule: only Breaking goes out at night).
- **400 / 409 / 422** and other client errors: FAILED at once (retrying can't help).
- **401 / 403** (token expired, revoked or lacking permission): posting for the page **stops** until the token changes in
  Railway or the app restarts. One alert email per IST day to the active ADMIN users (ElasticEmail), and an amber banner on
  the LinkedIn screen. Pushed articles wait as retries and post once posting resumes, if still within 24 h.

## The post
`POST https://api.linkedin.com/rest/posts`, headers `LinkedIn-Version: $LINKEDIN_API_VERSION` (default `202603`),
`X-Restli-Protocol-Version: 2.0.0`, `Authorization: Bearer <token>`. Author = the page's organization URN; `PUBLIC`;
`MAIN_FEED`; `PUBLISHED`; `content.article.source` = the UTM link, `title` = the headline. The post id comes from the
`x-restli-id` header, else the body.

- **Commentary** = headline, a blank line, then the hashtags, in LinkedIn's *little text* format. Reserved characters
  `\ | { } @ [ ] ( ) < > # * _ ~` are backslash-escaped in the headline (taxscan headlines hold `[Read Order]` and `(2)`).
  Hashtags use the documented template form **`{hashtag|\#|Tag}`** (checked against LinkedIn's *little Text Format* page,
  2 Nov 2026), which renders as a real hashtag.
- **Hashtags** (max 6, unique, letters and digits, `#taxscan` last, no fixed `#TaxNews`) come from the CMS's own editorial
  data, one fetch per post: `GET https://api.taxscan.in/api/v1/articles/<slug>` (public, no auth; 5 s timeout, one attempt,
  ≤ 2 MB, host must be `api.taxscan.in`). Court (`courts[0]`; SC → `#SupremeCourt`; a clean acronym → `#ITAT`, or the
  bench keyword `ITAT Panaji` → `#ITATPanaji`; else CamelCase of the name), category (not `Other Taxations`), up to 3 editorial
  keywords in the editor's order (section phrases → `#Section270A` / `#Section69CGST`; otherwise ≤ 3 words and ≤ 24
  characters; the stop-list `KEYWORD_STOPLIST` in `post.ts` drops generic ones). **Fail-open**: if the fetch fails, the
  fallback is the campaign's own authority + category + `#taxscan`, logged `hashtags=fallback`; the post is never delayed
  or blocked.
- **UTMs**: `utm_source=taxscan-linkedin`, `utm_medium=social`, `utm_campaign=linkedin-<page>` (`linkedin-taxscan`),
  `utm_content=` the numeric id when the URL has one, else the slug (≤ 100 characters). Existing `utm_*` are replaced (SET,
  never duplicated); other params and the fragment survive; the final URL passes `isAllowedPushUrl`. The helper is
  `src/services/social/utm.ts`, shared with WhatsApp.

## The link card's picture and description
The Posts API does **not** scrape the link for `content.article`: a thumbnail appears only when the post supplies
`content.article.thumbnail`, an image URN uploaded through the **Images API** (brief `docs/briefs/2026-11-02-linkedin-article-thumbnail.md`).
So, in each attempt, after the CMS article is read for the hashtags (`src/services/linkedin/post.ts`, `image.ts`, `client.ts`):
1. **Source:** the CMS article's `cover_image_url` (and `excerpt`). If the CMS fetch failed there is no picture; the page is never scraped.
2. **Fetch the picture (`fetchCoverImage`):** https only, exact host `documents.taxscan.in` / `www.taxscan.in` / `taxscan.in` (no userinfo, no
   port), **no redirects**, 10 s for the whole fetch including the body, at most 5 MB (the read stops at the cap), `content-type` image/jpeg,
   image/png or image/gif only.
3. **Upload (`uploadImage`, LinkedIn "Images API", checked 2 Nov 2026):** `POST https://api.linkedin.com/rest/images?action=initializeUpload`
   (same `LinkedIn-Version` / `X-Restli-Protocol-Version` / Bearer headers) with `{"initializeUploadRequest":{"owner":"<org URN>"}}` →
   `value.uploadUrl` and `value.image` (`urn:li:image:…`); then `PUT` the bytes to `uploadUrl` **with the Bearer token** (the image upload
   call requires it; a 200 / 201 answer). The upload URL must be https on `linkedin.com` / `licdn.com`, or the token is not sent to it.
4. **Wait until the image is ready:** the upload is asynchronous (WAITING_UPLOAD → PROCESSING → AVAILABLE). After the PUT the worker looks at
   `GET https://api.linkedin.com/rest/images/<urn>` (the URN **URL-encoded** in the path, `urn%3Ali%3Aimage%3A…`, as the Rest.li 2.0 protocol
   requires; same headers; the `status` field) up to 4 times, 1.5 s apart. AVAILABLE attaches the thumbnail (`image=ok`); still processing →
   `image=none:processing`, a failed processing → `image=none:processing_failed`, a 401 / 403 / 5xx from the status call →
   `image=none:status_<code>`: the post then goes out without it. **If the status call itself errors** (a 4xx other than 401 / 403, or a network
   error) that says nothing about the picture, so it is attached anyway and logged `image=ok:unverified`; step 6 repeats the post without it if
   LinkedIn rejects it.
5. **Post** with `content.article = { source, title, description, thumbnail: <image URN> }`. The **description** is the CMS `excerpt`, else the
   campaign body: whitespace-collapsed, ≤ 200 characters at a word boundary with "…", a plain string (not escaped like the commentary).
6. **A post rejected because of the picture still goes out:** if the post WITH a thumbnail gets a client error that is not 401 / 403 / 429 (the
   `failed` verdict: 400 / 409 / 422 …), the same attempt repeats the post once, right away, WITHOUT the thumbnail (description kept) and logs
   `image=dropped:<status>`. Safe because a 4xx means LinkedIn did not create the first post. The repeat's verdict is the attempt's. A 2xx, 5xx, 429
   or network error is never repeated here (the normal retry rules apply, with the thumbnail), and a 401 / 403 is an auth-stop with no repeat.
7. **Fail-open:** any failure in 2–4 (timeout, 4xx/5xx, wrong type, too big, a bad answer, the image not ready) posts WITHOUT `thumbnail` (the description is kept) and
   the outcome line says why: `image=ok` / `image=ok:unverified`, or `image=none:<reason>` with `host`, `redirect`, `timeout`, `network`, `type`, `size`, `http_<n>`,
   `init_http_<n>` / `init_network` / `init_timeout` / `init_bad_answer`, `put_http_<n>` / `put_network` / `put_timeout`, or `no_cover`. A picture
   problem is never a post failure, never a retry, never an auth-stop, **except** a 401 / 403 from the registration: that is handled like the post's
   own 401 / 403 (the token is bad for everything), and no post call is made. A retried attempt uploads again (images are cheap); there is no loop
   inside one attempt. Time budget per attempt: CMS 5 s + picture 10 s + registration 15 s + upload 15 s + post 15 s, far inside the 10-minute stale window.
Log line: `[linkedin] page=taxscan campaign=… outcome=posted hashtags=cms|fallback image=ok|none:<reason>|dropped:<status>`.

## Pages (keyed for later)
`LinkedInPost.page` is a plain string. Page `taxscan` reads `LINKEDIN_TAXSCAN_ORG_URN` + `LINKEDIN_TAXSCAN_ACCESS_TOKEN`
(`src/services/linkedin/pages.ts`, `PORTAL_TO_PAGE`). **Adding Shopscan or Academy = their two env variables + one mapping
entry; no schema change.** (The screen shows the first mapped page; a page switch would come with the second page.)

## Flags / env
| Variable | Default | Meaning |
|---|---|---|
| `LINKEDIN_POSTING_ENABLED` | off | worker + screen + `/api/linkedin`; off = no cron, menu hidden, API 404 |
| `LINKEDIN_POST_FROM` | — | **required when enabled** (ISO time); nothing pushed before it is ever posted |
| `LINKEDIN_API_VERSION` | `202603` | the `LinkedIn-Version` header |
| `LINKEDIN_TAXSCAN_ORG_URN` | — | e.g. `urn:li:organization:12345` |
| `LINKEDIN_TAXSCAN_ACCESS_TOKEN` | — | a token with `w_organization_social`; never logged, never in a response or the `error` column |

## Switch-over (owner, after deploy)
1. Set `LINKEDIN_TAXSCAN_ORG_URN` + `LINKEDIN_TAXSCAN_ACCESS_TOKEN` in Railway (the same values as the automation repo's
   GitHub secrets, or a fresh token).
2. **In the same sitting**: set `sheet_to_linkedin` → `"enabled": false` in `taxscan-automation/config.json` and push, set
   `LINKEDIN_POST_FROM` to the current time (UTC ISO), then `LINKEDIN_POSTING_ENABLED=true`. (Doing the old job's switch-off
   first avoids a double post.)
3. Watch the first `[linkedin] page=taxscan campaign=… outcome=posted` log line and the post on the page.

## Token renewal
(brief `docs/briefs/2026-11-02-linkedin-token-refresh.md`; `src/services/linkedin/token.ts`.) The page's **access token lasts about 60
days and its refresh token about a year**. With `LINKEDIN_TOKEN_REFRESH_ENABLED=true` the app renews the access token itself, so the only
manual job left is the **yearly sign-in**, announced by email 30 days ahead.

**How it works.** At 10:15 IST every day (and ~2 minutes after boot) each configured page is checked:
1. When does the token in use expire? LinkedIn's token inspector: `POST https://www.linkedin.com/oauth/v2/introspectToken` (form
   `client_id`, `client_secret`, `token`; the answer has `active`, `status` and `expires_at`, epoch seconds). If that is unavailable the
   expiry stored at the last renewal is used; with neither, the expiry is **estimated** as the moment the app first saw this env token
   (the `LinkedInToken` row's `createdAt`) plus `LINKEDIN_ACCESS_TOKEN_TTL_DAYS` (default 60), so renewal still starts ~14 days before it. The
   estimate is marked (`accessExpiresSource = estimate`), shown on the LinkedIn screen as "valid until **about** …", and replaced as soon
   as LinkedIn or a renewal gives a real date. The log line says why the inspector gave nothing:
   `[linkedin-token] page=taxscan access_left_days=N (source=linkedin|stored|estimate|renewal) refresh_left_days=M introspect=ok|no_expires_at|http_<status>|network action=…`.
2. **14 days or less left (or the token is inactive) → renew:** `POST https://www.linkedin.com/oauth/v2/accessToken`
   (`application/x-www-form-urlencoded`: `grant_type=refresh_token`, `refresh_token`, `client_id`, `client_secret`). The answer holds the
   new `access_token`, `expires_in`, the refresh token (the same one, or a new one, which is then used from then on) and
   `refresh_token_expires_in` (seconds remaining; the refresh token's own lifetime does NOT restart on renewal).
3. The new token is stored **encrypted** in `LinkedInToken` (AES-256-GCM, `v1:<iv>:<tag>:<ciphertext>`, a fresh IV per value, key
   `LINKEDIN_TOKEN_KEY`) and is the token the worker and Retry use from the next tick. A renewal also ends a login stop and clears the
   LinkedIn screen's amber banner, without a restart.
4. One log line per page per run: `[linkedin-token] page=taxscan access_left_days=N refresh_left_days=M action=none|renewed|failed`.

**Which token is used** (`activeAccessToken`): the stored one while its `envFingerprint` equals the SHA-256 of the current
`LINKEDIN_<PAGE>_ACCESS_TOKEN` env value; otherwise the env token (and a stored row that no longer matches is dropped). So **pasting a new
token into Railway wins at once**. With renewal off, or the key missing / not 32 bytes, the env token is used and posting is unaffected.

**Failures** (all go to the active ADMIN users by email, **once per IST day**, saying how many days the current token has left):
- a **400 / 401** from LinkedIn (the refresh token is invalid, expired or revoked): no further refresh calls until the env values change
  (`LINKEDIN_<PAGE>_ACCESS_TOKEN` / `_REFRESH_TOKEN`), then it tries again;
- a **5xx / timeout / network error**: tried again at the next daily run.
`LinkedInToken.lastError` holds a short, secret-free reason; the LinkedIn screen shows it as "last renewal failed" (red).

**The yearly sign-in.** Within 30 days of the refresh token's expiry an email "Yearly LinkedIn sign-in due by <date>" goes out, at most once
a week. The refresh token's expiry comes from `refresh_token_expires_in` (after the first renewal) or `LINKEDIN_<PAGE>_REFRESH_EXPIRES_AT`
(ISO) if you set it. To sign in again (about 5 minutes):
1. LinkedIn Developer Portal → the app (`taxscan_post_app`) → Tools → **OAuth 2.0 tools**: create a token with the same scopes
   (`w_organization_social`), signed in as an admin of the Taxscan page.
2. Copy the **access** token, then run: `railway variable set LINKEDIN_TAXSCAN_ACCESS_TOKEN="$(pbpaste)" -s taxscan-push`
3. Copy the **refresh** token, then run: `railway variable set LINKEDIN_TAXSCAN_REFRESH_TOKEN="$(pbpaste)" -s taxscan-push`
   (secrets go through the clipboard; never type or paste them anywhere else). If LinkedIn reports no expiry, also set
   `LINKEDIN_TAXSCAN_REFRESH_EXPIRES_AT` to a year from now (ISO).

**Setting it up (once).**
1. A key: `openssl rand -base64 32`, then `railway variable set LINKEDIN_TOKEN_KEY="$(pbpaste)" -s taxscan-push` (copy it first; keep it in the
   password manager: without it a stored token can't be read, and the env token is used instead).
2. The LinkedIn app's `LINKEDIN_CLIENT_ID` and `LINKEDIN_CLIENT_SECRET` (one app serves every page), and `LINKEDIN_TAXSCAN_REFRESH_TOKEN`
   (the refresh token that came with the current access token).
3. `LINKEDIN_TOKEN_REFRESH_ENABLED=true`. If anything above is missing the log says `[linkedin-token] refusing to start: <which variable>`
   and nothing is renewed; posting keeps working with the env token.

| Variable | Default | Meaning |
|---|---|---|
| `LINKEDIN_TOKEN_REFRESH_ENABLED` | off | the daily renewal; off = the env token only, no cron, the screen shows no token line |
| `LINKEDIN_CLIENT_ID` / `LINKEDIN_CLIENT_SECRET` | — | the LinkedIn app's credentials |
| `LINKEDIN_TAXSCAN_REFRESH_TOKEN` | — | the refresh token (about a year) |
| `LINKEDIN_TOKEN_KEY` | — | 32 bytes, base64: encrypts the stored token |
| `LINKEDIN_TAXSCAN_REFRESH_EXPIRES_AT` | — | optional ISO time, if LinkedIn doesn't report the refresh token's expiry |
| `LINKEDIN_ACCESS_TOKEN_TTL_DAYS` | 60 | the access token's lifetime (1–365), used only to estimate the expiry when LinkedIn gives no date |

The renewal does NOT write back into Railway variables and has no sign-in page of its own: the yearly sign-in stays in LinkedIn's OAuth tools.

## Backups and restores
`LinkedInPost` and `LinkedInToken` (the encrypted renewed token) are **not** in the R2 export (the small `linkedin:auth:<page>` banner row and `linkedin:token:state:<page>` markers live in `DigestSetting`, which is; a restored stale one is harmless). After a restore the env token is used and the next daily renewal re-creates the `LinkedInToken` row. After a restore keep
`LINKEDIN_POSTING_ENABLED` **off**, and set `LINKEDIN_POST_FROM` to the restore time before switching it back on (the
`LinkedInPost` rows are gone, so without that, recent articles would post twice). See `docs/BACKUPS.md`.

## Logs
One line per attempt: `[linkedin] page=taxscan campaign=<id> outcome=posted|retry|failed|auth_stop`. Every error goes
through `safeErrorLog`; the token appears nowhere.
