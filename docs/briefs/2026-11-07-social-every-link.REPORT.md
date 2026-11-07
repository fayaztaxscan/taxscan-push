# REPORT: 2026-11-07-social-every-link

- **Code commit:** `8677ae3` — `feat(social): every push reaches social, whatever page it links to (brief 2026-11-07-social-every-link)`
- **Branch:** `build/social-every-link` (cut from `origin/develop` `7066776`)
- Status: **built, all 11 acceptance tests PASS, full suite green (3rd run; see below).** No mismatch between the brief and the code.

## Design in one paragraph
`SOCIAL_ANY_LINK_FROM` is parsed like the other all-pushes times (`parseAllPushesFrom`) into `env.social.anyLinkFrom`. A new sibling of `storeLinkOf`, `pageLinkOf()`, recognises "any other page on a host named in `ALLOWED_PUSH_HOSTS`" (not an article, course or product); `pageUtmContent()` gives `collections-all` / `pricing` / `home`. **The time check is inside `isAllPushesCampaign()` itself**: a page push qualifies only when `lastSentAt >= SOCIAL_ANY_LINK_FROM`, and a push with **no** `lastSentAt` never qualifies (fail closed). So no caller can skip it, and a caller that forgot `lastSentAt` posts nothing rather than the past. Each caller still does its own channel split first (the channel's all-pushes time), which is the brief's "that channel's page already follows the all-pushes rule at that send time". `storeLinkOf` is untouched; course, product and article code paths are untouched (the shared tail of the two store builders was moved into a private function, unchanged).

## Files changed
- `src/lib/env.ts` — `SOCIAL_ANY_LINK_FROM_VAR`, `env.social.anyLinkFrom`.
- `src/services/social/allPushes.ts` — `pageLinkOf`, `pageUtmContent`, `PageLink`; the time check in `isAllPushesCampaign` (new optional 3rd parameter for tests); header comment.
- `src/services/social/storePage.ts` — the card fetch may also be pointed at an other page (https only, host named in `ALLOWED_PUSH_HOSTS`); everything else about the fetch is unchanged (no redirects, 5 s, capped read, fixed-word reasons).
- `src/services/linkedin/post.ts` — `buildPagePost`; `buildStorePost` and `buildPagePost` share a private `cardPost` (the old body, moved unchanged).
- `src/services/linkedin/worker.ts` — `attempt()` picks `buildPagePost` for a page link; `kind=page` in the log; plain error text for a bad page link.
- `src/services/facebook/post.ts` — `buildFacebookPagePost`, sharing a private `storeLikePost` with `buildFacebookStorePost`.
- `src/services/facebook/worker.ts` — same branch and `kind=page`.
- `src/services/whatsapp/pushText.ts` — the page post (bold title, short line, link) and `pushKindOf` → `'page'`.
- `src/services/whatsapp/queue.ts` — `QueueRow.kind` type gains `'page'`.
- `admin/src/views/WhatsApp.vue` — `kind` type, the "Page" label, one CSS rule (ui-developer).
- `docs/LINKEDIN_POSTING.md` ("Other pages", variable row), `docs/FACEBOOK_POSTING.md` ("Other pages", variable row), `docs/BACKUPS.md` (restore step: set `SOCIAL_ANY_LINK_FROM` to the restore time or unset it), `docs/Taxscan-Push-Admin-Guide.html` (one sentence in section 11; version **2.25 → 2.27**, footer 2.24 → 2.27).
- `src/__tests__/socialEveryLink.test.ts` (new, 65 tests) and `src/__tests__/socialEveryLink.golden.json` (output captured from develop, see acceptance 9).
- `src/__tests__/socialAllPushes.test.ts`, `src/__tests__/whatsappAllPushes.test.ts` — three assertions updated (see Deviations).
- `docs/briefs/2026-11-07-social-every-link.shots/` — 8 screenshots (report commit).

## Migrations
None.

## Flags / env
`SOCIAL_ANY_LINK_FROM` — default unset (= off). Not set by this build.

## Every caller of `isAllPushesCampaign` (the brief's main risk)
Eight call sites in six files. In each, the campaign passed carries `lastSentAt` (checked by reading the `select`/type at each site), and each has a behaviour test with a real other-page push, including the one-second-before case. A source-scan test (`socialEveryLink.test.ts`, "every call site…") pins **exactly these 8 calls in these 6 files**, so a new or removed caller fails it and must be reviewed.

| # | Call site | `lastSentAt` reaches the predicate | Channel split before it | Covered by |
|---|---|---|---|---|
| 1 | `routes/linkedin.ts` (LinkedIn screen) | yes: `select { id, title, url, target, lastSentAt }` | `pushesFrom && c.lastSentAt >= pushesFrom` | "the screens › LinkedIn screen" (WAITING → POSTED; one second before: no row; setting removed: rows leave the list, DB untouched) |
| 2 | `routes/facebook.ts` (Facebook screen) | yes: same `select` | same | "the screens › Facebook screen" |
| 3 | `services/linkedin/worker.ts` | yes: the call is inside `pushesFrom && sentAt && sentAt >= pushesFrom`, and the `select` includes `lastSentAt` exactly when `pushesFrom` is set | the page's own all-pushes time | "LinkedIn worker" 1–8, 11 (both pages; acceptance 3 through the worker) |
| 4 | `services/facebook/worker.ts` | yes: same shape | the page's all-pushes time | "Facebook worker" 1–8, 11 |
| 5 | `services/whatsapp/queue.ts` `getQueue` | yes: `select … lastSentAt` | `from && c.lastSentAt >= from` | "WhatsApp queue and marks" 1–7, 11 |
| 6 | `services/whatsapp/queue.ts` `markArticle` | yes: `select … lastSentAt` | same | "WhatsApp … 10." (Posted, Skip, undo; `not_found` before the time or with the setting removed) |
| 7 | `services/metrics.ts` `channelsFor`, LinkedIn + Facebook (`pushKeyOf`) | yes: the loop requires `c.lastSentAt &&` | `liNew` / `fbNew`: `lastSentAt >= pushesFrom` | "Campaigns Channels marks" (real `listCampaigns`) |
| 8 | `services/metrics.ts` `channelsFor`, WhatsApp (`waPushKeyOf`) | yes: `c.lastSentAt &&` | `c.lastSentAt >= waPushesFrom` | same |

**Mutation check (to prove the tests can fail):** I temporarily removed the time check from the predicate and ran `socialEveryLink.test.ts`: **9 tests failed**, across the LinkedIn worker, Facebook worker, WhatsApp queue, WhatsApp marks, both screens, the Campaigns marks and the predicate. Restored (no trace left; the committed file has the check).

## Test results (verbatim)
- `npx tsc -p tsconfig.json --noEmit` → exit 0, no output.
- `npm run lint` → `eslint "src/**/*.ts"`, exit 0, no output.
- New tests: `socialEveryLink.test.ts` — `Tests: 65 passed, 65 total`.
- Area tests: `socialAllPushes.test.ts` + `whatsappAllPushes.test.ts` (after the three assertion updates) — `Test Suites: 2 passed, 2 total` / `Tests: 261 passed, 261 total`. (Also inside the full suite: every `linkedin*`, `facebook*`, `whatsapp*`, `campaignChannels` file.)
- Admin build (`cd admin && npm run build`, includes `vue-tsc`; ui-developer): `✓ 128 modules transformed.` … `✓ built in 2.15s`, exit 0.
- **Full suite — ran, because the brief says `Full suite: yes` and the change touches config/env.** Three runs on the same code (`NODE_OPTIONS=--max-old-space-size=1536 nice -n 10 npx jest`):
  1. `Tests: 3 failed, 2421 passed, 2424 total` — the 3 failures were the three existing assertions that pinned the old rule (see Deviations); fixed.
  2. `Tests: 1 failed, 2421 passed, 2422 total` — `audienceIngest.test.ts`, "seq 7 deleted, erasure TRUE": `expected 16, received 17` on a **global** `AuditLog` count of `AUDIENCE_ERASURE` rows, i.e. another test file running in parallel wrote an audit row between its two reads. It passes alone, twice (`Tests: 78 passed, 78 total` both times). This is the known cross-file shared-database flake; this build touches no audience or audit code.
  3. **`Test Suites: 103 passed, 103 total` / `Tests: 2422 passed, 2422 total`**, exit 0. (Run 1 had two more tests: I removed two refusal cases that now qualify.)
  - Each run printed `A worker process has failed to exit gracefully and has been force exited`; I did not investigate it and cannot say whether it is new.

## Acceptance tests
| # | Result | Where (`socialEveryLink.test.ts` unless noted) |
|---|---|---|
| 1. Setting unset: the three pages make no row on any channel; articles, courses, products as today | PASS | predicate "1."; LinkedIn / Facebook worker "1." (an article, course and product post, the three pages do not); WhatsApp "1."; Campaigns marks "1." |
| 2. Setting set: each of the three, at or after the time, one row on LinkedIn Taxscan, LinkedIn Academy, Facebook, WhatsApp | PASS | LinkedIn worker "2." (3 rows on each page, 6 posts), Facebook worker "2.", WhatsApp "2." (labelled `page`, push order, copy text), Campaigns marks "a page push at or after the time", both screens |
| 3. One second before the time: no row on any channel, however old; switching on posts nothing from the past | **PASS — through every path** | predicate "2–3."; LinkedIn worker "3." (a push one second before, one at 08:30 after every page's own time, one before go-live: nothing; then the same second after posts); Facebook worker "3."; WhatsApp "3."; Campaigns marks "3."; both screens; and the mutation check above |
| 4. A page that has not switched on its all-pushes rule gets no row | PASS | LinkedIn worker "4." (Academy off; and a time later than the push), Facebook "4.", WhatsApp "4.", Campaigns marks "4." |
| 5. Off the allowlist and test-segment-only: no row, setting on | PASS | predicate "5."; every channel's "5."; permissive (empty allowlist) mode makes no page |
| 6. One set of the channel's UTMs; the push's own gone; other parameters stay; `collections-all`, `pricing`, `home` | PASS | LinkedIn "6.", Facebook "6.", WhatsApp "6."; `pageUtmContent` unit test (also decode, 100-char cut) |
| 7. A resend makes a new row; two overlapping ticks post one | PASS | LinkedIn "7.", Facebook "7.", WhatsApp "7." |
| 8. A failed, slow or redirecting page fetch still posts with the push's wording and no picture (LinkedIn and Facebook) | PASS | LinkedIn: timeout / redirect / 404 / network / throw, and through the **real** `fetchStorePage` with a redirecting and a slow `fetch` (no URL, body or header in any log; `redirect: 'error'`); the fetch guard tests (https only, named host, userinfo, port, lookalike host, 301, 404, abort). Facebook: the page post is pure and synchronous, **there is no fetch to fail** (Facebook builds the card itself) |
| 9. Unchanged article, course and product post: byte-identical text and link, on all channels | PASS | `socialEveryLink.golden.json` was produced by running the same script on **untouched `origin/develop`** (`401ab18`) and on this build, and diffing the two JSON outputs: **identical except `pushKindOf` for `/pricing` and `/collections/all` (null → `page`)**, which is the change. The test recomputes the output and compares it with the golden: LinkedIn course / course-fetch-failed / product / article, Facebook course / product / article, WhatsApp article / push-article / course / product, and the URL fetched for a course card. (The script is not in the repo.) Existing exact-text tests in `socialAllPushes`, `linkedin*`, `facebook*`, `whatsapp*` also pass. |
| 10. WhatsApp shows the row with its label and working Copy, Posted, Skip; Campaigns shows its Channels marks; browser, stubbed API, screenshots | PASS | ui-developer, Playwright Chromium against the Vite dev server with `/api/*` stubbed (fake content only; no request left localhost, no unstubbed call, no console error), desktop 1280 and a real 375×812 viewport. Screenshots below. |
| 11. Removing the setting reposts nothing; rows already made keep their status | PASS | LinkedIn "11." (a FAILED row stays FAILED, POSTED stays POSTED, a new page push adds nothing) plus a retry of a FAILED page row still posts after the setting is gone (the LINK picks the builder, never the time); Facebook "11."; WhatsApp "11." (the mark stays in the table); Campaigns marks "11."; both screens |

**Screenshots** (`docs/briefs/2026-11-07-social-every-link.shots/`): `whatsapp-page-row-desktop.png`, `whatsapp-page-row-375.png` (rows in push order: Page, Article, Course, Shop; the Page row carries the real post-text shape), `whatsapp-copied-desktop.png`, `whatsapp-copied-375.png` (Copy), `whatsapp-after-posted-desktop.png`, `whatsapp-after-posted-375.png` (Posted on the page row, Skip on the course row, counts), `campaigns-page-marks-desktop.png`, `campaigns-page-marks-375.png` (a waiting and a done page push beside an article in the same two states: identical marks). I looked at `whatsapp-page-row-375.png` and `campaigns-page-marks-desktop.png` myself. The Posted and Skip requests the agent saw were `POST /api/whatsapp/queue/<id>` with `{status, articleKey: "push:…"}`.

## Agents run
- `ui-developer` (one, background): the "Page" label and its CSS, the browser check of the WhatsApp and Campaigns screens at desktop and 375 px, the screenshots. Finding: **the Campaigns screen needed no change**; `Campaigns.vue` draws a mark whenever `channels.<x>` is truthy and never looks at the URL or kind, so a blank mark can only come from the server sending `null`.
- I did the backend, the tests, the golden capture (a throwaway worktree of `origin/develop`, already removed), the docs, and the full suite myself.

## Deviations from the brief
1. **Three existing assertions were updated, because they pinned the rule this brief changes**: in `socialAllPushes.test.ts`, "a collection → page_host" and "the academy home page → page_host" (the card fetch now accepts other pages, https only; the two cases are removed from that list and the new behaviour is tested in `socialEveryLink.test.ts`); in `whatsappAllPushes.test.ts`, "a shop collection gives no post text" (now it has the course-shaped post; the "no post" case is an unlisted host, and the new shape is asserted). Every other existing assertion is unchanged and passes.
2. **`pageLinkOf` requires the host to be *named* in `ALLOWED_PUSH_HOSTS`**, not merely "allowed" by `isAllowedPushUrl` (which allows everything when the list is emptied). Reason: the card fetch must never be pointed at a host nobody listed (SSRF). With the list emptied, nothing counts as a page. Production has the list set.
3. A page link qualifies on http as well as https (as an article does), but **the card fetch is https only**, so an http page posts with the push's wording and no picture.
4. **Guide version 2.27**, not 2.26: the `free-digest-segment` build also bumps from 2.25 to 2.26 (and fixes the stale 2.24 footer). Both edit the same three lines of `docs/Taxscan-Push-Admin-Guide.html`, so **expect a trivial merge conflict there**; resolve to 2.27 if social merges second.
5. No boot log line for `SOCIAL_ANY_LINK_FROM` (the brief did not list one).

## Worth remembering (planning decides what becomes record)
- **The trap the brief named is closed in the predicate, not in eight places**; the remaining risk is a *future* caller. The source-scan test is there for that. A caller whose `select` omits `lastSentAt` posts nothing and shows no mark, with no error: if a future change does that, the first symptom is silence.
- With the setting **unset or removed, the LinkedIn / Facebook screens stop listing page pushes** (they are not candidates), though their rows stay in the database with their status. Same shape as courses and products when their all-pushes time is removed today.
- `utm_content` for a page is the decoded path segments joined by `-`, cut to 100 (`/collections/all` → `collections-all`, `/` → `home`). A deeper path such as `/collections/gst-books/products/x` becomes a **page** now (`collections-gst-books-products-x`): it is not a course or product (`storeLinkOf` is course/product only, as the brief says).
- The card page is fetched at `https://<host><path>` of the push: **its query and fragment dropped**, no trailing-slash normalisation (the course fetch adds one for WordPress; Shopify and the new CMS do not need it).
- LinkedIn repeats a post it rejected with a 4xx **once without the picture**, so a page row only stays FAILED when the card has no picture (relevant if you test a failure by hand).
- Suggestions, not built: (a) the Campaigns "Channels" column tooltip says "Whether the **article** was also posted…" and the WhatsApp screen's nudge opt-in says "when **articles** are waiting": both read slightly off now that pages post too; (b) a boot line like the other all-pushes ones (`[social] any link on for SOCIAL_ANY_LINK_FROM (from …)` / off and why).
- Not checked: the WhatsApp **Share** button (headless Chromium has no `navigator.share`). The Campaigns table scrolls 11 px sideways at 1280 with the Channels column (existing layout, every row).
- `src/lib/env.ts` is also edited by the `free-digest-segment` build, in a different place: expect a small textual merge.
- Switch-on and restore (planning + owner, not this build): set `SOCIAL_ANY_LINK_FROM` to the moment of switch-on, never earlier; after any restore, set it to the restore time together with the other post-from / all-pushes times (`docs/BACKUPS.md`). A page also needs its own all-pushes time on, or its page pushes make no row there.

## Clean-up (planning runs this after merging)
```sh
git worktree remove ../taxscan-push-worktrees/social-every-link
dropdb taxscan_push_build_social-every-link; dropdb taxscan_push_build_social-every-link_shadow
git branch -D build/social-every-link; git push origin --delete build/social-every-link
```
