# Brief: Activity log is admin-only

- **Date / name:** 2026-10-29-activity-admin-only → branch `build/activity-admin-only`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first)

## Goal
Only an ADMIN (or the `ADMIN_TOKEN` bearer, if the route accepts it today) can see the Activity (audit) log. A
PUBLISHER doesn't see it in the menu, can't open the page, and gets 403 from the API.

## Why (owner's words)
> 2026-10-29: "Publisher role need not have access to activity log."

`src/routes/audit.ts` lines 2–6 already anticipated this: "if the call wants this restricted to ADMINs, flip the
middleware to requireUser(['ADMIN'])".

## Scope
**In:**
- `src/routes/audit.ts`: `GET /api/audit` → `requireUser(['ADMIN'])`. Update the header comment to record the
  owner's decision and date.
- `admin/src/router.ts`: `/activity` gets `meta: { roles: ['ADMIN'] }`. A publisher visiting it directly is
  redirected exactly as `/users` is today.
- `admin/src/components/NavBar.vue`: show Activity only when `user?.role === 'ADMIN'`.
- Any other SPA place that links to Activity or calls `/api/audit` for a publisher. Planning's grep found none
  outside `Activity.vue`; confirm it.
- Admin guide: the role table (~line 163) and the menu table (~line 413) mark Activity as Admins only. Bump the
  version line to **v2.6, 29 October 2026**.
- Fix the 3 pre-existing lint errors while you're here (`src/__tests__/audienceConfig.test.ts:226`
  `no-var-requires`; `src/__tests__/digestRenderer.test.ts:513` `no-irregular-whitespace` ×2) without changing what
  those tests assert, so `npm run lint` is clean.

**Out:**
- Audit *writing* is unchanged: publishers' actions are still recorded.
- No change to audit retention, the sweeper, or any other role gate.

## Acceptance tests
1. API: PUBLISHER session → 403 on `GET /api/audit`; ADMIN → 200; no session → 401. Extend
   `publisherStaffBoundary.test.ts` (the over-opening guard from 29 Oct).
2. A publisher's action, e.g. creating an ad, still writes its audit row; an ADMIN can read it.
3. In a real browser, as a publisher: no Activity in the menu (desktop and the hamburger below 1200 px), and
   `/admin/activity` redirects. As an admin: Activity is there and loads. One browser only.
4. `npm run lint` → 0 errors. tsc, `npm run build:admin` and the full suite are green.

## Files
`src/routes/audit.ts`, `admin/src/router.ts`, `admin/src/components/NavBar.vue`,
`src/__tests__/publisherStaffBoundary.test.ts`, `src/__tests__/audienceConfig.test.ts`,
`src/__tests__/digestRenderer.test.ts`, `docs/Taxscan-Push-Admin-Guide.html`.

## Constraints
No flag, no migration, no env. Queue it after `2026-10-29-digest-lookalike` (one brief at a time).
