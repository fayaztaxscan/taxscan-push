# Brief: Facebook Academy page posts every push

- **Date / name:** 2026-11-27-facebook-academy-page  →  branch `build/facebook-academy-page`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first)

## Goal
A third Facebook page, **Academy** (facebook.com/taxscanacademy, owner 27 Nov), posts every push exactly like the Shopscan page does: its own page id,
Page token and go-live, its own pacing/stops/Pause/alerts, "Facebook · Academy" in Compose "Post to" and on the Facebook screen.
Off until its three variables are set.

## Why (owner's words)
> 27 Nov 2026: "I wanted to start pushing contents to Academy page of facebook like other facebook pages"

Standing rule (memory `social-follows-push`, owner 4 Nov): every page posts EVERY push (articles, courses, products, site pages,
exact repeats), no filtering.

## Scope
**In:**
- `parseFacebookAcademyEnv` = the Shopscan parser generalised: make ONE `parseSharedFacebookPage(src, 'SHOPSCAN' | 'ACADEMY')`
  (like `parseSharedLinkedInPage`) and use it for both; variables `FACEBOOK_ACADEMY_PAGE_ID`, `FACEBOOK_ACADEMY_PAGE_TOKEN`,
  `FACEBOOK_ACADEMY_POST_FROM`. Shopscan's behaviour and boot line stay byte-identical.
- `PAGE_ACADEMY = 'academy'`; `SHARED_PAGES = [PAGE_SHOPSCAN, PAGE_ACADEMY]` (tick order Taxscan → Shopscan → Academy);
  `env.facebook.sharedPages` gains `academy` while active.
- UTM campaign `facebook-academy` (source/medium as the other pages).
- Boot line `[facebook] academy page on (every push from <ISO>)` / `… off: not configured (…)`, never a value.
- Everything that today lists Shopscan through `portalPages()` / `SHARED_PAGES` / `pageStatus` picks Academy up; fix any place
  that names `shopscan` directly (grep `shopscanActive`, `'shopscan'`, `PAGE_SHOPSCAN`) so it works for any shared page.
- Facebook screen: the page switch shows Taxscan / Shopscan / Academy (only active pages).

**Out (do not build):**
- No LinkedIn change (the LinkedIn Academy page already exists, `linkedin:academy`).
- No quota guard (Facebook has none; per-page gap + daily cap as today).
- No schema change.

## Acceptance tests
Each one must PASS in the REPORT. All Graph calls mocked.
1. Academy variables unset / partial / invalid id / invalid token / invalid time: the worker starts, ticks behave as today
   (Taxscan + Shopscan only), one boot line naming what is missing, never a value. Shopscan's tests pass unchanged.
2. All three pages active: one push → three rows and three post calls, Taxscan → Shopscan → Academy, each with its own page id + token;
   Academy's link tagged `utm_campaign=facebook-academy`.
3. Every push from Academy's go-live: article, course, shop product, site page (with `SOCIAL_ANY_LINK_FROM`) and an exact repeat each
   post on Academy; a push before `FACEBOOK_ACADEMY_POST_FROM` never does.
4. Pacing + daily cap counted per page; a busy/held Academy never holds Taxscan or Shopscan, and vice versa.
5. 190/401/403 on Academy stops Academy only; 368 stops Academy until an ADMIN Resume of `academy`; one alert per page per IST day.
6. Pause `facebook:academy` → Academy SKIPPED `page_paused`, others unaffected; Resume → next push posts.
7. Compose: "Facebook · Academy" listed only when active; unticking it → Academy SKIPPED `compose_skip`, others post.
8. Compose picture: `/photos` on Academy too; a 4xx there falls back to `/feed` on Academy only.
9. `GET /api/facebook/posts?page=academy` → its rows when active, 400 when inactive; Retry/Skip on an Academy row touches only it.
10. Screen: switch lists only active pages; Academy tab shows its rows + banner + Check connection (real browser, phone + desktop).
11. `pageStatus` / alerts report `facebook:academy` on its own.
12. LinkedIn, Telegram, WhatsApp and Channels tests pass unchanged.

## Files
- `src/lib/env.ts`, `src/services/facebook/pages.ts`, `src/services/facebook/worker.ts`, `src/routes/facebook.ts`
- `src/services/social/pages.ts`, `src/services/social/pageStatus.ts` (only if they name shopscan directly)
- the Facebook admin screen (`admin/src/views/…Facebook…`)
- `docs/FACEBOOK_POSTING.md` (an "Academy page" section + switch-on steps), admin guide (bump version), `.env.example`
- Tests: Facebook env / worker / route tests, social pages / pageStatus tests

## Constraints
- Flag: the three `FACEBOOK_ACADEMY_*` variables are the switch, off by default; `FACEBOOK_POSTING_ENABLED` governs all.
- Migrations: none (`FacebookPost.page` is a plain string).
- Full suite: yes — touches config/env.
- Never log, store or return a token; never call real Facebook from a test.
- UI goes to `ui-developer`.
- Switch-on (planning, after release, on the owner's yes): owner sets `FACEBOOK_ACADEMY_PAGE_ID` and `FACEBOOK_ACADEMY_PAGE_TOKEN` via
  `railway variable set NAME="$(pbpaste)"` (a NEVER-expiring **Page** token from `me/accounts` for `taxscan_post_app`, not a user or
  system-user token), then `FACEBOOK_ACADEMY_POST_FROM` = the moment of switch-on (never earlier; after a restore, the restore time).

## Context the builder needs
- Model: `docs/briefs/2026-11-12-facebook-shopscan-page.md` and its code (`parseFacebookShopscanEnv`, `SHARED_PAGES`, `portalPages()`,
  `pagePostFrom`, the multi-page tick fix that keeps per-page totals). `parseSharedLinkedInPage` in `env.ts` is the generalisation pattern.

## Follow-up 1 (planning, 27 Nov — builder's catch)
`socialComposeSkip.test.ts` "7. a scheduled send keeps its socialSkip…" fails on develop e00dd0a itself (date bomb): its
clock is fixed at 24 Nov 2026 while send-route tests in the same describe stamp campaigns with the REAL time, which since
24 Nov falls after the pages' go-live, so the LinkedIn tick posts them too. Allowed in this build, **test-only**: before that
tick, clear `lastSentAt` on the describe's other campaigns (scoped to the test's own PORTAL/prefix, never global), with a
one-line comment naming the cause. No production code change for this. Acceptance 12 then = full suite green; say in the
REPORT that this test was changed and why.
