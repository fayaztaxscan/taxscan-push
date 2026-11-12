# Brief: Facebook: also post to the Shopscan page

- **Date / name:** 2026-11-12-facebook-shopscan-page  →  branch `build/facebook-shopscan-page`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first)
- **Order:** build AFTER `build/audience-test-flake` is merged to `develop` (owner, 12 Nov: "go the recommended order").

## Goal
Every push that posts to the Taxscan Facebook page also posts to the **Shopscan** Facebook page (facebook.com/shopscan.in), with
the same text, hashtags and Compose picture, once the owner sets the Shopscan variables. Unset, production behaves exactly as today.

## Why (owner's words)
> "can we automate posting to https://www.facebook.com/shopscan.in" (12 Nov 2026), then "go with recommendation" for: every push,
> own pacing and stops, joins Compose Post-to, own UTM.

Standing rule (owner, 4 Nov, `feedback_social_follows_push`): every page posts EVERY push (articles, courses, shop products,
collections, site pages, exact repeats; no filtering). Shopscan is an every-push page from its own go-live. The LinkedIn Shopscan page
(brief `2026-11-09-linkedin-shopscan-page`) is the model.

## Scope
**In:**
- **A second Facebook page `shopscan`** (`src/services/facebook/pages.ts`, `src/lib/env.ts`). Variables:
  - `FACEBOOK_SHOPSCAN_PAGE_ID` — digits (same `PAGE_ID` rule)
  - `FACEBOOK_SHOPSCAN_PAGE_TOKEN` — Page access token (same `TOKEN` rule; Railway only)
  - `FACEBOOK_SHOPSCAN_POST_FROM` — strict ISO time (same rule as `FACEBOOK_POST_FROM`)
  Active only when ALL THREE are valid and `FACEBOOK_POSTING_ENABLED` is on. Otherwise Shopscan is simply off: no rows, no
  failures, and **the worker must NOT refuse to start** (today `startupProblem()` refuses when any page in `PORTAL_TO_PAGE` lacks
  config — Taxscan keeps that rule, Shopscan must not inherit it). ONE boot line saying why it is off (names, never values).
- **Shared page, not a portal page.** Today pages come from `PORTAL_TO_PAGE` (one page per portal). Shopscan must receive the
  `taxscan` portal's pushes as well, so add a "shared page" notion like LinkedIn's (`sharedPages` / `portalPages()` in
  `src/services/linkedin/pages.ts`): pages for a portal = Taxscan, then Shopscan when active. Every reader of the page list
  (`worker.ts`, `src/services/social/pages.ts` Compose Post-to, `src/services/social/pageStatus.ts` alerts/status,
  `src/routes/facebook.ts`) uses the same one function, so Shopscan appears everywhere at once and nowhere when inactive.
- **Every push from go-live.** Shopscan's every-push time IS its `FACEBOOK_SHOPSCAN_POST_FROM` (no separate `…_ALL_PUSHES_FROM`):
  same eligibility as Taxscan's every-push rule (`isAllPushesCampaign` + `SOCIAL_ANY_LINK_FROM`), one post per push, repeats
  included. Nothing pushed before its go-live is ever posted there, whatever `FACEBOOK_POST_FROM` says.
- **Pacing per page** (already per page in the tick — keep it): own `FACEBOOK_MIN_GAP_MINUTES` gap and `FACEBOOK_DAILY_CAP` cap
  counted on Shopscan's own rows. Order in a tick: Taxscan, then Shopscan, so a busy tick only delays Shopscan.
- **Stops per page** (already keyed by page — keep it): token stop and policy stop (code 368) on Shopscan stop Shopscan only, own
  alert, own banner, own ADMIN Resume. Pause/Resume and the held/failing alerts (PR #114) work for `facebook:shopscan`.
- **Picture:** Compose picture → `/photos` on Shopscan too, same one-fallback-to-`/feed` rule.
- **UTMs:** the existing helper → `utm_campaign=facebook-shopscan` (source/medium unchanged).
- **Compose Post-to:** "Facebook · Shopscan" appears when active (via the shared function); unticking it writes SKIPPED
  `compose_skip` for Shopscan only.
- **Screen (SOCIAL → Facebook, `ui-developer`):** a page switch Taxscan / Shopscan, shown only when Shopscan is active (copy the
  LinkedIn page switch); `GET /api/facebook/posts?page=shopscan` validated like LinkedIn's (400 when inactive/unknown; default
  `taxscan`). Check-connection works per page.
- **Docs:** `docs/FACEBOOK_POSTING.md` (Pages, Flags/env, switch-on), admin guide Facebook section + version bump,
  `.env.example` if it lists Facebook variables.

**Out (do not build):**
- A Facebook Academy page (later, same pattern, when the owner brings its token).
- Different text/hashtags per page; a delay between pages; a quota guard (Facebook has no shared per-member quota like LinkedIn's).
- A per-page Channels mark on Campaigns (the column keeps meaning the Taxscan page).
- Any change to Taxscan's posting, go-live times or rules. Token renewal machinery (page tokens from a long-lived user token don't expire).

## Acceptance tests
Each one must PASS in the REPORT. All Graph calls mocked.
1. Shopscan variables unset / one or two set / invalid id / invalid token / invalid time: the worker starts, a tick behaves exactly
   as today (Taxscan rows only), one boot line naming what is missing, never a value.
2. Active: one push makes two rows and two post calls, Taxscan then Shopscan, each with its own page id + token, Shopscan's link
   tagged `facebook-shopscan`.
3. Every push from go-live: a course push, a shop product push, a site-page push (with `SOCIAL_ANY_LINK_FROM` set) and an exact
   repeat each post on Shopscan; a push before `FACEBOOK_SHOPSCAN_POST_FROM` never does.
4. Pacing: a Taxscan post inside the gap does not hold Shopscan, and vice versa; each page's daily cap counts only its own rows.
5. A 190 / 401 / 403 on Shopscan stops Shopscan only; a 368 stops Shopscan only until an ADMIN Resume of `shopscan`; Taxscan posts
   in the same and later ticks; one alert per page per IST day.
6. Pause `facebook:shopscan` → Shopscan rows SKIPPED `page_paused`, Taxscan unaffected; Resume → next push posts.
7. Compose: Post-to lists "Facebook · Shopscan" only when active; unticking it → Shopscan SKIPPED `compose_skip`, Taxscan posts.
8. Compose picture: `/photos` on both pages; a 4xx on Shopscan's photo falls back to `/feed` on Shopscan only.
9. `GET /api/facebook/posts?page=shopscan` → its rows when active; 400 when inactive/unknown; default `taxscan`. Retry/Skip on a
   Shopscan row leaves Taxscan rows untouched.
10. Screen: no switch when inactive; with it active the switch changes rows + banner (real browser, phone + desktop shots).
11. Page status / alerts (`pageStatus.ts`) report `facebook:shopscan` on its own.
12. LinkedIn, Telegram, WhatsApp and Channels tests pass unchanged.

## Files
- `src/lib/env.ts`, `src/services/facebook/pages.ts`, `src/services/facebook/worker.ts`
- `src/services/social/pages.ts`, `src/services/social/pageStatus.ts`, `src/routes/facebook.ts`
- `admin/src/views/Facebook.vue` (or the Facebook screen's actual file)
- `docs/FACEBOOK_POSTING.md`, `docs/Taxscan-Push-Admin-Guide.html`, `.env.example`
- Tests: the Facebook worker / route / env tests + social pages / pageStatus tests

## Constraints
- Flag: the three Shopscan variables are the switch, off by default. `FACEBOOK_POSTING_ENABLED` still governs everything.
- Migrations: none (`FacebookPost.page` is a plain string).
- Full suite: yes — touches config/env.
- Never log, store or return a token; token only in the POST body / Authorization header (as today). Never call real Facebook from a test.
- Switch-on (planning, after release, on the owner's yes): owner sets `FACEBOOK_SHOPSCAN_PAGE_ID` and
  `FACEBOOK_SHOPSCAN_PAGE_TOKEN` via `railway variable set NAME="$(pbpaste)"` (the **Page** token from `me/accounts`, NOT the
  system-user token), then `FACEBOOK_SHOPSCAN_POST_FROM` = the moment of switch-on (never earlier; after a restore, the restore time).

## Context the builder needs
- Model: `docs/briefs/2026-11-09-linkedin-shopscan-page.md` and its built code (`sharedPages`, `portalPages()`,
  `pageAllPushesFrom()` in `src/services/linkedin/pages.ts`), but WITHOUT the quota guard.
- Today `runFacebookTick` derives pages from `Object.values(portals)` and `startupProblem` checks every one — both must move to
  the shared function, with Shopscan optional.
- `docs/FACEBOOK_POSTING.md` already promises "a later Facebook page (Academy, Shopscan) joins the list by its own name with no
  change to Compose" — keep that true.
- Live volume: ~20–22 pushes/day; the 30/day cap per page is enough.
