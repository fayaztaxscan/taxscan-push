# REPORT: 2026-10-30-nav-groups

- **Branch:** `build/nav-groups` (base `0a63a0e`, develop). **Code commit:** `556826e`. Report commit follows. No migrations, no flags, no backend change, `router.ts` untouched.
- **Agents run:** one `ui-developer` (NavBar.vue, app.css, the guide, the e2e spec; it ran no browser). I did the browser check and the width fixes myself.

## Files
`admin/src/components/NavBar.vue`, `admin/src/styles/app.css`, `admin/e2e/nav-groups.spec.ts` (new), `docs/Taxscan-Push-Admin-Guide.html` (tip box on the menu groups; version 2.10).

## Menu, per role (paths unchanged)
- **ADMIN:** Dashboard (/dashboard) │ PUSH: Compose (/compose), Review (/review), Queue (/queue), Campaigns (/campaigns) │ EMAIL: Digests (/digests), Ads (/ads), Templates (/templates) │ Reports (/reports) │ Admin ▾: Users (/users), Activity (/activity) · email + role badge · Guide (/guide) · Change password (/change-password) · Log out.
- **PUBLISHER:** the same without the Admin button (no Users, no Activity).
- Hamburger (< 1200 px): Dashboard, Reports, then headings Push, Email, Admin (admins only) with their links listed under them, then Guide / Change password.

## Acceptance
1. ADMIN / PUBLISHER link sets — **PASS in the real browser** (measured on the rendered menu for both roles). The Playwright spec `nav-groups.spec.ts` covers it too but was **not run** (needs backend + DB + Vite on :5173, like `users.spec.ts`); it type-checks under vue-tsc. The admin has no component-test setup.
2. Admin menu — **PASS in the browser:** click opens (`aria-expanded` true, Users + Activity), Escape closes with `aria-expanded` false and focus back on the button. Outside click and route change are implemented and in the unrun spec; I did not exercise those two by hand.
3. Active styling — **PASS:** on /ads the EMAIL label is emphasised and Ads is highlighted (screenshot).
4. Real browser widths — **PASS**, with fixes: the agent's first version wrapped to two rows and overflowed at 1200 px (page 1267 px wide). I tightened the 1200–1499 range (smaller link padding and group spacing) and hide the email address below 1500 px (the role badge stays; 110 px cap with ellipsis above). Final measurements, ADMIN with a very long email address: one row (53 px high), no horizontal overflow at 1920, 1600, 1500, 1499, 1440, 1400, 1300 and 1200. 1199 px and 375 px: hamburger, no overflow, every link reachable under the three headings for ADMIN, and without Admin for PUBLISHER. The window could not be made wider than about 614 px, so widths were checked in same-origin frames of the real app at those widths. Screenshots: `/var/folders/6p/7cdddtbx7690lgfqzd2ykhrr0000gn/T/claude-chrome-screenshots-ur1AGN/screenshot-1793362661473-10.jpg` (1440, EMAIL emphasised), `…screenshot-1793362703396-11.jpg` (Admin menu open), `…screenshot-1793362723655-12.jpg` (375 hamburger).
5. Every existing route reachable as before — **PASS** (list above; /guide and /change-password stay in the top bar / account row).
6. vue-tsc, lint, tsc, admin build clean; full suite **83 suites, 1,706 of 1,706**.

## Notes
- Beyond the brief, to keep one row: the desktop nav no longer wraps, links are slightly tighter, and the email address is hidden from 1200 to 1499 px. The role badge still shows.
- The stored guide PDF no longer exists (removed 29 Oct), so nothing to rebuild; the guide has no menu screenshot to replace.

## Clean-up (planning)
`git worktree remove ../taxscan-push-worktrees/nav-groups`; `dropdb taxscan_push_build_nav_groups`; `dropdb taxscan_push_build_nav_groups_shadow`; `git branch -D build/nav-groups`; `git push origin --delete build/nav-groups`.
