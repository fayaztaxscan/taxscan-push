# REPORT: login-loads-features

- **Branch:** `build/login-loads-features` (base `origin/develop` 771f0b4). **Code commit:** `1967f9e`.

## Cause and fix
`POST /api/auth/login` answers `{ id, email, role }` with no `features`, so after a fresh login `user.value` had none until a reload (`checkSession()` on page load reads `/api/auth/me`, which has them). The SOCIAL menu and the `/whatsapp` + `/linkedin` route guards therefore saw "no features" (Abhiram's case).

`admin/src/composables/useAuth.ts`:
- New module-level `readMe()` — `GET /api/auth/me`, returns the user or **null on any failure** (a non-OK status, a network error, a body that isn't JSON); it never throws and never touches `user`.
- `login()` now sets the user from the login reply (as before), then calls `readMe()` once and, if it answered, replaces the user with the full one (features included). If `/me` fails it keeps the login's user and shows nothing (the menu just lacks SOCIAL, as before).
- `checkSession()` uses the same `readMe()` and keeps its behaviour exactly (a failure still means signed out). I did **not** reuse `checkSession()` for the login path as the brief suggested, because on a `/me` failure it sets the user to null, which would contradict "keep the login's user".
- Every place that assigns `user.value`, checked: `checkSession` (reads `/me`, has features), `acceptInvite` (already re-hydrates through `checkSession()`), a forced password change (`changePassword` only clears `passwordResetRequired` on the existing user, so it keeps its features), `logout` and the 401 handler in `useApi` (set null). Only `login()` was missing them.
- Two harmless casts (`res.json()` as the known shape) so the file also compiles under the server's TypeScript settings, where `json()` is `unknown`; needed to import it from a jest test. No behaviour change.
- No server change.

## Files
- `admin/src/composables/useAuth.ts` (above); `src/__tests__/adminLoginFeatures.test.ts` (new, 10 tests: the composable driven with a fake `fetch`, no browser, no database).

## Results (verbatim)
- `npx tsc -p tsconfig.json --noEmit`: clean. `npm run lint`: clean. `npm run build:admin` (vue-tsc + vite): clean.
- `adminLoginFeatures.test.ts`: `Tests: 10 passed, 10 total`.
- No full suite (admin-only; the release check covers the rest).

## Acceptance
1. After a login as PUBLISHER and as ADMIN, `/api/auth/me` is read once (`['/api/auth/login','/api/auth/me']`) and the user carries `features` (switches that are off stay off), so the SOCIAL group and the route guards see them with no reload: **PASS at the composable level.**
   **NOT checked in a real browser, desktop or 375 px.** You told me to stop using Chrome for Testing, and the in-session extension browser tools are not available to the build agents, so there was no sanctioned browser. The menu and the router guard read `user.features` unchanged (the WhatsApp / LinkedIn / SOCIAL builds did); only where the value comes from changed. If you want the visual check, it is a 2-minute job on a phone once this is deployed: log out, log in as a PUBLISHER, SOCIAL should show at once.
2. `/api/auth/me` failing after a login (a 500, a 401, a network error, a body that isn't JSON) → the login still resolves, nothing is thrown, the user stays the login's (so the router lands on the Dashboard as today; no error shown): PASS (4 tests). A wrong password still throws the same `AuthError`s and reads nothing else: PASS.
3. `build:admin`, lint, tsc clean: PASS.

## Agents run
None (a composable, no visual change).

## Clean-up (planning session, after merge)
```sh
git worktree remove ../taxscan-push-worktrees/login-loads-features
git branch -D build/login-loads-features; git push origin --delete build/login-loads-features
```
(no database was created for this build: it needs none.)
