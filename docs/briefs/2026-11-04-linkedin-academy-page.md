# Brief: LinkedIn: also post to the Taxscan Academy page

- **Date / name:** 2026-11-04-linkedin-academy-page  →  branch `build/linkedin-academy-page`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first)
- **Order:** build AFTER `2026-11-04-social-no-age-limit` is merged to `develop`. Both change the same lines of the LinkedIn worker.

## Goal
Every article posted to the Taxscan LinkedIn page is also posted to the Taxscan Academy page (`urn:li:organization:91100022`), with
the same text, hashtags and picture, once the owner sets the Academy variables. Unset, production behaves exactly as today.

## Why (owner's words)
> "Let us start posting to https://www.linkedin.com/company/91100022/admin/dashboard/ also like taxscan linkedin page" (4 Nov 2026)

Planning's reading: the same taxscan.in articles as the Taxscan page, not academy.taxscan.in course pushes. The page already shows
taxscan.in articles. If the owner corrects this before the build, the shared-rule section changes.

## Scope
**In:**
- **One portal, several pages.** `PORTAL_TO_PAGE` maps a portal to one page today. Change it so portal `taxscan` maps to `taxscan` and, only
  when configured, `academy`. Update every reader: both workers' deps where relevant to LinkedIn, `src/routes/linkedin.ts`,
  `src/services/metrics.ts`. Facebook stays one page and is not changed.
- **Env (config):** `LINKEDIN_ACADEMY_ORG_URN` and `LINKEDIN_ACADEMY_POST_FROM`. The Academy page is active only when BOTH are valid. An unset or invalid
  pair means no Academy rows, no FAILED rows, no refusal to start, no log noise beyond one boot line saying it is off.
- **Own go-live time.** Academy uses `LINKEDIN_ACADEMY_POST_FROM` wherever Taxscan uses `LINKEDIN_POST_FROM`, including the `earlier` check: nothing
  pushed before it is posted to Academy, and a repeat of an article first pushed before it is not posted to Academy.
- **Shared token.** The Academy page uses the Taxscan page's token, the same member token with `w_organization_social`. No Academy token variables, no second
  `LinkedInToken` row, no second renewal: renewal runs once, for `taxscan`. The active-token cache resolves `academy` through `taxscan`.
- **Stops are per page.** A 401 / 403 on one page must not stop the other. Today `out.authStopped` makes the tick `continue` past later pages and `break` a page's
  loop: fix that so the flag no longer gates another page. A 403 on Academy alone (no role on that page) stops Academy only, with its own banner
  state and its own alert email, and Taxscan posts normally. `TickResult.authStopped` may stay as an "any page stopped" report.
- **Tick budget is fair.** `MAX_PER_TICK` stays. Taxscan goes first, and a busy Taxscan page only delays Academy to a later tick.
- **Per-page row:** `LinkedInPost` already has unique `(page, articleKey)`, so the two pages have independent rows, statuses, Retry and Skip.
- **Picture:** uploaded separately under each page's org URN (check `image.ts` takes the owner from the page config, not a constant).
- **UTMs:** unchanged helper, so Academy links carry `utm_campaign=linkedin-academy`. Hashtags unchanged, `#taxscan` last.
- **Screen (SOCIAL → LinkedIn, `ui-developer`):** a page switch (Taxscan / Academy), shown only when Academy is active. `GET /api/linkedin/posts?page=` validated against active pages,
  default `taxscan`. Rows, counts and the login banner follow the switch. Token status shows on both, and says it is the one shared token. Page wording no longer
  hard-codes "Taxscan" where the Academy page is showing.
- **Log line:** `[linkedin] page=academy …` (already keyed by page).
- **Docs:** `docs/LINKEDIN_POSTING.md` "Pages" + "Flags / env" (the "two env variables" line is now wrong); admin guide LinkedIn section; guide version bump; `.env.example` if it lists LinkedIn variables.

**Out (do not build):**
- Posting academy.taxscan.in or shop links. `isPublicArticleCampaign()` is not changed.
- A Channels mark per page on Campaigns: that column keeps meaning the Taxscan page (`PAGE_TAXSCAN`).
- Different text, hashtags or picture for Academy. A delay between the two pages. A Shopscan page.
- Any Facebook change.

## Acceptance tests
Each one must PASS in the REPORT. All LinkedIn calls are mocked.
1. Academy variables unset: a tick behaves exactly as today, with no Academy row and no startup problem. Same with only one of the two set, or an invalid time.
2. Academy active: one pushed article makes two rows and two post calls, one per org URN, with `linkedin-taxscan` and `linkedin-academy` links.
3. An article pushed after `LINKEDIN_POST_FROM` but before `LINKEDIN_ACADEMY_POST_FROM` posts to Taxscan only. Its repeat after the Academy time adds no Academy row.
4. A re-push adds no row on either page.
5. A 403 on Academy stops Academy only: Taxscan posts in the same tick and in later ticks. A 401 on Taxscan does not prevent Academy's attempt in that tick. One alert per page per IST day.
6. A rejected post or Skip / Retry on one page leaves the other page's row untouched.
7. `MAX_PER_TICK` holds across both pages, and a waiting Academy article posts on a later tick.
8. Renewal: one `LinkedInToken` row and one renewal with Academy active. After a renewal, both pages post with the new token on the next tick.
9. `GET /api/linkedin/posts?page=academy` returns Academy's rows when active; 400 for an unknown page or Academy when inactive. Default still `taxscan`.
10. The screen shows no switch when Academy is inactive, and the switch changes rows and the banner when active (real browser, phone and desktop shots).
11. Facebook tests pass unchanged. Campaigns Channels still reports the Taxscan page's status.
12. A 429 on the image status poll (the tightest daily quota, see Context) still publishes the post, with the picture attached unverified, and uses no retry loop.

## Files
- `src/lib/env.ts`, `src/services/linkedin/pages.ts`, `worker.ts`, `token.ts`, possibly `image.ts`
- `src/routes/linkedin.ts`, `src/services/metrics.ts`, `admin/src/views/LinkedIn.vue`
- `docs/LINKEDIN_POSTING.md`, `docs/Taxscan-Push-Admin-Guide.html`
- Tests: `src/__tests__/linkedinWorker.test.ts`, `linkedinToken.test.ts`, the LinkedIn route and Channels tests

## Constraints
- Flag: the two Academy variables are the switch, off by default. `LINKEDIN_POSTING_ENABLED` still governs everything.
- Migrations: none (`LinkedInPost.page` is a plain string).
- Full suite: yes — touches config/env.
- Docs that ship with it: the guide + `docs/LINKEDIN_POSTING.md`.
- Never log or return a token. Never call real LinkedIn from a test.

## Context the builder needs
- Org URN form: `urn:li:organization:91100022`. The owner is an admin of the page, and the current token was created by the owner, so no new sign-in is expected. The first real post proves it; a 403 is the signal that it does not.
- Trap memory: image URNs must be `encodeURIComponent`-encoded in REST paths (already fixed, keep it).
- App: `taxscan_post_app` is the only app to use. It has Community Management API on the **Development tier** (upgrade denied). The separate "Taxscan Academy" app has only Share on LinkedIn, which cannot post as a page: do not use it.
- Quotas seen in the portal on 4 Nov are per endpoint: 500 per app and 100 per member per 24 h. Two pages at ~21 posts a day make ~42 `posts-CREATE` and ~42 `images-ACTION`. `images-GET` is the tightest: observed 2 polls per post, so ~84 a day, and up to 4 polls per post is possible.
