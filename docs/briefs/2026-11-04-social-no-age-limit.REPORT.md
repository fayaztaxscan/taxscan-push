# REPORT: social-no-age-limit

- Code commit: `95719c2` on branch `build/social-no-age-limit` (rebased onto origin/develop `7705ac2` before pushing; the rebase only brought in the Academy brief file, the tests ran on the identical code).
- Agents run (one at a time): ui-developer (the Facebook.vue line + the real-browser check at 1280 and 375 px). Everything else (workers, routes, tests, docs, guide text, mutation checks) I did myself in the backend-developer role.

## Files changed
- `src/services/linkedin/worker.ts`, `src/services/facebook/worker.ts` — `WINDOW_MS` removed; `since` is the page's post-from. The list read is `select: { id, url, target }` (all `isPublicArticleCampaign()` + `articleKey()` need), `firstOf` maps article key → campaign id of its OLDEST push. The `earlier` look-back is now `[post-from − 14 d, post-from)`. The existing-rows lookup is `where: { page }` + `select articleKey` (one indexed read) instead of an `articleKey IN (…)` that would grow with the list. Header comments and both login-stop e-mail bodies no longer state a 24 h rule. Unused `Campaign` type import dropped.
- `src/routes/linkedin.ts`, `src/routes/facebook.ts` — **not in the brief's file list, see Deviations 1.** Each had its own `WINDOW_MS`: an unposted article was `WAITING` only if pushed < 24 h ago, else `NOT_POSTED`. Now `WAITING` = pushed since go-live, `NOT_POSTED` = before go-live.
- `admin/src/views/Facebook.vue` — the `<li>` "An article pushed more than 24 hours ago is never posted." removed from `fb-rules` (the other two stay, byte for byte). One deleted line.
- `docs/LINKEDIN_POSTING.md`, `docs/FACEBOOK_POSTING.md` — What posts, Pacing and login-stop lines say "no age limit"; one extra "How it runs" bullet in LinkedIn about the per-tick read.
- `docs/Taxscan-Push-Admin-Guide.html` — Facebook pacing box, both amber token banners, and the two "Not posted" status rows (**not in the brief, Deviations 2**); version 2.19 → 2.20, "Updated 4 November 2026" (cover + footer).
- `src/__tests__/linkedinWorker.test.ts`, `src/__tests__/facebookWorker.test.ts` — the two "nothing older than 24 h is posted" cases and the Facebook cap case replaced; new cases listed under Acceptance.
- `docs/briefs/2026-11-04-social-no-age-limit.shots/` — `desktop-facebook.png`, `phone-facebook.png` (mocked, empty list: the change is static text).

## Migrations / flags
None / none.

## Results
- tsc: `npx tsc -p tsconfig.json --noEmit` exit 0, no output.
- lint: `npm run lint` (`eslint "src/**/*.ts"`) exit 0, no findings.
- `npm run build:admin`: exit 0, `✓ 128 modules transformed.` / `✓ built in 2.23s`.
- Changed test files: `nice -n 10 npx jest src/__tests__/linkedinWorker.test.ts src/__tests__/facebookWorker.test.ts --runInBand --forceExit` → `Test Suites: 2 passed, 2 total` / `Tests: 100 passed, 100 total`.
- Area: `nice -n 10 npx jest linkedin facebook campaignChannels --runInBand --forceExit` → `Test Suites: 6 passed, 6 total` / `Tests: 157 passed, 157 total` (linkedinToken, linkedinWorker, linkedinThumbnail, linkedinPost, facebookWorker, campaignChannels).
- Guide endpoints: `npx jest src/__tests__/api.test.ts -t "guide"` → `Tests: 28 skipped, 4 passed, 32 total` (only status + content-type are asserted; no test reads the guide's text or version).
- Full suite: not run. Brief says `Full suite: no`; no schema, auth, push send path / pacer, config / env or `useApi` was touched.
- **Do the new tests bite?** Source files put back to origin/develop (no stash; saved and restored, `cmp` identical) with the NEW tests: `Tests: 21 failed, 79 passed, 100 total`. Then, on the new code: (A) look-back deletion `for (const c of earlier) firstOf.delete(…)` disabled → `4 failed` (both "pre-go-live re-push" cases and the two old what-posts cases); (B) `if (have.has(key)) continue;` disabled → first `100 passed` (the unique `(page, articleKey)` + the P2002 catch absorb a doomed insert), so the item-4 cases now spy on `create` and assert no insert is attempted → `6 failed, 94 passed`. Both restored; real code `100 passed`.

## Acceptance
1. PASS — LinkedIn `4b/1`, Facebook `1b/1` (`it.each` 25 h, 3 days, 30 days, all after post-from, no row): posted, one row POSTED, attempts 1.
2. PASS — `4b/2`, `1b/2`: pushes 1 min, 59 min, 25 h, 3 d, 20 d and 400 d before post-from never post (two LinkedIn ticks; 40 Facebook ticks = room for four gaps); one pushed exactly AT post-from does.
3. PASS — `4b/3`, `1b/3`: originals 30 min and 10 days before post-from, re-pushes 4 d, 3 d, 90 min and 5 min after it: zero rows, zero calls. (These pass on the old code too; they are guards, mutation A shows they bite.)
4. PASS — `4b/4`, `1b/4` × POSTED / SKIPPED / FAILED: first pushed 4 days ago, re-pushed 2 d / 26 h / 40 min ago: no row added, no post call, and **no insert attempted** (spy on `create`).
5. PASS — LinkedIn `4b/5`: ages 30 d, 5 d, 2 d, 26 h, 3 h created newest-first → tick 1 posts 30 d, 5 d, 2 d (≤ 3), tick 2 posts 26 h, 3 h, tick 3 none. Facebook `1b/5`: one per tick at minutes 0/10/20/30/40, same order.
6. PASS — Facebook "3. pacing" case rewritten: with 30 posted on 3 Nov the 31st waits (`waited: daily_cap`), and posts on the next IST day 24 h 35 min after its push.
7. PASS — Facebook `1b/7a` (an article pushed 3 days ago: 5 min after a post → `waited: 'gap'`, at 10 min posts) and `1b/7b` (a policy stop holds a 3-day-old article through 30 ticks; `resumePolicy` then posts it).
8. PASS — real headless Chromium, true 1280 px and 375 px, API mocked at the network layer (backend never started, nothing clicked, non-localhost aborted): rules list has exactly 2 `<li>` with the two required sentences; "24 hours" absent from page text and HTML; `scrollWidth` = `innerWidth` at both widths; no console errors / failed requests. I looked at both screenshots.
9. PASS — `grep -rn "24 hours ago\|last 24 hours" admin/src docs/Taxscan-Push-Admin-Guide.html` finds nothing (the only other "24 h" strings in `admin/src` are the digest Audience card); `WINDOW_MS` is gone from both workers and both routes (locked by tests `4b/8` and `1b/10`).

## Deviations from the brief (planning please review)
1. **Both screen routes changed (`src/routes/linkedin.ts`, `src/routes/facebook.ts`).** They carry their own copy of the 24 h window to label unposted articles. Left alone, after an outage or a Facebook cap backlog longer than a day the screen would say NOT_POSTED ("never posted") next to articles the worker will still post; the brief's Goal says the rule must be gone "in code, screen or docs". Two lines each, plus one new screen test per channel (a 3-day-old unposted article is WAITING, one before go-live NOT_POSTED). The Campaigns Channels marks (`metrics.ts`) never had a window and are untouched.
2. **Two more guide sentences.** The LinkedIn and Facebook status tables said NOT POSTED = "Pushed before this feature started, or more than a day ago. It is never posted late." Now "Pushed before this feature started. It is never posted." ("never posted late" would now be false: waiting articles do post late.)
3. **Both login-stop e-mail bodies** said "they post once posting resumes, if they are still within 24 hours of their push". Now "…they post once posting resumes." (Code text that states the rule; no test asserted it.)
4. **`have` lookup** is now `where: { page }` instead of `articleKey IN (all candidates)`. The brief asked to keep anything the change makes unbounded in check; the IN list would have grown to thousands of bind parameters.
5. **Extra tests beyond the nine:** a waited-through-a-login-stop article (> 24 h) posts when the new token is set and the stop e-mail makes no age promise; a `select` check on every campaign list the tick reads; the two source scans.
6. Left untouched on purpose: the `postFrom: at(NOW, -60 * 24)` overrides in the two "auth stop" tests. They only existed to stretch the old window and are harmless now.

## Worth remembering
- **First tick after release posts anything since go-live that has no row.** Planning's 4 Nov ~10:30 IST read says every such campaign is a non-article or a pre-go-live repeat (the `earlier` check still removes those). If the release slips, re-run that read first, especially after any LinkedIn / Facebook outage.
- **Per-tick read now grows ~20 rows/day/page:** `Campaign` (id, url, target ≈ 150 B a row) plus the page's `articleKey` list ≈ 35 B a row. About 1 MB + 250 KB per minute after a year. Fine for now; if it ever matters, a posted-high-water mark is the fix (I did not build it: it would be an age limit in disguise).
- **Pre-existing approximation, now more visible:** the screen decides "first push" from its own 14 days before the shown day, the worker from `[post-from − 14 d, post-from)`. A manual re-push of an article first pushed 15+ days before the shown day but within 14 days before go-live shows WAITING forever on the screen while the worker (correctly) never posts it. Before this change it flipped to NOT_POSTED after 24 h. Rare; fixable by giving the route the same `earlier` check if wanted.
- **Facebook phone screen (unchanged, cosmetic):** the "Skipped" chip wraps onto its own full-width row and the empty-state text sits left of centre. Not caused by this change.
- Screenshots use mocked data (empty list) because the change is static text; re-render real rows yourself if you want to see them.
- The brief `2026-11-04-linkedin-academy-page` says to build after this is merged and changes the same worker lines, `src/routes/linkedin.ts` and the guide version. At the owner's request it is being built **stacked on this branch**: merge this one first, then that one; the guide there goes 2.20 → 2.21.

## Clean-up
```sh
git worktree remove ../taxscan-push-worktrees/social-no-age-limit
dropdb taxscan_push_build_social-no-age-limit; dropdb taxscan_push_build_social-no-age-limit_shadow
git branch -D build/social-no-age-limit; git push origin --delete build/social-no-age-limit
```
(`build/linkedin-academy-page` is cut from this branch; deleting this branch afterwards does not affect it, its history carries these commits.)
