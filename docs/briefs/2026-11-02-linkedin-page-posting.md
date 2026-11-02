# Brief: LinkedIn page posting — every pushed article goes to the Taxscan LinkedIn page, with UTMs

- **Date / name:** 2026-11-02-linkedin-page-posting  →  branch `build/linkedin-page-posting`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first). UI parts go to **ui-developer**.

## Goal
When the push system sends a taxscan.in article, the same article is posted **automatically** to the **Taxscan LinkedIn
page** soon after: headline, hashtags, and a link preview card whose link carries our LinkedIn UTMs. That's one post
per article, in push order, and only what we push. A **LinkedIn** screen shows each article's status. The design is
keyed by page, so the Shopscan and Academy LinkedIn pages can be added later with configuration only. This replaces
the `sheet_to_linkedin` job in the separate `fayaztaxscan/taxscan-automation` repo, which posts every feed article.

## Why (owner's words)
> 2 Nov: "I am thinking about moving one by one to taxscan-push platform where we will post only what we currently do.
> May be we can move posting to linkedin to taxscan push?" … "we need to have utms required to track this. we have
> linked in pages for taxscan, shopscan and academy. so this is just taxscan page only"

The planning session's recommendations were presented, and the owner did not change them: post automatically right
after the push; hashtags from our own authority/category data; about 20 posts a day instead of every feed article.

## Scope
**In:**
1. **What gets posted:** every `Campaign` with `status = SENT`, `portal = 'taxscan'`, a taxscan.in article URL
   (reuse `articleContentOf()` from `src/services/whatsapp/postText.ts`, which accepts URLs with or without a trailing
   id), and `lastSentAt ≥ LINKEDIN_POST_FROM` and within the last 24 h. One post per **article** (`articleKey()`): a
   re-push or the morning-backfill clone never posts again. Order: `lastSentAt` ascending.
2. **The worker:** a 1-minute `node-cron` tick in a new `src/services/linkedin/`, started like the other crons only
   when the flag is on. It **does not touch the send path**: it reads Campaign rows. Per tick it posts at most 3
   (oldest first). A row is created in `LinkedInPost` (PENDING) **before** the API call, so a crash mid-call can't
   double-post. A PENDING row older than 10 min with no result becomes FAILED with "unknown — check the page", and is
   never re-posted automatically.
   - **Retries:** 429 / 5xx / network → +1, +5, +15 min (3 attempts), then FAILED.
   - **Login errors (401, or 403 meaning token/permission):** stop all posting for this page until a new token is
     deployed. Raise one alert per IST day: an email to ADMIN users via the existing internal mail (ElasticEmail), plus
     an amber banner on the LinkedIn screen.
   - **Night:** a first attempt goes out whatever the hour (pushes already obey the night rule; only Breaking goes out
     at night). A **retry** that falls in quiet hours (23:00–07:00 IST, `isQuietHours` from `src/lib/quietHours`)
     waits until 07:00.
3. **The post (LinkedIn Posts API, `POST https://api.linkedin.com/rest/posts`, header `LinkedIn-Version` from env,
   default `202603`, `X-Restli-Protocol-Version: 2.0.0`):** author = the page's organization URN; visibility PUBLIC;
   `distribution.feedDistribution = MAIN_FEED`; `lifecycleState = PUBLISHED`.
   - `commentary` = headline, a blank line, then the hashtags.
   - `content.article.source` = the UTM link; `content.article.title` = headline.
   - Store the returned post id (`x-restli-id` header, else body `id`).
   - **Escape the commentary** per LinkedIn's "little text" format. `\ | { } @ [ ] ( ) < > # * _ ~` must be
     backslash-escaped in plain text, or LinkedIn cuts the text at the first unescaped one. Taxscan headlines contain
     `[Read Order]` and `(2)`. The hashtags themselves must still render as hashtags. Check LinkedIn's current docs for
     the hashtag form (plain `#Tag` vs `{hashtag|\#|Tag}`), and note what you used in the REPORT.
4. **Hashtags: per-article, from the CMS's own editorial data** (owner 2 Nov: "I don't want to end up using only common
   repeated hashtags"). One pure function (unit-tested) + one fetch.
   - **Source:** the public CMS article API `GET https://api.taxscan.in/api/v1/articles/<slug>` (slug = last URL path
     segment; no auth; the site itself uses it). Read `keywords` (editor-set phrases, e.g. `ITAT Panaji`, `NFAC`,
     `Land Acquisition Act`, `Section 270A`), `courts[]` (`name`, `shortName`, e.g. `ITAT`, `SC`, `TELANGAN-HC`) and
     `category_name`. The fetch runs in the worker just before posting: 5 s timeout, one attempt, response capped at
     2 MB, host must be `api.taxscan.in`. **Fail-open:** if it fails, use the fallback below and log `hashtags=fallback`.
     Never block or delay the post for it.
   - **Order and limits (max 6, each unique, case-insensitive):**
     1. **Court:** `courts[0]`. `SC` → `#SupremeCourt`. A clean acronym shortName (`^[A-Z]{2,8}$`, e.g. ITAT, CESTAT,
        ICAI, NCLAT, GSTAT) → `#<shortName>`. Otherwise CamelCase of `name` (e.g. `Telangana High Court` →
        `#TelanganaHighCourt`). **Prefer a bench keyword** when one starts with the acronym (`ITAT Panaji` →
        `#ITATPanaji`).
     2. **Category:** `category_name` → CamelCase (`Income Tax` → `#IncomeTax`, `GST` → `#GST`). Skip `Other Taxations`.
     3. **Up to 3 editorial keywords, in the editor's order**, after these rules:
        - A **section phrase** (`Section 270A`, `Section 57(iv) of the Income Tax Act`, `Section 69 CGST Act`) →
          `#Section<number+letters>`, plus the act's acronym when the phrase names CGST/IGST/SGST/FEMA/PMLA/IBC/CGST
          (e.g. `#Section69CGST`, `#Section270A`, `#Section57`).
        - Otherwise keep a keyword only if it is ≤ 3 words and ≤ 24 characters once CamelCased (drops long SEO phrases
          like `ICAI disciplinary action against auditor`).
        - Skip a keyword that repeats the court or category, and a short stop-list of generic ones (`Income Tax Act`,
          `Interest`, `Assessing Officer`, `Tax`, `Order`, `Judgment`, `Result Date`, `Disciplinary action`, `Latest
          Judgments`; keep the list in one constant, easy to extend).
        - Acronyms stay upper case (GST, ITC, NFAC, ICAI, DGGI, CBDT, CBIC, TDS, TCS, AO …); CamelCase otherwise;
          letters and digits only.
     4. **`#taxscan`** last, always. No `#TaxNews` or other fixed tags.
   - **Fallback (CMS unavailable or no keywords):** court from `Campaign.authority`, category from `Campaign.categories`,
     plus `#taxscan`.
   - Examples from real 2 Nov articles (use them as fixtures):
     - ITAT Panaji, Land Acquisition interest → `#ITATPanaji #IncomeTax #NFAC #LandAcquisitionAct #Section57 #taxscan`
     - ICAI revaluation reserve → `#ICAI #CashFlowStatement #CharteredAccountant #RevaluationReserve #taxscan`
       (`ICAI` keyword deduped against the court, `Institute of Chartered Accountants of India` too long)
     - Telangana HC GST arrest → `#TelanganaHighCourt #GST #GSTArrest #Section69CGST #DGGIInvestigation #taxscan`
5. **UTMs (owner: required):** `utm_source=taxscan-linkedin`, `utm_medium=social`, `utm_campaign=linkedin-<page>`
   (`linkedin-taxscan` now; later `linkedin-shopscan`, `linkedin-academy`), and `utm_content=` the id, else the slug
   (same rule as WhatsApp). SET, never duplicate. The final URL passes `isAllowedPushUrl`. Put the constants beside the
   WhatsApp ones in one shared helper, so both channels build links the same way.
6. **Pages, keyed for later:** `LinkedInPost.page` = 'taxscan'. The page config comes from env per page:
   `LINKEDIN_TAXSCAN_ORG_URN`, `LINKEDIN_TAXSCAN_ACCESS_TOKEN`. Campaign portal 'taxscan' → page 'taxscan'; nothing else
   is mapped yet. Adding Shopscan/Academy later = new env + a mapping entry, no schema change.
7. **Migration (additive, one):** table `LinkedInPost` (`id`, `page`, `articleKey`, `campaignId`, `status` enum
   PENDING/POSTED/FAILED/SKIPPED, `linkedinPostId?`, `error?` (≤ 240 chars, never the token or the request body),
   `attempts`, `nextAttemptAt?`, `postedAt?`, `createdAt`, `updatedAt`), unique (`page`, `articleKey`).
8. **Screen `LinkedIn`** (PUSH menu, after WhatsApp; ADMIN + PUBLISHER; hidden when the flag is off, via the
   `features` field on `/api/auth/me` that WhatsApp added):
   - Day picker like WhatsApp. Rows in push order: pushed time, headline, status (Waiting / Posted, with a link to the
     LinkedIn post (`https://www.linkedin.com/feed/update/<post id>/`) / Failed + reason / Skipped).
   - On a Failed row: **Retry** (ADMIN + PUBLISHER, confirm "Post to LinkedIn now?") and **Skip**. Note: Retry on an
     "unknown — check the page" row needs the confirm text "Check the LinkedIn page first — it may already be posted."
   - The amber login banner when the page's token is rejected.
   - Phones: `class="stack"` cards.
9. **Flags/env:** `LINKEDIN_POSTING_ENABLED` (default off), `LINKEDIN_POST_FROM` (ISO time; **required** when enabled,
   or the worker refuses to start and logs why; nothing pushed before it is ever posted), `LINKEDIN_API_VERSION`
   (default `202603`), and the two per-page vars. `.env.example` entries.
10. **Logging:** one line per attempt `[linkedin] page=taxscan campaign=… outcome=posted|retry|failed|auth_stop`. Every
    error goes through `safeErrorLog`. The token never appears in a log, an error column or a response.
11. **Docs:** admin guide section "LinkedIn page" (what posts, when, status meanings, Retry/Skip, the banner) + version
    bump. `docs/BACKUPS.md`: `LinkedInPost` is NOT in the backup, and **after a restore keep `LINKEDIN_POSTING_ENABLED`
    off and set `LINKEDIN_POST_FROM` to the restore time before switching it on** (else recent articles post twice).
    The design note + switch-over steps go in `docs/LINKEDIN_POSTING.md` (below).

**Out (do not build):**
- Shopscan / Academy pages (only the keyed design).
- Any change to the push send path, pacer, Compose or the WhatsApp screen beyond sharing the UTM helper.
- Images/uploads to LinkedIn (the article card comes from the link), editing or deleting posts, comments, analytics
  pulls from LinkedIn.
- Scraping article pages or keyword extraction (the old script's approach: since the CMS move it picks the site's
  menu — `#FinanceAndEconomicOffences #Budget #SignIn`, author names — on nearly every post).
- Token refresh / OAuth flow in the app (the token is set by the owner in Railway). Only the alert.
- Changes to the `taxscan-automation` repo (the switch-over step is the owner's, see below).

## Acceptance tests
Each one must PASS in the REPORT.
1. Commentary for the headline `CBDT Sets Cost Inflation Index at 384 for FY 2026-27 [Read Notification]` with
   authority/category is the expected exact string, with the reserved characters escaped and the hashtags well-formed.
2. Hashtags: the three examples above come out exactly as written, from recorded CMS API fixtures. Max 6, no duplicates,
   letters and digits only. A CMS timeout/404/500 → the fallback, and the post still goes out. No `#TaxNews` anywhere.
3. UTM link: exactly one each of `utm_source=taxscan-linkedin`, `utm_medium=social`, `utm_campaign=linkedin-taxscan`,
   `utm_content=<id|slug>`, for both URL shapes. Other params survive.
4. Worker (LinkedIn HTTP mocked): it posts SENT taxscan articles after `LINKEDIN_POST_FROM` in `lastSentAt` order, at
   most 3 per tick. It never posts one from before `LINKEDIN_POST_FROM`, an academy/shop link, or a second push of the
   same article.
5. Crash safety: a PENDING row older than 10 min becomes FAILED "unknown" and is not re-posted. Two overlapping ticks
   never post the same article (the unique row is created first).
6. 429 → retries at +1/+5/+15 then FAILED. A retry due inside quiet hours waits until 07:00 IST. 401 → `auth_stop`, no
   further calls that day until a token change/restart, one alert email per IST day, banner data on the API.
7. The token is never in logs, the `error` column or any API response (a test greps captured logs + rows).
8. Flag off → no cron started, menu hidden, API 404. Flag on without `LINKEDIN_POST_FROM` → refuses to start, with a log line.
9. Screen (ui-developer, real browser, desktop + 375 px): statuses render, Retry/Skip work with confirms, the banner shows.
10. `tsc`, lint, the new tests, the WhatsApp tests (shared UTM helper) and the full suite pass. Migration applies cleanly.

## Files
- `prisma/schema.prisma` + one migration `2026110x…_linkedin_post`.
- `src/services/linkedin/` (`client.ts`, `post.ts` for commentary/hashtags/link, `worker.ts`), `src/routes/linkedin.ts`,
  a shared UTM helper (e.g. `src/services/social/utm.ts`, used by WhatsApp too).
- `src/lib/env.ts`, `.env.example`, `src/app.ts` / server start (cron).
- `admin/src/views/LinkedIn.vue`, NavBar, router, guide section.
- `docs/LINKEDIN_POSTING.md` (new), `docs/BACKUPS.md`.
- Tests: `src/__tests__/linkedin*.test.ts`.

## Constraints
- Flag: `LINKEDIN_POSTING_ENABLED`, default off.
- Migrations: additive only.
- Full suite: yes — new migration, env, a new cron.
- The request path never calls LinkedIn; only the worker and a Retry do, and a Retry runs one post, then answers.
- No new npm dependency (use `fetch`).

## Context the builder needs
- The CMS article API is public and read-only. Use plain `fetch`, no auth header, and never send any of our secrets
  to it.
- The current LinkedIn poster, for reference only: `fayaztaxscan/taxscan-automation`, `main.py` `post_to_linkedin()`
  (same endpoint, payload and headers). It posts headline + hashtags with an article card, and doesn't escape the
  commentary.
- "Recently pushed" must read `Campaign.lastSentAt`, never `Event` (memory rule).
- Current taxscan.in article URLs have **no trailing id** (`/<section>/<slug>`). `articleKey()` falls back to the URL.
- Internal alert mail: see how the digest/report alerts send to ADMIN users (`src/services/digest/alerts.ts`).

## Switch-over (owner, after deploy; goes in docs/LINKEDIN_POSTING.md)
1. Set `LINKEDIN_TAXSCAN_ORG_URN` + `LINKEDIN_TAXSCAN_ACCESS_TOKEN` in Railway (same values as the automation repo's
   GitHub secrets, or a fresh token).
2. In the same sitting: set `sheet_to_linkedin` `"enabled": false` in `taxscan-automation/config.json` and push, set
   `LINKEDIN_POST_FROM` to the current time (UTC ISO), then `LINKEDIN_POSTING_ENABLED=true`.
3. Watch the first `[linkedin] … outcome=posted` line and the post on the page.

---

## Follow-up 1 (owner, 2 Nov): manually composed pushes go to LinkedIn too, but test sends never do

> Owner: "even the manually composed one should go to linked like it goes for push notification."

**In:**
1. Make it explicit (code comment + test): the worker selects by `status = SENT` + `portal` + article URL, **whoever
   sent it**. So Compose "Send now", a scheduled Compose send (run later by the sweeper), Queue/Review "Push now" and
   Breaking all post, exactly like the pacer's sends. Don't filter on `createdByUserId`, `sendQueue` or Breaking.
2. **Exclude test sends.** A campaign whose `target` is ONLY the test-segment topic (`env.testSegmentTopic`, used by
   ADMIN `/api/admin/subscribers/:id/test-segment`) must never post to LinkedIn. "Test on this device" creates no
   Campaign, so nothing to do there. Apply the same exclusion to the WhatsApp queue (`getQueue` / `markArticle`) with
   one shared predicate, e.g. `isPublicArticleCampaign()` in `src/services/social/`.
3. Compose sends to a non-article taxscan.in URL (home page, a section page) or to academy/shop stay excluded, as before.

**Acceptance tests:**
H1. Seeded SENT campaigns: (a) pacer send, (b) Compose send with `createdByUserId`, target All, (c) Compose send to a
    topic, (d) a scheduled Compose send marked SENT by the sweeper → all four post, in `lastSentAt` order.
H2. A SENT Compose campaign targeted only at the test-segment topic → not posted, and not on the WhatsApp list.
H3. The WhatsApp tests still pass with the shared predicate.
