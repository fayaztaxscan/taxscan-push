# REPORT: 2026-10-29-activity-admin-only

- **Branch:** `build/activity-admin-only` (base `origin/develop` at `deb9943`)
- **Code commit:** `f95f7685f57f9eb161164f449db3247c9d59e866`
- **Result:** all 4 acceptance items PASS. One finding the brief did not expect (`CampaignDetail.vue`, below).

## Files changed

- `src/routes/audit.ts`: `GET /api/audit` → `requireUser(['ADMIN'])` (the route takes a session only; it never accepted the bearer, so there is no bearer case). Header comment records the owner's decision and date.
- `admin/src/router.ts`: `/activity` gets `meta: { roles: ['ADMIN'] }`; a publisher is redirected to the dashboard exactly as for `/users`.
- `admin/src/components/NavBar.vue`: Activity shown only for `user?.role === 'ADMIN'`. One link serves both the desktop bar and the hamburger.
- **`admin/src/components/CampaignDetail.vue` (not in the brief's file list):** see Worth remembering.
- `src/__tests__/publisherStaffBoundary.test.ts`: `GET /api/audit` (and `?limit=5`) added to the publisher-403 / no-session-401 list; new tests: ADMIN 200 / PUBLISHER 403 (no rows in the refusal) / none 401, and "a publisher creating an ad writes the audit row with the publisher as actor, and an admin reads it".
- `src/__tests__/audit.test.ts`: "returns 200 for a PUBLISHER too" is now "returns 403 for a PUBLISHER"; the five filter/pagination tests (which don't care about the role) log in as an ADMIN instead; header comment updated.
- `src/__tests__/auth.test.ts`: the forced-password-change test used `/api/audit` as its "normal any-role route"; it now uses `/api/campaigns`, which every signed-in user can read. What the test asserts is unchanged.
- `src/__tests__/audienceConfig.test.ts` (lint): the `eslint-disable` comment named `no-require-imports` but the rule that fired is `no-var-requires`; comment corrected. No assertion touched.
- `src/__tests__/digestRenderer.test.ts` (lint): the invisible zero-width / bidi characters in one regex literal are now written as `\u` escapes (same character set: `​-‍ ⁠ ﻿ ‪-‮ ⁦-⁩`). Same pattern, same assertions.
- `docs/Taxscan-Push-Admin-Guide.html`: **v2.6, 29 October 2026**. Role table (Administrator: "…and read the Activity log"; Publisher: no Activity, "cannot … choose who gets the report email, or read the Activity log"), the "Keep your login private" box ("which administrators can read"), and the menu table (Activity marked "(Admins only)"). The guide on `develop` was already v2.5 (guide-pdf branch merged), so this is the next number.

## Migrations / flags / env

None.

## Test results (verbatim)

- `npx tsc -p tsconfig.json --noEmit`: exit 0.
- `npm run lint`: exit 0, no errors (**the three known errors are gone**).
- `npm run build:admin`: `✓ built in 2.12s`.
- New and changed suites: `src/__tests__/audit`, `publisherStaffBoundary`, `auth` pass.
- **Full suite (`--maxWorkers=1`):** `Test Suites: 74 passed, 74 total` · `Tests: 1478 passed, 1478 total`. (An earlier run of this same code failed `auth.test.ts` — that was the `/api/audit` dependency above, fixed.)

## Acceptance tests

1. **PASS.** `GET /api/audit`: PUBLISHER → 403 (body has no `items`), ADMIN → 200, no session → 401, in `publisherStaffBoundary.test.ts`.
2. **PASS.** A publisher creates an ad through the API (201); the audit row for that ad exists with `userId` = the publisher and an action starting `DIGEST_AD`; an ADMIN reads it with `GET /api/audit?userId=<publisher>`. Audit writing is untouched.
3. **PASS**, real Chrome against the local dev server (port 3917, build DB, one browser):
   - **Publisher:** the desktop menu is `Dashboard Compose Review Queue Campaigns Reports Digests Ads Templates Guide Change password` (no Activity). In a 900 px frame (the hamburger layout, menu opened) the same list. Opening `/admin/activity` directly lands on `/admin/dashboard`.
   - **Admin:** Activity and Users are in the menu in both layouts; `/admin/activity` loads and lists the rows, including the publisher's earlier login and logout.
   - **Campaign detail** (the extra finding): as a publisher it opens and shows the campaign, source and numbers with no error and no audit section; as an admin it still shows "Audit log for this campaign".
   The window resize in this automation did not narrow the real viewport, so the hamburger layout was checked in a same-origin 900 px frame, as in earlier builds.
4. **PASS.** lint 0 errors, tsc, `build:admin`, full suite green.

## Agents run

None.

## Deviations from the brief

1. **`CampaignDetail.vue` changed** (outside the brief's file list, but the brief asked me to "confirm" no other SPA place calls `/api/audit` for a publisher; planning's grep found none). There is one: the campaign detail panel fetched `/api/campaigns` and `/api/audit` together in one `Promise.all`, so once the API returns 403 the whole panel would have shown "Request failed" for every publisher opening a campaign. Fix: for a non-admin it skips the audit call and hides the "Audit log for this campaign" block (the Source row, which comes from the campaigns API, still shows).
2. **`auth.test.ts` changed** for the same reason (a test that used `/api/audit` as its generic route). Its assertions are the same.

## Worth remembering

- Any other test or script that reads `/api/audit` with a publisher login will now get 403. In this repo that was `audit.test.ts`, `auth.test.ts` and the campaign detail panel.
- The audit log now holds publisher activity that publishers can no longer see themselves; the guide says so ("which administrators can read").
- The guide's mentions of Activity in the phone-layout paragraph (line ~857, "Activity keeps its filters behind a Filters button") and the "Activity records every approval, hold…" bullet describe the log itself and read fine for admins, so I left them.
- Build DB users from the browser check (`pub-check@team.test`, `adm-check@team.test`) and a test campaign exist only in this build DB.

## Clean-up

```sh
git worktree remove ../taxscan-push-worktrees/activity-admin-only
dropdb taxscan_push_build_activity-admin-only; dropdb taxscan_push_build_activity-admin-only_shadow
git branch -D build/activity-admin-only; git push origin --delete build/activity-admin-only
```
