# REPORT: linkedin-token-refresh

- **Branch:** `build/linkedin-token-refresh` (base `origin/develop` 4c0a963). **Code commit:** `f5a4044`.

## Files changed
- `prisma/schema.prisma` + `prisma/migrations/20261102104159_linkedin_token/` — table `LinkedInToken` (`page` unique, `accessTokenEnc`, `refreshTokenEnc?`, `envFingerprint`, `accessExpiresAt?`, `refreshExpiresAt?`, `renewedAt?`, `lastCheckAt?`, `lastError?`). **Additive.**
- `src/services/linkedin/token.ts` (new) — AES-256-GCM (`v1:<iv>:<tag>:<ciphertext>`, key `LINKEDIN_TOKEN_KEY`), `activeAccessToken`, the daily check (introspection → renew at ≤ 14 days), failure / yearly emails, `tokenStatus`, the cron (`startLinkedInTokenRenewal`: 10:15 IST + ~2 min after boot).
- `src/services/linkedin/pages.ts` — `pageConfig()` returns the token in use (the cache the worker refreshes); `worker.ts` — `refreshActiveTokens()` at the start of each tick and before a Retry. The worker's login stop keys on the ACTIVE token's fingerprint, so a renewal ends a stop with no restart.
- `src/routes/linkedin.ts` — `GET /api/linkedin/posts` gains a `token` block (dates + status only) only while renewal is on. `src/index.ts` starts the cron. `src/services/backup.ts` — documents the exclusion of `LinkedInToken`.
- `src/lib/env.ts`, `.env.example` — `LINKEDIN_TOKEN_REFRESH_ENABLED` (default off), `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `LINKEDIN_TAXSCAN_REFRESH_TOKEN`, `LINKEDIN_TOKEN_KEY`, optional `LINKEDIN_TAXSCAN_REFRESH_EXPIRES_AT`.
- `admin/src/views/LinkedIn.vue` — the token line under the title (amber / red by status, "last renewal failed" in words). `docs/Taxscan-Push-Admin-Guide.html` — a paragraph in the LinkedIn section; **guide 2.16 → 2.17**.
- `docs/LINKEDIN_POSTING.md` ("Token renewal": how it works, the yearly sign-in steps with the `railway variable set NAME="$(pbpaste)" -s taxscan-push` commands, `openssl rand -base64 32`), `docs/BACKUPS.md` (LinkedInToken excluded).
- Tests: `src/__tests__/linkedinToken.test.ts` (19), `backup.test.ts` (exclusion list now also names LinkedInToken, LinkedInPost, WhatsAppPost).

## LinkedIn endpoints (confirmed against LinkedIn's current docs, 2 Nov 2026)
- Refresh: `POST https://www.linkedin.com/oauth/v2/accessToken`, `application/x-www-form-urlencoded`: `grant_type=refresh_token`, `refresh_token`, `client_id`, `client_secret` → `access_token`, `expires_in`, `refresh_token` (same, or new), `refresh_token_expires_in` (seconds REMAINING: a renewal does not extend the refresh token's year). 400 = invalid / expired / revoked refresh token.
- Introspection: `POST https://www.linkedin.com/oauth/v2/introspectToken` (form `client_id`, `client_secret`, `token`) → `active`, `status` (active/expired/revoked), `expires_at` (epoch seconds), `created_at`, `scope`; 200 with `active:false` when the credentials don't match the token.

## Results (verbatim)
- tsc clean; lint clean; `npm run build:admin` clean.
- New tests: `linkedinToken.test.ts` 19 passed; with the backup, LinkedIn, WhatsApp, campaign-channel and staff-push files: 145 passed, 5 repeated runs.
- **Full suite (ran: migration, env, cron, backup):** `Test Suites: 92 passed, 92 total` / `Tests: 1825 passed, 1825 total`. **One earlier full run had ONE failure** in `linkedinToken.test.ts` "6. a renewal resumes posting after a login stop" (`Tests: 1 failed, 1824 passed`); I did not capture its message. That test passes alone and in the next full run, and in 5 repeats of the neighbouring suites; I could not reproduce it. It ran right after I killed the ui-developer's test server and browser on the same database, which is my best (unproven) guess. Treat as a possible flake and watch it.

## Acceptance tests
1. Active token: matching fingerprint → stored; env changed → env used and the row dropped; no row → env (also: renewal off or a bad key → env): PASS.
2. 20 days left → no call; 13 → one refresh call with the right form body, new token stored encrypted (≠ plaintext, decrypts back), `accessExpiresAt` set, the next worker post uses it: PASS.
3. A new refresh token is stored encrypted and used on the next renewal (the env value is the fallback): PASS.
4. Refresh 400 / 401 → no further refresh calls until an env value changes; one admin email per IST day; 5xx / network → retried at the next tick: PASS.
5. Refresh token 29 days from expiry → the yearly email, at most once per 7 days (31 days → none): PASS.
6. After an auth-stop a successful renewal resumes posting with no restart, and the banner state (`linkedin:auth:<page>`) is cleared: PASS.
7. Secrets (access, refresh, rotated refresh, client secret, key) never in logs, `lastError`, the emails, the screen API, the DB state rows or the backup output (LinkedIn's error text echoing them is scrubbed): PASS.
8. `LINKEDIN_TOKEN_KEY` missing / not 32 bytes (also client id / secret, page refresh token) → `[linkedin-token] refusing to run/start: …` and posting with the env token still works: PASS.
9. The backup excludes `LinkedInToken`; flag off → no cron, no `token` block on the API: PASS.
10. tsc, lint, build:admin, new tests, LinkedIn tests, full suite: PASS (see the flake note). Migration applied on an empty DB.
- **Screen (scope item 4): NOT checked in a browser.** You asked me to stop using Chrome for Testing (the Playwright browser the ui-developer fell back on, because the claude-in-chrome tools aren't available to subagents). The line is covered by the `token` API block tests and `npm run build:admin` (vue-tsc + vite), but its look on desktop and at 375 px, and the amber / red colours, are unchecked.

## Agents run
ui-developer, once: the token line and the guide paragraph. It was stopped before its browser check; its code and guide edits were complete and I reviewed the diff.

## Decisions / worth remembering
- A renewed token is used only while `LINKEDIN_TOKEN_REFRESH_ENABLED` is on and the key is valid; otherwise the env token (so switching the flag off is a clean rollback).
- On the first daily check a row is created holding the CURRENT env token (encrypted) so expiry dates have somewhere to live; it is identical to the env token until the first renewal.
- "Blocked until the env values change" is kept as a fingerprint of the env access + refresh token in `DigestSetting` (`linkedin:token:state:<page>`), together with the failure-email day and the last yearly-email time; no extra table. `DigestSetting` is in the backup (harmless if restored).
- If the expiry can't be read (no introspection, no stored date) nothing is renewed and the log says `access_left_days=unknown`; the owner would then only learn at the auth-stop alert. A rarely-hit gap; the first successful introspection fills it.
- The refresh token's own expiry (`refresh_token_expires_in`) counts down from the first renewal; before that it comes from `LINKEDIN_TAXSCAN_REFRESH_EXPIRES_AT` if the owner sets it, else the yearly warning cannot fire until the first renewal. **Suggest the owner sets that variable to a year from the 2 Nov sign-in when switching this on.**
- Owner steps after deploy are in `docs/LINKEDIN_POSTING.md` "Setting it up (once)": a key, the client id / secret, the refresh token, then the flag.

## Clean-up (planning session, after merge)
```sh
git worktree remove ../taxscan-push-worktrees/linkedin-token-refresh
dropdb taxscan_push_build_linkedin_token_refresh; dropdb taxscan_push_build_linkedin_token_refresh_shadow
git branch -D build/linkedin-token-refresh; git push origin --delete build/linkedin-token-refresh
```
