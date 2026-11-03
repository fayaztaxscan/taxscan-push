# Brief: Facebook page posting (facebook.com/taxscan)

- **Date / name:** 2026-11-03-facebook-page-posting  →  branch `build/facebook-page-posting`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first). Backend → backend-developer; the SOCIAL → Facebook
  screen + Campaigns mark → ui-developer (one subagent at a time).

## Goal
Every taxscan.in article the push system sends is posted automatically, about a minute later, to the **Taxscan Facebook
page**: headline + a few hashtags as the message, and the article as Facebook's own link card (Facebook reads the
article's og:title / og:image itself). One post per article, in push order, behind a flag that defaults off. Same rule,
same shape, same screens as the LinkedIn posting built on 2 Nov — **without changing LinkedIn's behaviour**.

## Why (owner's words)
> 3 Nov 2026: "Yesterday we automated posting to taxscan linkedin page, let us do the same for
> https://www.facebook.com/taxscan". Owner chose "our own Meta app" (option 3) with precautions, then "go".

**Account-safety context (important for the design):** the owner's earlier attempt with a *newly created* Facebook account
got that account banned. This time the app is made by the owner's long-standing page-admin account. The code must help
keep the page in good standing: never burst, stop at once if Meta signals a policy block, and never retry into a block.

## Scope
**In:**
1. **Module `src/services/facebook/`** mirroring `src/services/linkedin/` (client, pages, post, worker), reusing:
   - `isPublicArticleCampaign()` (`src/services/social/publicCampaign.ts`) — the same "what posts" rule (SENT, mapped
     portal, taxscan.in article URL either shape, not test-segment-only, whoever sent it).
   - `articleKey()` — one post per article; re-pushes and backfill clones never post again.
   - the UTM helper `src/services/social/utm.ts` — `utm_source=taxscan-facebook`, `utm_medium=social`,
     `utm_campaign=facebook-taxscan`, `utm_content=<id|slug>`; final URL must pass `isAllowedPushUrl`.
   - the CMS article fetch + hashtag builder from `src/services/linkedin/post.ts` (`fetchCmsArticle`, `hashtagsFor`,
     `slugOf`, …). If you move them into `src/services/social/`, keep LinkedIn importing them unchanged in behaviour
     (its tests must pass untouched apart from import paths). Fail-open exactly as LinkedIn: CMS down → fallback tags,
     never delayed or blocked.
2. **The post:** `POST https://graph.facebook.com/<FACEBOOK_GRAPH_VERSION>/<page-id>/feed`, form-encoded `message`,
   `link`, `access_token` **in the body, never in the URL** (URLs end up in logs). Default version `v25.0`.
   - `message` = the headline, a blank line, then **at most 4 hashtags** as plain `#Tag` text (`#taxscan` last). No
     LinkedIn little-text escaping. No link inside the message (the `link` field makes the card).
   - Post id = the answer's `id` (`<pageid>_<postid>`); the screen links `https://www.facebook.com/<id>`.
   - No image upload — Facebook scrapes the link (planning checked 3 Nov: taxscan.in serves og:title / og:description /
     og:image to `facebookexternalhit`).
3. **Table `FacebookPost`** (additive migration), same columns and rules as `LinkedInPost`: `page`, `articleKey`,
   `campaignId`, `status` (PENDING/POSTED/FAILED/SKIPPED), `facebookPostId`, `error` (≤ 240 chars, never the token or the
   body), `attempts`, `nextAttemptAt`, `postedAt`; unique (`page`, `articleKey`). Row created BEFORE the call. **Not in
   the R2 backup** (same as `LinkedInPost`/`WhatsAppPost`).
4. **Worker** (1-minute `node-cron` tick, started only when `FACEBOOK_POSTING_ENABLED=true` AND `FACEBOOK_POST_FROM` AND
   the page id + token are valid; else `[facebook] refusing to start: …`):
   - Oldest push first, campaigns with `lastSentAt ≥ FACEBOOK_POST_FROM` and within 24 h.
   - **Pacing for account safety: at most 1 post per tick, and at least `FACEBOOK_MIN_GAP_MINUTES` (default 10) between
     two posts on the page**, so a burst of pushes (backfill, Breaking) spreads out. **Daily cap `FACEBOOK_DAILY_CAP`
     (default 30) per IST day**; over the cap → the rest wait until the next day (then the 24 h window decides).
   - Stale in-flight row > 10 min → FAILED "unknown — check the page", never re-posted automatically.
   - Error handling by Graph's `error.code` (and HTTP status):
     - **Auth stop** — code `190` (invalid/expired token), `10` / `200`–`299` (permission), HTTP 401/403: stop posting for
       the page until the token changes in Railway or the app restarts; one alert email per IST day to active ADMINs;
       amber banner on the screen (LinkedIn's `loginProblem` pattern).
     - **Policy stop (new, account safety)** — code `368` ("temporarily blocked for policy violations"), or any answer whose
       `error_subcode`/`type` says spam/blocked/restricted, or `error_user_title` present on a 4xx that isn't one of the
       above: **stop posting for the page and do NOT auto-resume, even on restart**: persist the stop (a small row or a
       field — your choice, additive), email ADMINs at once, red banner "Facebook blocked a post — check the page before
       resuming". Only an ADMIN pressing **Resume** on the screen (audited) clears it. Retry is refused while stopped.
     - **Rate limit** — code `4`, `17`, `32`, `613`, HTTP 429: retry at +15 min, +60 min, then FAILED (slower than
       LinkedIn's +1/+5/+15 on purpose). Retries never fall in quiet hours (23:00–07:00 IST → wait to 07:00).
     - **Transient** — 5xx, network, timeout, code `1` / `2`: retry +1/+5/+15, then FAILED.
     - **Duplicate** — code `506`: FAILED "Facebook says this was already posted", no retry.
     - Other 4xx: FAILED at once.
   - Log line: `[facebook] page=taxscan campaign=… outcome=posted|retry|failed|auth_stop|policy_stop hashtags=cms|fallback`.
5. **Connection check (ADMIN):** a "Check connection" button on the screen → `GET /<version>/<page-id>?fields=name`
   with the token (header `Authorization: Bearer`, not the URL) → shows "Connected to page: <name>" or the error class.
   Makes no post. Lets the owner verify the token before switching on.
6. **API** `src/routes/facebook.ts` like `routes/linkedin.ts`: list by IST day (14 days back), Retry, Skip, Check
   connection (ADMIN), Resume after policy stop (ADMIN, audited). Flag off → 404 and menu hidden;
   `features.facebookPosting` in `/api/auth/me`.
7. **Admin SPA:** SOCIAL → **Facebook** screen (copy `admin/src/views/LinkedIn.vue`'s layout: today's posts, status,
   links to the post, Retry/Skip, the banners, Check connection, Resume); Campaigns **Channels** column gets a Facebook
   mark like LinkedIn's. Phone layout per app.css `stack` rules.
8. **Docs:** `docs/FACEBOOK_POSTING.md` (what posts, pacing, error classes, flags table, switch-on steps) + admin guide
   section (bump minor version) + `.env.example` lines.

**Out (do not build):**
- Token renewal machinery — a Page token made from a long-lived user token does not expire on a timer. (If the owner
  later uses a system-user token, it's the same env variable.)
- Image upload, video, Instagram, Shopscan/Academy pages (keyed for later: `PORTAL_TO_PAGE` like LinkedIn).
- Any change to LinkedIn's behaviour, WhatsApp, or the push send path.
- Any login/OAuth flow in our app — the token is pasted into Railway.

## Acceptance tests
Each one must PASS in the REPORT. All Graph calls against a fake fetch — **no real Facebook call in any test**.
1. What posts: SENT taxscan article (both URL shapes) posts once; test-segment-only, home/section/academy/shop URLs,
   before `FACEBOOK_POST_FROM`, older than 24 h → never; a re-push / backfill clone of the same article → no second row.
2. Request shape: form body has `message`, `link`, `access_token`; the URL has no token; version from env; message =
   headline + blank line + ≤ 4 plain hashtags ending `#taxscan`; link carries the four Facebook UTMs and passes the allowlist.
3. Pacing: 5 campaigns pushed at once → 1 per tick and ≥ `FACEBOOK_MIN_GAP_MINUTES` apart; the 31st of an IST day waits.
4. Errors: 190 → auth stop + one email per day + banner; 368 → policy stop that **survives a restart** and is cleared only
   by ADMIN Resume (audited); Retry refused while stopped; 4/17/32/613/429 → +15/+60 then FAILED; 5xx/network → +1/+5/+15;
   506 → FAILED no retry; quiet-hours deferral of retries; stale row → FAILED unknown, not re-posted.
5. The token never appears in a log line, an `error` column, an API response or an email (source-scan + runtime checks,
   like LinkedIn's).
6. Flag off: no cron, `/api/facebook/*` 404, menu hidden, `features.facebookPosting=false`. Refusing-to-start cases logged.
7. Check connection: fake 200 `{name}` → "Connected to page: …"; 190 → auth class; makes no `/feed` call; ADMIN only.
8. LinkedIn tests pass unchanged (apart from import paths if helpers moved).
9. UI: Facebook screen + Campaigns mark checked in a real browser at desktop AND 375 px (ui-developer).

## Files
- New: `src/services/facebook/{client,pages,post,worker}.ts`, `src/routes/facebook.ts`, `admin/src/views/Facebook.vue`,
  `docs/FACEBOOK_POSTING.md`, migration `<ts>_facebook_post`, tests `src/__tests__/facebook*.test.ts`.
- Changed: `prisma/schema.prisma`, `src/config/env` (flags below), `src/index.ts` (start worker), `src/routes/auth.ts`
  (features), Campaigns list API + `admin/src/views/Campaigns.vue` (mark), `admin/src/router.ts`, `NavBar.vue` (SOCIAL),
  maybe `src/services/social/*` (moved helpers), admin guide, `.env.example`.

## Constraints
- Flag: `FACEBOOK_POSTING_ENABLED` default off; `FACEBOOK_POST_FROM` required when on.
- Env: `FACEBOOK_TAXSCAN_PAGE_ID`, `FACEBOOK_TAXSCAN_PAGE_TOKEN`, `FACEBOOK_GRAPH_VERSION` (default `v25.0`),
  `FACEBOOK_MIN_GAP_MINUTES` (10), `FACEBOOK_DAILY_CAP` (30).
- Migrations: additive only (`FacebookPost` + the persisted policy stop).
- Full suite: **yes** — touches the Prisma schema and config/env.
- Never put the token in a URL, log, error column, response or email (`safeErrorLog`, a `safeError`-style redaction).
- The request path never calls Facebook, except Retry (one post) and Check connection (one GET).

## Context the builder needs
- Copy the LinkedIn design end to end: `docs/LINKEDIN_POSTING.md`, briefs `2026-11-02-linkedin-page-posting.md` (+
  REPORT), worker `src/services/linkedin/worker.ts`, route `src/routes/linkedin.ts`, screen `admin/src/views/LinkedIn.vue`,
  Campaigns marks (`Campaigns.vue` ~line 167).
- Graph error JSON: `{"error":{"message","type","code","error_subcode","error_user_title","error_user_msg","fbtrace_id"}}`.
  Store at most code + subcode + a trimmed message.
- The old `taxscan-automation` repo has an unused `post_to_facebook_page` (v25.0 `/feed`) — it never ran (owner); don't
  rely on it, don't edit that repo.
- Switch-on (owner, after deploy; record in the doc): owner creates the Meta app from the long-standing admin account
  (planning sends the steps) → Railway: page id + token → ADMIN "Check connection" → set `FACEBOOK_POST_FROM` = now and
  `FACEBOOK_POSTING_ENABLED=true` → watch the first `outcome=posted` and check the post shows in a logged-out browser.
