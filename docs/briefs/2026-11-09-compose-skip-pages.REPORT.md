# REPORT: 2026-11-09-compose-skip-pages

- **Branch:** `build/compose-skip-pages` (base `origin/develop` de92fd6; the Shopscan build is already in it)
- **Code commit:** `468c70d`
- **Built to the brief. Acceptance 1-11 all PASS.** No flag: all-ticked is today's behaviour, byte for byte (the request carries no `socialSkip` field). Two choices differ from, or go beyond, the brief's wording and need a word from planning: points 1 and 2 below.

## For planning to read first

1. **WhatsApp has NO persisted `WhatsAppPost` row for a compose skip; its "Skipped in Compose" status is derived from the campaign.** The brief says "a `WhatsAppPost` SKIPPED row". I did not do that, deliberately: WhatsApp has no worker, so the only places to write the row are (a) a hook in the send path (`executeCampaign`, which the pacer, Queue/Review Push now and the sweeper all share: the brief's own principle is that the social side never touches the send path) or (b) a write on a GET; and `WhatsAppPost` has no reason column, so a persisted SKIPPED row would be indistinguishable from a person's Skip without a new column. What the derivation gives, and what the brief asked for ("so it never shows as To do"): the queue lists that push as its own SKIPPED row (`skipReason: 'compose_skip'`, no actor), the counts and the staff nudge (which counts To do only) exclude it, the Campaigns mark reads SKIPPED, and `POST /api/whatsapp/queue/:id` answers `409 compose_skip` for it (nothing written). If you want real rows after all, it is one `createMany` in `executeCampaign` (a try/catch'd write, so it can never fail a send) plus a reason column; say so and I add it as a follow-up.
2. **Compose with the Breaking box ticked still honours the unticked pages.** The brief's "Out" lists Breaking beside Push now / Queue / Review / the pacer; I read that as the "Send now as Breaking" doors on Queue and Review, which take no skip (they ignore a `socialSkip` in the body; tested). In Compose, Breaking is a checkbox on the same form as the "Post to" group, and silently ignoring a visible untick would be worse than honouring it. One line in `/api/send` would refuse the combination instead (400); say if you prefer that. Acceptance 8's "Breaking campaigns have `socialSkip = []`" holds for every Breaking that does not come from Compose, and for Compose-Breaking when nothing is unticked.
3. **The row key is always the push's own, and the skipped push leaves the page's candidates.** Under today's rule (one post per article, keyed by the article) a skip row on the article's key, or a skipped push left as the article's "oldest push", would stop a later push of the same URL from ever posting (acceptance 6). Both halves are tested, under both rules, on LinkedIn and Facebook; **disabling the exclusion makes exactly those two tests fail** (`LinkedIn 6b`, `Facebook 6`), which is the blocking bug the brief warned about. `src/services/social/composeSkip.ts` has the reasoning in its header.
4. **Existing tests I edited (all because they pin what this change legitimately adds; each says why in a comment):** `linkedinAcademy.test.ts` (2 tests) and `linkedinWorker.test.ts` / `facebookWorker.test.ts` ("reads only the columns": each worker now makes one more small campaign read per page per tick, the Compose-skip read, identified by its `socialSkip` filter and asserted separately); `socialEveryLink.test.ts` (the `isAllPushesCampaign` call-site scan: +1 in `services/social/composeSkip.ts`, +1 each in the two screen routes, +1 in the WhatsApp queue; those tests exist to flag new callers); and **`socialPicture.test.ts` test 9, whose before/after counts were TABLE-WIDE** (`linkedInPost.count()`), so any other test file writing LinkedIn rows at the same moment broke it at random. It failed once in my first full run (96 vs 99) and passes alone. I scoped the two row counts to the test's own campaigns (none exist, by the assertion above them), keeping its intent and removing the race; worth knowing since a Release check could hit the same flake on any develop.
5. **The one-time send id is NOT renewed after a successful send** (the brief says the ticks reset "like the one-time send id"). In the real Compose code the id is deliberately kept (`keepRequestIdOnce`: pressing Send again on unchanged text must still meet `duplicate_send`), and the UI agent kept that and confirmed it live. The ticks reset after every accepted send (immediate or scheduled); they are not part of that watch.
6. **Audit:** the immediate send's `CAMPAIGN_DISPATCHED` entry carries `socialSkip` (keys only; absent when nothing was unticked). A **scheduled** send writes no audit entry today (no enum value exists, and a new one needs a migration), so its stored `Campaign.socialSkip` is the record.

## What it does
- `Campaign.socialSkip String[] @default([])`, additive migration `20261109070541_campaign_social_skip` (one `ALTER TABLE ... ADD COLUMN`). The pacer, RSS captures, Push now, the backfill clone (`cloneForResend` copies nothing of it) and a bearer send leave it empty.
- `activeSocialPages()` (`src/services/social/pages.ts`): LinkedIn pages from `portalPages()` (only while `LINKEDIN_POSTING_ENABLED`), Facebook pages with a valid id + token (only while `FACEBOOK_POSTING_ENABLED`), `whatsapp` (only while its queue is on). Keys `linkedin:<page>`, `facebook:<page>`, `whatsapp`; labels `LinkedIn · Taxscan` etc. A later Facebook Academy/Shopscan page joins with no Compose change (tested at the key level). `GET /api/social/pages` serves it (ADMIN/PUBLISHER or the bearer).
- `POST /api/send`: `socialSkip: string[]` (each name once), every key must be in the list at send time, else `400 { error: 'unknown_social_page', keys, message }` **before anything is read or created** (no campaign, no send, no rows, and the one-time id stays usable: tested). Stored on the scheduled path too.
- Workers: at the top of each page's turn (DB only, no call, no budget, not gated by a login stop, a Facebook gap/daily cap/stop or the daily quota guard) a push that names the page gets ONE `SKIPPED` row, error `compose_skip`, attempts 0, key `push:<id>:<ms>`; and only if it would have posted there (any qualifying push from the page's all-pushes time, a public article before it). It then leaves that page's candidates.
- Screens: the LinkedIn / Facebook list routes derive `SKIPPED` + `skipReason: 'compose_skip'` for such a push even before the worker has written its row (no flicker through "Waiting"), never group it with the article, and keep Retry/Skip refused (409). The Campaigns Channels marks read `SKIPPED` with `skipReason` in the detail (whatever rows exist: an article's row from another push cannot hide it).
- Compose (ui-developer): "Post to" under the picture field, all ticked on open and after each accepted send; hidden when the list is empty or fails; `Not posted to: <labels>` on the Send-now confirm (a new optional `note` on `ConfirmPush`, so Queue/Review dialogs are unchanged); phone layout one 44 px row per page at 16 px. The three SOCIAL screens and the Campaigns tooltips say "Skipped in Compose" (never the code), with no action buttons on such a row.

## Files changed
- `prisma/schema.prisma` + `prisma/migrations/20261109070541_campaign_social_skip/`
- New: `src/services/social/pages.ts`, `src/services/social/composeSkip.ts`, `src/routes/socialPages.ts`, `src/__tests__/socialComposeSkip.test.ts` (45 tests)
- `src/app.ts` (mount `/api/social`), `src/routes/api.ts` (schema, validation, scheduled create), `src/services/send.ts` (input, create, audit), `src/services/linkedin/worker.ts`, `src/services/facebook/worker.ts`, `src/routes/linkedin.ts`, `src/routes/facebook.ts`, `src/services/whatsapp/queue.ts`, `src/routes/whatsapp.ts` (409), `src/services/metrics.ts` (Channels marks)
- `admin/src`: `views/Compose.vue`, `components/ConfirmPush.vue`, `views/LinkedIn.vue`, `views/Facebook.vue`, `views/WhatsApp.vue`, `views/Campaigns.vue`
- Docs: `docs/LINKEDIN_POSTING.md` (new section "Compose: untick a page for one push", API note), `docs/FACEBOOK_POSTING.md` (matching section), `docs/Taxscan-Push-Admin-Guide.html` (v2.30 -> **v2.31**: Compose field table + "Post to: leave a social page out of one push", WhatsApp, LinkedIn and Facebook sections)
- Existing tests edited: see point 4.

## Migrations
`20261109070541_campaign_social_skip`: `ALTER TABLE "Campaign" ADD COLUMN "socialSkip" TEXT[] DEFAULT ARRAY[]::TEXT[];` Additive only; code that does not know the column is unaffected (safe through a rolling deploy). The R2 backup exports `Campaign` through its model delegate, so the column travels with it (not separately tested).

## Flags / env
None. The group appears whenever any social channel is on and every page starts ticked.

## Test results (verbatim)
- `npx tsc -p tsconfig.json --noEmit` - no output, exit 0
- `npm run lint` - `eslint "src/**/*.ts"`, no output (clean)
- `cd admin && npm run build` (vue-tsc + vite) - `✓ built in 2.23s`
- `npx prisma migrate status` - `Database schema is up to date!` (57 migrations)
- New file: `Test Suites: 1 passed, 1 total` / `Tests: 45 passed, 45 total`
- **Full suite (`Full suite: yes`; schema + send path), `NODE_OPTIONS=--max-old-space-size=1536`, `nice`:**
  - first run: `Test Suites: 2 failed, 108 passed, 110 total` / `Tests: 2 failed, 2616 passed, 2618 total`. The two: the `socialEveryLink` call-site scan (my added callers, expected counts updated: that test is built to flag exactly this) and the `socialPicture` table-wide count race described in point 4.
  - **final run, after those two edits: `Test Suites: 110 passed, 110 total` / `Tests: 2618 passed, 2618 total` / `Time: 56.94 s`.** One `A worker process has failed to exit gracefully` line, as in the earlier full runs (not traced).
- **The new tests bite** (worker/queue temporarily changed, restored byte-for-byte after each): skipped pushes kept as candidates in both workers -> `Tests: 2 failed, 43 passed, 45 total` (LinkedIn 6b and Facebook 6, the "later push of the same URL under today's rule" cases); WhatsApp ignoring the skip -> `Tests: 3 failed, 42 passed, 45 total`.

## Acceptance tests
1. `GET /api/social/pages` lists exactly the active pages in order; an inactive LinkedIn page (Academy/Shopscan unset), Facebook off, WhatsApp off, `LINKEDIN_POSTING_ENABLED` off and "nothing on" are all absent/empty; a Facebook page without a valid id/token is not offered; 401 without a login - **PASS**
2. A send with no `socialSkip` (or `[]`) stores an empty list and every worker posts everywhere (LinkedIn three pages, Facebook, WhatsApp To do) - **PASS**
3. `socialSkip` with one LinkedIn page: the other pages post; that page gets one SKIPPED `compose_skip` row (push key, attempts 0) and no API call; every page unticked = no LinkedIn call at all - **PASS** (private page names in the worker; the real keys through the send route)
4. Facebook + WhatsApp unticked: no Facebook call, a `compose_skip` row; WhatsApp a SKIPPED row, never To do, mark API 409 - **PASS** (WhatsApp derived, point 1)
5. Unknown / inactive / malformed key -> 400 `unknown_social_page`, no campaign, no rows, the one-time id still usable; a body that is not a short-string list is the ordinary 400 - **PASS**
6. A later push of the same URL from another door posts on the skipped page: LinkedIn (new rule, today's rule, and the reverse order), Facebook (both rules), WhatsApp (To do); a skip row never blocks any other push - **PASS**
7. A scheduled Compose send keeps its `socialSkip` through SCHEDULED -> SENT and the worker honours it when it fires - **PASS** (the sweeper's own claim + `executeCampaign`; the sweeper itself sweeps every scheduled row in the database, so a test does not run it)
8. Pacer / RSS default, Queue Push now and Review Push now (a `socialSkip` in the body is ignored; Review also with Breaking) and the backfill clone store `[]` - **PASS**; Compose-Breaking honours an untick (point 2)
9. Compose screen, real browser, desktop and 375 px (`ui-developer`, Playwright Chromium, no worker, no social call): group shown and all ticked; untick -> the confirm names the pages; after an accepted send all ticked again; empty list and a failing list hide the group; the body carries exactly the unticked keys and no field when all ticked; the 400 path shows the server's message and refreshes the list - **PASS**. Screenshots (not in the repo; SAMPLE rows) under `/private/tmp/claude-501/-Users-bestdoc-Documents-taxscan-push/963246c2-195c-4c4d-94e1-55b004759fb2/scratchpad/ui-check2/`: `a-compose-desktop-5-ticked.png`, `b1-compose-375-group-5-ticked-viewport.png`, `b2-compose-375-full-page.png`, `c1-compose-desktop-group-2-unticked.png`, `c2-compose-desktop-confirm-not-posted-to.png`, `c3-compose-375-confirm-not-posted-to.png`, `d1-compose-desktop-after-send-all-ticked-again.png`, `e1-...empty-list-group-absent.png`, `e2-...list-request-fails-group-absent.png`, `g1-...unknown-social-page-refreshed.png`, `h1`-`h7` (LinkedIn three pages, Facebook, WhatsApp, 375 px) and `i1`/`i2` (Campaigns). I opened `c2` and `h7`: they show what the agent reported.
10. LinkedIn, Facebook, WhatsApp screens and the Channels marks show it as skipped in Compose: SKIPPED + `skipReason` before and after the worker's row, no action buttons (Retry/Skip answer 409: tested on LinkedIn; Facebook uses the same status rule, not separately tested), a later push of the same URL an ordinary row next to it; the Channels mark wins over a row another push of the same article left - **PASS** (API tests here; wording in the browser by the UI agent)
11. The send's audit entry carries the skipped keys (keys only; no `@`, no token), and has no such field when nothing was unticked - **PASS**

## Agents run
- `ui-developer` (one, background): Compose group, the three SOCIAL screens' wording, Channels tooltips, real-browser check (desktop + 375 px). Served the real API through a throwaway `createApp` script (fake sender, no workers, no social call); cleaned up its seeded rows and audit rows in the private build DB. Scripts and server log stay in the scratchpad `ui-check2/`.
- The backend, tests and docs I did myself (no second agent in parallel).

## Deviations from the brief
- WhatsApp: derived status instead of a persisted `WhatsAppPost` row (point 1).
- Compose-Breaking honours the untick (point 2).
- The one-time send id is not renewed after success (point 5).
- Compose has no "test-segment-only" target (it offers All and By topic), so there was no such send to ignore; **Test on this device** builds its own payload and never carries `socialSkip` (the UI agent confirmed in the browser).
- Not replicated: the 14-day "an earlier push of the same article before go-live" look-back. A compose-skipped re-push of an article first pushed before a page's go-live gets a SKIPPED row although it would never have posted there; harmless and shown as skipped.

## Worth remembering
- Each of the two post workers now makes one more campaign read per page per tick (4 a minute with three LinkedIn pages and Facebook): `socialSkip { has: <key> }` over the SENT pushes since go-live, almost always empty, no index on the array (the list is the same size the main read already scans).
- A skip row is written whatever the page is waiting for, because it makes no post; the Facebook gap and daily cap count posts only.
- `skipRows()` decides "would it have posted" with the page's own two rules; the screens and the Channels marks derive their SKIPPED from the campaign's own `socialSkip`, so they agree with the workers without waiting for a row.
- The UI agent noticed, unchanged: the Campaigns Channels column clips the third (`fb`) mark at 1280 and 1500 px (existing layout); WhatsApp's existing 404 "no longer on the list" message is cleared by the reload that follows (existing), while the new 409 message is set after the reload.

## Clean-up (planning runs this after merging)
```sh
git worktree remove ../taxscan-push-worktrees/compose-skip-pages
dropdb taxscan_push_build_compose-skip-pages; dropdb taxscan_push_build_compose-skip-pages_shadow
git branch -D build/compose-skip-pages; git push origin --delete build/compose-skip-pages
```
