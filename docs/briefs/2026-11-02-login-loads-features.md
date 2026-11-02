# Brief: after login, the admin loads the feature switches (SOCIAL menu shows without a reload)

- **Date / name:** 2026-11-02-login-loads-features  →  branch `build/login-loads-features`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first). UI part → **ui-developer**.

## Goal
Right after a successful login, the menu (SOCIAL → WhatsApp / LinkedIn) and the `/admin/whatsapp` + `/admin/linkedin`
route guards see the server's feature switches, without the user reloading the page.

## Why (owner's words)
> 2 Nov: "Abhiram is not having access to social section?"

Cause (planning, from code): `useAuth().login()` (`admin/src/composables/useAuth.ts` ~54) sets `user.value = data.user` from
`POST /api/auth/login`, whose `user` is `{ id, email, role }` with **no `features`**. Only `checkSession()` (GET `/api/auth/me`,
run on page load) returns `features`. So after a fresh login `features` is undefined: the SOCIAL group is hidden and the router
bounces `/admin/whatsapp`/`/admin/linkedin`, until a reload.

## Scope
**In:**
- In `login()`, after a successful response, fetch `/api/auth/me` once (reuse `checkSession()`), so `user.value` carries
  `features` (and anything else `/me` returns). If that `/me` call fails, keep the login's user (the menu just lacks SOCIAL,
  as today). Don't show an error.
- The same after `acceptInvite()` and after a forced password change, if they set `user.value` from a reply without `features`.
  Check each path that assigns `user.value`.
- No server change.

**Out:** changing `POST /api/auth/login`'s response, role rules, or the menu logic.

## Acceptance tests
1. Real browser (ui-developer): log out, log in as a PUBLISHER with both switches on → SOCIAL with WhatsApp + LinkedIn is
   visible immediately. Opening `/admin/whatsapp` directly after login works (no bounce). Same as ADMIN. Desktop + 375 px.
2. With `/api/auth/me` failing after login (simulate) → the login still succeeds and lands on the Dashboard.
3. `npm run build:admin`, lint, `tsc` clean.

## Constraints
- Flag: none (a bug fix).
- Migrations: none.
- Full suite: no — admin-only. Area check: `build:admin` + the browser check. The release check covers the rest.
