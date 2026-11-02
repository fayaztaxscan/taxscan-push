# REPORT: token-expiry-and-flaky-tests

- **Branch:** `build/token-expiry-and-flaky-tests` (base `origin/develop` 391b666). **Code commit:** `08da850`.

## Part A — the LinkedIn token expiry is never "unknown"

### Files
- `src/services/linkedin/token.ts` — `introspect()` now ALWAYS returns a verdict with a reason (`ok` | `no_expires_at` | `network` | `http_<status>`; never a body or a secret). `checkPage` resolves the expiry in this order: LinkedIn's date → the stored real date (a renewal's, or an earlier inspector date) → an **estimate** = the `LinkedInToken` row's `createdAt` (when this env token was first seen) + `LINKEDIN_ACCESS_TOKEN_TTL_DAYS`. The estimate is stored with a source marker and replaced the moment LinkedIn or a renewal gives a real date. The renewal treats the estimate like a real date (≤ 14 days → renew). The failure email says "about" while the date is an estimate. `tokenStatus()` returns `validUntilSource`.
- Log line now: `[linkedin-token] page=taxscan access_left_days=N (source=linkedin|stored|estimate|renewal) refresh_left_days=M introspect=<reason|ok> action=none|renewed|failed`.
- `prisma/schema.prisma` + `prisma/migrations/20261102112933_linkedin_token_expiry_source/` — `LinkedInToken.accessExpiresSource TEXT` (nullable). **Additive.** (`prisma format` also re-aligned the columns of the LinkedInToken block: whitespace only.)
- `src/lib/env.ts`, `.env.example` — `LINKEDIN_ACCESS_TOKEN_TTL_DAYS` (1–365 integer; anything else, or unset → 60).
- `admin/src/views/LinkedIn.vue` — "Token valid until **about** …" only when `validUntilSource === 'estimate'`. `docs/LINKEDIN_POSTING.md` — the estimate rule, the new log line, the env var.
- LinkedIn docs re-read (token-introspection page, 2 Nov 2026): **unchanged** — `POST /oauth/v2/introspectToken`, form `client_id` / `client_secret` / `token`, no Basic auth. `expires_at` is documented as **optional**, so a 200 without it is legitimate (reason `no_expires_at`). Also documented: valid credentials that don't match the token's app answer 200 with `active:false` (the code reads that as inactive and renews; the new `introspect=` field shows it).

### Acceptance
- A1 PASS (401 / 200-without-`expires_at` / network: reason in the log line, expiry = createdAt + 60 days, source `estimate`, at 13 days left a renewal is attempted and the source becomes `renewal`). A2 PASS (a 200 with `expires_at` → `linkedin`, estimate replaced; a renewal → `renewal` with now + `expires_in`; a later inspector outage never overwrites a real date with an estimate). A3 PASS (TTL 30 changes the estimate and a changed TTL recomputes it; `abc`, `0`, `-5`, `12.5`, `400`, empty, unset → 60). A4 PASS for `tokenStatus()` (estimate / linkedin / renewal); the screen's wording is a one-line template in `LinkedIn.vue`, pinned by a test that reads the file, and **not checked in a browser** (no browser used, per the owner). A5 PASS (the secrets grep covers the new line and an inspector error that echoes the client secret). Also: the failure email says "about N days left" / "until about <date>" for an estimate.

## Part B — the flaky tests: root causes and fixes

**1. `digestTick.test.ts` "UNKNOWN with a live webhook …" and "… 17:00 cut-off is judged as UNKNOWN" (failed together).**
Cause: `webhookHealth()` counted `NO_ADDRESS` events with no portal filter and **no upper time bound**, and `noAddressRecently()` did not guard against future timestamps. These tests run on a fixed clock in October; `digestWebhook.test.ts` writes real-time `NO_ADDRESS` rows into the shared table. Whenever one existed, the banner read `webhook_no_address` (which outranks the `complaint_rate_unknown` these two expect; the neighbouring test expects `webhook_silent`, which outranks both, so it never failed). **Reproduced deterministically** by planting one `NO_ADDRESS` row: exactly those two tests failed with "Expected complaint_rate_unknown, Received webhook_no_address".
Fix (a small **production change**, no behaviour change in production where `now` is real time): the status read is "as of now": `webhookHealth` queries `receivedAt ≤ now` and `noAddressRecently` requires `0 ≤ age < 24 h`. Regression test `digestWebhookAsOf.test.ts` (rows dated 2099 so it can't disturb other files).

**2. `metricsWarmer.test.ts` "keeps the live parts live even while totals are cached".**
Cause: it asserted `activeSubscribers` goes from N to N+1, but that figure is a GLOBAL status count of every subscriber, and other test files create/expire subscribers at the same time.
Fix: the test now pins the contract itself, deterministically: the status query is intercepted so each build must re-run it (7 → 8, exactly one status query per build) while the cached lifetime totals do not move. No production change.

**3. `linkedinToken.test.ts` "6. a renewal resumes posting after a login stop" (failed once, message lost; my own test).**
Cause: the worker's "close stale in-flight rows" step was **table-wide** (`status PENDING, nextAttemptAt null, updatedAt < now − 10 min`, no page filter). With a fixed future clock every in-flight row looks stale, so a tick in one test file (`linkedinWorker.test.ts`) could close the in-flight row that another file's post had just created, while its post was in the air. I could not catch the original failure, but the mechanism reproduces deterministically: a regression test (in-flight rows of two pages, one tick) failed before the fix with `staleClosed` 2 instead of 1.
Fix (a small **production change**, same behaviour in production): the stale step is scoped to the pages the tick handles (`page IN (portals' pages)`), which is also simply correct: a tick should not judge pages it does not post for. Regression test in `linkedinWorker.test.ts`.

**4. `eventRetention.test.ts` "lifetime totals …" (already on the list).**
Cause: it compared the Dashboard's GLOBAL lifetime totals (live + rolled-up over the whole `Event` table) before and after a sweep, and other test files insert and delete events while it runs.
Fix: the test now asserts the exact invariant that makes the totals identical and that nobody else can disturb: the roll-up (only the sweeper writes it) grows by exactly the rows the sweep deleted, per type; our recent row is untouched; and the Dashboard totals include that roll-up. (The per-campaign parity tests, unchanged, still cover identical figures for an isolated campaign.) No production change.

### Acceptance
- B1: causes and fixes above. B2 PASS: the six affected files (digestTick, metricsWarmer, linkedinToken, eventRetention, digestWebhookAsOf, linkedinWorker) passed **15 of 15 consecutive runs** (101 tests each) while a full suite of the other 87 files ran at the same time (`Tests: 1736 passed`). B3 PASS: the full suite passed **twice in a row, nothing else running, no re-runs**: `Test Suites: 93 passed, 93 total` / `Tests: 1837 passed, 1837 total`, twice.
- tsc, lint (exit 0), `npm run build:admin`, migration (applied on an empty DB): PASS.

## A method trap I fell into (worth knowing)
My first stress attempts saw `digestTickQa.test.ts` fail twice ("No record was found" for a `DigestSend` mid-tick). **That was caused by my own method, not a flake:** that file cleans up by the portal prefix `test-digest-tickqa-`, so two jest processes running it at once (my loop and the full suite) delete each other's rows. It passed 14/14 alone beside a full suite, 25/25 single-test under CPU burners, and 12/12 whole-file under burners. The same applies to every file that cleans up by a fixed key (`linkedinWorker` page `litest`, `linkedinToken` page `litoken`, the digest `test-digest-*` prefixes): **don't run the same test file in two processes against one database.** The B2 run above therefore excluded the looped files from the concurrent full suite.

## Other findings for planning (not changed)
- **Real, small, production:** the Dashboard's lifetime totals (`computeHeavyAggregates`, `metrics.ts`) read the live `Event` counts and the `EventRollup` counts as two separate queries (no shared snapshot). If the nightly sweep commits between them, a row can be counted twice or not at all for up to the 5-minute cache. A `REPEATABLE READ` transaction would fix it, but it wraps a multi-second `groupBy` (Prisma's 5 s interactive-transaction default would need `timeout`), so I left it for a brief rather than change a hot path.
- Same class as the metricsWarmer fix, still in that file: the first and third tests assert `recapture` source counts as "before + 1" on a global table (not seen failing).
- `digestWebhook.test.ts` deletes ALL `NO_ADDRESS` rows globally (lines ~100, 503, 736), and digest-retention tests sweep `EmailEvent` rows by age with fake `now` values; either could in principle remove another file's events. Not seen failing.

## Agents run
None (no UI beyond one label; done directly; the LinkedIn.vue wording is unchecked in a browser).

## Clean-up (planning session, after merge)
```sh
git worktree remove ../taxscan-push-worktrees/token-expiry-and-flaky-tests
dropdb taxscan_push_build_token_expiry_and_flaky_tests; dropdb taxscan_push_build_token_expiry_and_flaky_tests_shadow
git branch -D build/token-expiry-and-flaky-tests; git push origin --delete build/token-expiry-and-flaky-tests
```
