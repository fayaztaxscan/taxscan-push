# Brief: LinkedIn access token renews itself (refresh token), with warnings

- **Date / name:** 2026-11-02-linkedin-token-refresh  →  branch `build/linkedin-token-refresh`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first). UI parts go to **ui-developer**.

## Goal
The Taxscan LinkedIn page's access token (about 60 days) is renewed **automatically** before it expires, using the
LinkedIn refresh token (about 365 days). The only manual work left is a yearly sign-in, announced by email 30 days ahead.
A renewed token is stored **encrypted** in Postgres and kept out of the backup. The LinkedIn screen shows when the token
and the refresh token expire.

## Why (owner's words)
> 2 Nov: "Shall we set up refresh token also for renewing after 2 months?" Planning explained the yearly limit and
> recommended automatic renewal with encrypted storage + emails. Owner: "go ahead".

Today's state: LinkedIn posting has been live since 2 Nov 15:56 IST. `LINKEDIN_TAXSCAN_ACCESS_TOKEN` is a token made on
2 Nov with LinkedIn's "OAuth 2.0 tools" for app `taxscan_post_app` (2-month lifetime). The owner holds the matching
refresh token.

## Scope
**In:**
1. **Which token is used (one function, e.g. `activeAccessToken(page)` in `src/services/linkedin/token.ts`, used by
   `pageConfig()`/the worker/Retry):**
   - If a stored (renewed) token exists for the page AND its `envFingerprint` equals the SHA-256 fingerprint of the
     current `LINKEDIN_<PAGE>_ACCESS_TOKEN` env value, use the stored token.
   - Otherwise use the env token, and drop any stored row whose fingerprint doesn't match. So when the owner pastes a new
     token into Railway (e.g. after the yearly sign-in), the new env token wins straight away.
   - The worker's auth-stop (`stoppedFor` fingerprint) keys on the ACTIVE token, so a successful renewal ends a stop
     without a restart. Clear the banner state too (`linkedin:auth:<page>`).
2. **Daily renewal check:** a `node-cron` tick at 10:15 IST, plus one run ~2 minutes after boot. For each configured page:
   - Ask LinkedIn when the active access token expires: the token introspection endpoint
     (`POST https://www.linkedin.com/oauth/v2/introspectToken`, form `client_id`, `client_secret`, `token`).
     **Confirm the endpoint and fields in LinkedIn's current docs and note them in the REPORT.** If introspection is
     unavailable, fall back to the stored `accessExpiresAt` (from the last renewal's `expires_in`).
   - **≤ 14 days left → renew:** `POST https://www.linkedin.com/oauth/v2/accessToken`
     (`application/x-www-form-urlencoded`: `grant_type=refresh_token`, `refresh_token`, `client_id`, `client_secret`).
     Store the new `access_token` (encrypted), `accessExpiresAt = now + expires_in`, and `refreshExpiresAt` from
     `refresh_token_expires_in` when present. If the response carries a DIFFERENT `refresh_token`, store it encrypted
     and use it from then on (env is the fallback).
   - Renewal failure (network / 5xx: next day's tick; 400/401 invalid or expired refresh token: no retries until the env
     values change) → **email the active ADMIN users once per IST day** (existing ElasticEmail path, like the LinkedIn
     auth alert), saying how many days the current token has left and what to do (repeat the OAuth-tools steps, paste
     the new access + refresh tokens with the clipboard command).
   - **Refresh token within 30 days of expiry** → one email per week: "Yearly LinkedIn sign-in due by <date>", with the
     steps.
   - One log line per page per run: `[linkedin-token] page=taxscan access_left_days=N refresh_left_days=M action=none|renewed|failed`.
3. **Encrypted storage:** additive table `LinkedInToken` (`page` unique, `accessTokenEnc`, `refreshTokenEnc?`,
   `envFingerprint`, `accessExpiresAt?`, `refreshExpiresAt?`, `renewedAt?`, `lastCheckAt?`, `lastError?` (≤ 240 chars,
   never a secret), `createdAt`, `updatedAt`).
   - AES-256-GCM via `node:crypto`, key = `LINKEDIN_TOKEN_KEY` (32 bytes, base64; refuse to start the renewal if it's
     missing or the wrong length). Random 12-byte IV per value, stored as `v1:<iv>:<tag>:<ciphertext>` (base64 parts).
   - **Not in the R2 backup** (`src/services/backup.ts`): add it to the explicit exclusions + a test, like
     `StaffPushSubscription`. After a restore, the env token is used, and the next renewal re-creates the row.
4. **Screen (LinkedIn, ADMIN + PUBLISHER read-only):** a small line under the title: "Token valid until 1 Jan 2027 ·
   renews automatically · yearly sign-in due by 2 Nov 2027". Amber when < 14 days (access) or < 30 days (refresh), red
   when a renewal failed. Data from `GET /api/linkedin/posts` (add a `token` block) or a sibling endpoint. **No secret
   ever leaves the server**: only dates and status.
5. **Flags/env:** `LINKEDIN_TOKEN_REFRESH_ENABLED` (default off), `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` (one app,
   all pages), `LINKEDIN_TAXSCAN_REFRESH_TOKEN`, `LINKEDIN_TOKEN_KEY`, optional `LINKEDIN_TAXSCAN_REFRESH_EXPIRES_AT` (ISO,
   if LinkedIn doesn't report it). `.env.example` entries. When on but incomplete: log
   `[linkedin-token] refusing to start: <which var>` and do nothing (posting itself keeps working with the env token).
6. **Docs:** `docs/LINKEDIN_POSTING.md` gains "Token renewal" (how it works, the yearly sign-in steps, the clipboard
   commands: `railway variable set NAME="$(pbpaste)" -s taxscan-push`, how to make the key: `openssl rand -base64 32`).
   `docs/BACKUPS.md`: `LinkedInToken` excluded. Admin guide: one paragraph in the LinkedIn section + version bump.

**Out (do not build):**
- Any OAuth sign-in flow / redirect page in our app (the yearly sign-in stays in LinkedIn's OAuth tools).
- Writing tokens back into Railway variables (no Railway API use).
- Shopscan/Academy pages (the design is per page; nothing else configured).

## Acceptance tests
Each one must PASS in the REPORT. LinkedIn HTTP is mocked throughout.
1. Active token: stored row with a matching fingerprint → stored token. Env token changed → env token is used and the
   row is dropped. No row → env.
2. Renewal: 20 days left → no call. 13 days left → one refresh call with the right form body, new token stored
   encrypted (the DB value ≠ plaintext, decrypts back), `accessExpiresAt` set, the next worker post uses it.
3. A response with a new refresh token → stored and used on the next renewal.
4. Refresh 400/401 → no further refresh calls until an env value changes, one admin email per IST day. 5xx → retried at
   the next tick.
5. Refresh token 29 days from expiry → the "yearly sign-in" email, at most once per 7 days.
6. After an auth-stop, a successful renewal resumes posting without a restart, and the banner state is cleared.
7. Secrets never appear in logs, `lastError`, any API response, or the backup output (a test greps them all for the
   plaintext token, refresh token, client secret and key).
8. `LINKEDIN_TOKEN_KEY` missing or not 32 bytes → refuses with a log line, and posting with the env token still works.
9. The backup excludes `LinkedInToken` (test). Flag off → no cron, the screen shows nothing new.
10. `tsc`, lint, `build:admin`, the new tests, the LinkedIn tests and the full suite pass. Migration applies cleanly.

## Files
- `src/services/linkedin/token.ts` (new: active token, crypto, renewal, introspection), `pages.ts`/`worker.ts` (use the
  active token), `src/routes/linkedin.ts` (token status), `src/index.ts` (cron), `src/services/backup.ts` (exclude).
- `prisma/schema.prisma` + one migration `2026110x…_linkedin_token`.
- `src/lib/env.ts`, `.env.example`, `admin/src/views/LinkedIn.vue`, guide, `docs/LINKEDIN_POSTING.md`, `docs/BACKUPS.md`.
- Tests: `src/__tests__/linkedinToken.test.ts` (+ backup exclusion).

## Constraints
- Flag: `LINKEDIN_TOKEN_REFRESH_ENABLED`, default off.
- Migrations: additive only.
- Full suite: yes (migration, env, cron, backup).
- No new npm dependency (`fetch`, `node:crypto`).
- Every error log goes through `safeErrorLog`. LinkedIn's error text is scrubbed of every secret before it's stored.

## Context the builder needs
- The LinkedIn worker, the auth-stop and the alert email: `src/services/linkedin/worker.ts` (`handleAuthStop`,
  `alertAdmins`, `fingerprint`, `authKey`). Reuse the email path and the fingerprint helper.
- Page config: `src/services/linkedin/pages.ts`. Existing env token: `LINKEDIN_TAXSCAN_ACCESS_TOKEN`.
- Backup exclusions: see how `StaffPushSubscription` / `WhatsAppPost` / `LinkedInPost` are left out.
- The owner sets secrets with `railway variable set NAME="$(pbpaste)" -s taxscan-push` (clipboard, never typed).
