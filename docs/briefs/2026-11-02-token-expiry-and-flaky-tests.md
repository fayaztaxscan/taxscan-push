# Brief: LinkedIn token expiry never "unknown" + steady the flaky tests

- **Date / name:** 2026-11-02-token-expiry-and-flaky-tests  →  branch `build/token-expiry-and-flaky-tests`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first). UI parts go to **ui-developer**.

## Goal
**A.** The LinkedIn token renewal always knows (or safely estimates) when the access token expires, so it renews ~14 days
before, instead of doing nothing when LinkedIn won't say.
**B.** The tests that failed intermittently under machine load today pass reliably, so release checks stop needing
re-runs.

## Why (owner's words)
> 2 Nov: owner said "yes" to planning's proposal after PR #96 went live.

**A, evidence from prod (2 Nov 16:50 IST, first check after deploy):**
`[linkedin-token] page=taxscan access_left_days=unknown refresh_left_days=364 action=none`.
`introspect()` (`src/services/linkedin/token.ts` ~187) returned null or no `expires_at`, and the env token has no stored
`accessExpiresAt`. So `accessLeft === null`, step 2 of `checkPage` never runs, and no email goes out. Left alone, the token
(made 2 Nov, app TTL "2 months") would expire ~1 Jan and posting would stop.

**B, flaky tests seen today (each passes alone, fails ~1 in 3 full runs under load avg 6–15):**
- `src/__tests__/digestTick.test.ts:659` "UNKNOWN with a live webhook …" and `:677` "… unconfirmed at the 17:00 cut-off is
  judged as UNKNOWN" (failed together, twice);
- `src/__tests__/metricsWarmer.test.ts:78` "keeps the live parts live even while totals are cached";
- `src/__tests__/linkedinToken.test.ts:310` "6. a renewal resumes posting after a login stop" (failed once, message lost);
- older, already on the list: eventRetention "lifetime totals" under parallel workers.

## Scope
**In:**

### A. Token expiry
1. **Know why introspection fails:** `introspect()` returns a reason as well (`http_<status>` / `no_expires_at` /
   `network`; never a body, never a secret). The check line gains it:
   `[linkedin-token] page=taxscan access_left_days=… (source=linkedin|stored|estimate) refresh_left_days=… introspect=<reason|ok> action=…`.
   Keep the request as is (`client_id`, `client_secret`, `token`, form-encoded). Re-read LinkedIn's current
   "Token Introspection" docs. If they say something different (another URL, Basic auth, a field name), match them and note
   it in the REPORT.
2. **Never unknown:** when LinkedIn gives no expiry and no stored `accessExpiresAt` exists, **estimate** it as the
   `LinkedInToken` row's `createdAt` (= when we first saw this env token) + `LINKEDIN_ACCESS_TOKEN_TTL_DAYS` (default 60,
   env). Store it with a source marker. Add an additive column `accessExpiresSource` (`'linkedin' | 'renewal' |
   'estimate'`, nullable). A real date from LinkedIn or from a renewal's `expires_in` always replaces an estimate.
3. **The renewal uses the estimate** like a real date (≤ 14 days → renew). The failure email wording says "about" when the
   date is an estimate.
4. **Screen:** the token line says "Token valid until about 1 Jan 2027" when the source is `estimate`, and no "about"
   otherwise. `tokenStatus()` returns the source.
5. Docs: one line in `docs/LINKEDIN_POSTING.md` (estimate rule + env var), `.env.example`.

### B. Flaky tests
For each test listed above: **find the cause and fix it at the cause.** Likely suspects, to confirm or rule out:
- real wall-clock time or `setTimeout` in a test that should use the injected clock / fake timers;
- module-level state carried between tests (e.g. the LinkedIn `stoppedFor` / token `cache` maps, the metrics warmer's
  cache, digest state rows) without a reset;
- rows from another test file in the shared test DB (parallel workers) matched by an over-broad query;
- a race between an un-awaited promise and the assertion.

Fix the test (or the test-only hook) unless the cause is a real production bug. If it IS a production bug, fix it and say
so plainly in the REPORT. Do not raise timeouts or add retries/sleeps as the fix. Do not skip or delete a test.

**Out (do not build):**
- Any change to LinkedIn posting, renewal timing (14 days) or the yearly-sign-in rule beyond the above.
- Re-architecting the test setup (one DB per worker, etc.) unless a flaky test can't be fixed without it. If so, stop and
  REPORT the proposal.

## Acceptance tests
Each one must PASS in the REPORT.
A1. Introspection mocked as 401 / 200-without-`expires_at` / network error → the reason is in the log line. Expiry =
    row `createdAt` + 60 days, source `estimate`, and at 13 days left a renewal is attempted.
A2. A 200 with `expires_at` → source `linkedin`, the estimate is replaced. A successful renewal → source `renewal`, the
    date = now + `expires_in`.
A3. `LINKEDIN_ACCESS_TOKEN_TTL_DAYS=30` changes the estimate. Invalid/missing → 60.
A4. The screen and `tokenStatus()` show "about" only for `estimate`.
A5. No secret in any log line or response (extend the existing grep test to the new line).
B1. For each listed test: the REPORT states the root cause in one or two sentences and the fix.
B2. **Stress run:** each affected test FILE passes **15 consecutive runs** while a full-suite run is going on at the same time
    (that's two programs, within the machine rule; use `nice`). Paste the loop's pass count.
B3. Then the full suite passes **twice in a row** with no re-runs.
A/B. `tsc`, lint, `build:admin`, migration applies cleanly.

## Files
- `src/services/linkedin/token.ts`, `src/routes/linkedin.ts` (status), `admin/src/views/LinkedIn.vue` ("about").
- `prisma/schema.prisma` + one migration `2026110x…_linkedin_token_expiry_source`.
- `src/lib/env.ts`, `.env.example`, `docs/LINKEDIN_POSTING.md`.
- Tests: `linkedinToken.test.ts`, `digestTick.test.ts`, `metricsWarmer.test.ts`, `eventRetention*.test.ts` + whatever the
  causes point to.

## Constraints
- Flag: none new (renewal is already behind `LINKEDIN_TOKEN_REFRESH_ENABLED`, which is ON in prod; this fixes its
  behaviour).
- Migrations: additive only.
- Full suite: yes (and twice, per B3).
- Machine rule: at most two programs at once, `nice`, jest `maxWorkers: 2`.

## Context the builder needs
- Prod today: the env access token was set 2 Nov ~16:40 IST and the `LinkedInToken` row was created on the first check
  after the 16:48 deploy, so the estimate lands ~1 Jan 2027 and the renewal ~18 Dec.
- `ensureRow()` creates the row when the env fingerprint is new. Its `createdAt` is "first seen".
