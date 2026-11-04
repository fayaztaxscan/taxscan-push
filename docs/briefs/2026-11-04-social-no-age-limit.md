# Brief: LinkedIn + Facebook: remove the 24-hour age limit

- **Date / name:** 2026-11-04-social-no-age-limit  →  branch `build/social-no-age-limit`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first)

## Goal
An article pushed at or after `LINKEDIN_POST_FROM` / `FACEBOOK_POST_FROM` that has not been posted is posted however long ago it
was pushed. The rule "An article pushed more than 24 hours ago is never posted" no longer exists, in code, screen or docs.

## Why (owner's words)
> "In the linkedin and facebook page, I want to remove this rule - 'An article pushed more than 24 hours ago is never posted.'" (4 Nov 2026)

## Scope
**In:**
- `src/services/linkedin/worker.ts` and `src/services/facebook/worker.ts`: drop `WINDOW_MS`; `since` = the page's post-from time.
- The tick now reads every SENT campaign since post-from, every minute, and that list only grows (~20 a day). Read only the columns
  `isPublicArticleCampaign()` and `articleKey()` need (a `select`), never whole rows. Same for anything else this makes unbounded.
- Update the code comments that state the rule (LinkedIn worker header; the "before go-live, or more than 24 h ago" comment in both).
- Remove the rule from `admin/src/views/Facebook.vue` (the `<li>` in `fb-rules`).
- Docs: `docs/LINKEDIN_POSTING.md` (What posts), `docs/FACEBOOK_POSTING.md` (line 11 area); admin guide
  `docs/Taxscan-Push-Admin-Guide.html`: Facebook pacing box ("and one pushed more than 24 hours ago is never posted") and both amber
  token banners ("articles pushed in the last 24 hours that were not posted are still posted" becomes "articles that were not posted
  are still posted"). Guide version + date bump.

**Out (do not build):**
- No new pacing, quiet-hours rule, cap or age limit on either channel. No change to Facebook's 1 per 10 min / 30 per day.
- `LINKEDIN_POST_FROM` / `FACEBOOK_POST_FROM` stay required and stay absolute: nothing pushed before them is ever posted.
- The WhatsApp queue, the shared `isPublicArticleCampaign()` rule, UTMs, hashtags, pictures.
- `EARLIER_LOOKBACK_MS` stays: a re-push or clone of an article first pushed before go-live is still never posted.

## Acceptance tests
Each one must PASS in the REPORT. Replace the two "nothing older than 24 h is posted" tests; do not delete the cases around them.
1. LinkedIn: an article pushed 3 days ago (after post-from) with no row is posted. Facebook: the same.
2. LinkedIn + Facebook: an article pushed before post-from is never posted, at any age.
3. LinkedIn + Facebook: a re-push or morning-backfill clone of an article first pushed BEFORE post-from adds no row.
4. LinkedIn + Facebook: a re-push of an article already holding a row (POSTED, SKIPPED or FAILED), first pushed days ago, adds no row
   and no call.
5. Several waiting articles of different ages post oldest push first; LinkedIn keeps ≤ 3 per tick.
6. Facebook: the 31st post of an IST day waits, and still posts on a later day even when the push is more than 24 h old (rewrite the
   "still inside 24 h" test).
7. Facebook: a waiting article older than 24 h respects the 10-minute gap and a policy stop.
8. The Facebook screen no longer shows the sentence; the other two rules remain.
9. `grep -rn "24 hours ago\|last 24 hours" admin/src docs/Taxscan-Push-Admin-Guide.html` finds no social-posting line, and `WINDOW_MS`
   is gone from both workers.

## Files
- `src/services/linkedin/worker.ts`, `src/services/facebook/worker.ts`
- `admin/src/views/Facebook.vue` (UI line: `ui-developer`)
- `docs/LINKEDIN_POSTING.md`, `docs/FACEBOOK_POSTING.md`, `docs/Taxscan-Push-Admin-Guide.html`
- Tests: `src/__tests__/linkedinWorker.test.ts`, `src/__tests__/facebookWorker.test.ts`

## Constraints
- Flag: none. The owner asked for the rule to go, and production has nothing waiting today (see Context), so release changes no
  current post. The post-from variables remain the safety line.
- Migrations: none.
- Full suite: no — area tests: `linkedinWorker`, `linkedinToken`, `facebookWorker`, plus any guide or Facebook-screen test. (The social
  workers are not the push send path.)
- Docs that ship with it: the guide + two posting docs above.
- Do not post, or call LinkedIn or Facebook, from a test.

## Context the builder needs
- Planning checked production read-only on 4 Nov ~10:30 IST: every SENT campaign since post-from with no row is a non-article (academy,
  shop, `/trackers`, `/subscription`) or a morning repeat of an article first pushed before that page's post-from. The `earlier` check
  still excludes those repeats, so nothing should post on release.
- `articleKey` + the unique `(page, articleKey)` row is what stops a second post. `firstOf` keeps the oldest campaign per key.
