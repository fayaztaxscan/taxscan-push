# Brief: LinkedIn: also post to the Shopscan page

- **Date / name:** 2026-11-09-linkedin-shopscan-page  →  branch `build/linkedin-shopscan-page`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first)
- **Order:** build AFTER `build/audience-alert-fixes` is merged to `develop` (one build at a time on this Mac).

## Goal
Every push that posts to the Taxscan LinkedIn page also posts to the **Shopscan** page (`urn:li:organization:80241094`, 649
followers), with the same text, hashtags, picture and Compose picture, once the owner sets the Shopscan variables. Unset,
production behaves exactly as today.

## Why (owner's words)
> "Let us start posting in https://www.linkedin.com/company/80241094/admin/dashboard/ also" (9 Nov 2026)

Standing rule (owner, 4 Nov, `feedback_social_follows_push`): LinkedIn, Facebook **and any future page** post EVERY push —
articles, courses, shop products, collections, site pages, exact repeats; no filtering. So Shopscan is an every-push page from
its own go-live, never on the old one-post-per-article rule. Planning verified 9 Nov: the owner (the token's creator) is an
admin of the page (the admin dashboard opens for them).

## Scope
**In:**
- **A third shared page, built exactly like Academy** (`src/services/linkedin/pages.ts`, `src/lib/env.ts`): page name
  `shopscan`, Taxscan's token (`tokenFrom: 'taxscan'`), own org URN, own go-live. Variables:
  - `LINKEDIN_SHOPSCAN_ORG_URN` — `urn:li:organization:<digits>`
  - `LINKEDIN_SHOPSCAN_POST_FROM` — strict ISO time (same `ISO_DATE_START` rule as Academy)
  Active only when BOTH are valid; otherwise off: no rows, no failures, no refusal to start, ONE boot line saying why (names,
  never values). Prefer generalising the Academy parser into one `parseSharedLinkedInPage(src, prefix)` used by both, rather than
  a copy; Academy's behaviour and boot wording must not change.
- **Every push from go-live.** Shopscan's all-pushes time IS its `LINKEDIN_SHOPSCAN_POST_FROM` (no separate
  `…_ALL_PUSHES_FROM` variable): `pageAllPushesFrom('shopscan')` returns its post-from while active, null otherwise. Same
  eligibility as the other every-push pages (`isAllPushesCampaign` + `SOCIAL_ANY_LINK_FROM` for any other allowed page), one post
  per push, repeats included. Nothing pushed before its go-live is ever posted there.
- **Order in a tick:** Taxscan, then Academy, then Shopscan (`portalPages()`), so a busy tick only delays Shopscan.
- **Quota headroom guard (Shopscan only).** All pages share one member token on the Development tier: 100 calls per member per
  endpoint per 24 h (`docs/LINKEDIN_POSTING.md` "Quota note"). Before Shopscan creates a post, count today's (IST day)
  `posts-CREATE` attempts across ALL pages (LinkedInPost rows with a create attempt today — use whatever the worker already
  stamps; add nothing to the schema). At or above `LINKEDIN_SHOPSCAN_DAILY_HEADROOM` (default **85**), Shopscan does not post:
  its row becomes SKIPPED with reason `quota_headroom` (never retried, never posted later — a late post of an old push is worse
  than none), logged once per IST day as `[linkedin] page=shopscan quota_headroom skipped=N`. Taxscan and Academy are never
  limited by this guard.
- **Stops are per page** (already true since Academy): a 401/403 on Shopscan stops Shopscan only, own banner state + own alert.
- **Picture:** uploaded under Shopscan's org URN (as Academy). Compose picture posts there too (PR #108 path).
- **UTMs:** unchanged helper → `utm_campaign=linkedin-shopscan`.
- **Screen (SOCIAL → LinkedIn, `ui-developer`):** the page switch gains **Shopscan**, shown only when active;
  `GET /api/linkedin/posts?page=shopscan` validated like academy. SKIPPED `quota_headroom` rows read "Skipped — daily LinkedIn
  limit kept for Taxscan" (not a raw code). Compose's picture hint says "LinkedIn pages" if it names a count.
- **Docs:** `docs/LINKEDIN_POSTING.md` (Pages, Flags/env, Quota note with the guard), admin guide LinkedIn section + version
  bump, `.env.example` if it lists LinkedIn variables.

**Out (do not build):**
- A Shopscan Facebook page, X, or any Facebook change.
- Different text, hashtags or pictures per page; a delay between pages.
- A per-page Channels mark on Campaigns (the column keeps meaning the Taxscan page).
- Any change to Taxscan or Academy posting, their go-live times, or their rules.
- A separate token, renewal or `LinkedInToken` row for Shopscan.

## Acceptance tests
Each one must PASS in the REPORT. All LinkedIn calls mocked.
1. Shopscan variables unset / only one set / invalid time / invalid URN: a tick behaves exactly as today (Taxscan + Academy rows
   only), one boot line, no startup problem. Academy's boot line unchanged.
2. Active: one push makes three rows and three post calls in the order Taxscan → Academy → Shopscan, with
   `linkedin-shopscan` on Shopscan's link.
3. Every-push from go-live: an academy course push, a shop product push, a site-page push (with `SOCIAL_ANY_LINK_FROM` set) and an
   exact repeat each post to Shopscan; a push before `LINKEDIN_SHOPSCAN_POST_FROM` never does.
4. Headroom: with 85 creates already recorded today across pages, Shopscan's row is SKIPPED `quota_headroom`, no API call, and
   Taxscan + Academy still post in the same tick. At 84 it posts. A new IST day resets the count. `LINKEDIN_SHOPSCAN_DAILY_HEADROOM`
   overrides the default; invalid → default, with a boot note.
5. A 403 on Shopscan stops Shopscan only; Taxscan and Academy post in the same and later ticks; one alert per page per IST day.
6. Retry / Skip on a Shopscan row leaves the other pages' rows untouched; a `quota_headroom` row is not retryable.
7. Renewal: still one `LinkedInToken` row and one renewal; all three pages use the new token next tick.
8. `GET /api/linkedin/posts?page=shopscan` returns its rows when active; 400 when inactive or unknown; default still `taxscan`.
9. Screen: no Shopscan switch when inactive; with it active, the switch changes rows + banner; the skipped wording shows
   (real browser, phone + desktop shots).
10. Compose picture: a push with a picture uploads it under each active page's URN, Shopscan included.
11. Facebook, WhatsApp and Channels tests pass unchanged.

## Files
- `src/lib/env.ts`, `src/services/linkedin/pages.ts`, `worker.ts` (and `image.ts` only if the owner URN is not already per page)
- `src/routes/linkedin.ts`, `admin/src/views/LinkedIn.vue`
- `docs/LINKEDIN_POSTING.md`, `docs/Taxscan-Push-Admin-Guide.html`, `.env.example`
- Tests: `src/__tests__/linkedinWorker.test.ts` (+ route / env tests that cover Academy)

## Constraints
- Flag: the two Shopscan variables are the switch, off by default. `LINKEDIN_POSTING_ENABLED` still governs everything.
- Migrations: none (`LinkedInPost.page` is a plain string).
- Full suite: yes — touches config/env.
- Never log or return a token. Never call real LinkedIn from a test.
- Switch-on (planning, after release, on the owner's yes): `LINKEDIN_SHOPSCAN_ORG_URN=urn:li:organization:80241094`,
  `LINKEDIN_SHOPSCAN_POST_FROM`=the moment of switch-on (never earlier; after a restore, the restore time).

## Context the builder needs
- Model it on `docs/briefs/2026-11-04-linkedin-academy-page.md` and its built code (`parseLinkedInAcademyEnv`, `academyActive`,
  `portalPages`, `pageAllPushesFrom`, `sharedPages`). The every-push rule is `docs/briefs/2026-11-04-academy-store-posts.md`.
- Live volume (prod, 5–8 Nov): ~20–22 posts per page per day → ~66/day with three pages; `images-GET` already passes 100 on
  some days and is handled (429 on the poll → `image=ok:unverified`, no retry). The guard exists for `posts-CREATE`.
- Image URNs must be `encodeURIComponent`-encoded in REST paths (keep it).
- App `taxscan_post_app` only (Development tier; Standard appeal open, CAS-12316619-W9J3R4).
