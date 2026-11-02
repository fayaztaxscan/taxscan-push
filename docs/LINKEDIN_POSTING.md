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

## Backups and restores
`LinkedInPost` is **not** in the R2 export (the small `linkedin:auth:<page>` banner row lives in `DigestSetting`, which is; a restored stale one is harmless and clears on the first successful post). After a restore keep
`LINKEDIN_POSTING_ENABLED` **off**, and set `LINKEDIN_POST_FROM` to the restore time before switching it back on (the
`LinkedInPost` rows are gone, so without that, recent articles would post twice). See `docs/BACKUPS.md`.

## Logs
One line per attempt: `[linkedin] page=taxscan campaign=<id> outcome=posted|retry|failed|auth_stop`. Every error goes
through `safeErrorLog`; the token appears nowhere.
