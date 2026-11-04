# Brief: LinkedIn + Facebook: every push posts, like a notification

- **Date / name:** 2026-11-04-academy-store-posts  →  branch `build/academy-store-posts`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first). UI parts go to **ui-developer**.
- **If a build already started from an earlier version of this brief:** this version replaces it. Its rule "one post per link + wording" and its `*_STORE_POST_FROM` variables are gone.

## Goal
From a time set per page, the Taxscan LinkedIn page, the Taxscan Academy LinkedIn page and the Taxscan Facebook page post **every push**: taxscan.in articles, academy.taxscan.in courses and shop.taxscan.in products, one post per push, repeats included. Unset, each page behaves exactly as today.

## Why (owner's words)
> "not only course links, links from shop.taxscan.in also." / "both should get posted in linkedin and facebook pages as well." / "You do not have to filter even if it duplicate." / "This will be the same in case of facebook or linked or any other social pages when we add in future. Just follow it as we follow in push notification." Asked whether an identical repeat posts again, with the morning backfill as the example: "Option B" = every push posts. (4 Nov 2026)

## Scope
**In:**
- **Switches, one per page:** `LINKEDIN_TAXSCAN_ALL_PUSHES_FROM`, `LINKEDIN_ACADEMY_ALL_PUSHES_FROM`, `FACEBOOK_ALL_PUSHES_FROM`, strict ISO as `LINKEDIN_ACADEMY_POST_FROM`. Unset or invalid = that page stays on today's rule, with one boot line saying so. The Academy one needs the Academy page active.
- **Why a time is essential:** today's rows are keyed by article, and past repeats and course or shop pushes have no row. Without the time, the release would post all of them. A push with `lastSentAt` before the page's time follows today's rule, forever. A push at or after it follows the new rule. Nothing older ever becomes eligible.
- **What qualifies under the new rule:** a SENT campaign of portal `taxscan` with `lastSentAt` set, not test-segment-only (`isTestSegmentOnly`), on `ALLOWED_PUSH_HOSTS`, whose URL is a taxscan.in article (`articleContentOf`), `https://academy.taxscan.in/course/<slug>` or `https://shop.taxscan.in/products/<slug>`. A home, section, collection or other page does not qualify. Add this as a new rule in `src/services/social/`; `isPublicArticleCampaign()` is NOT changed, because the WhatsApp queue uses it and stays exactly as it is.
- **One post per push:** the row key is `push:<campaignId>:<lastSentAt ms>`, in `LinkedInPost.articleKey` / `FacebookPost.articleKey`, so a resend of the same campaign row posts again and unique `(page, articleKey)` still stops two ticks posting the same push. Under the new rule the `earlier` look-back and the "first push of the article" logic do not apply.
- **Article posts:** text, hashtags and picture exactly as today, from the existing builders.
- **Course and product posts on LinkedIn:**
  - Commentary: the push title, a blank line, the push body (single line breaks), a blank line, `#taxscan`. Use the existing little-text escaping; emoji must survive it. Keep within LinkedIn's length limit, cutting the body and never the title.
  - Link: `withLinkedInUtm(url, <page>, <slug>)`, replacing the push's own UTMs.
  - Card title + description: the page's `og:title` + `og:description`, falling back to the push title + body.
  - Picture: fetch the page, read only the start (see `src/services/digest/articleImage.ts`), prefer `og:image:secure_url` then `og:image`, https only. Fail-open: no picture still posts, logged `image=none:<reason>`. Add `academy.taxscan.in` and `shop.taxscan.in` to the LinkedIn image hosts. Redirects stay refused.
- **Course and product posts on Facebook:** message = push title, a blank line, push body, a blank line, `#taxscan`; `link` = the URL with the Facebook UTMs (`taxscan-facebook / social / facebook-taxscan / <slug>`). Facebook builds the card from the og tags.
- **An identical repeat that the platform refuses:** LinkedIn's duplicate answer (422 `DUPLICATE_POST`; confirm the shape from their docs) and Facebook's 506 become FAILED with a plain reason ("LinkedIn says this was already posted"). No retry, no login stop, no policy stop, no alert. The LinkedIn repeat-without-picture path must not hide this reason.
- **Workers:** old-rule and new-rule candidates merge by `lastSentAt`, oldest first. LinkedIn keeps `MAX_PER_TICK` (Taxscan first), retries, stale handling and per-page stops. Facebook keeps one post per tick, the 10-minute gap, the 30-a-day cap, retries, the auth stop and the policy stop. No new caps.
- **Screens:** SOCIAL → LinkedIn (both pages) and SOCIAL → Facebook list one row per push under the new rule, so a repeat shows as its own row with Retry and Skip. WAITING and NOT_POSTED follow the rule that applies to that push.
- **Campaigns Channels:** a push under the new rule shows the status of its own row for the Taxscan LinkedIn page and Facebook, through the same batched queries. With the switches off the output is byte-identical to today.
- **Docs:** `docs/LINKEDIN_POSTING.md` + `docs/FACEBOOK_POSTING.md` (What posts, env, logs), `.env.example`, admin guide LinkedIn + Facebook sections + version bump, `docs/BACKUPS.md` restore step gains the three variables (each set to the restore time).

**Out (do not build):**
- The WhatsApp queue. A Shopscan LinkedIn page. New pacing or caps.
- CMS hashtags for courses and products. Editing post text on the screen.
- Any detection of the team's manual posts: they continue, and never block an automatic post.
- A Channels mark for the Academy page.

## Acceptance tests
Each one must PASS in the REPORT. LinkedIn, Facebook and page fetches mocked.
1. All three variables unset or invalid: no new-rule row, no page fetch, ticks and screens exactly as today; every existing test passes unchanged.
2. Each switch alone affects only that page. All three set: one push makes one row and one post on each page, under the right org URN or page id.
3. **No flood at switch-on:** with past articles, past backfill clones, and past course and product pushes before the time, setting it creates no row for any of them. A pre-time article with no row still follows today's rule.
4. After the time: the same article pushed twice (a clone, a Compose resend, or the same campaign row sent again) posts twice. The same course with the same wording pushed twice posts twice. A morning backfill clone of an article already posted posts again.
5. An article first pushed before the time and repeated after it posts once for the repeat.
6. A non-course academy page, a shop collection, the shop home, the taxscan.in home or a section page, and a test-segment-only push make no row. Overlapping ticks never post the same push twice.
7. Each link carries exactly one set of UTMs, that channel's; the push's `utm_*` are gone.
8. Commentary: title, body, `#taxscan`, with emoji, parentheses, `#`, `@` and line breaks correctly escaped (real titles in Context). An over-long body is cut and the title kept.
9. Picture: `secure_url` preferred; an http `og:image` ignored; off-allowlist host, redirect, timeout, 404 or no tag posts without a picture and logs why. A page fetch failure never fails the post.
10. LinkedIn's duplicate answer and Facebook's 506 give FAILED with the plain reason, with no retry, no stop and no alert, and later pushes still post.
11. A 403 on Academy stops Academy only. A Facebook policy stop holds every kind of post until Resume. The gap, the daily cap, `MAX_PER_TICK` and oldest-first hold across all kinds; a capped Facebook post spills to the next day.
12. A 429 on the image status poll still publishes the post with the picture attached unverified (left over from the Academy brief).
13. Screens and Campaigns: one row per push, correct statuses, Retry and Skip (real browser, phone and desktop).
14. WhatsApp tests pass unchanged.

## Files
- `src/services/social/` (new rule), `src/services/linkedin/worker.ts`, `post.ts`, `client.ts`, `image.ts`, `pages.ts`, `src/services/facebook/worker.ts`, `post.ts`, `src/lib/env.ts`, `src/routes/linkedin.ts`, `src/routes/facebook.ts`, `src/services/metrics.ts`
- `admin/src/views/LinkedIn.vue`, `Facebook.vue`, Campaigns only if a row needs it
- `docs/LINKEDIN_POSTING.md`, `docs/FACEBOOK_POSTING.md`, `docs/BACKUPS.md`, `docs/Taxscan-Push-Admin-Guide.html`, `.env.example`
- Tests: a new `src/__tests__/socialAllPushes.test.ts`; existing files unchanged except test 12

## Constraints
- Flag: the three per-page variables, off by default.
- Migrations: none.
- Full suite: yes — touches config/env.
- Fetching a page happens in the worker only, never on the request path. Never log a token.
- Do not post, or call LinkedIn or Facebook, from a test.

## Context the builder needs
- Production, last 60 days (read 4 Nov):

| Host / section | Pushes | Links | Distinct wordings |
|---|---|---|---|
| shop.taxscan.in/products | 105 | 23 | 67 |
| academy.taxscan.in/course | 76 | 10 | 64 |

  That is ~3 course and product pushes a day on top of ~20 article pushes, so Facebook stays under its 30-a-day cap on a normal day.
- The morning backfill creates a new `Campaign` row with the same URL for an article pushed the day before.
- Both store sites serve og tags to a plain request. Course: `og:image` is https on academy.taxscan.in (`/wp-content/uploads/…`). Shop: `og:image` is **http**, `og:image:secure_url` is https, both `shop.taxscan.in/cdn/shop/files/…?v=…`.
- Real titles for tests: `🕵️‍♂️ Stop being "just an accountant." Become a Financial De…`, `🚨COURSE STARTS TOMORROW 7 PM 🚨`, `❗GSTAT E-FILING CONFUSION? FEARING DEFECT NOTICES? 💻`, `🚨MEGA AUDIT OFFER – 50% OFF + EXTRA 10% OFF!  ! Training on …`. Bodies can be several lines with `- ` bullets.
- `buildPost()` returns null for non-taxscan.in links today; courses and products need their own builder rather than a loosened article rule.
- App quotas: Development tier, 100 calls per member per endpoint per day. Today ~21 article posts on two pages is ~42 `posts-CREATE`; every push adds ~3 course and product posts plus backfill repeats per page, so ~60 a day is plausible. `images-GET` at 2 polls per post could reach ~120 and hit 100, which is why test 12 matters.
