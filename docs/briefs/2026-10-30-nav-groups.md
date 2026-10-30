# Brief: admin menu grouped by channel (Push / Email / Admin)

- **Date / name:** 2026-10-30-nav-groups  →  branch `build/nav-groups`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first). **UI work → `ui-developer` agent.**

## Goal
The admin top bar shows its 12 items in labelled groups instead of one flat row, with every daily screen still one
click away. Only the admins-only group becomes a dropdown. The phone/hamburger menu shows the same groups as headings.

## Why (owner, 30 Oct)
> "Can we organise our menu better?" → chose the grouped row ("go with recommendation").

Today `admin/src/components/NavBar.vue` lists Dashboard · Compose · Review · Queue · Campaigns · Reports · Digests ·
Ads · Templates · Activity · Users flat, push and email mixed. Editors use Review and Queue many times a day, so no
daily screen may move behind a dropdown.

## The layout
Desktop (≥ 1200 px, today's breakpoint), left to right:

`Taxscan Push` · **Dashboard** │ <small label> PUSH · Compose · Review · Queue · Campaigns │ <small label> EMAIL ·
Digests · Ads · Templates │ **Reports** │ **Admin ▾** (Users, Activity — ADMIN only) · spacer · email + role badge ·
Guide · Change password · Log out

- Group labels: small uppercase muted text in the settled visual system (same tokens as the rest of the SPA); a thin
  divider between groups. Labels are not links.
- The active route's group label is emphasised too (so you can see you're "in Email").
- **Admin ▾**: a disclosure button (`aria-expanded`, `aria-controls`), opens a small menu with Users and Activity;
  closes on Escape, outside click and route change; keyboard reachable (Tab / Enter / Escape, focus returns to the
  button). Not rendered at all for PUBLISHER (as today, where both links are hidden).
- Below 1200 px (hamburger): one column with section headings **Push**, **Email**, **Admin** (admins only); Dashboard
  and Reports at the top. No nested taps — Admin's two links are listed under its heading.
- Routes, URLs, role gates and page titles are unchanged.

## Scope
**In:** `admin/src/components/NavBar.vue` (+ its styles), any tiny shared style it needs; the admin guide's
"Finding your way around" (or equivalent) paragraph + a menu screenshot if the guide has one; bump minor version.

**Out (do not build):**
- No new pages, renames, route changes, badges/counters, remembered channel, or analytics.
- No change to role gates in `router.ts`.

## Acceptance tests
Each one must PASS in the REPORT.
1. Component test: ADMIN sees Dashboard, the PUSH group (4 links), the EMAIL group (3), Reports, an Admin button that
   reveals Users + Activity; PUBLISHER sees no Admin button and no Users/Activity links.
2. Admin menu: opens/closes on click, Escape closes and returns focus, route change closes; `aria-expanded` correct.
3. Active-route styling on the link and on its group label (e.g. on `/ads`, EMAIL is emphasised).
4. Real browser (screenshots in the REPORT), logged in as ADMIN and PUBLISHER: desktop at 1440 and 1200 px — one row,
   no wrap, no overflow; 1199 px and 375 px — hamburger with the three headings, every link reachable.
5. Every existing route still reachable from the menu exactly as before (list them in the REPORT).
6. Admin `vue-tsc`, lint, admin build, full suite green (known flaky tests may be re-run alone).

## Files
- `admin/src/components/NavBar.vue`; a NavBar test under the admin test setup if one exists (else follow the SPA's
  existing component-test pattern); the admin guide HTML.

## Constraints
- Flag: none — presentation only.
- Migrations: none. Backend: no change.
- Keep the settled visual system (memory: "here the settled visual system beats novelty").

## Context the builder needs
- Breakpoint and hamburger behaviour already exist in `NavBar.vue` (`.nav-toggle`, `.nav-menu.open`,
  `display: contents` on desktop) — extend, don't replace.
- Activity and Users are ADMIN-only (`router.ts` meta.roles); both are hidden for PUBLISHER today.
