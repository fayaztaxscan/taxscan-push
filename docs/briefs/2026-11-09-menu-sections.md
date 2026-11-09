# Brief: Admin menu — sections on top, tabs underneath

- **Date / name:** 2026-11-09-menu-sections  →  branch `build/menu-sections`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first). This is a UI build: `ui-developer`.
- **Order:** build AFTER `build/telegram-channel` is merged (both change `admin/src/components/NavBar.vue`).

## Goal
The admin menu stops folding into ☰ on laptops. A short top row of sections plus a tab row for the section you are in
replaces today's single crowded row. ☰ appears only on phones (≤ 720 px). Routes, screens and the visual style are unchanged.

## Why (owner's words)
> "I was wondering if our menu placement need a relook?" (9 Nov 2026), then "go with recommendation" on
> `docs/design/2026-11-09-menu-relook.md` (Option C) and on its open questions.

Read that proposal first: problems §1, Option C mockups §2–3. Facts it established: today ☰ starts below **1430 px**
(`admin/src/styles/app.css:867`), so 1280 and 1366 px laptops already get the phone menu. An ADMIN sees 13 links in one row,
and a phone shows ~17 rows. Telegram would push the row to ~1510 px.

## Scope
**In:**
- **Top row (desktop and tablet, > 720 px):** `Dashboard · Push · Social · Email · Reports`, then on the right **Admin ▾**
  (ADMIN only: Users, Activity) and **Account ▾** (role badge / signed-in user, Guide, Change password, Log out).
  `Social` shows only while at least one social channel is on (today's rule). Dashboard and Reports are single screens with no tab row.
- **Tab row** under the top row, for the active section only:
  - Push: Compose · Review · Queue · Campaigns
  - Social: WhatsApp · LinkedIn · Facebook · Telegram (each only while its channel is on, today's flags)
  - Email: Digests · Ads · Templates
- **Clicking a section opens the screen last used in that section** (owner: proposal default). Remember it per browser
  (`localStorage`, wrapped in try/catch; fall back to the first tab: Compose / the first active social channel / Digests).
- **Phones (≤ 720 px):** ☰ opens one list: sections as headings with their screens beneath (same order as desktop), then
  Admin, then Account. Close ☰ on **any route change** (today it closes only on a link click, so Back leaves it open).
- **CSS:** rewrite the nav block in `app.css`, delete the 1430/1700 px squeeze tuning (and the Telegram build's interim **1500 px** fold, added because four Social links wrapped the row), and move the ☰ cut-off to 720 px. Keep
  the existing colours, type, active-state emphasis and `data-group` attributes.
- **Accessibility:** the tab row is a `nav` with `aria-current="page"` on the active tab; the dropdowns open by click and Enter,
  close on Escape and outside click (as Admin ▾ does today).
- **Docs:** admin guide (menu section ~lines 170–175, the "about 1200 pixels" answer at ~1153 → phones only) + version bump;
  check the guide's print/PDF pages.

**Out (do not build):**
- A marker on Email when a digest awaits approval (owner chose to leave it for later).
- Any route, screen content, role rule or backend change. A left sidebar.

## Acceptance tests
Each one must PASS in the REPORT. Real browser via `admin/e2e`.
1. At 1280, 1366 and 1440 px: no ☰; the top row and the tab row are fully visible with no squeezed padding; the signed-in
   email is not hidden.
2. Every existing route is reachable within at most 2 clicks from any screen; Compose ↔ Review ↔ Queue ↔ Campaigns is 1 click.
3. Clicking Push after visiting Queue opens Queue. With storage blocked, it opens Compose.
4. Social and its tabs follow the channel flags: none on → no Social section. Telegram appears as a tab only while active.
5. PUBLISHER sees no Admin ▾. ADMIN sees Users and Activity in it. Account ▾ holds Guide, Change password and Log out for both roles.
6. At 375 px: ☰ opens one list that fits one screen with the headings shown; any navigation, including browser Back, closes it.
7. Keyboard: Tab reaches every item, dropdowns open with Enter and close with Escape, and the active tab has `aria-current="page"`.
8. `admin/e2e/nav-groups.spec.ts` is updated to the new structure; every other e2e spec and the admin build still pass.
9. Screenshots at 1440, 1366 and 375 px in the REPORT.

## Files
- `admin/src/components/NavBar.vue` (rewrite), `admin/src/styles/app.css` (nav block), possibly a small `SectionTabs.vue`
- `admin/e2e/nav-groups.spec.ts`
- `docs/Taxscan-Push-Admin-Guide.html` (+ version)

## Constraints
- Flag: none (presentation only). Say so in the REPORT.
- Migrations: none.
- Full suite: no — area tests: admin build, lint, and all `admin/e2e` specs (the menu is on every screen).
- Keep every route path and route name. Keep the settled visual system (memory: spend effort only on the new tab row).

## Context the builder needs
- `docs/design/2026-11-09-menu-relook.md` is the design: mockups, file:line list and the test that pins the nav.
- Social channel visibility flags already live in `NavBar.vue` (`showWhatsApp`, `showLinkedIn`, `showFacebook`, plus
  Telegram's from its build).
- Verify in a real browser, not just tests (memory: tests once passed while the UI rendered wrong).
