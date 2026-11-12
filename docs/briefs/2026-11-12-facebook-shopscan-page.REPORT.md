# REPORT: facebook-shopscan-page

- **Brief:** `docs/briefs/2026-11-12-facebook-shopscan-page.md` (planning, taxscan-push-64; base `origin/develop` a012e44)
- **Branch:** `build/facebook-shopscan-page`
- **Code commit:** `7167591` — `feat(facebook): also post every push to the Shopscan page, with a page switch on the screen (brief 2026-11-12-facebook-shopscan-page)`
- **Date:** 2026-11-12 (IST evening). Full suite: **yes** (the brief says it touches config/env).

## In one paragraph
The Shopscan Facebook page is built as a **shared page**: it receives the `taxscan` portal's pushes too, with a page id, token and go-live of its own, and exists only while
`FACEBOOK_SHOPSCAN_PAGE_ID`, `_PAGE_TOKEN` and `_POST_FROM` are all valid (and `FACEBOOK_POSTING_ENABLED` is on). Unset, production behaves exactly as today (page list = the old
map, the screen's answer has the same keys, the worker starts as before). It posts every push from its own go-live, with its own pace, stops, alerts, Pause and rows; Compose
"Post to", the screen API and the page status all read ONE `portalPages()`; the SPA gets a Taxscan | Shopscan switch only when two pages are active. **All 12 acceptance tests pass;
full suite 2,867/2,867 (twice).** The build also found and fixed **a latent multi-page bug in the Facebook tick** (below): without the fix Shopscan could not post in a tick where Taxscan had
posted or stopped.

## What changed
| File | What / why |
|---|---|
| `src/lib/env.ts` | `FACEBOOK_PAGE_ID_SHAPE` / `FACEBOOK_TOKEN_SHAPE` (the old rules, now exported), `SharedFacebookPage`, pure `parseFacebookShopscanEnv(src)` (active only when all three valid; `off` names variables, never values), `env.facebook.sharedPages` (only `shopscan`, only while valid; kept OUT of `pages`). |
| `src/services/facebook/pages.ts` | `PAGE_SHOPSCAN`, `SHARED_PAGES`, `shopscanActive()`, `isSharedPage()`, **`portalPages()`** (Taxscan, then Shopscan while active — the one list every reader uses), `pagePostFrom`, `pageAllPushesFrom` (a shared page's go-live IS its every-push time), `resolvePostFrom` / `resolveAllPushesFrom` (one time for every page — the old shape — or one per page), `pageConfig` reads `pages` then `sharedPages`. `PORTAL_TO_PAGE` unchanged (Taxscan only; the Channels mark on Campaigns still uses it). |
| `src/services/facebook/worker.ts` | `portals` / `postFrom` / `allPushesFrom` options widened (old shapes still work). `startupProblem`: the Taxscan rule unchanged, a shared page never refuses the start. The tick resolves go-live, every-push time and portals PER PAGE, skips a shared page without a valid config, handles Taxscan then Shopscan. One boot line for Shopscan. **Bug fix:** see below. |
| `src/routes/facebook.ts` | `GET /posts?page=` (400 `invalid_page` for unknown/inactive; default the first page), `pages` in the answer ONLY while ≥2 pages are active, `POST /check` and `/resume` take `{page}`, pause routes get the page list. |
| `src/services/social/pages.ts`, `pageStatus.ts` | Compose "Post to" and the status list read `portalPages()` → "Facebook · Shopscan" appears with it and nowhere without it. |
| `admin/src/views/Facebook.vue` | Page switch (`ui-developer`), see "UI" below. |
| `docs/FACEBOOK_POSTING.md`, `.env.example`, `docs/Taxscan-Push-Admin-Guide.html` | Docs: new "The Shopscan page" section, flags, API, switch-on, restore note; guide **v2.37** (12 Nov): a "Two pages" box in section 13, Compose list, screens table. |
| `src/__tests__/facebookShopscan.test.ts` (new, 744 lines, 25 tests) | Backend acceptance tests 1–9 and 11 (no existing test was edited). |
| `docs/briefs/2026-11-12-facebook-shopscan-page.shots/` (this report's commit) | 18 PNGs, desktop + 375 px. |

- **Migrations:** none (`FacebookPost.page` is a plain string).
- **Flags/env added (all default unset = off):** `FACEBOOK_SHOPSCAN_PAGE_ID`, `FACEBOOK_SHOPSCAN_PAGE_TOKEN`, `FACEBOOK_SHOPSCAN_POST_FROM`. No other new variable.

## The bug this build found (please read)
`runFacebookTick`'s step 2 ended with `if (out.posted + out.retried + out.failed > 0 || out.authStopped || out.policyStopped) continue;` — those are the **tick's running totals across
all pages**. It was written for one page. With two pages: after Taxscan posted (or was stopped by a policy / token stop) in a tick, Shopscan skipped its new-post step in that same tick, and
a Taxscan stop would have held Shopscan back for good (the brief: "a stop on one page never holds the other"). Fixed with a per-page `attempted` flag (identical for one page). Proof: with the
old condition put back, **6 of the 25 new tests fail** (acceptance 2, 5 ×3, 6, 8); restored, all pass. *Suggestion:* look for the same pattern (a tick-wide `out.*` read inside a
per-page loop) in `src/services/linkedin/worker.ts` — I did not read it for this and did not change it.

## Verification
- `npx tsc -p tsconfig.json --noEmit` → exit 0. `npm run lint` → exit 0. `cd admin && npm run build` (vue-tsc + vite) → exit 0 (the router dynamic-import warning is pre-existing).
- New tests: `Tests: 25 passed, 25 total` (`facebookShopscan`); `--detectOpenHandles` on that file: nothing reported.
- Area tests, first run on the new code (before the two fixes below): `facebookWorker socialPause socialPageStatus socialComposeSkip socialEveryLink socialPicture socialAllPushes whatsappQueue` →
  `Tests: 1 failed, 466 passed` — `socialAllPushes` #13 pinned the Facebook answer's exact keys; fixed in the code (`pages` only while ≥2 pages), not the test. All of them pass in the full runs.
- **Full suite, run 1** (load average ~12–16 from another session's `node --test` run on this Mac): `Test Suites: 120 passed, 120 total` / `Tests: 2867 passed, 2867 total` / `Time: 195.429 s` — and ONE line
  `A worker process has failed to exit gracefully…`.
- **Full suite, run 2:** `Test Suites: 120 passed, 120 total` / `Tests: 2867 passed, 2867 total` / `Time: 135.909 s, estimated 197 s` — no such line. So it was the load, not a leak (and my file has no open handles).
  (The suite is ~105 s on a quiet machine; 2,842 + my 25 = 2,867.)

### Acceptance tests
1. **Variables unset / partial / invalid → worker starts, Taxscan only, one boot line, no values — PASS.** Every combination of the three (none, each one and two set, each one invalid with sentinel values) is OFF with the variables named and
   no value printed; a lenient date (`12`) is refused; with Shopscan inactive `portalPages()` is exactly `{taxscan:['taxscan']}`, a tick with the real name `shopscan` listed makes no Shopscan row and no refusal; the Taxscan page keeps its refusals;
   boot lines: `[facebook] shopscan page off: not configured (it needs FACEBOOK_SHOPSCAN_PAGE_ID, FACEBOOK_SHOPSCAN_PAGE_TOKEN and FACEBOOK_SHOPSCAN_POST_FROM)` / names of what is missing / `shopscan page on (every push from …)`; the worker started each time.
2. **Active: one push → two rows, two calls, Taxscan then Shopscan, own id + token, Shopscan's link `facebook-shopscan` — PASS.** (Private page names in the DB tests; the real name `shopscan` is asserted on `withFacebookUtm` → `utm_campaign=facebook-shopscan`.)
3. **Every push from go-live — PASS:** course, shop product, collection page and site page (with `SOCIAL_ANY_LINK_FROM`), an exact repeat of a course and a re-push of an old article each post on Shopscan (oldest first, `push:` keys); a push before `FACEBOOK_SHOPSCAN_POST_FROM` never does although Taxscan (earlier go-live) posts it; without `SOCIAL_ANY_LINK_FROM` the site page does not.
4. **Pacing per page — PASS:** a Taxscan post inside the gap does not hold Shopscan and the reverse; each page's daily cap counts only its own rows.
5. **Stops per page — PASS:** 190 / 401 / 403 classify as auth; a token rejection on Shopscan stops Shopscan only (Taxscan posts in the same and later ticks, ONE alert email for the page, a new token resumes it); a 368 stops Shopscan until `resumePolicy('shopscan')` (Resume of the other page changes nothing); a Taxscan stop does not hold Shopscan.
6. **Pause `facebook:shopscan` — PASS:** rows SKIPPED `page_paused`, no call, Taxscan posts; resumed → the next push posts, the skipped one never.
7. **Compose — PASS:** "Facebook · Shopscan" only while active (after "Facebook · Taxscan"); a send may untick it only then; unticking → SKIPPED `compose_skip` for Shopscan, Taxscan posts.
8. **Picture — PASS:** a photo post (`photoUrl`) on each page; a 4xx on Shopscan's photo is repeated ONCE without the photo on Shopscan only (`posted as a link post…`), Taxscan's row unaffected. (That `photoUrl` means `/photos` is the existing client's rule.)
9. **Route — PASS:** default = first page, `?page=shopscan` its own rows (every push is its own row, `everyPushFrom` = its go-live), unknown/inactive → 400 `invalid_page`, no `pages` key while only one page; each page's banners / `pageStatus` are its own; Retry and Skip by row id leave the other page's rows alone; `/check` asks the page it was told (its own id and `Bearer` token), `/resume` clears that page's stop only (409 when none, 400 for an unknown page).
10. **Screen — PASS (real browser, phone + desktop):** no switch when inactive; with it active the switch changes rows + banner + Pause + Check connection per page. Shots in `docs/briefs/2026-11-12-facebook-shopscan-page.shots/` (`a-shopscan-inactive`, `b-shopscan-active-taxscan-tab`, `c-shopscan-tab-failing`, `c-shopscan-policy-stop`, `c-shopscan-token-stopped`, `c-shopscan-paused`, `c-shopscan-check-ok`, `c-shopscan-check-rejected`, `c-shopscan-retry-confirm`, each `-desktop` / `-phone`). Per the UI agent, the "inactive" shots are byte-identical to a build of the ORIGINAL `Facebook.vue` served from the same harness and data (I did not repeat that comparison). I looked at the failing (desktop) and policy-stop (phone) shots myself.
11. **Page status / alerts — PASS:** `activePages()` names `facebook:shopscan` only while active, after Taxscan; two failed Shopscan posts → `failing` for Shopscan alone, ONE email that day, Taxscan `not_alertable`/`ok`; the stop markers are keyed by page.
12. **LinkedIn, Telegram, WhatsApp and Channels tests pass unchanged — PASS:** the full suite (2,867/2,867, twice) with no existing test edited (the commit adds one test file and changes no other).

## UI (`ui-developer`)
Switch copied from LinkedIn's (`.fb-scope` / `.fb-switch`, joined box, 44 px tap targets and full width at ≤720 px, labels "Taxscan" / "Shopscan"). State: `page`, `pages`, `multi`; first request has no `page=` and adopts the server's; `selectPage` clears rows, counts, every banner, the check result and the retry dialog, then reloads; a load counter drops stale answers; a remembered page that is no longer active falls back to the first with no error. With the switch, Check connection and Pause move onto the switch's row (they are about the page chosen); with one page they stay where they were. Bodies sent: `check {page}`, `resume {page}`, `page-pause {page, note}`, `page-resume {page}`. Banners, intro, retry hints, resume notes and the check result name the page — only while the switch is present; with one page every string is identical.

## Deviations from the brief (and why)
1. **`pages` is in the `GET /posts` answer only while ≥2 pages are active** (LinkedIn always sends it). An existing test (`socialAllPushes` #13) pins the Facebook answer's exact keys, and the brief says unset = exactly as today. The SPA shows the switch only when `pages.length > 1`, so nothing is lost.
2. **`FACEBOOK_SHOPSCAN_POST_FROM` uses the STRICT ISO rule** (same as LinkedIn Shopscan's and the all-pushes variables). The brief says "(same rule as `FACEBOOK_POST_FROM`)" and also "strict ISO"; `FACEBOOK_POST_FROM` itself is parsed leniently with `Date.parse` (`12` would be accepted). I took "strict" — if you want the lenient rule, it is one line in `parseFacebookShopscanEnv`.
3. **`startupProblem` generalised:** it now checks the go-live and config of every page that is not a shared page (in production: Taxscan alone) instead of hard-coding the name `taxscan` — needed so a per-page injected `postFrom` works; behaviour for the real setup is identical.
4. **Fixed the latent worker bug above** (in `worker.ts`, a file the brief lists; not mentioned in the brief).
5. **UI agent:** (a) added one sentence on the Shopscan tab's "since" line — "From 12 Nov 2026, 09:00 IST every push is posted. Pushes before then are not posted to this page." — because the Taxscan wording ("earlier pushes keep the old rule: one post per article") is false for Shopscan; (b) the brief said LinkedIn remembers the page in `localStorage` — **it does not** (only an in-component ref); the Facebook screen copies that, so a reload opens on Taxscan; (c) the Chrome automation tools were not available to it, so it used the project's own `playwright-core` driving headless Chromium (real browser, isolated profile, true 375 px viewport) against a throwaway harness outside the repo; (d) with one page the screen now also sends `{page:'taxscan'}` in check / resume / pause bodies (harmless: always active); (e) the Retry dialog's heading stays "Post to Facebook now?" (only the detail line names the page).
6. **Enabled gating is in the readers, not inside `shopscanActive()`:** the worker starts only when `FACEBOOK_POSTING_ENABLED` is on, the routes answer 404 when it is off, and Compose / page status already require `env.facebook.enabled` — so the "only while enabled" part of the brief holds everywhere it matters.
7. Environment only: `admin/node_modules` installed (the SPA changed and the suite compiles `admin/src`).

## Worth remembering (planning decides what becomes record)
- Shopscan's every-push eligibility is `isAllPushesCampaign` + `SOCIAL_ANY_LINK_FROM`, unchanged; Taxscan's own rules, go-live and times are untouched (if `FACEBOOK_ALL_PUSHES_FROM` is unset for Taxscan, Taxscan posts articles only while Shopscan posts every kind — as the brief intends).
- The Campaigns **Channels** mark still means the Taxscan page (`metrics.ts` filters `page: 'taxscan'`); a Shopscan row cannot confuse it.
- `FacebookPost` is not in the R2 backup: after a restore set `FACEBOOK_SHOPSCAN_POST_FROM` to the restore time (written into `docs/FACEBOOK_POSTING.md` "Backups and restores").
- Switch-on (documented in `docs/FACEBOOK_POSTING.md`): the two Railway variables via `railway variable set NAME="$(pbpaste)"` (the **Page** token from `me/accounts`), then `FACEBOOK_SHOPSCAN_POST_FROM` = the moment of switch-on; boot line `[facebook] shopscan page on (every push from …)`; SOCIAL → Facebook → Shopscan tab → Check connection. Removing any one of the three switches it off (a deleted variable needs a redeploy).
- DB tests never write rows under the real page names `taxscan` / `shopscan` (private `fbshop-t…` / `fbshop-s…`, `env` registered for the file and restored).
- The Mac was heavily loaded by another project's long test run (load average 10–16): full-suite times were 135–198 s against ~105 s quiet, and the "worker failed to exit gracefully" line appeared once under that load and not in the second run.
- Screenshots use sample content (the harness's seeded campaigns); re-render real content if you want it before shipping.

## Agents run
- `ui-developer` (one, background): `Facebook.vue` + the real-browser check + the 18 screenshots. It reports it stopped every process it started and removed its seed data (I checked that nothing of ours is still running; the 8 `CAMPAIGN_DISPATCHED` audit rows it mentions are from my own earlier jest run, 12:51 UTC = 18:21 IST).

## Clean-up (planning runs this after merging)
```sh
git worktree remove ../taxscan-push-worktrees/facebook-shopscan-page
dropdb taxscan_push_build_facebook-shopscan-page; dropdb taxscan_push_build_facebook-shopscan-page_shadow
git branch -D build/facebook-shopscan-page; git push origin --delete build/facebook-shopscan-page
```
(`admin/dist` in the worktree is a gitignored build; the agent's throwaway harness lives in the session scratchpad, not the repo.)
