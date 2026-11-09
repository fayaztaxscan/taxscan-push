# REPORT: 2026-11-09-menu-sections

- **Branch:** `build/menu-sections` (base `origin/develop` f017472)
- **Code commit:** `b41d8d1`
- **Built to the brief (Option C). Acceptance 1-9 all PASS.** Presentation only: **no flag, no migration, no route, screen-content, role or backend change** (`router.ts` untouched). The interim 1500 px fold and the 1430/1700 px squeeze tuning are deleted; the hamburger cut-off is 720 px.

## For planning to read first

1. **The phone ☰ list: the brief and its acceptance 6 pulled apart, and I followed the acceptance.** "Sections as headings with their screens beneath" as one link per row is about 24 rows for an ADMIN with all four channels (more than a phone screen). So each section is a heading with its screens as **wrapping inline links beneath it** (40 px tap height), in the desktop order: Dashboard, Push, Social, Email, Reports, Admin, Account (email + role, Guide, Change password, Log out). Measured at 375×667 as ADMIN with all four channels (the worst case): **list 489 px, whole header 558 px**, Log out well inside 667; all four Social links fit one row; PUBLISHER with Social off: 340 px. Dashboard and Reports stay single rows.
2. **The tab row steps aside while ☰ is open** (my call; the list already holds those screens). With it kept the header was 652 px at 375×667, only 15 px of slack. It is back when ☰ closes. Closed, the phone header is 111 px (bar + tab row).
3. **The signed-in email at tablet widths.** `.nav-email` is shown in full at 1280/1366/1440 (and from 900 px up); above 320 px wide it ellipsizes with a `title`. At **721-899 px the top row cannot hold it**, so there it moves to the top of the Account ▾ panel (`.nav-panel-email`). The brief says "not hidden" for 1280/1366/1440 only; this covers the narrower tablets.
4. **One new narrow-tablet rule** (721-1023 px: nav padding 14 px, link padding 9 px). The ADMIN row computed to ~713 px with default padding, too close to 721 px. I did not test whether it is strictly needed; it is one small media block if you would rather drop it.
5. **A section link has `aria-current="page"` only when you are exactly on its target.** With storage blocked you can be on Queue inside Push while the Push link points at Compose: it then has the `active` class (and the highlight) but not `aria-current`. Tabs always carry `aria-current="page"` from router-link, and the CSS uses that attribute as the active-tab state.
6. **Two older e2e specs were already stale for reasons unrelated to the menu** (not run against the base; each failure was on a line the menu does not touch), and I fixed only those lines: `compose-send` never confirmed the "Send to everyone now?" dialog (added 21 Oct) and read Campaigns columns by position (the table has gained columns; it now uses `data-label`); the Dashboard read `/api/metrics`, which is cached 20 s, so the e2e backend env now has `METRICS_CACHE_TTL_MS: '0'` (`admin/playwright.config.ts`, one line); `users.spec` used `.section-title`, which now matches two headings (it uses `h1.section-title`). Their menu steps follow the new structure (Account ▾ → Log out, Admin ▾ → Users, Push → Campaigns).
7. **Flake risk to know about:** logins are limited to 5 a minute per address and the whole e2e suite does 6 UI logins (compose-send 1, nav-groups 2, users 3). It passed on all three full runs (two by `ui-developer`, one by me), but a run that lands all six inside one minute could trip the limit. Not changed here.
8. **`npm run lint` at the repo root only covers `src/**/*.ts`, not the admin SPA**; `vue-tsc` covers the SPA and the specs. Both pass.
9. The record to update afterwards (yours): CLAUDE.md's nav notes ("hamburger below 1350 / 1430 px", the interim 1500 px fold) now read **720 px**; the admin guide is already updated by this build (v2.34).

## What it does

- **Top row (> 720 px):** brand, `Dashboard · Push · Social · Email · Reports`, then on the right **Admin ▾** (ADMIN only: Users, Activity), the signed-in email + role badge, **Account ▾** (Guide, Change password, Log out). `Social` shows only while at least one channel is on. Dashboard and Reports are plain links with no tab row.
- **Tab row** (a `<nav aria-label>` under the top row) for the active section only: Push: Compose · Review · Queue · Campaigns; Social: WhatsApp · LinkedIn · Facebook · Telegram (each while its own `features.*` flag is on); Email: Digests · Ads · Templates. Same look as the Reports tab row; scrolls inside its own box on a phone and keeps the current tab in view.
- **A section link opens the screen last used in it.** Remembered per browser in `localStorage` under `tsp.nav.last.push`, `tsp.nav.last.social`, `tsp.nav.last.email` (each holds a path such as `/queue`); every access, including the `window.localStorage` getter, is in try/catch. The remembered path is checked against the user's role and flags when resolved (Telegram switched off since = the first available tab); with storage blocked nothing is remembered and a section opens on its first screen (Compose / the first active social channel / Digests). Memory is per browser, not per user.
- **Phones (≤ 720 px):** brand + ☰ (the tab row under the bar), ☰ opens the one list (point 1). **Any route change closes ☰ and any dropdown**, browser Back included; Escape closes ☰ and returns focus to it. The desktop row and the phone list are two separate trees switched by `matchMedia('(max-width: 720px)')` (the same 720 px as the CSS), so only one is ever in the page; crossing 720 px re-renders and closes anything open.
- **Dropdowns** (`NavDropdown.vue`, Admin ▾ and Account ▾): click or Enter/Space opens, Escape closes with focus back on the button, outside click and route change close, Tab out of an open one closes it, only one open at a time (a close request is ignored unless it is still the open one, so clicking the other button cannot undo what it just opened).

## Files changed

- `admin/src/components/NavBar.vue` (rewritten), `admin/src/components/NavDropdown.vue` (new), `admin/src/components/SectionTabs.vue` (new), `admin/src/composables/useNavSections.ts` (new: section and tab definitions, flag/role filtering, last-screen memory), `admin/src/styles/app.css` (the nav block rewritten; 1430/1700 tuning and the 1500 px fold deleted; existing colours, type and `data-group` emphasis kept).
- `admin/e2e/nav-groups.spec.ts` (rewritten, 19 tests), `admin/e2e/compose-send.spec.ts`, `admin/e2e/users.spec.ts`, `admin/playwright.config.ts` (one env line).
- `docs/Taxscan-Push-Admin-Guide.html` (**v2.34**): the menu tip rewritten for sections, tabs and Account ▾; the password tip points to Account ▾; the "can I use it on my phone" answer now says ~720 px and that a laptop or tablet keeps the full menu (the old "about 1200 pixels" was already wrong). The "(menu: SOCIAL)" mentions read fine as they are. The guide has no stored PDF (removed 29 Oct); its print rules (`.box` and rows do not break across pages) cover the longer tip box.
- `docs/briefs/2026-11-09-menu-sections.shots/` (9 PNGs, below).

## Migrations / flags

None. (No flag: the menu is not behind one.)

## Test results (verbatim)

- `cd admin && npx vue-tsc --noEmit`: exit 0. `npm run lint` (root): clean. `npm run build:admin`: `✓ built in 3.10s` (the pre-existing `router.ts` dynamic-import warning remains; `dist` removed afterwards).
- **E2E, the whole admin suite, my own run:** `cd admin && npx playwright test` -> `23 passed (1.4m)` (compose-send 1, nav-groups 19, users 3). Spec log line: `[menu 375x667 ADMIN, 4 channels] list 489px, whole header 558px`. The two `ui-developer` full runs also passed (23 passed, 1.8 m).
- **No full jest suite** (UI only, as the brief says: area tests = admin build, lint, e2e).
- **The tests bite:** with the route-change close removed from `NavBar.vue`, the dropdown test and the 375 px Back test both failed; restored.

## Acceptance tests

1. **PASS.** At 1280, 1366 and 1440: no ☰, the one-line bar is under 60 px, link padding is the normal 12 px (not squeezed), the email is shown and not truncated, the top row and the tab row are fully visible and not clipped. Also checked 721, 768 and 1024: full menu, no ☰, no horizontal overflow.
2. **PASS.** Every one of the 17 screens is reachable within 2 clicks from four kinds of start screen (Dashboard, a Push screen, a Social screen, an Email screen); Compose, Review, Queue and Campaigns are always 1 click apart.
3. **PASS.** Push after visiting Queue opens Queue; with storage blocked (the `localStorage` getter throws) it opens Compose; a remembered screen that is no longer available is replaced by the first one.
4. **PASS.** With every channel off there is no Social section; each channel is a tab only while its flag is on (all flag combinations), and Telegram only while `telegramPosting` is true.
5. **PASS.** PUBLISHER has no Admin ▾ and no Users/Activity link anywhere; ADMIN has Users and Activity in Admin ▾; Account ▾ holds Guide, Change password and Log out for both roles.
6. **PASS.** At 375 px ☰ opens one list with all five headings that fits one screen (489 px list, 558 px with the bar, at 375×667); a link tap, Back, Escape and a same-page tap all close it; as PUBLISHER with Social off the list has no Social and no Admin heading and is 340 px.
7. **PASS.** Tab reaches every item in order; Enter and Space open the dropdowns and Escape closes them with focus back on the button; the active tab has `aria-current="page"`; the section you are in carries `active`.
8. **PASS.** `nav-groups.spec.ts` is rewritten for the new structure; compose-send and users are updated (point 6); the whole suite passes (23) and the admin build passes.
9. **PASS.** Screenshots (committed, ~30-50 KB each, local throwaway data) in `docs/briefs/2026-11-09-menu-sections.shots/`: `1440-push-queue-admin.png`, `1440-social-telegram-admin.png` (cropped to the header: the local backend has Telegram off, so the screen below shows `not_found`), `1440-account-dropdown.png`, `1366-email-digests-publisher.png`, `1280-dashboard-admin.png`, `1024-push-compose.png`, `375-push-queue-tabs.png`, `375-menu-open-admin.png`, `375-menu-open-publisher.png`.

Looked at in a real browser (real Playwright viewports, not iframes) as ADMIN and PUBLISHER, Social on and off, at 1920, 1440, 1366, 1280, 1024, 768, 721, 375 and 320 px, on Push/Queue, Social/Telegram, Email/Digests, Dashboard, Reports, Campaigns (the widest page) and Compose: the content below the nav did not move or lose width, the 1920 nav stays left-aligned with centred content as before, focus rings show inside the tabs, Account lights up on `/guide`. **Not tested:** real iOS Safari or a real touch swipe.

## Agents run

- `ui-developer` (one, background): the whole build and its real-browser check. Its throwaway users, audit rows and servers are gone (build DB left at 0 users / 0 audit rows / 0 campaigns); `admin/dist`, `admin/test-results` and `admin/tsconfig.tsbuildinfo` removed. I re-ran vue-tsc, lint, the build and the full e2e suite myself, and read three of the screenshots.
- Never touched the main checkout, production, the stash, `develop` or `main`.

## Deviations from the brief

- The ☰ list renders each section's screens as wrapping inline links, not one link per row (point 1); the tab row hides while ☰ is open (point 2); email at 721-899 px lives in Account ▾ (point 3); one extra narrow-tablet padding rule (point 4); two stale e2e lines fixed in passing and one e2e env line (point 6).

## Worth remembering

- A section link's target is read inside a computed that refreshes on every route change; memory is in storage, never in a ref, so blocked storage behaves exactly like first use.
- The e2e config starts the backend (`src/index.ts`, mock sender, RSS/sweeper off) and Vite itself, on 3000 and 5173 with `reuseExistingServer: false`: nothing else may hold those ports, and it uses the worktree's `.env` database.

## Clean-up (planning runs this after merging)

```
cd /Users/bestdoc/Documents/taxscan-push
git worktree remove ../taxscan-push-worktrees/menu-sections
dropdb taxscan_push_build_menu-sections && dropdb taxscan_push_build_menu-sections_shadow
git branch -d build/menu-sections   # after the merge
```
