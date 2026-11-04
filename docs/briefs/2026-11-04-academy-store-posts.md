# Brief: LinkedIn Academy page: also post course and shop pushes

- **Date / name:** 2026-11-04-academy-store-posts  →  branch `build/academy-store-posts`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first). UI parts go to **ui-developer**.

## Goal
A push whose link is an academy.taxscan.in course or a shop.taxscan.in product also posts to the Taxscan Academy LinkedIn page, using the push's own wording and the page's share picture. Only the Academy page changes.

## Why (owner's words)
> Asked whether course pushes should post to the Academy page: "go with recommendation." Then: "not only course links, links from shop.taxscan.in also." (4 Nov 2026)

Planning's reading: shop pushes go to the Academy page too, not the Taxscan page and not the separate Shopscan LinkedIn page.

## Scope
**In:**
- **What qualifies (new rule, new name, e.g. `isStorePromoCampaign()` in `src/services/social/`):** a SENT campaign of portal `taxscan` whose URL is `https://academy.taxscan.in/course/<slug>` or `https://shop.taxscan.in/products/<slug>`, on `ALLOWED_PUSH_HOSTS`, and not test-segment-only (reuse `isTestSegmentOnly`). A home, collection or other page does not qualify. `lastSentAt` must be set (`[system] shop URL check` rows have none).
- **`isPublicArticleCampaign()` is NOT changed:** Taxscan LinkedIn, Facebook and the WhatsApp queue stay exactly as they are.
- **Switch:** new `LINKEDIN_ACADEMY_STORE_POST_FROM`, validated like `LINKEDIN_ACADEMY_POST_FROM` (strict ISO). Unset or invalid = no store posts, with one boot line saying so. Needs the Academy page active. Nothing pushed before it posts, at any age; no age limit after it.
- **One post per wording:** these links are re-pushed often with new wording (see Context). The row key is the link without its query string plus a hash of the normalised title, in the key namespace `store:`. New wording on the same link posts again; the same wording never does. Store it in `LinkedInPost.articleKey` (page `academy`); unique `(page, articleKey)` still prevents a double post.
- **The post:**
  - Commentary: the push title, a blank line, the push body (whitespace kept to single line breaks), a blank line, the hashtag `#taxscan`. Use the existing little-text escaping; emoji must survive it. Keep within LinkedIn's length limit, cutting the body and never the title.
  - Link: `withLinkedInUtm(url, 'academy', <slug>)`, which replaces the push's own UTMs. Result: `utm_source=taxscan-linkedin`, `utm_medium=social`, `utm_campaign=linkedin-academy`, `utm_content=<slug>`.
  - Card title and description: the page's `og:title` + `og:description`, falling back to the push title + body.
  - Picture: fetch the page, read only the start of it (see `src/services/digest/articleImage.ts`), prefer `og:image:secure_url` then `og:image` (https only). Fail-open: no picture still posts, logged as `image=none:<reason>`. Add `academy.taxscan.in` and `shop.taxscan.in` to the LinkedIn image hosts. Redirects stay refused.
- **Worker:** store campaigns join the Academy page's candidates, merged by `lastSentAt`, oldest first. Same budget (`MAX_PER_TICK`, Taxscan first), retries, stale handling and per-page stop.
- **Screen:** `page=academy` lists these rows with articles, so Retry and Skip work. WAITING and NOT_POSTED use the store go-live for store rows. The Taxscan page's rows are unchanged.
- **Docs:** `docs/LINKEDIN_POSTING.md` (What posts, env, logs), `.env.example`, admin guide LinkedIn section + version bump, `docs/BACKUPS.md` restore step gains the new variable.

**Out (do not build):**
- Store posts on the Taxscan LinkedIn page, Facebook or WhatsApp. A Shopscan LinkedIn page.
- CMS hashtags for store posts. Editing post text on the screen.
- Campaigns Channels marks for store posts (they stay as they are).

## Acceptance tests
Each one must PASS in the REPORT. LinkedIn and page fetches mocked.
1. Variable unset or invalid: no store row, no store fetch, ticks as today.
2. Set: a course push and a product push each make one `academy` row and one post call under Academy's org URN, and no `taxscan` row.
3. A non-course academy page, a shop collection, the shop home, a test-segment-only push and a push before the go-live make no row.
4. Same link + same wording pushed again: no row, no insert attempted. Same link + new wording: a second post. Same wording with a different link: its own post. Whitespace-only title differences count as the same wording.
5. The link carries exactly one set of UTMs, the LinkedIn ones; the push's `utm_*` are gone.
6. Commentary: title, body, `#taxscan`, with emoji, parentheses, `#`, `@` and line breaks correctly escaped (use real titles from Context). An over-long body is cut and the title kept.
7. Picture: `secure_url` preferred; `og:image` over http is ignored; off-allowlist host, redirect, timeout, 404 or no tag posts without a picture and logs the reason. A page fetch failure never fails the post.
8. Taxscan article posting, Facebook, WhatsApp and Channels tests pass unchanged. Articles still post to both LinkedIn pages.
9. A 403 on Academy stops Academy's store posts and articles together; Taxscan is unaffected.
10. `MAX_PER_TICK` holds with articles and store posts waiting; oldest first across both kinds.
11. Screen: `?page=academy` shows store rows with correct WAITING / NOT_POSTED, Retry and Skip (real browser, phone and desktop).
12. A 429 on the image status poll still publishes the post with the picture attached unverified (left over from the Academy brief; add for articles too).

## Files
- `src/services/social/` (new rule), `src/services/linkedin/worker.ts`, `post.ts`, `image.ts`, `pages.ts`, `src/lib/env.ts`, `src/routes/linkedin.ts`
- `admin/src/views/LinkedIn.vue` only if a row needs it
- `docs/LINKEDIN_POSTING.md`, `docs/BACKUPS.md`, `docs/Taxscan-Push-Admin-Guide.html`, `.env.example`
- Tests: a new `src/__tests__/linkedinAcademyStore.test.ts`; existing files unchanged except test 12

## Constraints
- Flag: `LINKEDIN_ACADEMY_STORE_POST_FROM`, off by default.
- Migrations: none.
- Full suite: yes — touches config/env.
- Fetching a page happens in the worker only, never on the request path. Never log a token.
- Do not post, or call LinkedIn, from a test.

## Context the builder needs
- Production, last 60 days (read 4 Nov):

| Host / section | Pushes | Links | Distinct wordings |
|---|---|---|---|
| shop.taxscan.in/products | 105 | 23 | 67 |
| academy.taxscan.in/course | 76 | 10 | 64 |

  That is roughly 2 store posts a day on top of ~20 articles.
- Both sites serve og tags to a plain request. Course: `og:image` is https on academy.taxscan.in (`/wp-content/uploads/…`). Shop: `og:image` is **http**, `og:image:secure_url` is https, both `shop.taxscan.in/cdn/shop/files/…?v=…`.
- Real titles for tests: `🕵️‍♂️ Stop being "just an accountant." Become a Financial De…`, `🚨COURSE STARTS TOMORROW 7 PM 🚨`, `❗GSTAT E-FILING CONFUSION? FEARING DEFECT NOTICES? 💻`, `🚨MEGA AUDIT OFFER – 50% OFF + EXTRA 10% OFF!  ! Training on …`. Bodies can be several lines with `- ` bullets.
- `buildPost()` returns null for non-taxscan.in links today; store posts need their own builder rather than a loosened article rule.
- App quotas: Development tier, 100 calls per member per endpoint per day. Two extra posts a day are small.
