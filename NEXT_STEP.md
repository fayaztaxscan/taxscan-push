# NEXT_STEP.md — Where I am in Task 12

Snapshot for resuming work after a break. Update this file whenever the
status changes so a fresh Claude session can pick up cleanly.

---

## ▶️ NEXT STEPS / open items (as of 2026-08-06) — BOARD CLEAN in code, ONE user-side

-8 (surfaces: Jan-2026 history + calendar months + custom range) is SHIPPED + LIVE. -7
(session-cookie expiry) is SHIPPED + LIVE. -6, -5 and -4 are
SHIPPED + LIVE. User-side item unchanged: send the editorial note asking taxscan to 301-redirect
deleted duplicates (the residual gap no code can close).

-8. **✅ SHIPPED + LIVE 2026-08-06 — SURFACES: JAN-2026 HISTORY + CALENDAR MONTHS + CUSTOM RANGE.
   PR #51 (merge `e489404`), deployed and serving within ~25s of merge; healthz 200 throughout, no
   migration, no env change.
   VERIFIED IN PRODUCTION, not just by version string:** `/api/reports/surfaces` returns
   `mode=months` with columns **Jan 2026 → Aug 2026\*** (Aug flagged partial) and Discover totals
   `953,962 / 565,047 / 417,508 / 386,162 / 322,318 / 208,884 / 138,837 / 8,676`; `compare` is
   `{current:6, base:5}` = Jul vs Jun, correctly skipping the part-month. `?from=2026-04-01&to=
   2026-06-30` returns `mode=range`, `compare {0,1}`, and a **-53% FALL** — the direction that was
   inverted pre-fix. A reversed range 400s. Guide endpoint serves **v1.3**, 16 pages, SHA-256
   identical to the local build.** Stakeholders asked for three things off the new Surfaces tab: data from
   01-Jan-2026, a custom date filter, and month-to-month comparison. Months-as-columns delivers the
   first and third in one shape, so the tab was rebuilt around them.
   **(1) BACKFILL — DONE, IN PRODUCTION ALREADY (data only, no deploy needed).** `ArticleSurfaceStat`
   went **3,744 → 31,832 rows**, now spanning **2026-01-01 → 2026-08-06**. Run from this machine
   against the prod DB via Railway's TCP proxy (`DATABASE_PUBLIC_URL` on the **Postgres** service —
   the app service's `DATABASE_URL` is `postgres.railway.internal` and is NOT reachable from
   outside). New committed script `scripts/backfill-surfaces.ts` (`npm run backfill:surfaces --
   --from 2026-01 --yes`; dry-run without `--yes`) replaces the old raise-the-lookback-and-revert
   dance — it walks MONTH BY MONTH so each replace-by-date transaction stays small and an
   interrupted run is simply restarted (idempotent).
   **⚠️ THE TRAP THAT COST THE FIRST ATTEMPT:** `syncSearchSurfaces` used ONE `now` for two jobs —
   the query window AND the clock its service-account JWT is signed with. Back-dating `now` to move
   the window back-dates the token, and Google rejects it outright: *"Invalid JWT: Token must be a
   short-lived token"*. Every month failed identically. Fixed by adding explicit
   `startDate`/`endDate` params (they win over `lookbackDays`); `now` stays the real clock. **Use the
   explicit span for ANY historical fetch.**
   **THE DATA IS THE STORY:** Discover clicks by month — **Jan 954,691 · Feb 565,047 · Mar 417,508 ·
   Apr 386,162 · May 322,318 · Jun 208,884 · Jul 138,837**. That is **−85% across seven months**, a
   monotonic slide, and it corroborates the ~88% YoY drop found on 2026-08-05 with month-level
   resolution. Google News is a rounding error throughout (~1-2k/month). **This is an SEO/editorial
   conversation to have, not a bug.**
   **(2) TIME AXIS — trailing windows → CALENDAR MONTHS.** The old 1w/1m/3m/6m/12m columns are
   cumulative, so they all contain the same recent days, all move together, and none isolates a
   month — they structurally hide exactly this trend. Columns now run oldest-first from the first
   synced month to the current one, capped at **18** (`MAX_MONTH_COLUMNS`; a year plus the same month
   a year earlier). The current month is flagged `partial` and hatched, because Search Console never
   reports the newest 2-3 days.
   **(3) CUSTOM RANGE.** `GET /api/reports/surfaces?from&to` → two columns: the chosen span and the
   equally-long span immediately before it, plus Δ. Validated server-side by `customSurfacesWindow`
   (format / calendar / order / future / **400-day** cap — Search Console retains 16 months). Its own
   control on the tab, NOT the coverage Custom tab, which is a different report with a 30-day ceiling.
   **⚠️ THE BUG THE BROWSER CAUGHT, and the reason the payload now states its own comparison:** the
   two modes order columns differently — months oldest-first, range **subject-first**. The UI inferred
   "newest is last", so in range mode every Δ came out INVERTED: a 53% fall rendered as a **111%
   rise**, and Supreme Court read ▲187% when it had dropped 65%. Unit tests all passed; only opening
   the page showed it. The payload now carries `compare: {current, base}`, the client consumes it
   instead of re-deriving, and `comparePair()` is pinned by tests.
   **UI (design pass, existing visual system deliberately unchanged):** headline leads with the last
   complete month + MoM Δ + **distance from the best month on screen** (a single month's number reads
   as fine in isolation; the slope is the story); a per-row **trend sparkline placed BEFORE the
   numbers** (new `TrendLine.vue` — 540 figures become 30 shapes); a totals row per surface; Δ column
   at the far right. Violet stays the Google-clicks ramp, shaded on **share of its own column** so it
   answers "what did Google favour that month" rather than restating the collapse in every row.
   **Small-base honesty:** below 50 clicks in the earlier period the Δ shows the movement
   (**▲ 2.8k**) instead of a true-but-useless **▲ 30711%**.
   **VERIFIED IN A REAL BROWSER** against a copy of production data (local Postgres, dev servers,
   Chrome): months view, range view, the inverted-Δ fix, and that each grid scrolls inside its own
   wrapper at 380px without the page overflowing. **PNG export: ✅ CONFIRMED WORKING by the user
   post-deploy (2026-08-06).** It could NOT be exercised from the automated browser — `toPng` never
   completes there, even for a tiny node, and behaves identically on the untouched Weekly tab — so
   that was the automation context, not a regression, and the user's manual check settled it. The
   precaution that mattered: the sparkline SVGs carry explicit width/height, which html-to-image
   needs to rasterise inline SVG. **Lesson: html-to-image cannot be validated in this Chrome
   automation setup at all — don't burn time re-testing it there, hand it to the user.**
   **Suite 371 → 382.** Guide → **v1.3** (Surfaces section rewritten for months/range/Δ; PDF rebuilt,
   16 pages) and `.box` callouts now carry `break-inside: avoid` after a rebuild split one across two
   pages.
   **⚠️ FOOTGUN FOUND THE HARD WAY: running `npx jest` WIPES local `ArticleSurfaceStat` rows for
   portal `taxscan`** — the route tests clear that portal from whatever DB `DATABASE_URL` points at.
   Fine against the local dev DB; it would be destructive if `DATABASE_URL` ever pointed at prod.

-7. **✅ SHIPPED + LIVE 2026-08-06 — SESSION COOKIE EXPIRY: match the server TTL, and slide it.
   PR #50 (merge `42db65d`), commits `271d055` + `1fd6c45`. Deploy SUCCESS 06:09:52 UTC, all ten
   crons re-registered, healthz 200 throughout, no migration.** Backend-only; no schema, env, flag
   or subscriber-facing change. **Symptom the code predicted:** editors logged out roughly daily
   despite the documented 7-day sliding session. **Two defects, both about the COOKIE, not the
   session row:**
   (1) `SESSION_TTL_HOURS` went 8h → 7 days on 2026-06-19 but `SESSION_COOKIE_MAX_AGE_MS` in
   `routes/auth.ts` stayed at 8h, so the browser stopped sending the cookie long before the row
   expired and the sliding renewal was **unreachable**. Now derived from `SESSION_TTL_HOURS`.
   (2) Even at the right length it never actually slid: `findValidSession` pushes
   `UserSession.expiresAt` out on every request, but the cookie was written **only at login**, so
   the browser copy kept counting down from sign-in — an editor working daily was still logged out
   mid-week with a live session. `requireUser` now re-issues the cookie the moment the session
   validates: **same token, same signature, only the expiry moves** (a new token would invalidate
   requests already in flight from that browser). Re-issued before the role/reset checks so the
   cookie tracks the DB even on a 403 — the two expiries are always the same instant. A rejected
   session writes no cookie.
   **Two things that fall out of sliding on every request:**
   • **Logout** runs behind `requireUser`, which has already queued a fresh cookie — two Set-Cookie
   lines for one name. Last-wins resolves it in practice, but that is not a bet worth taking on a
   logout, so `clearSessionCookie` strips any queued slide header first. Response now carries
   exactly one session cookie and it is the expiring one.
   • **The cookie helpers moved to `lib/auth.ts` as the single definition** (`routes/auth.ts`
   imports them). `res.clearCookie` only matches a cookie whose path/secure/sameSite match how it
   was written, so set and clear MUST share attributes — the same class of drift as defect (1),
   removed rather than kept in sync by convention.
   **Suite 368 → 371** (+3: Max-Age equals the TTL — fails against the old constant; an authed
   request re-issues the SAME token at full TTL; logout sends exactly one, expiring, cookie).
   **⚠️ ROLLOUT — nothing to flip, but not retroactive:** browsers still holding the old 8h cookie
   cannot be amended remotely, so everyone gets ONE more early logout and picks the fix up at their
   **next login**. Telling the team to sign out and back in once makes it immediate.
   **VERIFYING THIS ONE FROM OUTSIDE IS NOT POSSIBLE** — `Set-Cookie` only appears on a SUCCESSFUL
   login, so it needs real credentials (a failed login correctly returns 401 with no cookie, which
   is all an unauthenticated probe can confirm). The 30-second manual check: log out, log back in,
   DevTools → Application → Cookies → `tx_push_session` → **Expires ~7 days out, not ~8 hours**;
   reload any admin page and the expiry jumps forward again = the slide working.
   **Deliberately unchanged:** genuinely idle for 7 days still logs you out. That is the security
   boundary, not a leftover of the bug.
   **Deploy-verification note (this service still has no version endpoint):** the Railway CLI binary
   is broken locally (`railway status` → "could not find the CLI binary"), but `railway whoami` and
   the **stored OAuth session against the GraphQL API still work** — query `project(id:){services}`
   for the service id (it is NOT in `~/.railway/config.json` for this project; `service` is null),
   then `deployments(first:N, input:{projectId, environmentId, serviceId})` for status + commit, and
   `deploymentLogs(deploymentId:)` for the boot lines. Token lives at `config.json` →
   `user.accessToken` (`user.token` is empty) and expires hourly.

-6. **✅ SHIPPED + LIVE 2026-08-05 — GOOGLE DISCOVER / NEWS TRACKING (PRs #46 feature, #47 UI pass;
   merges `5b890ff`, `8817272`). ⚠️ ONE OPEN ITEM: the history backfill (below).**
   **THE HEADLINE FINDING — Discover is taxscan.in's biggest Google channel by a mile.** Measured
   live over 28 days to 2026-08-03: **Discover 109,125 clicks (84.0%) · Search 19,752 (15.2%) ·
   Google News 1,075 (0.8%)**. Discover sends **5.5× more traffic than Google Search**, and it had
   been invisible the whole time. **WHY GA4 COULD NEVER SHOW THIS:** a Discover click carries a
   plain `google.com` referrer, so GA4 files it under `google / organic` next to ordinary search;
   via the Google app the referrer is stripped entirely into `(direct)`. Google News is only partly
   visible (news.google.com referrals) and misses both the News app and the Search News tab.
   **Search Console's `type` parameter (`discover` / `googleNews`) is the ONLY authoritative split.**
   Top Discover pages cluster into two kinds: personal-tax stories a reader feels personally
   (capital gains on a house, cash deposits, deductions) and CA-profession news (ICAI discipline,
   stipends) — NOT the court-hierarchy material the push pacer prioritises. Real editorial signal.
   **Shipped:** `ArticleSurfaceStat` + migration; `searchSurfaces.ts` (flag-gated cron, paginated
   Search Analytics query per surface, canonical URLs normalised through the existing `readsPath()`
   so the join key can't drift from the Reads columns, replace-by-date write, both surfaces fetched
   BEFORE any delete so a second-surface failure can't wipe the first's dates); `surfacesReport.ts`
   + `GET /api/reports/surfaces`; a fifth **Surfaces** tab on Reports. Suite 338 → **365**.
   **Also fixed a latent auth bug this would have tripped:** `getGaAccessToken` cached ONE token in
   a module-level slot with the scope hardcoded to `analytics.readonly`. The moment a
   Search-Console-scoped caller existed, one cron would get the other's token and be rejected — as
   intermittent 403s tracking CRON ORDER, not code. Cache is now keyed by (service account, scope).
   **DESIGN CALL — deliberately NOT columns on Campaigns** (the user raised it and was right):
   Search Console has NO data for the newest 2-3 days (not partial — none), so every fresh campaign
   row would render as no-data, and the em-dash there already means "untracked link" — three states
   collapsing into one glyph on the rows people look at most. Retrospective trailing-window view is
   the honest home. Per-article need is served by a most-surfaced list inside the report instead.
   **UI pass (PR #47)** after the first live read: lead with the answer (per-surface last-month
   clicks) instead of a 90-word warning; a surface under 10% of clicks collapses behind "Show
   breakdown" (threshold COMPUTED, not hardcoded — Discover 84% vs News 0.8% had identical billing);
   cells show clicks only (impressions/CTR/share were already in every tooltip; 2 numbers × a 30-row
   grid = 300 to read past); callout ~90 → ~45 words but still on-panel so it survives the PNG export.
   **⚠️ OPEN — ONE-OFF HISTORY BACKFILL.** The sync fetches a rolling `SEARCH_CONSOLE_LOOKBACK_DAYS`
   (=7), so on 2026-08-05 `dataFrom`=2026-07-29 and EVERY window (1w…12m) reads the same 9,218 —
   the 12-month column would take a year to mean anything. Mitigated honestly, not hidden: the
   payload carries `dataFrom` and the panel says "we only hold N days of history so far" whenever
   history is shorter than the widest window (self-clearing as days accumulate). **To actually fill
   it:** Search Console retains **16 months** — raise `SEARCH_CONSOLE_LOOKBACK_DAYS` (e.g. 180–400),
   let ONE sync run, then put it back to 7. Same env dance as the GA reads 30-day backfill. **Do NOT
   leave it high** — every 6h it would re-fetch and replace that whole span (heavy query, large
   delete+insert). Revert is possible from the Railway dashboard → Variables if a CLI token expires
   mid-way. Not done this session: the stored Railway OAuth token was ~15 min from expiry and the
   user had not yet chosen to run it.
   **Setup facts worth keeping:** property is **URL-prefix `https://www.taxscan.in/`**, NOT a domain
   property (a domain property would also cover academy/shop and remove the apex-URL blind spot).
   Search Console permissions do NOT inherit from GA or GCP — the service account needed adding
   under Search Console → Settings → Users and permissions (**Restricted** is enough), AND the
   Search Console API enabled in GCP project `taxscan-push-ga` (number **641507376203**). **GOTCHA
   that cost a round-trip: Users-and-permissions is PER-PROPERTY**, so the first grant landed on
   `academy.taxscan.in` and every surface read zero. Probe script pattern (mint JWT → `sites.list`
   → per-`type` totals) is the fastest way to confirm both the grant and the volume.
   **Built with a 5-agent workflow** (2 scouts → 2 parallel implementers against a contract fixed in
   the script → 1 adversarial verifier). Fixing the contract in the SCRIPT rather than having an
   agent derive it is what kept two blind implementers from drifting — the seam came back clean and
   re-checked by hand. Verifier found 0 defects; a hand pass still caught a duplicated
   `ARTICLE_PATH_JS_RE` (now exported from readsReport and shared).

-5. **✅ SHIPPED + LIVE 2026-08-05 — ADMIN GUIDE v1.1 (PR #44, merge `88c8da5`).** Docs-only; no
   source/schema/env/flag change, zero subscriber impact. **Trigger:** user noticed the Campaigns
   screen's GA4 **Reads / via Push** columns were absent from the guide. Root cause was broader —
   the guide was **Version 1.0 dated 2026-06-19**, so EVERYTHING shipped after that date was
   missing, and one tip had become actively wrong. What went in: (1) Campaigns → new "the columns
   explained" table (Sent · Clicked/CTR · **Reads** · **via Push**), stating that Clicked measures
   the notification while Reads measures the article, and that **`—` is not a zero** (academy/shop
   links untracked, pre-tracking articles, ~48h GA settling); (2) Reports → new **"The Reads tab"**
   subsection (bench/category × trailing 1w–12m windows + how to read it against the coverage
   report); (3) the **Custom** tab (shipped 07-10) was also undocumented — all four tabs now in a
   table; (4) the emailed report's **"How it was read"** section; (5) Review → new **"Repeat
   headlines"** subsection, because the 72h duplicate guard (item -4) is USER-VISIBLE and editors
   would otherwise see held headlines unexplained; (6) **deleted a stale tip** claiming the
   categories heat-map "fills in over the first week / mostly Uncategorised" — untrue since PR #28
   + #39 (title inference; that row no longer exists); (7) FAQ +5 (Clicked vs Reads · the `—` ·
   repeat headline in Review · article vanishing from the queue = dead-link check ·
   redirect-don't-delete under "Can I undo a send?") and 3 quick-reference rows.
   **Regenerated the PDF** with `npm run build:guide` (12 → 15 pages).
   **PROCESS NOTE — read the rendered PDF, don't just build it:** the first pass pushed section 6
   one box past the page and produced a ~90%-blank page; the block was condensed and rebuilt. The
   HTML is the source of truth (`docs/Taxscan-Push-Admin-Guide.html`); the PDF is generated, and
   BOTH are committed and ship with the deploy — `Guide.vue` only iframes `/api/guide.html` and
   links `/api/guide?download=1`, so there is no third copy to sync.
   **VERIFY-A-DOCS-DEPLOY TRICK (this service has no version endpoint —`/healthz` returns only
   `{"status":"ok"}`):** the auth-gated guide endpoint doubles as one. Take a BASELINE read before
   merging, then poll:
   `curl -s -H "Authorization: Bearer $ADMIN_TOKEN" https://push.taxscan.in/api/guide.html | grep -oE 'Version 1\.[01]'`
   Confirmed live at 12:33 UTC (~2.5 min after merge): v1.0/30,997 B → **v1.1/38,937 B**, "via Push"
   present; PDF endpoint 706,852 B / 15 pages and **SHA-256 identical to the local build**; healthz
   200 throughout.

-4. **✅ SHIPPED + LIVE 2026-07-28 — DEAD PUSH LINKS: duplicate-title guard + pre-push link check.
   Merged via PR #42 (merge `83b9bfe`, commit `03c2fdb`); BOTH FLAGS SET TRUE on Railway at
   13:23 UTC and verified in the live logs** — poll lines now carry `duplicates=`, a field that
   exists only in the new build, which is also how you verify a backend-only deploy here (there is
   no version endpoint; `/healthz` returns only `{"status":"ok"}`). Deploy was zero-downtime
   (healthz 200 throughout). User tapped a notification and got taxscan's 404 page. **Root cause is
   NOT ours** — we push the exact URL the RSS feed gives us. taxscan published the SAME story
   twice as two posts (different ids/slugs); GUID dedupe can't see a re-post, so the second copy
   classified and pushed as fresh news; the desk later deleted one of the two posts, and whichever
   one we'd pushed became a dead link. **Key CMS fact:** taxscan resolves articles by the TRAILING
   ID and 301s any slug (verified: `/top-stories/x-1449424` → canonical). So a renamed headline can
   NEVER break our links — only an actual deletion can.
   **Measured blast radius (GA4, 14 days):** 2 confirmed dead pushes, ~1.5% of ~129 pushes, each
   having reached ~2,550 subscribers — (a) 2026-07-28 18:08 IST *Revenue Cannot Revive…NCLT: Bombay
   HC* (id `1449457` deleted, `1449424` survives); (b) 2026-07-27 08:24 UTC *Tax and Interest…
   Unutilised GST ITC: Madras HC* (id `1449354` recorded 51 live views **then 14 "Page Not found -
   404" views** — caught mid-deletion; `1449379` survives). Everything else healthy: 6,443
   push-attributed pageviews/14d with no systemic breakage, all 38 queued URLs live. A third
   suspect (Gujarat HC pre-deposit) was a FALSE POSITIVE — its article is fine (1,653 views); the
   dead hits were a truncated `/financial-incapacity-to-pay-rs-19l` with no id (someone's broken
   copy-paste, not our push).
   **GOTCHA for re-measuring:** filtering GA by `sessionSource='taxscan-push'` UNDERCOUNTS 404
   landings badly (returned 0) — GA4 session attribution reflects how the SESSION started, so a
   push click inside an existing session isn't tagged. Query `pageTitle` EXACT `Page Not found -
   404` across ALL sources instead, then cross-reference paths against pushed titles. The 404 page
   does fire GA (`G-2PTEG0Z7SB`), so it is measurable. Also: `/api/campaigns` does NOT return `url`
   (dropped in the DTO), and the railway CLI is NO LONGER installed on this machine — GA was the
   only route to this answer.
   **Shipped (commit on `develop`, suite 338/338, was 324):** (1) `DUPLICATE_TITLE_GUARD_ENABLED`
   (+`DUPLICATE_TITLE_WINDOW_HOURS`=72) — `normalizeTitle()` in `poller.ts` strips `[Read Order]`
   tags/punctuation/case; a headline already captured inside the window routes to **REVIEW**
   (defer-not-drop, so the weekly Round-Up just needs an approve click) and the poll result gains a
   `duplicates` counter. (2) `LINK_CHECK_ENABLED` (+`LINK_CHECK_TIMEOUT_MS`=5000) — the pacer HEADs
   the URL after its atomic claim, and archives a deleted article as **EXPIRED** (NOT back to
   DRAFT, else every later tick re-picks it and the queue wedges); new reason `dead_link`; the slot
   isn't consumed since no SENT event is written. **FAIL-OPEN by design** — only 404/410 count as
   dead; timeouts/5xx/network errors send as normal.
   **RESIDUAL GAP — cannot be fixed in code:** if taxscan deletes the copy we already pushed, the
   notification is already on 2,550 phones and its link can't be edited. Deletion is not
   consistently the newer copy (07-28 newer deleted, 07-27 OLDER deleted). The only complete fix is
   editorial: **301-redirect a removed duplicate to the survivor instead of hard-deleting it** —
   drafted at `docs/NOTE-TO-EDITORIAL-deleted-articles.md` (untracked, per the docs/ precedent).
   **REMAINING (user-side):** send that note to the desk.
   **Watch:** the poller logs `duplicates=N` each tick (a hold also prints
   `[rss] duplicate headline within 72h → REVIEW: "<title>"` and the article lands on Review); the
   pacer logs `[pacer] article gone from the site — archived, not sent` and flips that campaign to
   EXPIRED. At ~3 republishes/week, expect the first `duplicates=1` within days, not hours.
   **Railway access note:** the `railway` CLI is NO LONGER installed here, but the stored OAuth
   session at `~/.railway/config.json` still works against the GraphQL API
   (`https://backboard.railway.com/graphql/v2`, `Authorization: Bearer <accessToken>`) — that is
   how these flags were set (`variableUpsert`; project `b08dbc23…`, env `9bd24594…`, service
   `dae954c6…`). The access token is short-lived (~1 h), so re-read it from the config each time.

Everything below is history. First scheduled coverage email carrying the "How it was read"
section went out **Mon 2026-07-13 07:00 IST** — confirm with the user it landed well.

-3. **✅ SHIPPED to `main` 2026-07-15 — editorial CONFIRMED; FEMA kept as a separate row.**
   The user delivered the corrections as **column G of `docs/News-vs-Articles-Study.xlsx`** (71
   keyword→category rules, e.g. "DGFT, Import- Customs"). Decisions taken: strong **title keyword
   wins over generic RSS tags**; **broad keywords constrained to safe phrasings**; do **BOTH** the
   category remapping AND the News/Articles/Job split. Shipped to `develop` (commit `b0d08b5`,
   suite **324/324**) — report-only, no migration/flag, history reclassifies; `readsReport` moved
   to the new row-key helpers so the Reads tab + email stay in sync. What changed in
   `src/services/reports.ts`: (1) `reportCategory` now title-first; (2) widened Income Tax / GST /
   Customs / Corporate / Other Taxations / Audit / Benami keyword sets (safe forms only); (3) bug
   fixes the data caught — `\bGST\b` missed **GSTR/GSTN/IGST/CGST/SGST**, "Income‑Tax" with a
   U+2011 hyphen missed the rule, `CIT(A)` trailing `\b`; (4) `detectBench` gains **DRT + DRAT**,
   `CESTAT` relaxed for PCESTAT; (5) `detectContentType` + `categoryRowKey`/`benchRowKey` split
   **Uncategorized → Other News / Articles – General** and **Unspecified → No bench – News/
   Articles/Job posts**. **Coverage 59/71**; the 12 held back are broad-word collisions +
   the FEMA question (default safely). Fixtures committed as regression oracles
   (`src/__tests__/fixtures/content-type-groundtruth.json` 240/240 lock +
   `category-corrections.json` ≥59). **Editorial PDF produced** (`docs/News-vs-Articles-Report-
   Corrections.{html,pdf}`, untracked) — circulated + confirmed. **FEMA-row decision = keep
   separate** (already the default; no code change). Merged develop→main (Railway auto-deploys;
   report-only, internal, zero subscriber impact). **Item -3 DONE — board clean.** The 12
   held-back items stay uncaught by design (broad-word safety). The original study groundwork
   (below) is unchanged. ~~PAUSED on user data~~ — data received + shipped. Groundwork
   already complete (this session's News-vs-Articles study): dumped ALL prod campaigns
   (1,273 rows → 1,137 unique articles, 2026-06-01→07-13) via
   `railway variables --service Postgres --json` → `DATABASE_PUBLIC_URL` → read-only psql,
   replayed the report's own dedupe/classify pipeline, and manually read all **240 residual
   items** (52 Uncategorized on the category grid, 206 Unspecified on the bench grid, 18 in
   both). Result: they split **News 115 (48%) / Articles = knowledge content 91 (38%) /
   Job posts 34 (14%)**. Uncategorized is 87% adjacent-law court news (SARFAESI/DRT, NI Act,
   PC Act, property tax — no tax keyword in title); Unspecified is where the knowledge
   content hides (44% Articles). No hard signal exists (no RSS "Articles" tag; 95% of URLs
   under `/top-stories/`; page markup always `articleSection:"Top Stories"`), so the draft
   classifier is title-grammar based (`detectContentType`, ~97% agreement with the manual
   read; 'traps' must stay PLURAL — "CBI Trap Case" is news). Proposal on the table: split
   Unspecified → "No bench – News / – Articles / – Job posts", split Uncategorized →
   "Other News" + "Articles – General", add missing DRT/DRAT benches (also: "PCESTAT"
   doesn't match /\bCESTAT\b/) — report-only change like PR #28, history reclassifies, and
   it flows to the emailed report + Reads tab for free. Assets (docs/, untracked by design):
   `News-vs-Articles-Study.{html,pdf,xlsx}` (shared with colleague),
   `News-vs-Articles-draft-classifier.ts` (tested ruleset + study harness; its hardcoded
   scratchpad paths need fixing on reuse), `News-vs-Articles-study-data.json` (240 labeled
   items = ground-truth fixture for tests). Artifact:
   https://claude.ai/code/artifact/3186fcc8-44dc-47b8-94f2-8483796be55b

-2. **✅ SHIPPED 2026-07-10 — custom date-range reports (Reports → "Custom" tab).** Editors can
   now pick any From/To window of up to **30 days** (both ends inclusive, IST; "To" may be
   today for a so-far-today look) and see the same Category×dates + Bench×dates report.
   Backend: `customReportWindow()` in `reports.ts` validates the range (format, calendar
   validity, order, future, 30-day max) and the route accepts
   `GET /api/reports?period=custom&from=YYYY-MM-DD&to=YYYY-MM-DD` (400 with a human message
   on a bad range); the vs-previous insight compares against the equally-long window
   immediately before. Report cache is now keyed by window (custom ranges cache separately;
   expired entries pruned). SPA: third "Custom" segment with two date pickers + Apply,
   prefilled to the last 7 days, client-side inline validation mirroring the server's;
   "Email me a test" stays Weekly/Monthly-only (scheduled emails unchanged). Verified
   headless end-to-end (API + built SPA via Playwright). Suite 298/298.

-1. **✅ SHIPPED 2026-07-07 — richer report category rows (PR #28, `5661672`).** Data till date
   showed (a) taxscan's feed emits ONE comma-joined `<category>` string, so the un-aliased
   guides section appeared as a raw `Other Taxations,Top Stories` row (18 in June, 8 last
   week) — now aliased to a clean **Other Taxations** row (tag wins over title inference, so
   TDS/ITR-titled guides move here from Income Tax); and (b) **Uncategorized was ~10% of the
   week** (24/248; steady 3–7/day) — tag-less reconciler captures whose titles carry no tax
   keyword. New title rules: **Audit/Profession** (tax audit/ICAI/CA-firm pieces), **JobScan**
   (vacancy/recruitment), and activation of the five dormant alias labels (**Benami/PMLA,
   FEMA, International Tax/TP, Labour Law, Round-Ups/Digests**) that taxscan's tags never
   emit. Ordering: content forms → specialist subjects → broad tax → profession vocab last
   ("GST audit" stays GST). Report-only (categories computed at report time; history
   reclassifies automatically). Verified on the live sitemap (75 titles): Uncategorized 2→0.
   Suite 294/294.

0. **✅ SHIPPED & VERIFIED LIVE 2026-06-23 — coverage reports count each article ONCE
   (PR #26, `4432cd5`, merged to `main` + deployed).** The reports counted every Campaign row,
   so the morning backfill (which clones yesterday's article into a fresh row keeping the
   original `createdAt`) and manual re-pushes **double-counted** articles — confirmed live (20
   duplicate-title `auto`/`SENT` pairs with identical-ms `createdAt`). Fix in
   `src/services/reports.ts`: `buildReport` now dedupes to **one row per unique article URL**
   (keeps the richest-classified row — the clone drops `categories`, so the original's RSS
   category survives — and buckets on the earliest capture instant); `prevTotal` is a distinct-URL
   count too. **academy/shop storefront pushes excluded** (non-articles, by URL host). Counting
   stays by **capture date** (`createdAt`), not push date. **Production verification:** weekly
   `total` dropped **224 → 193** (31 re-sends/storefront collapsed), heatmap grand-totals both
   match 193 (dedup flows through the heatmaps), `prevTotal` legitimately unchanged at 159 (the
   06-09→06-15 week predates the 06-18 backfill, so no clones to collapse). No DB migration, no
   env-var change, internal-only — zero subscriber impact. Suite 290/290.

1. **✅ DONE 2026-06-19 — responsive-design audit across all admin pages (was TOP priority).**
   Audited all 6 pages (Dashboard/Compose/Review/Queue/Campaigns/Reports) headless via
   Playwright (real built SPA, mocked `/api/**`) at **390 / 768 / 1024 / 1100px**, asserting
   zero page horizontal overflow. **Two real bugs found + fixed (merged to `main` + live):**
   - **Reports** (commit `ad7f001`): `.insights` was `repeat(4,1fr)` → the 4th card (`32·45·4`
     unbreakable middot string) clipped off the right edge on phones; and the two heat tables
     overflowed the document (no scroll container, unlike `.card`). Fix: insights wrap via
     `auto-fit minmax(150px,1fr)` (2-up phone / 4-up tablet+); each heat table now lives in a
     `.heat-scroll` wrapper. The WhatsApp PNG is preserved — `renderPng()` adds an `.exporting`
     class that drops the scroll clip and captures at full content width (desktop output byte-
     identical; mobile export now complete).
   - **Nav bar, ALL pages** (commit `ee69b0f`): the hamburger only engaged at ≤720px, so the
     full desktop nav row (8 links + account + utils, intrinsic ~1100px) **overflowed the whole
     721–1100px tablet band by ~315px** (iPad portrait 768 + landscape 1024). Fix: raised the
     hamburger breakpoint to **≤1024px** (split the nav-collapse rules into their own media
     query; content tweaks stay at 720/480) + `flex-wrap` on `.nav` as a safety net for the
     1025–1100 sliver. After: 0 overflow at every width on every page.
   - Everything else (Campaigns 10-col table, Queue, Review pipeline strip, Compose flags,
     Dashboard metric grid) was already clean — dense tables scroll inside their `.card`
     (`overflow-x:auto`); no changes needed.
   Re-run harness: `admin/` Playwright + `chromium` from `@playwright/test`, fixtures in
   `/tmp/fix-*.json` pulled from prod via ADMIN_TOKEN in repo `.env`.
2. **✅ DONE 2026-06-19 — reconciler CONFIRMED closing the gap (was: verify it had).** Method:
   fetched `news-sitemap-daily.xml` (rolling ~2-day window: 30 on 06-17, 34 on 06-18, 2 on
   06-19 = 66 entries) and cross-checked every `<news:title>` against the captured campaign
   titles from `GET /api/campaigns?limit=200`. Result: **65/66 captured**; the only gap was a
   06-19 article published minutes earlier, pending the next `*/20` reconcile cycle (normal
   lag, not a miss). The 06-18 captured count had risen **43 → 54** since the evening the
   verification poll was stopped — i.e. the reconciler kept ingesting; we now hold MORE for the
   18th (54) than the rolling sitemap still exposes (34). `totals.expired=1170` confirms
   retention is live too. **Gotcha for re-runs:** sitemap `<news:title>` is CDATA-wrapped and
   the report buckets by *capture date* (createdAt) while the sitemap groups by *publish date*,
   so per-day counts won't line up exactly — match by title (CDATA-stripped, normalized), not
   by per-day totals. No action needed; reconciler + retention working as designed.
3. **✅ DONE 2026-06-19 — "Refresh fails / site won't load" investigated + fixed (Dashboard +
   Reports), plus the Dashboard & Campaigns "missing records" bug.** All merged to `main` + live.
   Three fixes:
   - **Refresh resilience** (commit `69bd496`) — the shared `useApi` fetch had no timeout, no
     retry, and surfaced an expired session as a cryptic banner. Now: 15s per-attempt timeout
     (AbortController), up to 2 backoff retries on network err / 502 / 503 / 504 (GET/HEAD only),
     and 401 → redirect to `/login?reason=expired` with a "session expired" notice. Applies to
     Refresh on **every** page (identical `load()` pattern everywhere).
   - **`/api/reports` cache** (commit `69bd496`) — `getReport` wraps `buildReport` with a 60s
     in-process cache (`REPORTS_CACHE_TTL_MS`, 0 under test), mirroring `/api/metrics`.
   - **"Recent campaigns" / Campaigns list missing records** (commits `884f23c` Dashboard,
     `783a039` Campaigns) — both were sourced from the newest-N **by capture time** but shown
     **by push time**, so a campaign pushed recently yet captured earlier (pacer sends
     oldest-first; backfill + manual Push-now replay old drafts) silently vanished. *Confirmed
     live:* 3 of the 5 most-recently-pushed campaigns were absent from prod `/api/metrics`. Fix:
     union in the most-recently-pushed campaigns via a SENT-event `groupBy` (dashboard last 7d
     take 10; list last 14d take 50, carrying the "Show only mine" filter). Regression test
     `metricsRecentCampaigns.test.ts`. Backend 288/288.
4. **✅ RESOLVED 2026-06-19 — keep-warm is reliable (cold-worker theory refuted).** UptimeRobot
   monitor on `…up.railway.app/healthz` confirmed active (screenshot): **5-min checks, 100%
   uptime over 7 & 30 days, 0 incidents, 12-day up-streak, ~290ms flat**. So the worker does NOT
   go cold — the throttled GitHub `*/5` ping is redundant (KNOWN_ISSUES #6 downgraded to a
   non-issue). The 2026-06-19 "Refresh failed" reports were therefore NOT a server outage; the
   prime remaining cause is the 8h session TTL (item 5).
5. **✅ DONE 2026-06-19 — session TTL raised 8h → 7 days (sliding).** `src/lib/sessions.ts
   SESSION_TTL_HOURS = 24 * 7`; stops the day-apart logouts that caused the "Refresh failed"
   reports. Active editors now stay signed in across the work week (sliding: each request resets
   the 7-day clock); the graceful 401→login handles the eventual idle expiry. Tests TTL-agnostic
   (assert via the constant); full suite 288/288.
6. **✅ CLOSED 2026-07-10 — morning backfill watch.** Enabled since 2026-06-18 with no churn
   signal: live unsubscribe rate **0.016%** (threshold <0.5%), delivery 99.4%, active
   subscribers grew ~2,200 → **2,436**. Re-sending prior-day content is not driving unsubs.
7. **✅ CLOSED 2026-07-10 — report emails confirmed landing.** The automated weekly
   **Monday 07:00 IST** email (first run 2026-07-06 at the new time, PR #27) arrived as
   expected; monthly 1st-07:00 uses the same scheduler path. Category heatmap has matured
   (title inference covers tag-less rows since PR #28).
8. **✅ CLOSED 2026-07-10 — retention at 3 days is working as designed.** `totals.expired`
   = 3,578 and climbing daily; no reports of editor-pending REVIEW items aging out before
   review. If that ever changes, the agreed remedy is exempting REVIEW from
   `expireStaleDrafts` rather than raising the global window.
9. **✅ MOOT 2026-07-10 — the two `[system] … URL check — ignore` campaigns** (empty portal,
   0 recipients, from the 2026-06-18 live academy/shop allowlist verification) are no longer
   reachable through the UI: the Campaigns API caps at the newest 200 rows and ~3 weeks of
   captures (~30–50/day) have pushed them out of the window; the default Pushed-desc sort
   sinks never-pushed rows anyway. Rows still exist in Postgres but deleting them would need
   a direct prod-DB query — decided not worth touching prod data. No metrics/report impact
   (0 events; academy/shop URLs are excluded from reports since PR #26).
10. **✅ DONE 2026-07-11 — per-article read counts via GA4 (all phases shipped same day;
   feature COMPLETE).** Final piece: the weekly/monthly coverage email now carries a
   **"How it was read"** section — total reads so far + via-push, reads by category, and the
   top-10 most-read articles of the window (`readsSummaryForWindow` in `readsReport.ts`:
   ArticleReadStat sums over the window's IST day keys, article paths only, slug-classified
   with the report's own rules, captured campaign headlines used for titles with slug text as
   fallback). Only rendered when `GA_READS_ENABLED`; wrapped so a reads failure never blocks
   the coverage email. History of the build below. The user created the GCP service account
   (`taxscan-push-reads@taxscan-push-ga.iam.gserviceaccount.com`, Viewer on GA4 property
   258445828) and handed over the key JSON (repo root `ga-service-account.json`, gitignored
   via `*service-account*.json` — NEVER commit). A live probe proved access end-to-end:
   4,604 pages with views in 3 days; push attribution flowing (209 pages with
   `sessionSource=taxscan-push` views). **Phase B (this PR):** additive `ArticleReadStat`
   table (portal, pagePath, date, totalViews, pushViews, fetchedAt; unique per
   portal+path+date) + `src/services/gaReads.ts` — flag-gated (`GA_READS_ENABLED`) ~2h cron
   (`GA_READS_CRON=15 */2 * * *`) making ONE batched GA4 Data API call (pageviews by
   date×pagePath, unfiltered + filtered to our push UTM) over a rolling 3-day window
   (`GA_READS_LOOKBACK_DAYS`), replacing each returned date's rows wholesale in one
   transaction. Request path NEVER calls GA (GA failure = counts go stale, nothing breaks).
   Auth = plain service-account JWT (node:crypto) against the REST endpoint — deliberately
   NO `@google-analytics/data` dep, keeping `package-lock.json` untouched (Railway build-cache
   footgun). Creds: `GA_SERVICE_ACCOUNT_JSON` inline (Railway) or `GA_SERVICE_ACCOUNT_FILE`
   (local). Also runs one pass ~15s after boot so enabling is instantly verifiable.
   **To enable on Railway:** set `GA_SERVICE_ACCOUNT_JSON` (paste the key file's content) +
   `GA_READS_ENABLED=true`, then watch the deploy log for `[ga-reads] synced rows=…`.
   **Phase C part 1 — READS REPORT SHIPPED 2026-07-11 (same day):** Reports → **Reads** tab
   showing bench×window and category×window read heatmaps over trailing 1w/1m/3m/6m/12m
   windows — all-traffic GA pageviews on article pages (slug ends in the numeric id),
   classified from the headline with the coverage report's own rules, cells = reads + share
   of that window (blue intensity, sqrt-spread). Built daily 05:45 IST
   (`GA_READS_REPORT_CRON`) by `src/services/readsReport.ts` → `GaReadsReport` cache row
   (per portal); stale-aware boot pass (>12h). `GET /api/reports/reads` serves the cache and
   NEVER calls GA. Download/Copy image work; "Email me a test" stays Weekly/Monthly-only.
   Verified headless (390/1280px, zero overflow, real GA fixture).
   **Phase C part 2 — CAMPAIGNS READS COLUMNS SHIPPED 2026-07-11 (same day):** sortable
   **Reads** + **via Push** columns on the Campaigns screen. `listCampaigns` sums
   `ArticleReadStat` (totalViews/pushViews) per taxscan URL path (trailing-slash tolerant;
   academy/shop URLs and untracked articles show "—" = null, distinct from a real 0).
   One-time 30-day history backfill done via the `GA_READS_LOOKBACK_DAYS` env dance
   (30 → boot sync pulled 97,848 rows / 31 dates → back to 3; history persists because the
   sync only replaces dates GA returns). **Phase C remaining (optional):** per-category
   reads + top-10 most-read in the emailed weekly report.
   *(Original pause note, for context:)*
   Decision made: Google Analytics, NOT Hocalwire — probed taxscan's Hocalwire Public API live
   (s-id in `.env`: `HOCALWIRE_API_BASE`/`HOCALWIRE_S_ID`, gitignored): `getNewsDynamicProps`
   returns only editorial metadata (citation/coram/PDF — no view counts), `most_read` is empty,
   `buzz_count`=0. GA also survives the possible Hocalwire exit (join key = article URL, ours).
   GA4 property ID: **258445828**; push UTM (`taxscan-push / push_notifications`) already live.
   Agreed design: `GA_READS_ENABLED` flag, ~2h cron sync → ONE batched GA4 Data API call
   (pagePath × session source, rolling 3-day re-fetch) → additive `ArticleReadStat` table;
   request path never calls GA (zero perf impact; stale-tolerant). To resume: user creates a
   GCP service account (enable Google Analytics Data API, JSON key, Viewer on the property),
   then Phase B PR (migration + sync, flag off) and Phase C PR (Reads columns on Campaigns,
   per-category reads + top-10 most-read in reports).

> **All merged & live (as of 2026-06-23):** the reconciler verification doc, the responsive
> fixes (`ad7f001`, `ee69b0f`), refresh resilience + reports cache (`69bd496`), the missing-records
> fixes (`884f23c`, `783a039`), and the unique-article report counting (PR #26, `4432cd5`) are all
> on `main` and deployed. `develop` and `main` are in sync.

---

## What this system is + what's built (capability overview)

**What it is:** a self-hosted web-push notification platform for taxscan.in (a GST/Income-Tax
legal-news site), replacing/paralleling the third-party iZooto. Backend = Node 20 + TypeScript +
Express + Prisma/PostgreSQL on Railway; admin SPA = Vue 3 at `push.taxscan.in/admin`; push via the
`web-push` library (VAPID); RSS polling via `node-cron`. Architecture is portal-tagged so
academy/shop can plug in later. **Live in production since 2026-06-09; ~2,200 active subscribers.**

**What's been built:**
- **Capture** — browser SDK on taxscan.in (soft prompt, topic opt-in, recapture of iZooto-granted
  browsers, `pushsubscriptionchange`); every subscriber tagged with a `portal` + topics.
- **RSS → editorial classifier** (`classify.ts`) — polls 5 section feeds (corporate / gst /
  income-tax / customs / jobs) + the master feed (`RSS_FEED_NEWS` = taxscan.in/feed, all sections);
  stores each article's RSS `<category>` tags; classifies by TITLE into QUALIFIED (SC / priority
  HC = Bombay / other HC / regulatory) · FALLBACK (ITAT/CESTAT/NCLAT/NCLT) · REVIEW (analytical +
  job/recruitment posts).
- **No-miss reconciler + retention** (`reconciler.ts`) — a cron reconciles against taxscan's
  complete daily sitemap and captures any article the feeds missed (feeds show only ~11/poll);
  DRAFTs unsent within `RETENTION_DAYS` are archived (EXPIRED status) to bound the backlog.
  Reports infer category from the title when no RSS tag, so coverage stays accurate.
- **Editorial pacer** (`pacer.ts`) — 1 push per global 45-min slot, paced by quiet hours
  (23:00–07:00 IST) + spacing (~21/day; `DAILY_SEND_CEILING` disabled at 999 in prod as of
  2026-07-03, was 20), best-first (today → authority tier → oldest-published-first),
  defer-not-drop; morning backfill from yesterday (flagged off). Runs at cap=Infinity — the
  per-subscriber `FREQ_CAP_PER_DAY` (prod 30, was 4) gates only manual non-force `/api/send`.
- **Review queue** (`/review`) + **Send queue** (`/queue`) with **Push now**; a Captured → Review →
  Queue → Sent pipeline strip ties them together.
- **Manual Compose** — All/topic targeting, Breaking + Force, schedule-for-later, taxscan/academy/shop
  click URLs, and **Test on this device** (isolated preview to your own browser).
- **Dashboard** (health metrics + recent campaigns by push time), **Campaigns** (full sortable
  history, captured-vs-pushed times, **Source = Manual/Automatic** — Push-now is attributed to the
  editor), **Activity** (append-only audit), **Users** (RBAC, email invites, temp passwords).
- **Coverage reports** (`reports.ts` + `reportScheduler.ts`) — weekly + monthly Category×dates and
  Bench×dates heatmaps + insights (totals, vs-prev, gaps, quality split), counting every UNIQUE captured
  article by capture date (re-sends collapse by URL; academy/shop storefront pushes excluded).
  In-app **Reports** screen (Weekly / Monthly / Custom / **Reads**; Download/Copy image for
  WhatsApp) + emailed Mon 07:00 / 1st 07:00 IST to app users + a report-only email list;
  INTERNAL (never to subscribers). The email ends with a **"How it was read"** section
  (reads by category + top-10 most-read) when read tracking is on.
- **GA4 read tracking** (PRs #33–#36, 2026-07-11) — per-article pageview counts behind
  `GA_READS_ENABLED`; the request path never calls GA (crons mirror GA → Postgres):
  `gaReads.ts` ~2h sync → `ArticleReadStat` (total + push-attributed views by path×date;
  30-day history backfilled); `readsReport.ts` daily 05:45 IST → **Reports → Reads** tab
  (bench/category × trailing 1w/1m/3m/6m/12m windows) via `GET /api/reports/reads`;
  sortable **Reads / via Push** columns on Campaigns; reads section in the emailed report.
  Creds: `GA_SERVICE_ACCOUNT_JSON` (Railway) / gitignored `ga-service-account.json` (local).
- **Admin user guide** — in-app `/guide` reader + downloadable PDF (`npm run build:guide`).
- **Security** — cookie-session auth + `ADMIN_TOKEN` (cron/curl), DB-level append-only audit log,
  push-URL allowlist, rate limits, helmet.
- **iZooto** — KEPT (its ~3M base is cryptographically un-migratable; self-hosted is a parallel,
  growing channel).

Deeper detail lives in `SEND_PACING_PLAN.md`, `KNOWN_ISSUES.md`, `README.md`, `SECURITY.md`, and the
auto-memory (which loads into every Claude session in this folder). History continues below.

---

## ✅ 2026-06-18 (latest) — Coverage Report feature SHIPPED & LIVE (PRs #15–#17)

Automates the manual weekly/monthly heatmap reports the team built by hand.
- **Phase 1 / ingestion (PR #15):** poll the master feed (`RSS_FEED_NEWS` on Railway) + store each
  article's RSS `<category>` tags (`Campaign.categories`, additive migration). Topic now derived from
  categories with feed fallback. Fewer missed pushes + complete report data. (`categories` only fills
  from 2026-06-18 onward, so the **category heatmap matures over ~a week**; the **bench heatmap is
  accurate immediately** since it's title-derived.)
- **Reports engine (PR #16):** `reports.ts` — Category×dates + Bench×dates heatmaps (`detectBench`
  reads specific HCs/tribunals/AAR from titles), insights (totals, vs-prev, gaps, quality split),
  counts EVERY captured article. `GET /api/reports?period=weekly|monthly`. In-app **Reports** screen
  with **Download/Copy image** (html-to-image) for WhatsApp.
- **Email delivery (PR #17):** `reportScheduler.ts` cron — **Mon 08:00 IST weekly + 1st 08:00 IST
  monthly** → all active app users + a report-only email list (`ReportRecipient`, admin CRUD on the
  Reports page), deduped. INTERNAL — never to push subscribers. `POST /api/reports/test-email` +
  "Email me a test" button to preview. Behind `REPORTS_ENABLED` (now ON; email is configured).
- Two additive migrations (`categories`, `report_recipients`). Suite 282/282.

**Action for the team:** click **"Email me a test"** on the Reports page to verify the email before
the first Monday run; add any report-only recipients there.

---

## ✅ 2026-06-18 (later) — more shipped & LIVE (PRs #10–#14)

All merged to `main`, deployed + verified in production. Suite 274/274. `develop` = `main`.
- **Academy & shop push links** (PR #11) — `ALLOWED_PUSH_HOSTS` widened (Railway + code default) to
  include `academy.taxscan.in` + `shop.taxscan.in`, so editors can push course/product URLs.
- **Clear send errors** (PR #11) — `/api/send` URL rejection now returns a human message listing the
  allowed sites; the SPA surfaces it (`apiErrorMessage`) instead of "Request failed: 400".
- **Test on this device** (PR #12) — replaces the old test-segment flow (which would've blasted the
  whole base, since ~all subscribers are "All news"). Admin enables push on their OWN browser and
  previews to only that device. `POST /api/send/test-device`, `admin/.../useTestDevice.ts`.
- **Dashboard recent campaigns by PUSH time** (PR #13) — was capture time; Captured column dropped there.
- **Morning backfill SHIPPED — FLAG OFF** (PR #10) — fills empty morning slots from yesterday (re-send
  SC → Bombay HC → other HC, else unsent other-category, else best-clicked), mornings-only until fresh
  arrives, once-each-then-rotate. `MORNING_BACKFILL_ENABLED` (default off) + `MORNING_BACKFILL_UNTIL`
  (12:00). **To enable: set `MORNING_BACKFILL_ENABLED=true` on Railway; watch unsub (re-sends prior-day content).**
- **Guide refreshed** (PR #14) for all of the above.

**Key finding:** ~all subscribers carry only the **"All news"** topic, so any topic/"test" send folds
into the full base — there is no small audience except the isolated on-device test. (Two harmless
`[system] … URL check — ignore` campaigns from a live academy/shop verification sit in the Campaigns
list, empty portal, 0 recipients.)

---

## ✅ 2026-06-18 — Editorial UX batch SHIPPED & LIVE (verified on Railway)

The editorial send-pacing pipeline is **confirmed live and working** — this supersedes any
"rollout pending" framing further down. Today's batch is merged to `main` and deployed
(PRs #5 `6b54cab`, #6 `a3a47fe`), 257/257 tests, **no DB migration, no new env vars**, all
behind the existing `PACER_ENABLED`/`RSS_EDITORIAL_FILTER` flags:

- **Send order = oldest-published-first** within the same day + authority tier (was
  newest-first), so a same-day cluster of qualified rulings goes out in publish order.
  Today-before-backlog and SC→HC→regulatory precedence unchanged. (`pacer.ts` `rankQualified`.)
- **Priority high courts** — Bombay HC auto-jumps ahead of other High Courts (just below the
  Supreme Court). Config list `PRIORITY_HIGH_COURTS` in `classify.ts` — add Delhi etc. to extend.
  Tiers: 1 SC · 2 priority HC · 3 other HC · 4 regulatory/approved.
- **Queue screen** (`/queue`) — pending qualified/fallback articles in send order, each with
  **Push now** (full-reach force). `GET /api/queue`, `POST /api/queue/:id/push`.
- **"Pushed" time** everywhere campaigns show (Dashboard, Campaigns, detail) — distinct from
  "Captured" (capture time). `CampaignStat.sentAt` = earliest SENT event.
- **Campaigns table = clickable sortable columns** (Captured / Pushed / Sent / CTR / …;
  default Pushed desc). The Queue screen stays the pure upcoming-in-send-order view.
- **Guide** menu now opens an in-app HTML reader (`/guide`) with a Download-PDF option
  (`GET /api/guide.html`; `/api/guide?download`). Was: opened the PDF directly.
- **Campaigns table**: clickable sortable columns (Captured / Pushed / Sent / CTR / …), and a
  fix for the last column (Delivery) being clipped (wider `.page-wide` + compact dates).
- **Review & Queue clarity**: a `Captured → Review → Queue → Sent` pipeline strip on both
  screens (current stage highlighted) + cross-referencing descriptions, so their roles are obvious.
- **Job / recruitment posts → Review.** Job-scan titles (vacancy/hiring/recruitment/walk-in/
  internship/job opening) classify to REVIEW *before* the authority rules, so even "ICAI
  Recruitment" never auto-sends — an editor decides. ("Job Work under GST" is NOT a job post.)
  The **job-scan feed is wired** (`RSS_FEED_JOBS=https://www.taxscan.in/job-scan/feed` on
  Railway; poller now watches **5 feeds**), and job posts **target ALL subscribers** (no "jobs"
  topic exists). Verified live ~15:10 — vacancies now land in the Review queue. NOTE: enabling a
  brand-new feed captures its whole current list on the first poll (all REVIEW drafts — expected).
- Tracked the previously-untracked root state docs (+ `docs/archive/`), added a manual-push
  "leave Target on **All subscribers**" checklist to the admin guide, and an
  `npm run build:guide` script (Chrome headless HTML→PDF).

**Verified live ~14:00 IST:** pacer firing ~1 push / ~46 min (11 by 14:00, < 20/day ceiling);
Bombay HC sent ahead of Karnataka HC (priority working); active **2,213**, delivery **97.5%**,
unsub **0.03%**, recapture **3,076**, CTR **~0.64%**. `develop` and `main` are IN SYNC.

**Editor notes:** manual force-pushes (e.g. ICAI results) reset the 45-min spacing clock and
count toward the 20/day ceiling. Capture time ≠ push time — sort Campaigns by **Pushed** to
see real send activity. iZooto stays (see below — base not migratable).

---

## ⛔ 2026-06-16 — DECOMMISSION CANCELLED / recapture assumption corrected

**Do NOT decommission iZooto. The "7-day watch → cancel iZooto" plan below is VOID.**

Reason: web-push subscriptions are cryptographically bound to (origin + VAPID key).
iZooto's ~3M endpoints were minted with iZooto's VAPID keypair — we don't hold their
private key, so they can NEVER be sent to from this system. They cannot be migrated
or imported (`subscribersBySource.import = 0`, and `import-izooto.ts`'s own caveat:
import only works if iZooto used OUR VAPID key, which it didn't). The ONLY recovery
path is **recapture** (a returning browser re-subscribes under our VAPID key), which
is slow, lossy, and only works for users whose original grant was on the
`www.taxscan.in` origin (NOT an `*.izooto.com` origin).

Live metrics 2026-06-16: **activeSubscribers 1,987** (recapture 2,646 / soft-prompt 30
/ import 0); delivery 95.5% ✅; unsub 0.04% ✅; **CTR 0.66% ⚠️ (below the 4–6% target)**.
Recapture runs ~130–270/day and flat → it will plateau in the low tens of thousands at
best, NOT millions. So self-hosted is a parallel channel that grows, NOT a replacement
for iZooto. **Keep iZooto running indefinitely.**

Two unknowns that bound the recapture ceiling — get these before any further planning:
1. iZooto's REAL deliverable/active count (the "3M" is almost certainly cumulative
   all-time opt-ins, not reachable subscribers).
2. The origin iZooto subscribed under (`www.taxscan.in` vs an `*.izooto.com` subdomain).
   If the latter, recapture can't reach the bulk of the base at all.

Highest-leverage fixes (from the 2026-06-16 review): (a) the 20–28s Hocalwire
`loadScripts` delay (KNOWN_ISSUES #1) throttles recapture — render the SDK `<script>`
statically/`defer` in `<head>`; (b) clean the leaked `localhost:3000` dev/test
subscriber rows out of prod; (c) redesign send pacing (batch-window + editorial
priority + defer-not-drop) to lift the 0.66% CTR. The cooldown-DROP model currently
sends whichever article published FIRST in a 30-min window (not the most important)
and drops everyone else for that article.

---

## Today's status (last updated: 2026-06-09)

- ✅ **Pre-go-live security re-audit completed + 4 fixes shipped (2026-06-09).**
  Multi-agent audit of the post-Task-10d user-mgmt surface (auth, invites, audit
  immutability, CSRF, live-dispatch path). **No critical/high.** 24 confirmed
  findings; the 4 mediums were fixed before go-live: **M1** push click-URL
  allowlist now enforced on the RSS/sweeper dispatch path (was only on `/api/send`);
  **M2** `passwordResetRequired` now enforced server-side in `requireUser` (was
  SPA-only); **M3** login-lockout DoS removed (verify-password-first + generic 401);
  **M4** `bcrypt`→^6 clears the node-tar advisories (`npm audit` = 0). Full suite
  **198/198** green. Lows/infos deferred to a backlog — see `SECURITY.md`
  (2026-06-09 section). NOT yet committed/merged at time of writing.

- ✅ **Per-subscriber notification cooldown shipped (2026-06-08).** `MIN_GAP_MINUTES`
  (default 30; 0 disables) — a subscriber pushed within the window is held back for the next
  campaign, so a burst of articles in one poll tick can't fire several pushes back-to-back
  (the unsubscribe driver). Complements `FREQ_CAP_PER_DAY` (volume) with spacing. Lives in
  `filterByCap` (`src/lib/cap.ts`) → new `cooled` bucket, surfaced in the `/api/send` result
  + `CAMPAIGN_DISPATCHED` audit metadata. Merged to `main` (`4dc4af2`); `MIN_GAP_MINUTES=30`
  set on Railway. **No live effect until `SEND_MODE=live`** (capture_only = no auto-sends).
  NOTE: `breaking:true` does NOT bypass the cooldown (still subject to cap + cooldown) — one-
  line change if we ever want urgent sends to interrupt.
- ✅ **Admin SPA made mobile-responsive (2026-06-08).** The nav was a non-wrapping desktop row
  that overflowed phones. Now a hamburger menu on mobile (`NavBar.vue`; desktop unchanged via
  `display: contents`) + a shared `@media (max-width:720px)` block in `app.css` (wrapping
  toolbars, tighter padding, denser tables). Verified at 390px via headless Chromium. Merged
  to `main` (`61779c9`).
- ✅ **User-management Phase 8 (email invites) shipped & verified in production (2026-06-08).**
  Admin invites a teammate by email → single-use, 72 h, hashed token (separate `UserInvite`
  table) → recipient clicks `…/admin/accept-invite?token=…`, sets their own password, and is
  auto-logged-in. Resend/Revoke + a Pending-invites panel on the Users screen. Mail goes via
  ElasticEmail v4 transactional; if unconfigured/failed it degrades to a copyable link.
  Merged `develop → main` (`5689769`). Full suite green (193 tests). With Phase 8 done, the
  only remaining plan item is the always-optional cryptographically-chained audit upgrade.
  - **ElasticEmail prod config (set in Railway on the `taxscan-push` service):** `APP_BASE_URL`,
    `ELASTICEMAIL_API_KEY` (⚠️ **send-only key** — can't read account/logs/stats via API; use the
    ElasticEmail dashboard for delivery logs), `EMAIL_FROM=no-reply@taxscan.in`, `EMAIL_FROM_NAME`,
    `INVITE_TTL_HOURS=72`.
  - **Delivery gotcha (resolved):** first sends returned `emailSent:true` but didn't arrive —
    `emailSent:true` only means the API *accepted* the request. Delivery started once the
    ElasticEmail sending domain/account was verified. Yahoo is stricter than Gmail (enforces
    SPF+DKIM+DMARC) — confirm those stay green for `taxscan.in`.
- ✅ Backend deployed to Railway at `https://taxscan-push-production.up.railway.app`
- ✅ Admin SPA live at `/admin/`, login working
- ✅ Test-residue subscribers cleaned up
- ✅ ADMIN_TOKEN rotated (the one in chat history is dead — production has the new value)
- ✅ Vendor (Hocalwire) **shipped the 4-item brief cleanly** — iZooto fully removed from site templates, `/sw.js` at taxscan.in root, `TAXSCAN_PUSH_CONFIG` block + SDK reference in `<head>` of every page (spot-checked homepage + 3 article-section pages on 2026-06-06: all carry the block, 0 iZooto fingerprints).
- ✅ **Cutover blocker found and fixed (2026-06-06).** The SDK was failing to execute on live pages — root cause was helmet's default `Cross-Origin-Resource-Policy: same-origin` on Railway origin, which the browser enforced as `ERR_BLOCKED_BY_RESPONSE.NotSameOrigin` whenever Hocalwire's `Utils.loadScripts` injected the `<script>` into a `www.taxscan.in` page. Curl always worked (CORP is browser-only). Fixed by overriding to `cross-origin` on the two SDK routes (`src/app.ts`); regression-locked by `src/__tests__/asset-headers.test.ts`. Deployed in commit `daa0af6` (+merge `ea5eef1`).
- ✅ **Live verification PASSED** end-to-end via Claude in Chrome — see `CUTOVER_LIVE_VERIFY.md` for the full report. SDK loads, runs, registers `/sw.js?api=…` as ACTIVE on scope `/`, soft prompt + focus trap + 7-day dismiss all working, granted-permission recapture path proven (FCM endpoint, no iZooto).
- ✅ **Reliable SDK delivery shipped (2026-06-06).** Cache headers on the two assets (`/taxscan-push.js`: `max-age=300, stale-while-revalidate=86400`; `/sw.js`: `no-cache`) so returning visitors aren't blocked on a cold Railway worker. GitHub Actions warm-ping workflow live on main, hitting `/healthz` every 5 min. README has the full "Reliable SDK delivery" section.
- ✅ **UptimeRobot monitor configured** for `/healthz`, 5-min interval. The "TEST: Monitor is DOWN" mail received during setup was UptimeRobot's contact-verification test, not a real outage.

## 🚀 WENT LIVE 2026-06-09

- **`SEND_MODE=live` flipped on the Railway `taxscan-push` service (2026-06-09).** The RSS poller now dispatches new articles to the ~1,100 ACTIVE subscribers. All gates were cleared: security audit + M1–M4 fixes deployed, dashboard perf (DB→Singapore + cache), privacy policy published, GA UTM tagging live, recapture climbing for days. Baseline at flip: `totals.sent=81` (manual tests only), 1,100 active. Backlog of capture_only DRAFT campaigns does NOT re-send (GUID-deduped) — only new articles from the next poll onward. Watch: `totals.sent` rising, delivery ≥95%, CTR, unsub <0.5%, and the GA `taxscan-push / push_notifications` row.

## ▶️ ACTION — 7-day post-go-live health watch (opened 2026-06-09) — ⛔ SUPERSEDED 2026-06-16

> **VOID — see the "DECOMMISSION CANCELLED" block at the top of this file.** The exit
> condition of this watch was "7 green days → decommission iZooto." That conclusion is
> wrong: the ~3M iZooto base is not migratable and self-hosted (~2K) is not at parity.
> Keep iZooto. The health gates below are still fine to monitor as channel-health KPIs,
> but they do NOT gate any iZooto cancellation. Do not act on the exit condition.

**Do this each session until closed.** Pull live metrics and check the four
go-live health gates below. If all stay green for **7 consecutive days
(through ~2026-06-16)**, proceed to Step 6 (decommission iZooto). If any gate
goes red, investigate before decommissioning — do NOT cancel iZooto early.

**How to check** (or just ask Claude to probe `/api/metrics`):
```
curl -s --resolve taxscan-push-production.up.railway.app:443:69.46.46.113 \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  https://taxscan-push-production.up.railway.app/api/metrics
```

| Gate | Threshold | Baseline at first live send (2026-06-09 ~13:32) |
|------|-----------|--------------------------------------------------|
| Delivery rate | **≥ 95%** | 96.9% ✅ |
| Unsubscribe rate | **< 0.5%** | 0.09% ✅ |
| CTR | **~4–6%** (builds over hours/days) | too early at flip |
| Active subscribers | **stable or growing** | 1,057 after first-send prune; recapture climbing (1,123) |

Notes for whoever reads this next:
- A one-time `expired`/`failed` bump on the **first** live send is EXPECTED — it
  flushed ~75 dead endpoints accumulated during capture_only. Not a red flag;
  delivery should hold/improve as the base self-cleans.
- Old capture_only `DRAFT` campaigns are inert (GUID-deduped) — only new
  articles dispatch. Confirmed at go-live.
- GA: confirm the `taxscan-push / push_notifications` row is populating in
  Traffic acquisition (UTM tagging is live).

**Exit condition:** 7 green days → run Step 6 (Decommission iZooto) below, then
delete this ACTION block.

## What's NOT done yet

- ~~`SEND_MODE` capture_only~~ → now `live` (see above).
- ✅ **Privacy policy page updated on taxscan.in (2026-06-09).** This go-live precondition is now cleared.

### Deferred — decided to take up later (2026-06-09)

- **Known Issues #1–#4** are parked by decision. None block go-live. See `KNOWN_ISSUES.md` for the full writeups; the two worth re-surfacing around go-live:
  - **#1 Vendor follow-up:** Hocalwire wraps our SDK in their `Utils.loadScripts` async loader, which injects the `<script>` tag **20-28 s after navigation**. Visitors who bounce inside that window never load the SDK. Eventual ask: render `<script src="…taxscan-push.js" defer>` statically in `<head>` next to the `TAXSCAN_PUSH_CONFIG` block.
  - **#2 Ghost-subscriber hardening:** the SDK's `ensureSubscribedSilently` short-circuit (`public/taxscan-push.js` lines 137-150) can leave a "browser-side ghost" if a prior `POST /api/subscribe` failed and was never retried. Mitigation idea: a `GET /api/subscriber/exists?endpoint=…` probe. Measure via the recapture counter first.

## What runs by itself while I'm away

- RSS poller (every 5 min) — captures new articles as DRAFT campaigns.
- Sweeper (every 1 min) — nothing scheduled, no-op.
- Railway healthcheck — keeps the app warm.
- **GitHub Actions warm-ping workflow** (`*/5 * * * *` UTC) — hits `/healthz` to keep the Railway worker hot.
- **UptimeRobot monitor** (5-min interval) — independent second pinger of `/healthz`.

---

## When vendor confirms "shipped" — run this verification (Phase C from Task 12 runbook)

*(Already completed on 2026-06-06 — see `CUTOVER_LIVE_VERIFY.md` for the full report. Steps preserved below for reference if you re-verify after the vendor's loadScripts-delay follow-up lands.)*

**Use a clean Chrome Incognito window** for all five steps.

1. **Open https://www.taxscan.in/** → DevTools → Application → Service Workers
   - ✅ Pass: active SW at `https://www.taxscan.in/sw.js?api=https%3A%2F%2Ftaxscan-push-production.up.railway.app`
   - ❌ Fail: no SW, or iZooto SW still listed → screenshot to Claude

2. **DevTools → Network → filter "izooto" → reload**
   - ✅ Pass: zero matches
   - ❌ Fail: any `*.izooto.com` request → screenshot to Claude

3. **Click any article → scroll ~50% OR wait ~30s**
   - ✅ Pass: bottom-right banner "Get notified of new GST & Income Tax rulings?"
   - ❌ Fail: nothing after 60s → screenshot console to Claude

4. **Open admin dashboard in another tab, refresh every 10 min for first hour**
   - ✅ Pass: `recapture` count climbs (returning iZooto-granted users auto-migrate)
   - ❌ Fail: both `recapture` and `soft-prompt` stay at 0 for hours → paste metrics to Claude

5. **End-to-end smoke**
   - Accept the soft prompt + native prompt in the incognito window
   - Refresh admin → `Active subscribers` ↑1, `soft-prompt` ↑1
   - Admin → Compose → send a test (`target: all`, `breaking: true`) → notification arrives within seconds
   - Click it → URL opens, dashboard shows CLICKED

---

## When verification passes — go live

**Conditions to flip `SEND_MODE=live`:**
- ✅ All 5 verifications above passed (2026-06-06)
- ✅ Privacy policy page is published (done 2026-06-09)
- ✅ Pre-go-live security audit run + the 4 mediums fixed (2026-06-09; see `SECURITY.md`)
- ⏳ Security fixes committed to `develop` and merged/deployed to `main` (Railway)
- ⏳ `recapture` count has been climbing for 24-48 hours (the migration window) — verify before flipping

> **Capture keeps running after go-live.** `SEND_MODE` gates ONLY the RSS poller's
> dispatch (`src/services/poller.ts:150` — the single behavioral use; the other
> ref is just env parsing). Subscription capture — recapture, soft-prompt,
> `pushsubscriptionchange` — flows through `POST /api/subscribe`, which never reads
> `SEND_MODE`; it's driven by the browser SDK on every taxscan.in page load.
> Flipping to `live` therefore keeps capturing AND starts sending: each dispatch
> calls `resolveTargets` (`src/services/send.ts:80`) which queries ACTIVE
> subscribers at send time, so newly-recaptured users are automatically included
> in subsequent sends. (Recapture naturally tapers as the finite pool of
> iZooto-granted browsers migrates / once iZooto is decommissioned — not caused by
> the flip.)

**How to flip:**
- Railway dashboard → `taxscan-push` service → Variables tab → `SEND_MODE` → change `capture_only` → `live` → Save
- Wait ~30s for auto-redeploy
- Check admin → `totals.sent` should start rising as next RSS poll fires (~5 min)

**Don't flip during a publish burst** — pick a calm moment so queued articles don't fire all at once.

---

## Step 6 — Decommission iZooto (much later) — ⛔ DO NOT DO THIS (cancelled 2026-06-16)

> **Cancelled.** Decommissioning iZooto deletes its subscriber data and drops reach
> from ~3M to ~2K permanently, because the base cannot be migrated (origin+VAPID
> binding). Keep iZooto running as the primary channel. See the top-of-file block.
> The original (now-void) plan is preserved below for context only.

Wait minimum **7 days** after going live. Check:
- Active subscribers growing or stable
- Delivery rate green (≥95%)
- CTR green (≥4-6%)
- Unsubscribe rate green (<0.5%)

If all four are green for 7 consecutive days → log into iZooto, archive the property. Cancelling deletes iZooto's subscriber data — fine because our base is rebuilt.

---

## Key references for resumption

- **Domain**: `https://taxscan-push-production.up.railway.app`
- **Admin URL**: `/admin/` — per-user email + password login (cookie sessions). `ADMIN_PASSWORD`
  was retired in Phase 5. Bootstrap an admin with `npm run create-admin`; add teammates from the
  Users screen via "Create user" (temp password) or "Invite user" (emailed accept link).
- **Public DNS hack** (if domain doesn't resolve): `--resolve taxscan-push-production.up.railway.app:443:69.46.46.113` on any `curl`
- **Repo**: this directory, on branch `develop` (main + develop are in sync at last push)
- **README** in this repo has the full system documentation
- **SECURITY.md** has the audit + ongoing security checklist

## Bring these to a fresh Claude session

1. "I'm in Task 12, waiting on vendor. Here's NEXT_STEP.md content: [paste this file]"
2. Vendor reply (paste verbatim or screenshots)
3. Current dashboard metrics — fetch with:
   ```
   curl -s --resolve taxscan-push-production.up.railway.app:443:69.46.46.113 \
     -H "Authorization: Bearer <ADMIN_TOKEN>" \
     https://taxscan-push-production.up.railway.app/api/metrics
   ```

Claude will slot back in at the right step.
