# Security audit & posture

> **Two audits on record.** The **pre-go-live re-audit (2026-06-09)** below is
> the current state — it covers the user-management stack (Phases 1–8) that
> landed *after* the original pass. The **Task 10d audit (2026-06-02)** further
> down is retained for history but is partially superseded (e.g. it audits
> `ADMIN_PASSWORD`, which was retired in Phase 5; its "0 vulnerabilities" line
> was stale until the 2026-06-09 bcrypt bump restored it).

---

## Pre-go-live re-audit — 2026-06-09

Multi-agent audit (8 dimensions, every finding adversarially verified) of the
post-Task-10d surface: cookie-session auth, user management, audit-log
immutability, email invites, CSRF, and the live-dispatch path. **No critical or
high findings.** 28 raw findings → 24 confirmed, 4 false positives. Verified
clean by the audit: 256-bit session/invite tokens stored only as SHA-256 hashes,
fail-closed startup check, correct cookie flags (HttpOnly/Secure-in-prod/SameSite/
signed), CORP override correctly scoped to the two SDK routes, no SQLi/XSS sink,
no SSRF (feed URLs are env-only), secrets not committed.

### Fixed before go-live (the 4 mediums)

| ID | Finding | Fix | Test |
|----|---------|-----|------|
| **M1** | Push click-URL allowlist (`isAllowedPushUrl`) was only wired into the `/api/send` zod schema — the **RSS poller / sweeper dispatch path bypassed it**, and that path carries ~all traffic once `SEND_MODE=live`. | Enforce in `dispatchCampaign` (reject before persisting) **and** `executeCampaign` (covers the sweeper). New `DisallowedPushUrlError`; audit row logs host only. | `send.test.ts` "rejects an off-allowlist click URL" |
| **M2** | `passwordResetRequired` was enforced **only in the Vue router** — a temp/reset password worked as a permanent full-access credential via the API (curl). | Server-side gate in `requireUser`: a reset-required session may only hit change-password / logout / me; `403 password_change_required` elsewhere. Bearer/service path unaffected. | `auth.test.ts` "passwordResetRequired server-side enforcement (M2)" |
| **M3** | Per-email login lockout (5 fails/15 min, no IP scoping, pre-password-check) let an attacker **lock any known admin out** (targeted DoS) and blocked the real owner even with the right password. | Verify-password-**first**: a correct credential always authenticates; removed the weaponizable per-email 423 lockout; generic 401 on all failures. Brute-force bounded by the per-IP login limiter + bcrypt cost. | `auth.test.ts` "verify-first: a correct password still logs in after repeated failures" |
| **M4** | `bcrypt@5.1.1` pulled `@mapbox/node-pre-gyp → tar` with 3 high-severity advisories (build/CI-host supply-chain; not request-time reachable). Contradicted the old "0 vulnerabilities". | Bumped `bcrypt` → `^6.0.0` (patched chain; 35 transitive pkgs removed). `npm audit` = **0** (prod + dev). | full suite (hash/compare paths) + `npm audit` |

Full suite after fixes: **198/198 green** (`jest --runInBand`); `tsc --noEmit` + eslint clean.

### Deferred to a hardening backlog (decided 2026-06-09 — none block go-live)

**Low (12):** no absolute session lifetime cap (sliding 8h idle) · last-active-admin
guard is non-transactional (TOCTOU) · `/api/users/picker` leaks full roster+roles to
PUBLISHER · CSRF rests solely on SameSite=Lax (safe today — no GET mutators) · login
timing user-enumeration (bcrypt skipped for unknown email) · invite endpoints
unthrottled · `allow_purge` trigger authorizes any DELETE in its txn · `recordAudit`
swallows write failures silently · unbounded `subscribe` topics/portal · CSP disabled
app-wide · invite response reflects raw ElasticEmail error body · change-password
unthrottled / allows same-password reuse.

**Info / accept-as-designed:** audit log readable by PUBLISHER (deliberate
transparency, documented in `audit.ts` header) · immutability trigger disable-able
by a DB owner + TRUNCATE uncovered (requires DB creds) · login limiter counts
successes.

**Operator follow-ups (not code):** rotate the Railway DB password if it was ever
shared outside `.env` (still flagged from Task 10d) · the privacy-policy disclosure
items below remain the operator's responsibility.

---

## Task 10d audit (2026-06-02) — historical

Snapshot of the Task 10d audit. Each item lists what was checked, the
outcome, and where the fix lives in the codebase. **Partially superseded** —
see the 2026-06-09 re-audit above (notably: `ADMIN_PASSWORD` was retired in
Phase 5, so item 4's password-login details no longer apply; item 8's "0
vulnerabilities" was restored by the bcrypt 6 bump).

| # | Area | Status |
|---|---|---|
| 1 | Secrets in source / git history | **PASS** |
| 2 | HTTP hardening (helmet + CORS + body size) | **PASS — helmet added in this audit** |
| 3 | Rate limiting (public + admin login) | **PASS — added in this audit** |
| 4 | Auth (bearer, timing-safe, brute-force) | **PASS — brute-force backoff added** |
| 5 | Input / output (zod, URL allowlist, XSS) | **PASS — URL allowlist added** |
| 6 | Injection (Prisma everywhere) | **PASS** |
| 7 | Logging / PII | **PASS — endpoint tails redacted** |
| 8 | Dependencies (`npm audit`) | **PASS — 0 vulnerabilities** |
| 9 | Transport (DB SSL, HTTPS-only) | **PASS — production HTTPS redirect added** |

---

## 1. Secrets

**Checked**: `git grep` for `VAPID_PRIVATE_KEY=`, `ADMIN_TOKEN=`, `ADMIN_PASSWORD=`, real Postgres URLs across tracked files and the full `git log -p --all` history.

**Findings**:
- `.env` is git-ignored (`.gitignore` line: `.env`, `.env.local`). ✓
- `.env.example` only contains placeholder values (`postgresql://user:password@host:port/database?sslmode=require` etc.). ✓
- No actual secrets in any commit on `main`, `develop`, or in the reflog. ✓

**Rotation note**: the Railway DB password was pasted in the operator's chat session during development. **Rotate it now** in Railway → Postgres service → Connect → reset password, then update `DATABASE_URL` in the deployed `.env`. Any secret that leaves the operator's machine in plain text should be considered exposed.

## 2. HTTP hardening

**helmet** (`src/app.ts`) — installed in this audit. Default config minus CSP. Sets `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: no-referrer`, and the rest of helmet's safe defaults. CSP is intentionally disabled because the demo `public/index.html` uses inline scripts and styles; tightening that is a follow-up.

**CORS** (`src/lib/cors.ts`) — the gate is correct: when `ALLOWED_ORIGINS` is set, requests with a foreign `Origin` header get no `Access-Control-Allow-Origin` response header and the browser blocks them. When the env var is empty, CORS is open (dev default). Verified by test `security: CORS not open when ALLOWED_ORIGINS is set` in `src/__tests__/security.test.ts`.

**Body size** — `express.json({ limit: '64kb' })` in `src/app.ts`. Oversized JSON returns 413. Already present pre-audit.

## 3. Rate limiting

**Public endpoints** (`/api/subscribe`, `/api/unsubscribe`, `/api/track`, `/api/config`) — shared per-IP bucket, default **60 req/min** (`RATE_LIMIT_PUBLIC_PER_MIN`). Beyond the cap each request gets `429 {error:"rate_limited"}` with standard `RateLimit-*` headers.

**Admin login** (`/api/auth/login`) — separate bucket, default **5 req/min** (`RATE_LIMIT_LOGIN_PER_MIN`). Independent of the public bucket so a flooded subscribe endpoint can't help an attacker by exhausting the admin slot.

Implementation: `src/lib/rateLimit.ts` factories; wired in `createApiRouter`. `createApp({rateLimit:{publicPerMin, loginPerMin}})` accepts overrides for tests. Stores are in-memory; if we scale beyond a single instance, switch to a Redis store (`rate-limit-redis`).

Tests: `security: rate limiting` — bursts to `/api/subscribe` and `/api/auth/login` at tiny caps both produce 429s.

## 4. Auth

- **`requireBearer`** (`src/lib/auth.ts`) — `crypto.timingSafeEqual` after a length pre-check. Empty `Authorization` header, malformed bearer, length mismatch all return 401. Missing `ADMIN_TOKEN` in env also returns 401 (fail-closed). ✓
- **`/api/auth/login`** — same `timingSafeEqual` for `ADMIN_PASSWORD`. Empty / unconfigured admin password returns `503 admin_unconfigured`. ✓
- Brute-force backoff — added in this audit via the per-IP login limiter (item 3). After 5 wrong attempts/minute, `429`. Genuine attackers can rotate IPs; the cap makes naive brute-force infeasible.
- Admin endpoints behind `requireBearer`: `/api/send`, `/api/campaigns`, `/api/metrics`, `/api/admin/subscribers`, `/api/admin/subscribers/:id/test-segment`. Verified by existing tests (`admin.test.ts` "requires the bearer token" cases).

## 5. Input & output validation

- **zod on every endpoint**: `SubscribeSchema`, `UnsubscribeSchema`, `TrackSchema`, `SendSchema`, `LoginSchema`, `TargetSchema`. Malformed payloads return `400 invalid_request` with `issues`. ✓
- **Subscription-key length validation** (`src/routes/api.ts`) — `p256dh` must base64url-decode to 65 bytes; `auth` to 16 bytes. Bad keys never enter the DB as ACTIVE. ✓
- **Push URL allowlist** — new in this audit. `SendSchema.url` refines to `isAllowedPushUrl(url)`. `ALLOWED_PUSH_HOSTS` env var (default `taxscan.in,www.taxscan.in`) gates which hosts a click URL may point at. Stops a compromised admin or a malformed payload from redirecting subscribers to a phishing host. Tested in `security.test.ts`.
- **XSS in admin SPA** — `git grep "v-html"` across `admin/src/` returns nothing. All server data is rendered via `{{ }}` interpolation, which Vue escapes. ✓

## 6. Injection

`git grep '$queryRaw\\|\$executeRaw'` across `src/`, `scripts/`, and `admin/src/` returns no matches. All DB access goes through Prisma's typed query API; no string-built SQL anywhere. ✓

## 7. Logging / PII

Reviewed every `console.log/warn/error` template string. The fixes:

- `scripts/cleanup-bad-keys.ts` and `scripts/import-izooto.ts` were logging the last 40 chars of subscription endpoints on errors. Endpoints uniquely identify a subscriber and are sensitive (acting like a delivery API key for that user). **Both call sites now log only the subscriber id (cuid) or a redaction notice.**

What we never log: VAPID private key, `ADMIN_TOKEN`, `ADMIN_PASSWORD`, `DATABASE_URL`, `p256dh`, `auth`. Prisma's startup log shows the host:port but no credentials. The structured RSS log line records `feed=<url>` (deliberate — public RSS URL is not PII).

## 8. Dependencies

`npm audit` (production + dev): **0 vulnerabilities**.

`package-lock.json` is committed and not in `.gitignore` (verified). ✓

Re-run before each deploy:
```bash
npm audit
```

## 9. Transport

- **DB**: `DATABASE_URL` documented to include `?sslmode=require` in production. Railway also terminates TLS at the proxy, so the connection is encrypted regardless.
- **HTTPS-only in production**: `src/app.ts` now adds an HTTPS redirect when `NODE_ENV=production`. `app.set('trust proxy', 1)` lets Express read `X-Forwarded-Proto` from the reverse proxy; requests with `X-Forwarded-Proto: http` get a 301 to the HTTPS URL. helmet's HSTS header (180 days, includeSubDomains) sets the client-side enforcement.
- Dev and test always leave the redirect inactive — `NODE_ENV !== 'production'`.

---

## Tests added in this audit

`src/__tests__/security.test.ts`:

- helmet sets the standard hardening headers on `/healthz`.
- 429 after a public-rate-limit burst on `/api/subscribe`.
- 429 after a login-rate-limit burst on `/api/auth/login`.
- CORS — no `Access-Control-Allow-Origin` for a foreign origin when `ALLOWED_ORIGINS` is set.
- `/api/send` rejects a payload whose `url` host isn't in `ALLOWED_PUSH_HOSTS`.
- `/api/send` accepts `https://www.taxscan.in/...` (sanity).

Full suite: **94/94 passing** after the audit.

---

## Manual / compliance items (operator-side, NOT code)

Carry these forward independently before `SEND_MODE=live`:

- **Rotate the Railway DB password.** Pasted in chat → assume exposed.
- **Privacy policy** on taxscan.in must disclose:
  - That push subscriptions, topic preferences, and user agent are collected.
  - Why (article notifications).
  - How to withdraw (browser notification controls + the unsubscribe path).
- **Soft-prompt consent flow** — already non-dark-pattern (explicit Allow / No thanks / × close, all equivalent dismiss; 7-day cooldown). Keep it that way.
- **Data minimization** — the schema stores only endpoint, keys, topics, userAgent, status, timestamps. No identifying claims (name, email, IP-at-subscribe). ✓
- **Retention policy** — define (in writing) when to delete long-EXPIRED subscribers and how long to keep Events. Suggested starter:
  - EXPIRED subscribers older than 180 days → hard delete (events SetNull'd automatically).
  - Events older than 365 days → archive or hard delete depending on legal counsel.
- **Right to withdraw** — `/api/unsubscribe` works; the demo page's Unsubscribe button calls it. Verified via live curl earlier.
- **Regulatory scope** — India's DPDP Act, 2023 is primary. EU/UK readers add GDPR / UK-GDPR. Confirm with counsel before go-live.

> This audit gates Section 12 (go-live). Both the code-level acceptance (this file) AND the manual checklist above must be cleared before flipping `SEND_MODE=live`.
