# User Management & Audit Log — Build Plan

> **How to use this document:** the work is broken into nine numbered phases. Each phase has a self-contained prompt block you paste into Claude Code, plus an "Acceptance check" you run yourself before declaring the phase done and a "Deploy & verify" section that says when and how to push that phase live.
>
> **Run phases in order.** Skipping ahead breaks the no-disruption guarantee.
>
> **Phases 1–4 are zero user-impact** — they only add code and data, no existing behaviour changes. You can ship each of them to production immediately after the acceptance check. Phase 5 is the first phase that affects what users see in the admin SPA, by which time everything it depends on is already live.

---

## Decisions baked into this plan

| Decision | Value | Why |
|---|---|---|
| Roles | `ADMIN` and `PUBLISHER` | ADMINs manage users + system config. PUBLISHERs send and view activity. Minimal viable role design. |
| Audit log retention | **90 days** (env-configurable via `AUDIT_LOG_RETENTION_DAYS`) | Standard SOC-2 floor for internal operational logs. Long enough for last-quarter investigations, short enough that the table doesn't bloat. |
| Failed login attempts retained | 30 days | Noisier than successful events; shorter retention. |
| Audit log access | **Readable by every logged-in user** (ADMIN + PUBLISHER). | Transparency over secrecy: anyone on the team can see who did what. Trust is built by making everyone's actions visible, not by hiding them. |
| Audit log mutability | **Append-only. UPDATE / DELETE blocked at the database level via a Postgres trigger.** A code-level Prisma middleware enforces the same rule. The retention sweeper has the only legitimate carve-out, gated by a session variable inside its transaction. | A real "no one can edit the log" guarantee — including from direct `psql` access or any future code path. Editing requires deliberately dropping the trigger, which is itself a visible, traceable act. |
| Sessions | **Server-side**, stored in Postgres, **HTTP-only signed cookies**, **8-hour sliding expiry** | Cookies are revocable instantly on password change, no JWT secret rotation pain. Postgres avoids a new infra dependency (Redis). |
| Password hashing | `bcrypt`, cost factor 12 | Battle-tested, no native binding pain on Railway. |
| Failed-login throttling | 5 failures in 15 min → 15-min lockout for that account | Standard brute-force defence. |
| First-user bootstrap | `npm run create-admin` CLI | Predictable, scriptable, no chicken-and-egg in the UI. |
| New-user onboarding | Admin creates account with temp password, shares out-of-band, user changes on first login | Avoids adding email-sending dependency in v1. Email invite is optional Phase 8. |
| Existing `ADMIN_TOKEN` | Keeps working forever (RSS poller, scripts, cron) | Backwards-compat constraint. |
| Existing `ADMIN_PASSWORD` (single-shared login) | Retired in Phase 5 when the SPA migrates to cookie auth | Only the admin SPA you control reads this. With no external callers there's no benefit to a long shim window. (Reframed 2026-06-06 — see Phase 0 alignment note.) |

---

## Quick reference — what each phase ships

| # | Phase | User-visible impact | Deploys to live? |
|---|---|---|---|
| 0 | Design alignment | None | Doc-only |
| 1 | Database schema (additive) | None | Yes (silent) |
| 2 | Auth backend (cookies + sessions coexist with bearer) | Admin SPA login disrupted until Phase 5 deploy (~1–2 operators affected; no end-user / cron impact) | Yes |
| 3 | User management API | None | Yes (silent) |
| 4 | Audit log writing + retention sweeper + middleware swap on admin endpoints | None | Yes (silent) |
| 5 | Admin SPA login flow replacement + ADMIN_PASSWORD retirement | **Login page changes; legacy single-password flow removed entirely** | **Yes — first user-visible deploy** |
| 6 | Admin SPA user management screens | New admin-only screens appear | Yes |
| 7 | Admin SPA audit log + per-campaign attribution | New screens visible to all logged-in users | Yes |
| 8 | (optional) Email invite flow | Invite flow available | Yes when needed |
| 9 | (collapsed — folded into Phase 5) | — | — |

---

## Phase 0 — Design alignment (doc only)

**Goal:** capture the design decisions above into a doc that Claude Code can refer back to throughout phases 1–9. Confirms shared understanding before any code changes.

**Files affected:** `USER_MANAGEMENT_PLAN.md` (this file already exists), plus a new `docs/AUTH_DESIGN.md` if Claude Code prefers a separate auth-only doc.

### Paste this into Claude Code

```
Context: I'm extending taxscan-push to add per-user authentication, role-
based authorization, and an audit log. The full plan is in
USER_MANAGEMENT_PLAN.md at the repo root. Read it before doing anything.

This is Phase 0 — design alignment only. NO CODE CHANGES.

Please:

1. Read USER_MANAGEMENT_PLAN.md end to end.
2. Read CLAUDE.md to confirm project rules (develop branch only, no main,
   tests as you go).
3. Read the existing prisma/schema.prisma and src/lib/auth.ts so you
   understand the current auth model (ADMIN_TOKEN bearer + ADMIN_PASSWORD
   single login).
4. If you spot any contradiction between the plan and the current code,
   raise it now in chat — do not silently work around it.
5. If everything is internally consistent, confirm by replying with a
   short summary: (a) which models you'll add in Phase 1, (b) which
   middleware approach you'll use in Phase 2, and (c) which existing
   route signatures will be preserved unchanged for backwards compat.

Do not write code, do not create files, do not run migrations. Phase 0
ends when you've confirmed alignment in chat.
```

### Acceptance check (you)

- Claude Code's reply matches the plan's decisions (two roles, 90-day retention, cookie sessions, ADMIN_TOKEN preserved).
- Claude Code has flagged any inconsistency it found between the plan and the existing code. Resolve those before moving to Phase 1.

### Deploy & verify

Nothing to deploy. Move on.

---

## Phase 1 — Database schema (purely additive)

**Goal:** add the four new entities (`User`, `UserSession`, `AuditLog`, plus a nullable `createdByUserId` on `Campaign`) to the Prisma schema and run the migration. No business logic, no routes, no middleware — only schema.

**Files affected:** `prisma/schema.prisma`, new migration under `prisma/migrations/`.

### Paste this into Claude Code

```
Phase 1 of USER_MANAGEMENT_PLAN.md — database schema only.

Constraint: must be purely additive. No existing column types, names,
constraints, or relations may change. Live database state must be
unaffected for any row that already exists.

Branch: develop (per CLAUDE.md).

1. Edit prisma/schema.prisma to add:

   - A `UserRole` enum with values ADMIN, PUBLISHER.

   - A `User` model:
       id           String   @id @default(cuid())
       email        String   @unique
       passwordHash String
       role         UserRole
       isActive     Boolean  @default(true)
       createdAt    DateTime @default(now())
       updatedAt    DateTime @updatedAt
       lastLoginAt  DateTime?
       (back-relations to UserSession, AuditLog, and Campaign)

   - A `UserSession` model:
       id           String   @id @default(cuid())
       userId       String
       user         User     @relation(fields: [userId], references: [id], onDelete: Cascade)
       tokenHash    String   @unique
       expiresAt    DateTime
       createdAt    DateTime @default(now())
       userAgent    String?
       ipAddress    String?
       @@index([userId])
       @@index([expiresAt])

   - An `AuditAction` enum with values:
       LOGIN_SUCCESS, LOGIN_FAILED, LOGOUT,
       PASSWORD_CHANGED, USER_CREATED, USER_DEACTIVATED,
       USER_REACTIVATED, USER_ROLE_CHANGED, USER_PASSWORD_RESET,
       CAMPAIGN_DISPATCHED, CAMPAIGN_DISPATCH_FAILED

   - An `AuditLog` model:
       id           String      @id @default(cuid())
       userId       String?     // nullable — covers system / bearer-token actions
       user         User?       @relation(fields: [userId], references: [id], onDelete: SetNull)
       action       AuditAction
       resourceType String?     // e.g. 'campaign', 'user'
       resourceId   String?
       metadata     Json?
       ipAddress    String?
       createdAt    DateTime    @default(now())
       @@index([userId])
       @@index([createdAt])
       @@index([action])

2. Add a NULLABLE `createdByUserId String?` to the existing Campaign
   model, plus the relation:
       createdBy   User?  @relation(fields: [createdByUserId], references: [id], onDelete: SetNull)
   The field must be nullable so existing campaigns (and future RSS-poller
   / bearer-token-dispatched campaigns) are valid.

3. Run `npx prisma format` then `npm run db:migrate` to generate and
   apply the migration locally. Migration name: "add_users_sessions_audit".

4. Edit the generated migration's `migration.sql` to APPEND a Postgres
   trigger that enforces AuditLog immutability at the database layer.
   Add this verbatim to the bottom of the file:

   ```sql
   -- AuditLog is append-only. UPDATE is forbidden in all cases.
   -- DELETE is forbidden EXCEPT inside a transaction that sets the
   -- session variable audit_log.allow_purge = 'true' (used by the
   -- retention sweeper added in Phase 4).
   CREATE OR REPLACE FUNCTION audit_log_immutable_guard()
   RETURNS trigger AS $$
   BEGIN
     IF TG_OP = 'UPDATE' THEN
       RAISE EXCEPTION 'AuditLog rows are immutable; UPDATE not allowed';
     END IF;
     IF TG_OP = 'DELETE' THEN
       IF current_setting('audit_log.allow_purge', true) = 'true' THEN
         RETURN OLD;
       END IF;
       RAISE EXCEPTION 'AuditLog rows can only be deleted by the retention sweeper';
     END IF;
     RETURN NULL;
   END;
   $$ LANGUAGE plpgsql;

   CREATE TRIGGER audit_log_immutable_before
   BEFORE UPDATE OR DELETE ON "AuditLog"
   FOR EACH ROW EXECUTE FUNCTION audit_log_immutable_guard();
   ```

5. Re-apply the migration locally (`prisma migrate reset` against the
   dev DB, then `npm run db:migrate`) to confirm the trigger creation
   doesn't conflict with anything.

6. Run `npm run db:generate` to update the Prisma Client types.

7. Run `npm test` — all existing tests must pass unchanged.

8. Add a smoke test in src/__tests__/auditImmutability.test.ts that:
   - Inserts one AuditLog row via raw SQL.
   - Asserts UPDATE on it throws ("AuditLog rows are immutable…").
   - Asserts DELETE on it throws without the session variable.
   - Inside a single transaction with `SET LOCAL audit_log.allow_purge = 'true'`,
     asserts DELETE succeeds. (Use Prisma's `$transaction` /
     `$executeRawUnsafe` for this.)

9. Commit on develop with message:
   "Phase 1: add User, UserSession, AuditLog schema (additive) + DB-level audit immutability"

When done, print:
- The path to the new migration file
- The output of `npx prisma validate`
- Confirmation that `npm test` is green
- A note that no existing rows were affected

Do NOT add routes, middleware, services, or seed data in this phase.
Schema only.
```

### Acceptance check (you)

- `prisma/migrations/<timestamp>_add_users_sessions_audit/migration.sql` exists; reads as `CREATE TABLE … / CREATE INDEX …`, with no `ALTER TABLE` on existing tables except a single `ADD COLUMN createdByUserId` (nullable, no default) on `Campaign`.
- `npx prisma validate` passes.
- `npm test` passes.
- Production DB has not been touched yet (you haven't deployed).

### Deploy & verify

Deploy the migration to Railway in your normal way (the build runs `prisma migrate deploy` on boot, or you run it manually — whichever your pipeline does today). After deploy:

```bash
psql $DATABASE_URL -c "\d User"          # table exists, columns as expected
psql $DATABASE_URL -c "\d Campaign"      # createdByUserId column added, nullable
psql $DATABASE_URL -c "SELECT count(*) FROM \"User\";"   # 0 rows — nothing to migrate
```

Live impact: zero. New tables exist but no code reads or writes them.

**Rollback:** the migration is a single set of `CREATE TABLE` + one `ADD COLUMN`. If you need to undo, `DROP TABLE "AuditLog", "UserSession", "User"; ALTER TABLE "Campaign" DROP COLUMN "createdByUserId";` — no existing data is harmed.

---

## Phase 2 — Auth backend (cookies + sessions, coexisting with bearer)

**Goal:** stand up the cookie-session auth machinery, but leave every existing route's authorisation behaviour unchanged. New endpoints are added (`/api/auth/login`, `/api/auth/logout`, `/api/auth/me`), a new middleware (`requireUser`, optionally with role) is introduced, the existing `requireBearer` is left intact, and a CLI command bootstraps the first admin.

**Files affected:** `src/lib/auth.ts`, new `src/lib/sessions.ts`, new `src/routes/auth.ts`, new `scripts/create-admin.ts`, `src/index.ts` (wire new routes + cookie parser).

### Paste this into Claude Code

```
Phase 2 of USER_MANAGEMENT_PLAN.md — auth backend.

Constraint: the EXTERNAL surface stays unchanged.
- `requireBearer` middleware unchanged.
- `/api/send` and friends still accept `Authorization: Bearer
  $ADMIN_TOKEN` — the RSS poller, sweeper, and any external curl
  clients keep working identically.
- The end-user push pipeline is untouched: `/api/subscribe`,
  `/api/unsubscribe`, `/api/track`, `/api/config`, `/taxscan-push.js`,
  `/sw.js`, `/healthz`.

Acceptable disruption in this phase: the admin SPA's `/api/auth/login`
shape changes from `{ password }` → `{ email, password }`, response
from JSON bearer → `Set-Cookie`. The currently-deployed SPA bundle
won't be able to log in between THIS deploy and the Phase 5 deploy.
Only the ~1–2 admin operators are affected; no end-user, no cron,
no external script hits this endpoint. Schedule Phase 2 when you can
reasonably ship Phase 5 within the same day.

What to add:

1. Install dependencies: bcrypt (with @types/bcrypt), cookie-parser
   (with @types/cookie-parser). Use exact versions appropriate for the
   current Node version on Railway. Add to dependencies, not dev.

2. src/lib/sessions.ts — session helpers:
   - createSession(userId, opts: { userAgent?, ipAddress? }) → returns
     { token, expiresAt }. Generates a 256-bit random token, stores
     SHA-256 hash in UserSession.tokenHash, sets expiresAt = now + 8h.
   - findValidSession(token) → looks up by SHA-256 hash, returns the
     UserSession + User if not expired and user.isActive, otherwise null.
     Also: on each successful lookup, slide expiresAt forward to now+8h
     (sliding expiry).
   - revokeSession(token) → deletes the row.
   - revokeAllSessionsForUser(userId).
   - Unit tests in src/__tests__/sessions.test.ts.

3. src/lib/auth.ts — extend:
   - Keep `requireBearer` unchanged.
   - Add `requireUser(roles?: UserRole[])` middleware. Reads
     `tx_push_session` cookie, calls findValidSession, attaches req.user
     and req.session. If no session: 401. If roles given and user.role
     not in roles: 403. On success, sliding expiry is updated (done in
     findValidSession).
   - Add `requireBearerOrUser(roles?)` — accepts either auth method. New
     routes use requireUser; the bearer path keeps existing /api/send
     etc. fully working untouched.

4. src/routes/auth.ts — new router:
   - POST /api/auth/login    body { email, password } → sets
     tx_push_session cookie, returns { user: {id, email, role} }. Throttle:
     5 failed attempts in 15 min for an email triggers 15-min lockout
     (track via AuditLog LOGIN_FAILED rows; query in middleware). All
     attempts (success + fail) recorded in AuditLog.
   - POST /api/auth/logout   requireUser → revokes the session, clears
     cookie, records AuditLog LOGOUT.
   - GET  /api/auth/me       requireUser → returns { id, email, role,
     lastLoginAt }.
   - Wire the router into src/index.ts.

5. Cookie config:
   - name: tx_push_session
   - httpOnly: true
   - secure: true (HTTPS only)
   - sameSite: 'lax'
   - path: '/'
   - maxAge: 8h
   - signed: yes — add SESSION_COOKIE_SECRET to env (required, at least
     32 chars; throw at boot if missing or too short). Update .env.example.

6. scripts/create-admin.ts — CLI:
   - Reads email + password from stdin (use readline; mask the password).
   - Validates email format and password (min 12 chars, must contain
     mixed case + digit). On failure, prints reason and exits 1.
   - Hashes with bcrypt cost 12.
   - Creates a User with role=ADMIN, isActive=true.
   - Refuses to overwrite if a user with that email already exists.
   - Add npm script: "create-admin": "ts-node-dev --transpile-only
     --no-notify --respawn=false scripts/create-admin.ts"

7. Tests:
   - src/__tests__/sessions.test.ts — happy path + expiry + sliding +
     revocation.
   - src/__tests__/auth.test.ts — POST /api/auth/login (success, wrong
     password, throttle after 5 fails), GET /api/auth/me (no cookie →
     401, valid cookie → 200), POST /api/auth/logout (revokes
     subsequent /api/auth/me).
   - Use the supertest setup already in src/__tests__/api.test.ts as
     the pattern.

8. Update README.md "Authentication" section to document:
   - Two auth methods that coexist: Bearer (scripts/cron) and cookie
     sessions (admin SPA / human users).
   - How to create the first admin (`npm run create-admin`).
   - That ADMIN_TOKEN and ADMIN_PASSWORD are unchanged in this phase.

9. Commit on develop:
   "Phase 2: cookie-session auth coexisting with bearer; create-admin CLI"

Acceptance check to print at the end:
- All existing tests still pass.
- New tests pass.
- `npm run create-admin` works locally against the dev DB.
- /api/send still accepts ADMIN_TOKEN.
- /api/auth/login + /me + /logout work end-to-end via curl.
```

### Acceptance check (you)

- `npm test` — all green.
- `npm run create-admin` — creates a User row with `role=ADMIN`, hashed password.
- `curl -X POST http://localhost:3000/api/send -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" -d '{"portal":"taxscan","title":"x","body":"x","url":"https://x","target":{"type":"topics","topics":["test"]}}'` — still works (bearer path unchanged).
- `curl -i -c cookies.txt -X POST http://localhost:3000/api/auth/login -H "Content-Type: application/json" -d '{"email":"…","password":"…"}'` — sets `tx_push_session` cookie, returns 200.
- `curl -b cookies.txt http://localhost:3000/api/auth/me` — returns the user object.

### Deploy & verify

Set the new env var on Railway: **`SESSION_COOKIE_SECRET`** (any random 32+ char string). Deploy. After deploy:

- `curl -X POST $RAILWAY_URL/api/send -H "Authorization: Bearer $ADMIN_TOKEN" …` — same as before, must still work.
- `curl -i $RAILWAY_URL/api/auth/me` — must return 401 (no cookie). This confirms the new routes are reachable.
- Don't try to log in via cookie yet — there's no user. Phase 5 is where the admin SPA starts using these routes.

Live impact: admin SPA login is broken until Phase 5 ships the new
login flow. End-user push pipeline, RSS poller, sweeper, warm-ping,
UptimeRobot, and all bearer-token clients are unaffected. Plan the
Phase 5 deploy to follow within the same day if possible.

**Rollback:** revert the deploy. The new login behaviour disappears
and the old `{ password }` → bearer response returns immediately. No
DB rollback needed; new tables and User rows can stay.

---

## Phase 3 — User management API

**Goal:** add admin-only routes for managing users. Still no UI surface; this lays the API for Phase 6.

**Files affected:** new `src/routes/users.ts`, wired into `src/index.ts`. New tests.

### Paste this into Claude Code

```
Phase 3 of USER_MANAGEMENT_PLAN.md — user management API.

Add routes for managing users. All require an ADMIN session unless
noted. All use the requireUser/requireBearerOrUser middlewares from
Phase 2.

1. src/routes/users.ts:
   - POST /api/users        admin only. Body { email, password, role }.
     Validates email + password (same rules as create-admin CLI).
     Hashes password with bcrypt cost 12. Returns the created user
     (without passwordHash). 409 on duplicate email. Records AuditLog
     USER_CREATED with metadata { createdUserId, role }.

   - GET /api/users         admin only. Returns paginated list. Query
     params: ?limit=20&offset=0&includeInactive=false. Default 20.
     Returns { items: [...], total }. No passwordHash in any response.

   - GET /api/users/:id     admin only. Returns one user. 404 if not
     found. No passwordHash.

   - PATCH /api/users/:id   admin only. Body may include { role,
     isActive }. Admin cannot deactivate themselves or demote
     themselves out of ADMIN if they are the last active ADMIN (return
     409 with a clear message). Records appropriate AuditLog actions.

   - POST /api/users/:id/reset-password    admin only. Generates a
     temp password (16 chars, mixed-case + digit + symbol), updates
     passwordHash, revokes all sessions for that user, returns
     { temporaryPassword: '...' } so the admin can share it
     out-of-band. Records AuditLog USER_PASSWORD_RESET. The user must
     change this on next login (mark via a passwordResetRequired flag
     on User — add this field via a separate migration step in this
     phase; default false; backfill is trivial since false is the
     default).

   - POST /api/auth/change-password    requireUser (not admin-only).
     Body { currentPassword, newPassword }. Validates current
     password, hashes new one, revokes all OTHER sessions for the user
     (keeping the current one). If the user has passwordResetRequired
     = true, clears it. Records AuditLog PASSWORD_CHANGED.

2. Migration: add passwordResetRequired Boolean @default(false) to User.
   `npm run db:migrate` (name: "user_password_reset_required").

3. Tests in src/__tests__/users.test.ts — at least:
   - Admin can create a publisher; publisher cannot create users (403).
   - Last-active-admin protection: cannot deactivate or demote self.
   - Reset password generates a string of the expected shape, revokes
     other sessions, and the user can then log in with that temp
     password.
   - Change password rejects wrong currentPassword; on success the OLD
     session is no longer valid but the calling session still is.

4. README.md auth section: brief note on the admin-managed user
   lifecycle (create → share temp pw OOB → user changes on first
   login).

5. Commit on develop:
   "Phase 3: user management API + passwordResetRequired flag"

Acceptance: all tests green, no existing route behaviour changed.
```

### Acceptance check (you)

- `npm test` — all green.
- Locally, `curl -b cookies.txt -X POST http://localhost:3000/api/users -d '{"email":"editor@taxscan.in","password":"…","role":"PUBLISHER"}'` returns the new user.
- A second admin can't be deleted if they're the only active one.

### Deploy & verify

Deploy. Verify with curl that:
- `/api/users` returns 401 with no session cookie.
- `/api/users` returns 403 if logged in as PUBLISHER.
- `/api/users` returns the list if logged in as ADMIN.

Live impact: zero. No UI uses these routes yet.

**Rollback:** revert deploy + roll back the `passwordResetRequired` column (single nullable add — drop is safe).

---

## Phase 4 — Audit log writing + retention sweeper

**Goal:** start writing AuditLog rows from the auth + user-management routes (Phases 2–3 should already have written stubs in their handlers — this phase ensures the helper is centralised). Add a `GET /api/audit` endpoint for reading. Add a daily sweeper cron that prunes rows older than `AUDIT_LOG_RETENTION_DAYS` (default 90) and rows for `LOGIN_FAILED` older than 30 days.

**Files affected:** new `src/lib/audit.ts`, edits to `src/routes/auth.ts` and `src/routes/users.ts` (route through the helper), new `src/sweepers/auditRetention.ts` (cron entry in `src/index.ts`), `src/services/send.ts` writes `CAMPAIGN_DISPATCHED` / `CAMPAIGN_DISPATCH_FAILED` and sets `Campaign.createdByUserId` from `req.user` when present. New tests.

### Paste this into Claude Code

```
Phase 4 of USER_MANAGEMENT_PLAN.md — audit log writing, /api/audit
endpoint, retention sweeper.

1. src/lib/audit.ts:
   - export async function recordAudit(input: {
       userId?: string | null,
       action: AuditAction,
       resourceType?: string,
       resourceId?: string,
       metadata?: Record<string, unknown>,
       ipAddress?: string,
     }): Promise<void>
     — non-throwing; on DB error, console.warn and continue. Audit log
     writes must never block the underlying action.

2. Route through the helper:
   - Phase 2/3 routes that wrote inline AuditLog rows now call
     recordAudit. Same data, single function.

3. Middleware swap on admin endpoints + dispatchCampaign attribution:
   - Swap `/api/send`, `/api/campaigns`, `/api/metrics`,
     `/api/admin/subscribers`, and
     `/api/admin/subscribers/:id/test-segment` from `requireBearer`
     to `requireBearerOrUser` from Phase 2. Bearer keeps working
     identically (req.user stays unset → all current cron / curl
     usage unchanged); cookie sessions now also work (req.user is
     populated for the dispatch path to read).
   - dispatchCampaign accepts an optional `createdByUserId` (passed
     from the route handler when req.user is present; null when call
     came via bearer-token / RSS poller / sweeper).
   - Persists it onto Campaign.createdByUserId.
   - On dispatch result, recordAudit with action=CAMPAIGN_DISPATCHED
     and metadata { campaignId, sent, failed, capped, expiredPruned,
     status }. On thrown failure: CAMPAIGN_DISPATCH_FAILED with the
     error message.

4. src/routes/audit.ts:
   - GET /api/audit       requireUser (any role). Query:
     ?action=&userId=&since=&until=&limit=50&offset=0
     Limit max 200. Returns { items, total }. Joins user (email, role)
     so the UI doesn't have to lookup separately. PUBLISHERS can read
     the audit log; if you want to restrict to ADMINS, change to
     requireUser([ADMIN]) — but the default plan is "everyone on the
     team can see who did what".

5. src/sweepers/auditRetention.ts:
   - Cron: every day at 03:00 IST.
   - Reads env AUDIT_LOG_RETENTION_DAYS (default 90), and
     AUDIT_LOG_FAILED_LOGIN_RETENTION_DAYS (default 30).
   - Deletes AuditLog where createdAt < now - retention.
   - Logs how many rows were deleted.
   - Wire into src/index.ts (similar to the existing sweeper).
   - Env knob: `AUDIT_LOG_SWEEPER_ENABLED` (default true).

   IMPORTANT — the DB trigger from Phase 1 blocks DELETE on AuditLog by
   default. The sweeper must opt in to the carve-out, inside a single
   transaction, like this:

   ```ts
   await prisma.$transaction(async (tx) => {
     await tx.$executeRawUnsafe(
       `SET LOCAL audit_log.allow_purge = 'true'`,
     );
     const generalCutoff = new Date(Date.now() - retentionDays * 86400_000);
     const failedLoginCutoff = new Date(Date.now() - failedLoginRetentionDays * 86400_000);
     await tx.$executeRaw`
       DELETE FROM "AuditLog"
       WHERE ("action" = 'LOGIN_FAILED' AND "createdAt" < ${failedLoginCutoff})
          OR ("action" <> 'LOGIN_FAILED' AND "createdAt" < ${generalCutoff})
     `;
   });
   ```

   The `SET LOCAL` is scoped to that one transaction, so the carve-out
   cannot leak into any other DB connection or query.

6. src/lib/prisma.ts (or wherever the Prisma client is instantiated):
   add a client extension (Prisma v5+ `$extends`) that throws on
   `auditLog.update`, `auditLog.updateMany`, `auditLog.delete`, and
   `auditLog.deleteMany` calls. The retention sweeper bypasses this by
   using `$executeRawUnsafe` / `$executeRaw` (the extension only sees
   typed model operations, not raw SQL). This belt-and-braces guard
   catches accidental edits in PRs at code-review time, even before
   the DB trigger would catch them at runtime.

6. Update .env.example with the three new vars + brief inline doc.

7. Tests:
   - audit.test.ts — recordAudit never throws even when DB write fails
     (mock prisma to throw, assert no exception).
   - audit.test.ts — GET /api/audit honours filters, paginates.
   - auditRetention.test.ts — given seeded rows of varying ages and
     actions, the sweeper deletes the right ones (older than
     retention, including the shorter LOGIN_FAILED window).
   - auditRetention.test.ts — assert the sweeper transaction does not
     leak the carve-out: a second connection trying DELETE
     concurrently still gets the immutability error.
   - auditImmutability.test.ts (extend the smoke test from Phase 1) —
     after Phase 4 ships, also assert that the Prisma client extension
     throws on auditLog.update / updateMany / delete / deleteMany at
     the application layer, before the request even reaches the DB.
   - send.test.ts — extend to assert createdByUserId is persisted when
     a user is passed, null otherwise; AuditLog row is written.

8. Commit on develop:
   "Phase 4: audit log writing, /api/audit endpoint, retention sweeper"

Live impact, when this deploys: still zero user-visible — the audit log
just starts collecting. The next phase (5) is the first that surfaces
any of it to the UI.
```

### Acceptance check (you)

- `npm test` green.
- Locally, run a send via curl with bearer — confirm a Campaign row has `createdByUserId = null` and an `AuditLog` row with `action = CAMPAIGN_DISPATCHED`.
- Log in via curl, send via the same endpoint with the cookie — confirm Campaign.createdByUserId is set.
- Set `AUDIT_LOG_RETENTION_DAYS=0` locally, run the sweeper manually, confirm rows are deleted.

### Deploy & verify

Add env vars to Railway: `AUDIT_LOG_RETENTION_DAYS=90`, `AUDIT_LOG_FAILED_LOGIN_RETENTION_DAYS=30`, `AUDIT_LOG_SWEEPER_ENABLED=true`. Deploy. After deploy:

- `curl -b cookies.txt $RAILWAY_URL/api/audit?limit=10` should return whatever events happened during your verification.

Live impact: zero on the public site; only internal data collection starts.

**Rollback:** revert deploy. AuditLog rows already written can stay or be dropped; doesn't matter.

---

## Phase 5 — Admin SPA login flow (first user-visible deploy)

**Goal:** replace the existing single-password admin login with the new email + password flow. This is the first phase that changes what an admin sees.

**Files affected:** files in the admin SPA (Vue 3 + Vite). Locations depend on the existing structure — Claude Code will discover them.

### Paste this into Claude Code

```
Phase 5 of USER_MANAGEMENT_PLAN.md — admin SPA login flow.

This is the first phase that changes user-visible behaviour. Plan
deploy timing accordingly (see USER_MANAGEMENT_PLAN.md "Deploy &
verify").

The admin SPA lives in `admin/` (Vue 3 + Vite — check the package.json
to confirm). Today it uses a single-password flow against the
ADMIN_PASSWORD env var. Replace that with:

1. Login page:
   - Two fields: email + password. Submit calls POST /api/auth/login.
   - Sets cookie via the response Set-Cookie header (no client-side
     storage of the token).
   - On 401, show "Incorrect email or password" (do not distinguish
     "no such user" from "wrong password").
   - On 423 (locked out — backend returns 423 after 5 failures), show
     "Too many attempts. Try again in 15 minutes."
   - On success, redirect to / (the dashboard).

2. Router/guards:
   - Every authenticated route checks GET /api/auth/me on enter; if
     401, redirect to /login.
   - Persist nothing client-side except a flag "we have a session"
     after a successful /me ping. The cookie is the source of truth.

3. Header (top-right of admin UI):
   - User email + role badge.
   - "Change password" link → modal that calls
     POST /api/auth/change-password.
   - "Log out" button → POST /api/auth/logout, then redirect to /login.

4. First-login forced password change:
   - If GET /api/auth/me indicates passwordResetRequired = true (add
     this field to the response in src/routes/auth.ts), gate the SPA
     behind a "change your temporary password" modal that cannot be
     dismissed.

5. Retire ADMIN_PASSWORD (was Phase 9 — folded in here):
   - Phase 2 already replaced `/api/auth/login`'s shape; this phase
     ships the SPA that consumes the new shape. With both ends
     migrated and no external callers of the old `{ password }`
     branch, ADMIN_PASSWORD has no remaining readers.
   - Remove `ADMIN_PASSWORD` from `src/lib/env.ts` and the required-
     env list in `src/lib/startupCheck.ts`.
   - Remove the variable from `.env.example` and the README's
     env-vars section.
   - Drop the variable from Railway env AFTER the deploy succeeds
     (leaving it in env briefly after the code stops reading it is
     harmless; removing first would have done nothing).
   - No `/api/admin-password-login` legacy endpoint is required —
     no entrenched SPA tabs to shim around.

6. Tests (Vitest or whatever testing framework the SPA uses):
   - Login form happy path.
   - Wrong-password error message.
   - Forced password change blocks navigation.
   - Logout clears auth and routes to /login.

7. Update README.md:
   - "First-time setup" — `npm run create-admin`, then go to /login.
   - "Adding team members" — sign in as admin → Users page (Phase 6
     will land that page).

8. Commit on develop:
   "Phase 5: admin SPA email+password login, change-password modal,
   logout"

Acceptance: a freshly built admin SPA bundle, deployed against a
backend with at least one User row, can log in by email + password,
see user info in the header, change the password, and log out.
```

### Acceptance check (you)

Before deploying:
1. **Create at least one admin in production** with `npm run create-admin` (run it against the production database via Railway shell). Without this step, no one can log into the new UI.
2. Locally, walk through the four flows: login, see header, change password, log out.

### Deploy & verify (the careful one)

This is the **first user-visible deploy**. To avoid disruption to anyone who's currently logged in via the old flow:

1. Confirm at least one admin user exists in production.
2. Deploy.
3. **Tell your team in advance** that they'll see a new login screen and that they should ask you for an account.
4. After deploy, log in yourself once via the new flow.
5. Drop `ADMIN_PASSWORD` from Railway env (the deployed code no longer reads it).

Live impact: the login page changes; ADMIN_PASSWORD is gone from the system. Everything downstream of login is unaffected (you're still using the same admin features you have today; later phases add new ones).

**Rollback:** roll back BOTH the SPA bundle AND the Phase 2 backend together — Phase 5's SPA expects Phase 2's cookie endpoints, so rolling back only one half leaves a broken login. If you rolled forward past Phase 2 already, restoring the legacy `{ password }` → bearer behaviour requires reverting Phase 2's commit (the `/api/auth/login` shape change) and re-adding `ADMIN_PASSWORD` to Railway env.

---

## Phase 6 — Admin SPA: user management screens (admin only)

**Goal:** the Users page. Admins can list, create, deactivate, change roles, and reset passwords for other users.

### Paste this into Claude Code

```
Phase 6 of USER_MANAGEMENT_PLAN.md — admin SPA user management.

In the admin SPA, add an /admin/users route. Guard: visible only to
users with role=ADMIN; for PUBLISHERS the nav link is hidden and a
direct visit redirects to /.

1. Users list page:
   - Table: email, role, isActive, lastLoginAt, createdAt, actions.
   - Default filter: active only. Toggle to include inactive.
   - Pagination using the API's offset/limit.

2. "Create user" modal:
   - Fields: email, role (ADMIN/PUBLISHER), temp password (auto-
     generated with a "copy" button next to it).
   - Submit calls POST /api/users.
   - On success, show "Account created. Share this temp password with
     <email> through your usual channel. They'll be asked to change
     it on first login."

3. Row actions (per user):
   - Toggle isActive (with confirmation).
   - Change role (with confirmation).
   - Reset password — calls POST /api/users/:id/reset-password and
     shows the temp password back to the admin with a copy button.
     Includes a clear note that this revokes all the user's active
     sessions immediately.
   - All these surface the API's last-active-admin guard cleanly: if
     the API returns 409, show the human-readable message it returns.

4. Tests for the page (where the SPA's testing framework supports it):
   happy path for each action, plus the 409 last-admin guard.

5. Commit on develop:
   "Phase 6: admin SPA user management screens"

Acceptance: a logged-in ADMIN can fully manage the team from the UI;
PUBLISHERS see no Users link.
```

### Acceptance check (you)

- Manage at least one round-trip in the UI: create a user, change their role, reset their password, log in as them, change the password, log back in as admin and deactivate them.

### Deploy & verify

Deploy. Verify that a PUBLISHER (not admin) cannot see or visit `/admin/users`.

Live impact: ADMINs see a new nav item. PUBLISHERS see nothing new.

**Rollback:** redeploy previous bundle.

---

## Phase 7 — Admin SPA: audit log + per-campaign attribution

**Goal:** make the data visible. New "Activity" page reads `GET /api/audit`. The existing campaigns list/detail shows who sent each campaign and the dispatch result counters.

### Paste this into Claude Code

```
Phase 7 of USER_MANAGEMENT_PLAN.md — admin SPA: activity feed +
per-campaign attribution.

1. Activity page (route /activity, visible to all logged-in users):
   - Filters: user (dropdown of users), action (dropdown of
     AuditAction values), date range, search-by-resource-id (free-form).
   - Table: timestamp · user (email + role badge) · action · resource
     (type + id linked where relevant — campaign id links to the
     campaign detail page) · summary line built from metadata.
   - Server-side pagination via the API's offset/limit.
   - Default sort: newest first.

2. Campaign list page (existing route):
   - Add a "Created by" column. Show the user's email if set, "via
     bearer / system" if createdByUserId is null.
   - Add filter: "Show only mine" (=createdByUserId of current user).

3. Campaign detail page (existing route):
   - Surface the result metrics in one block: target size, sent,
     failed, capped, expired-pruned, click count, CTR.
   - Show the audit-log subset filtered to this campaign id
     (resourceType=campaign, resourceId=campaign.id), so admins can
     see the dispatch attempt + result line and any failures.

4. Nav:
   - Add "Activity" to the main nav. Visible to all logged-in users.

5. Tests where applicable.

6. README.md:
   - Brief section on the audit log: what's recorded, 90-day retention
     by default, where to find it in the UI, how to lengthen it via
     env var if needed.

7. Commit on develop:
   "Phase 7: admin SPA activity feed + per-campaign attribution"

Acceptance: everything the team needs to answer "who sent what, when,
and how did it go?" is visible in the UI without inspecting the DB.
```

### Acceptance check (you)

- Send a test campaign as ADMIN → it appears in Activity with action `CAMPAIGN_DISPATCHED` and your email as the actor; the Campaigns page shows your email as creator; the campaign detail shows the result metrics; reset another user's password → it appears in Activity as `USER_PASSWORD_RESET`.

### Deploy & verify

Deploy. Live impact: new screen + extra columns. No existing behaviour changes.

**Rollback:** redeploy previous bundle.

---

## Phase 8 (optional) — Email-invite flow

Skip unless team-growth volume justifies the dependency. When you're ready:

```
Phase 8 of USER_MANAGEMENT_PLAN.md — email invite flow.

Replace the admin-creates-with-temp-password flow with an email-invite
flow: admin enters email + role → backend creates an inactive User
with no password + a single-use invite token → emails the recipient a
link → on click, recipient sets their own password and the account is
activated.

Requires adding an email-sending dependency (Resend or Postmark or
similar). Configure via env. Keep create-admin CLI for bootstrapping;
keep manual-create-with-temp-password as an admin override.

Audit log gets two new actions: USER_INVITED, USER_INVITE_ACCEPTED.
```

### Acceptance / Deploy / Rollback

Standard pattern as previous phases.

---

## Phase 9 (collapsed — work folded into Phase 5)

Originally this phase removed the legacy single-shared-password fallback after the team migrated. The Phase 0 reframing on 2026-06-06 (no entrenched legacy users — the system went live the same day and the admin SPA has only ~1–2 operators, all coordinated directly) folded that work into Phase 5: ADMIN_PASSWORD is retired the moment the SPA stops using it.

The phase number is kept here as a placeholder so the rollback summary's phase column and any external references in commit messages or PR titles don't shift if you ever skim the table.

---

## Cross-cutting rollback summary

| Phase | Rollback action | Side effects |
|---|---|---|
| 1 | Drop the four new tables + the new column on Campaign | None (no rows existed) |
| 2 | Revert deploy | New endpoints disappear; bearer path unchanged |
| 3 | Revert deploy + drop `passwordResetRequired` | None (default value harmless) |
| 4 | Revert deploy | Audit log rows can stay or be dropped |
| 5 | Roll back BOTH the SPA bundle AND Phase 2 backend commit together + restore `ADMIN_PASSWORD` on Railway | Pre-Phase-2 login behaviour fully restored. Half-rollback (only one of the two) leaves login broken. |
| 6 | Redeploy previous admin SPA bundle | Nav item disappears |
| 7 | Redeploy previous admin SPA bundle | Activity page disappears |
| 8 | Revert deploy | Email invite gone; manual create still works |
| 9 | n/a — phase folded into Phase 5 | — |

All rollbacks are safe and isolated; no irreversible step exists in the plan.

---

## Open questions to revisit later

These are intentionally deferred — not blockers for shipping the plan above, but worth a five-minute think before you start:

1. **2FA.** Worth considering once the Phase 1–7 rollout is complete if the team ever exceeds ~5 people or you hold subscriber data that warrants it. TOTP (Google Authenticator) is the cheapest add — one extra column on User, one extra step in login, one library (`otplib`). Not in v1.
2. **Session length.** 8 hours sliding is comfortable for editorial work. If your team finds it too short or too long after a couple of weeks, change `SESSION_TTL_HOURS` (add it as an env var in Phase 2 — the plan above bakes in 8h via a constant; convert to env if you anticipate tuning).
3. **Cryptographically-chained audit trail.** The current plan makes the log unmodifiable from any normal app code path and from `psql` (the trigger blocks UPDATE/DELETE). The next level up is tamper-evident even by a DBA: each new row stores a hash of the previous row's content, and any retroactive edit is detectable by re-walking the chain. That's gold-standard for legal evidence; almost certainly overkill for an editorial team. If your needs ever change (e.g., regulatory inquiry, formal audit), this is the upgrade path; it's a one-column addition + one INSERT trigger and doesn't disrupt anything in this plan.
4. **Archive-then-delete instead of delete.** Today the retention sweeper hard-deletes rows older than the window. An alternative is "before deleting, write the row to an immutable cold-storage bucket (S3 Glacier, etc.)". Useful only if you ever need to answer questions about events older than retention; for the current use case, plain deletion is correct.

---

## Final note on safety

Phases 1, 3, 4, 6, 7, 8 deploy without any user noticing. **Phases 2 and 5 are a coupled pair** — Phase 2 changes the admin SPA's login endpoint shape, breaking the currently-deployed SPA's login flow; Phase 5 ships the new SPA bundle that consumes it. The window between the two deploys is the disruption window for the ~1–2 admin operators (you). Plan to ship Phase 2 and Phase 5 within the same working day, ideally back-to-back. End-user push, RSS poller, sweeper, and bearer-token cron clients see zero impact across all phases.
