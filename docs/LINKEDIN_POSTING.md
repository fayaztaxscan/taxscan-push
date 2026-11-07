# LinkedIn page posting

Every taxscan.in article the push system sends is posted, automatically and a few minutes later, to the **Taxscan LinkedIn
page**: headline, hashtags and a link-preview card whose link carries our LinkedIn UTMs. One post per article, in push order.
It replaces the `sheet_to_linkedin` job in the separate `fayaztaxscan/taxscan-automation` repo (which posts every feed
article). Brief: `docs/briefs/2026-11-02-linkedin-page-posting.md` (incl. follow-up 1).

**Optionally the same articles also go to the Taxscan Academy page** (`urn:li:organization:91100022`), with the same text, hashtags
and picture, once the owner sets the two `LINKEDIN_ACADEMY_*` variables (see "Pages"). Unset, nothing about it exists: no rows, no
log noise, no change to the Taxscan page. Brief: `docs/briefs/2026-11-04-linkedin-academy-page.md`.

**Optionally, from a time set per page, a page posts EVERY push** (articles, academy courses, shop products), one post per push,
repeats included, like the push notification itself (see "Every push posts"). Unset, each page behaves exactly as described below.
Brief: `docs/briefs/2026-11-04-academy-store-posts.md`.

## What posts
(This is **today's rule**, the one every page follows until its `LINKEDIN_*_ALL_PUSHES_FROM` time is set; see "Every push posts" below.)
A `Campaign` with `status = SENT`, a mapped `portal` (`taxscan` → page `taxscan`, and page `academy` too while it is on), a
taxscan.in **article** URL (`articleContentOf()`: `/<section>/<slug>`, or a trailing numeric id; never the home page, a section page,
academy or shop; the Academy PAGE posts these same taxscan.in articles, not academy.taxscan.in pushes) and `lastSentAt ≥` the page's
go-live time. **There is no age limit** (brief 2026-11-04-social-no-age-limit): an article that has no row yet is posted however long
ago it was pushed, so an outage, a login stop or a backlog never loses one. Only the page's go-live time is absolute
(`LINKEDIN_POST_FROM`; Academy: its own `LINKEDIN_ACADEMY_POST_FROM`): nothing pushed before it is ever posted to that page. **Whoever sent it does not matter**: the pacer, Compose
"Send now", a scheduled Compose send marked SENT by the sweeper, Queue/Review "Push now" and Breaking all post. The one
exclusion is a **test send**: a campaign whose target is ONLY the test-segment topic (`TEST_SEGMENT_TOPIC`, default `test`).
The predicate is shared with the WhatsApp queue: `isPublicArticleCampaign()` in `src/services/social/publicCampaign.ts`.

One post per **article per page** (`articleKey()`; the unique key is `(page, articleKey)`): a re-push or the morning-backfill clone
never posts again, nor does a re-push or clone of an article first pushed before that page's go-live (looked for up to 14 days
before the page's own go-live time). The two pages are independent: separate rows, statuses, Retry and Skip, and an article pushed
between the two go-live times is posted to the Taxscan page only (a later repeat of it adds no Academy row).

## Every push posts (brief 2026-11-04-academy-store-posts)
Off by default. Everything above is **today's rule**: one post per taxscan.in article. From a time the owner sets **per page**, a page
instead posts **every push, like the push notification itself**: taxscan.in articles, `academy.taxscan.in` courses and
`shop.taxscan.in` products, **one post per push, repeats included** (the morning-backfill clone, a Compose copy, the same campaign row
sent again). Nobody filters duplicates; the platform may refuse an identical one (see "A repeat LinkedIn refuses").

| Variable | Page |
|---|---|
| `LINKEDIN_TAXSCAN_ALL_PUSHES_FROM` | the Taxscan page |
| `LINKEDIN_ACADEMY_ALL_PUSHES_FROM` | the Academy page; counts only while the Academy page is on |

A strict ISO date or time, validated exactly like `LINKEDIN_ACADEMY_POST_FROM` (`parseAllPushesFrom()` in `src/lib/env.ts`; a bare year,
`04/11/2026` or `Nov 4` is refused). Unset or invalid = that page stays on today's rule, with ONE boot line saying why (names, never
values): `[linkedin] all pushes off: LINKEDIN_TAXSCAN_ALL_PUSHES_FROM is not set (today's rule: one post per article)`; on, `[linkedin] all
pushes on for LINKEDIN_TAXSCAN_ALL_PUSHES_FROM (from <ISO time>)`. Each page's line names the page through its variable.

- **Why a time is essential.** Today's rows are keyed by article, so past repeats and every course or product push have no row. Without a
  time, switching on would post all of them. **A push with `lastSentAt` before the page's time follows today's rule for good; a push at or
  after it follows the new rule; nothing older ever becomes eligible.** A pre-time article that has no row yet (waiting behind a login
  stop, say) still gets its one post by today's rule. Set the variable to the moment you switch on.
- **It never reaches back before the page's own go-live.** The new rule starts at the LATER of the all-pushes time and the page's
  `LINKEDIN_POST_FROM` / `LINKEDIN_ACADEMY_POST_FROM` (`newRuleFrom()`): "nothing pushed before a page's go-live is ever posted there"
  stays true whatever else is set.
- **What qualifies** (`isAllPushesCampaign()` in `src/services/social/allPushes.ts`, a NEW rule beside `isPublicArticleCampaign()`,
  which is unchanged because the WhatsApp queue relies on it): a SENT campaign of a mapped portal with `lastSentAt` set, not
  test-segment-only, on `ALLOWED_PUSH_HOSTS`, whose URL is a taxscan.in article, `https://academy.taxscan.in/course/<slug>` or
  `https://shop.taxscan.in/products/<slug>`. Any OTHER page on a named allowed host (the home page, a section page, a collection,
  `/pricing`) qualifies **only under `SOCIAL_ANY_LINK_FROM`**, see "Other pages" below; an off-list host never does.
- **One post per push.** The row key is `push:<campaignId>:<lastSentAt ms>` in `LinkedInPost.articleKey` (the same column and the same
  unique `(page, articleKey)`): a resend of the same campaign row has a new `lastSentAt`, so it posts again, while two overlapping ticks
  still cannot post the same push twice. Under the new rule the 14-day look-back and the "first push of the article" logic do not apply.
- **Turning it off is safe.** Today's rule skips an article any of whose pushes already has a `push:` row on the page (the campaign id is
  in the key, so the worker's one read of the page's keys supplies the ids; no extra query). Remove the variable, or move it later than
  those pushes, and nothing is reposted. The screens and the Campaigns mark show such an article with that row's status, never WAITING.
- **Candidates of both rules are merged by send time, oldest first**, and share everything else: `MAX_PER_TICK` (3, Taxscan first), the
  retries, the stale rule and the per-page login stop. No new caps.
- **Articles** are built exactly as before (CMS hashtags, cover picture, description); **course and product posts** below.
- **Screens.** SOCIAL → LinkedIn lists one row per push under the new rule (a repeat is its own row, with its own Retry and Skip), and
  today's one-row-per-article for earlier pushes; **Campaigns → Channels** shows a new-rule push the status of its own row (Taxscan
  page); both are exactly as before while the variable is unset.
- **Quota note.** The app is on the Development tier (100 calls per member per endpoint per day). About 3 course and product pushes a day
  plus repeats per page make roughly 60 `posts-CREATE` a day; `images-GET` (the status poll, 2 per post) could approach 100, which is why
  a 429 on that poll still publishes the post, with the picture attached unverified (`image=ok:unverified`) and no retry loop.

### Course and product posts
A course or product has no CMS article, so the post is built from the push and the page (`buildStorePost()` in `post.ts`):
- **Commentary** = the push title, a blank line, the push body (its own lines kept as single line breaks, so `- ` bullets survive), a
  blank line, `{hashtag|\#|taxscan}`. The title and the body are escaped as little text (emoji pass through untouched). If the whole
  would pass LinkedIn's **3,000-character** limit (`COMMENTARY_MAX`, measured on the text as sent), the **body** is cut at a word
  boundary with "…" and, if need be, dropped; **the title is never cut**. (LinkedIn documents 3,000 for a post's text; the Posts API
  answers 400 `FIELD_LENGTH_TOO_LONG` above its limit.)
- **Link** = the push's own link with `utm_source=taxscan-linkedin`, `utm_medium=social`, `utm_campaign=linkedin-<page>`, `utm_content=<slug>`
  (≤ 100 characters); the push's own `utm_*` are replaced.
- **Card title and description** = the page's `og:title` and `og:description` (entities decoded, markup stripped; the description ≤ 200
  characters), falling back to the push title and body.
- **Picture** (`src/services/social/storePage.ts`): the worker fetches the course / product page, reads **only the start of it**
  (256 KB, the stream is cancelled past that; `metaContent()` from the digest's `articleImage.ts`) with a 5 s limit, **no redirects**,
  https only, hosts `academy.taxscan.in` / `shop.taxscan.in`. The page is fetched in its canonical form, the link without a query string
  **with a trailing slash**, because WordPress answers the slash-less course URL with a 301. It prefers `og:image:secure_url`, then
  `og:image`, **https only** (Shopify serves `og:image` over http and the same file over https in `secure_url`); a relative value
  resolves against the page. The picture itself then goes through the existing `fetchCoverImage` (the two store hosts are now in its
  allowlist, redirects still refused), the Images API upload under the page's own org URN and the wait for AVAILABLE. **Fail-open**: any
  problem posts without a picture and the outcome line says why: `image=none:<reason>` with `page_host`, `page_timeout`,
  `page_redirect`, `page_network`, `page_http_<n>` (the page), `no_tag` or `not_https` (the tags), then the picture reasons listed above
  (`host`, `redirect`, `timeout`, `http_<n>` …). A page that cannot be read never fails the post: the card falls back to the push title
  and body.
- Log line: `[linkedin] page=<page> campaign=… outcome=posted hashtags=fixed image=ok|none:<reason> kind=course|product`. Articles keep
  their line unchanged.

### A repeat LinkedIn refuses
LinkedIn can answer an identical post with **422** and `errorDetails.inputErrors[].code = "DUPLICATE_POST"` ("Content is a duplicate of
urn:li:share:…"; LinkedIn's reference pages do not list the code, the shape is what the API returns, matched in `isDuplicateAnswer()`
only on a 422). The row becomes **FAILED** with the plain reason *"LinkedIn says this was already posted"*: **no retry, no repeat
without the picture, no login stop, no alert**, and the next push posts on the next tick (`reason=duplicate` in the log). Retry on it
asks LinkedIn again.

## How it runs
`src/services/linkedin/worker.ts`: a 1-minute `node-cron` tick, started only when `LINKEDIN_POSTING_ENABLED=true` **and**
`LINKEDIN_POST_FROM` + the Taxscan page's two variables are valid (otherwise it logs `[linkedin] refusing to start: …` and does not
run). The Academy page never blocks the start: it is active only when its own two variables are valid, and borrows the Taxscan
token, so once the Taxscan page is sound Academy cannot be the reason. It reads `Campaign` rows only; the push send path is
untouched, and the request path never calls LinkedIn (only the worker, and the screen's Retry, which makes one post and answers).

- At most **3 posts per tick, shared by both pages**, oldest push first. The Taxscan page is handled first in a tick, so a busy
  Taxscan page only delays the Academy page to a later tick (an article normally posts to both in the same tick).
- Each tick reads, per page, every SENT push since that page's go-live time (only `id`, `url` and `target`; plus `lastSentAt` while the
  page's all-pushes time is set, since that is what splits the pushes at that time) and the page's existing keys. That list grows by about 20 a day per page and nothing else does; it is the one thing to revisit if the pages run for years.
- The `LinkedInPost` row (PENDING, in flight) is created **before** the API call; unique (`page`, `articleKey`) means a
  crash or an overlapping tick can't post twice.
- An in-flight row older than **10 minutes** with no result becomes FAILED *"unknown — check the page"* and is **never
  re-posted automatically** (the call may have gone through). Retry on such a row asks the editor to check the page first.
- **429 / 5xx / network / timeout**: retried at +1, +5, +15 minutes (four calls in all), then FAILED. A retry that would
  fall in quiet hours (23:00–07:00 IST) waits until 07:00. A first attempt goes out at any hour (a push already obeyed the
  night rule: only Breaking goes out at night).
- **400 / 409 / 422** and other client errors: FAILED at once (retrying can't help).
- **401 / 403** (token expired, revoked or lacking permission): posting for **that page** **stops** until the token changes in
  Railway (or is renewed) or the app restarts. One alert email per page per IST day to the active ADMIN users (ElasticEmail), and
  an amber banner on the LinkedIn screen (each page keeps its own banner state, `linkedin:auth:<page>`). Pushed articles are kept and
  post once posting resumes, however long that takes. **A stop is per page**: a 401 / 403 on one page never gates the other, in the
  same tick or a later one. A 401 on the Taxscan page does not prevent the Academy page's attempt in that tick (it shares the token,
  so it fails too, stops itself and sends its own alert). A 403 on Academy alone, while Taxscan keeps posting, normally means the
  LinkedIn member who made the token has no admin role on the Academy page: Taxscan carries on, Academy stops with its own banner and
  e-mail, and after the role is fixed in LinkedIn the app must be restarted (or the token changed or renewed) for Academy to resume.

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

## Pages
`LinkedInPost.page` is a plain string: a page is its env variables plus a place in the portal → pages map (`portalPages()` in
`src/services/linkedin/pages.ts`). No schema change, no migration. One portal can post to several pages.

- **`taxscan`** reads `LINKEDIN_TAXSCAN_ORG_URN` + `LINKEDIN_TAXSCAN_ACCESS_TOKEN` (`env.linkedin.pages`) and `LINKEDIN_POST_FROM`.
- **`academy`**, the Taxscan Academy page, posts the **same taxscan.in articles** as the Taxscan page (portal `taxscan` → pages
  `taxscan`, then `academy`: Taxscan is always first). It is **active only when BOTH variables are valid**:
  - `LINKEDIN_ACADEMY_ORG_URN` = `urn:li:organization:<digits>` (the Academy page is `urn:li:organization:91100022`);
  - `LINKEDIN_ACADEMY_POST_FROM` = an ISO date or time, e.g. `2026-11-04T10:00:00Z`. A bare year, `04/11/2026` or `Nov 4` is refused
    (a loose reading would put the go-live months back, and with no age limit that posts everything pushed since).
  Anything else (neither set, only one set, either invalid) leaves it **off**: no Academy rows, no FAILED rows, no refusal to start, no
  log noise except ONE boot line from `startLinkedInWorker`, `[linkedin] academy page off: <which variable is missing or invalid>`
  (names, never values). On, the line is `[linkedin] academy page on (post from <ISO time>)`. The parser is the pure
  `parseLinkedInAcademyEnv()` in `src/lib/env.ts`; the result is read at call time (`env.linkedin.sharedPages`), never cached.
  - **Own go-live.** Academy uses `LINKEDIN_ACADEMY_POST_FROM` wherever the Taxscan page uses `LINKEDIN_POST_FROM`: the list read, the
    14-day look-back for earlier pushes, the screen's WAITING / NOT POSTED. Nothing pushed before it is posted to Academy; a repeat of
    an article first pushed before it adds no Academy row; an article pushed between the two times is posted to Taxscan only.
  - **Shared token.** No Academy token variables, no second `LinkedInToken` row, no second renewal. `pageConfig('academy')` = its own
    org URN + the Taxscan page's token IN USE (the renewed one when there is one: `cachedAccessToken` resolves `academy` through
    `taxscan`). The Academy page lives in `env.linkedin.sharedPages`, **not** in `env.linkedin.pages`, because every token loop
    (renewal, `LinkedInToken` rows, the active-token cache) walks `pages` and must never see a page without a token of its own.
    The LinkedIn member who made the token must be an admin of the Academy page too; the first real post proves it, and a 403 on
    Academy alone is the signal that it does not.
  - **Own rows, stops and alerts.** Rows, statuses, Retry and Skip are per page; so are the login-stop state (`linkedin:auth:academy`),
    the amber banner and the once-a-day alert e-mail (which names the shared token's variable, `LINKEDIN_TAXSCAN_ACCESS_TOKEN`).
  - **Picture.** The cover is uploaded separately under each page's own org URN (the Images API `owner`), so each post carries an
    image owned by its own page. Text, hashtags (`#taxscan` last) and headline are identical; only the link differs
    (`utm_campaign=linkedin-taxscan` / `linkedin-academy`).
  - **Switching it off** only stops it: its rows are kept and nothing is marked FAILED. **Switching it back on**: set
    `LINKEDIN_ACADEMY_POST_FROM` to that moment, or everything pushed since the old time posts at once, three a tick.
  - **Campaigns → Channels** keeps meaning the Taxscan page (its rows only), with Academy on or off.
- Adding Shopscan later is the same recipe: its variables and a place in `portalPages()`.

## The screen's API
`GET /api/linkedin/posts?date=YYYY-MM-DD&page=<key>` (ADMIN or PUBLISHER; `date` = an IST day, default today, up to 14 days back).
`page` must be one of the **active** pages (default `taxscan`); an unknown page, or `academy` while it is off, is
`400 {"error":"invalid_page"}`. The answer: `date`, `page`, `pages` (the active page keys, Taxscan first: the screen shows a page
switch only when there is more than one), `rows`, `counts`, `login` (that page's own banner state, or null) and, while renewal is on,
`token` (dates and a status, never a token). `tokenShared: true` appears only while two pages post with one token (then `token`
is that one token's status on both pages). Rows, counts and the banner follow `page`. Retry and Skip are by row id
(`POST /api/linkedin/posts/:id/retry|skip`); each touches only its own row.

## Flags / env
| Variable | Default | Meaning |
|---|---|---|
| `LINKEDIN_POSTING_ENABLED` | off | worker + screen + `/api/linkedin`; off = no cron, menu hidden, API 404 |
| `LINKEDIN_POST_FROM` | — | **required when enabled** (ISO time); nothing pushed before it is ever posted |
| `LINKEDIN_API_VERSION` | `202603` | the `LinkedIn-Version` header |
| `LINKEDIN_TAXSCAN_ORG_URN` | — | e.g. `urn:li:organization:12345` |
| `LINKEDIN_TAXSCAN_ACCESS_TOKEN` | — | a token with `w_organization_social`; never logged, never in a response or the `error` column. **Also the Academy page's token.** |
| `LINKEDIN_ACADEMY_ORG_URN` | — | the Academy page, `urn:li:organization:<digits>`. **The page is on only when this AND `LINKEDIN_ACADEMY_POST_FROM` are valid**; anything else = off (one boot line) |
| `LINKEDIN_ACADEMY_POST_FROM` | — | the Academy page's own go-live (ISO date or time); nothing pushed before it is ever posted to Academy. Set it to the moment you switch on |
| `LINKEDIN_TAXSCAN_ALL_PUSHES_FROM` | — | **every push posts** on the Taxscan page from this time (strict ISO); a push before it keeps today's rule for good. Unset or invalid = today's rule (one boot line). Never earlier than `LINKEDIN_POST_FROM`. Set it to the moment you switch on |
| `LINKEDIN_ACADEMY_ALL_PUSHES_FROM` | — | the same for the Academy page; counts only while the Academy page is on; never earlier than `LINKEDIN_ACADEMY_POST_FROM` |
| `SOCIAL_ANY_LINK_FROM` | — | **one time for all four channels**: from it on, a push to any OTHER allowed page (shop collection, pricing page, home page) is posted too, on every page whose all-pushes rule is on (strict ISO; a push before it never is; unset or invalid = off). See "Other pages" |

There are no Academy token variables: the two Academy variables are the whole switch, and `LINKEDIN_POSTING_ENABLED` still governs
everything (off = no worker for either page).

## Switch-over (owner, after deploy)
1. Set `LINKEDIN_TAXSCAN_ORG_URN` + `LINKEDIN_TAXSCAN_ACCESS_TOKEN` in Railway (the same values as the automation repo's
   GitHub secrets, or a fresh token).
2. **In the same sitting**: set `sheet_to_linkedin` → `"enabled": false` in `taxscan-automation/config.json` and push, set
   `LINKEDIN_POST_FROM` to the current time (UTC ISO), then `LINKEDIN_POSTING_ENABLED=true`. (Doing the old job's switch-off
   first avoids a double post.)
3. Watch the first `[linkedin] page=taxscan campaign=… outcome=posted` log line and the post on the page.

### Switching the Academy page on (after the Taxscan page works)
1. The token's member (the owner) must administer the Academy page too; no new sign-in is expected.
2. In Railway set `LINKEDIN_ACADEMY_ORG_URN=urn:li:organization:91100022` and `LINKEDIN_ACADEMY_POST_FROM` = the current time (UTC
   ISO), then redeploy. Nothing else changes for the Taxscan page.
3. Look for `[linkedin] academy page on (post from …)` in the boot log, then for `[linkedin] page=academy campaign=… outcome=posted`
   after the next push. A 403 (an amber banner and an e-mail for the Academy page only) means the token's member has no role on that
   page: the Taxscan page keeps posting. Give the member the role in LinkedIn and restart the app.

### Switching "every push posts" on (per page, any time after that page works)
1. In Railway set `LINKEDIN_TAXSCAN_ALL_PUSHES_FROM` (and `LINKEDIN_ACADEMY_ALL_PUSHES_FROM` if the Academy page is on) to **the current
   time** (UTC ISO), then redeploy. Pushes sent before that time keep today's rule; nothing in the past is posted.
2. Look for `[linkedin] all pushes on for LINKEDIN_TAXSCAN_ALL_PUSHES_FROM (from …)` in the boot log, then for
   `[linkedin] page=taxscan campaign=… outcome=posted hashtags=fixed … kind=course|product` after the next course or product push.
3. **Switching it off again.** Remove the variable (or move it later) and the page is back on today's rule, and **nothing is posted
   again**: an article any of whose pushes already has a `push:` row on that page is skipped by today's rule, whatever status the
   row has (POSTED, FAILED, SKIPPED, in flight). A new article posts once, as before; an article that never got a `push:` row still gets
   its one post. Set the variable again later and every push from that time posts, the past does not. (To stop all posting instead, set
   `LINKEDIN_POSTING_ENABLED=false`.)

### Other pages (brief 2026-11-07-social-every-link)
Off by default. **`SOCIAL_ANY_LINK_FROM`** is ONE strict ISO time for all four channels (LinkedIn Taxscan, LinkedIn Academy, Facebook and the
WhatsApp list; `parseAllPushesFrom()`; unset or invalid = off). From it on, a push to **any other page on a host named in
`ALLOWED_PUSH_HOSTS`** (a shop collection such as `https://shop.taxscan.in/collections/all`, `/pricing`, `/subscription`, the home page, a
section page) is posted like a course or product. Until then such a push makes no row on any channel (as before: the owner asked on
2026-11-07 why a push to `shop…/collections/all` reached no channel).
- **What qualifies** (`pageLinkOf()` in `src/services/social/allPushes.ts`): a SENT campaign, not test-segment-only, whose URL is on a host
  **named** in `ALLOWED_PUSH_HOSTS` (no userinfo, no port) and is not an article, course or product, **sent at or after
  `SOCIAL_ANY_LINK_FROM`**, and on a page that already follows the all-pushes rule at that send time (the page's
  `LINKEDIN_*_ALL_PUSHES_FROM` is set and the push is at or after it). A push **one second before** the time makes no row, however old or
  new: switching it on posts nothing from the past. With the allowlist emptied (the operator's permissive mode) nothing counts as a page.
- **The time check lives inside `isAllPushesCampaign()` itself**, so no caller can forget it: the LinkedIn and Facebook workers and screens,
  the WhatsApp queue and its Posted / Skip marks, and the Campaigns Channels marks all call it with the campaign's `lastSentAt`. A push
  with no send time never qualifies as an other page (fail closed). Articles, courses and products are untouched by the setting.
- **One post per push**, the same key `push:<campaignId>:<lastSentAt ms>`; a resend is a new row, two overlapping ticks post one.
- **The post** (`buildPagePost()` in `post.ts`) is built exactly like a course / product post: the push's own title and body as the
  commentary; the link is the push's own URL with this page's UTMs (`utm_content` = the path segments joined by `-`, cut to 100:
  `/collections/all` → `collections-all`, `/pricing` → `pricing`, `home` for the root path; the push's own `utm_*` are replaced, other query
  parameters stay); the card's title, description and picture come from the page's og tags. The page is fetched on the push's own address
  **without its query**, **https only**, host named in `ALLOWED_PUSH_HOSTS`, **no redirects**, 5 s, capped read (`fetchStorePage()`); a
  failed, slow or redirecting fetch is **fail-open**: the post goes out with the push's own wording and no picture. Log lines carry
  `kind=page`.
- **Switching on:** set `SOCIAL_ANY_LINK_FROM` to the moment you switch on (UTC ISO) and redeploy; **never move it earlier**. **Switching off:**
  remove it; nothing is reposted and the rows already made keep their status (the screens stop listing those pushes while it is unset).
  After a restore, see `docs/BACKUPS.md`.

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

**The Academy page shares this token.** Renewal runs once, for the page that owns the token (`taxscan`): one `LinkedInToken` row,
one daily check, one renewal. The Academy page posts with that same token (the renewed one once there is one) and has no variable,
row or renewal of its own. A successful renewal (or a token pasted into Railway) ends the login stop and clears the banner of BOTH
pages, and both post with the new token on the next tick; the screen shows the one token's status on either page.

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
`LinkedInPost` rows are gone, so without that, recent articles would post twice; with the Academy page on, also set
`LINKEDIN_ACADEMY_POST_FROM` to the restore time, for the same reason). **Set `LINKEDIN_TAXSCAN_ALL_PUSHES_FROM` and
`LINKEDIN_ACADEMY_ALL_PUSHES_FROM` to the restore time too** (or unset them): the `push:` rows are gone with the rest, and an old value
would post every push since then, repeats included. See `docs/BACKUPS.md`.

## Logs
One line per attempt: `[linkedin] page=taxscan campaign=<id> outcome=posted|retry|failed|auth_stop` (`page=academy` for the Academy
page). One boot line about the Academy page, from `startLinkedInWorker` only (`[linkedin] academy page on (post from …)` or
`[linkedin] academy page off: …`), and one per page about "every push posts" (`[linkedin] all pushes on for … (from …)` /
`[linkedin] all pushes off: <variable> is not set | is not a valid ISO time | is ignored while the Academy page is off (today's rule: one
post per article)`). A course or product post adds `kind=course|product` to its line, and a refused identical repeat is
`outcome=failed reason=duplicate`. Every error goes through `safeErrorLog`; the token appears nowhere.
