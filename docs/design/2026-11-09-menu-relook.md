# Menu relook — proposal (2026-11-09)

Proposal only. Nothing has been built. Routes and URLs stay as they are; the look (colours, fonts, the
small group labels, the Admin ▾ panel) stays too. This is about grouping, order, and what is always on screen.

## 1. What is wrong with today's menu

What it is: one flat row, `admin/src/components/NavBar.vue:90-136`. Dashboard · PUSH Compose Review Queue
Campaigns · SOCIAL WhatsApp LinkedIn Facebook · EMAIL Digests Ads Templates · Reports · Admin ▾ · (email) role ·
Guide · Change password · Log out.

1. **Too many items in one row.** An ADMIN with all three social channels on sees **13 links or buttons, 3 group
   labels and the role badge** (`NavBar.vue:91-135`). Each new channel has pushed the fold point wider:
   ~1100 px → 1200 → 1350 → **1430 px** today (`app.css:861-867`, `@media (max-width: 1429px)`). Between
   1430 and 1699 px the links are squeezed to 4 px padding and your email is hidden to make it fit
   (`app.css:446-475`).
2. **Ordinary laptops get the phone menu.** Below 1430 px the whole row folds into ☰. That covers the most
   common office laptop widths (1280, 1366, 1400), the iPad in both directions, and any desktop window
   that isn't full screen. An editor on a 1366 px laptop has to open ☰ for *every* move, Compose → Queue included.
3. **The written record is out of date.** The guide says the menu folds "narrower than about 1200 pixels"
   (`docs/Taxscan-Push-Admin-Guide.html:1153`); a comment in `app.css:311-312` says 1200; CLAUDE.md says 1350.
   The real number is 1430.
4. **The phone menu is long.** Open ☰ on a 390 px phone and you get ~17 tappable rows and 4 headings, at
   ~40 px each: about 850 px of list on a screen with ~700 px to spare. Log out, Guide and Admin are below
   the fold. The list also reorders (Dashboard, Reports, then the groups, `app.css:900-905`), so the phone
   order is not the desktop order.
5. **Daily and rare items sit side by side with equal weight.** Daily: Compose, Review, Queue, Campaigns,
   Digests (every morning), WhatsApp, Reports. Occasional: Ads, Templates, Guide. Rare: Change password,
   Users, Activity. Ads and Templates take the same space as Digests; Change password takes a slot on every
   screen forever.
6. **It gets worse next week.** Telegram (`build/telegram-channel`) adds a 14th link: the row needs ~1510 px,
   so the fold point rises again and 1440 px screens — the width the e2e test uses — start getting ☰ too.
   More Facebook pages are fine (they live inside the Facebook screen as a page switch, like LinkedIn's,
   `admin/src/views/LinkedIn.vue:367`), but every new *channel* costs a link in the row.

## 2. Options

### Option A — Keep the row, move rare items out of it
Ads + Templates stay under EMAIL; Guide, Change password and Log out go into one **Account ▾** menu at the
right (next to Admin ▾). Saves 3 slots, so ~10 links; fits to ~1200 px.

```
1440 px
Taxscan Push  Dashboard | PUSH Compose Review Queue Campaigns | SOCIAL WhatsApp LinkedIn Facebook Telegram |
              EMAIL Digests Ads Templates | Reports | Admin ▾              PUBLISHER  Account ▾
390 px: same as today minus 3 rows at the bottom (still ~14 rows).
```
+ Smallest change, nothing moves for editors. − Buys one or two channels of room; the 1280/1366 laptop
still gets ☰ once Telegram lands; the phone list is still taller than the screen.

### Option B — One dropdown per group
Dashboard · Push ▾ · Social ▾ · Email ▾ · Reports · Admin ▾ · Account ▾. Each ▾ opens a small panel like
today's Admin ▾.

```
1440 px
Taxscan Push   Dashboard   Push ▾   Social ▾   Email ▾   Reports   Admin ▾            PUBLISHER  Account ▾
                           ┌──────────┐
                           │ Compose  │
                           │ Review   │
                           │ Queue    │
                           │ Campaigns│
                           └──────────┘
390 px: ☰ → Dashboard / Push ▸ / Social ▸ / Email ▸ / Reports / Account ▸  (each ▸ expands in place)
```
+ Fits to ~800 px, so laptops and iPads keep a real menu; any number of channels. − **Every daily screen
becomes two clicks** (Push ▾ → Queue), including moving between Compose, Queue and Review all day; you can't
see where you can go without opening menus.

### Option C — Section bar plus a row of tabs for the section you're in  (recommended)
The top row holds only the sections: Dashboard · Push · Social · Email · Reports, with Admin ▾ and Account ▾
on the right. A thin second row shows the screens of the section you are in, as tabs — the same idea as the
tab row already on Reports and the page switch on LinkedIn. Clicking a section opens the screen you last
used in it (first visit: its first screen). Dashboard and Reports have no second row.

```
1440 px (on Queue)
Taxscan Push   Dashboard  [Push]  Social  Email  Reports                   Admin ▾   PUBLISHER  Account ▾
───────────────────────────────────────────────────────────────────────────────────────────────────────
               Compose   Review   [Queue]   Campaigns
───────────────────────────────────────────────────────────────────────────────────────────────────────

390 px (on WhatsApp)
Taxscan Push                         ☰
 WhatsApp  LinkedIn  Facebook  Telegram     ← tabs of the current section, always visible, swipe if needed
 ☰ opens:  Dashboard / Push / Social / Email / Reports / ── / Admin ▸ / Guide / Change password / Log out
           (~9 rows, fits one phone screen)
```
+ Top row is 5 sections + 2 menus, ~700 px, so **the ☰ is needed only on phones (≤720 px)**: 1280/1366
laptops and iPads get the full menu back. Inside a section every screen is one click and visible — Compose
↔ Queue ↔ Review, the all-day loop, stays one click. Telegram and any later channel add a tab, not a slot in
the top row. On a phone, the screens of your current section are on screen without opening ☰, and the ☰
list fits one screen. − Moving *between* sections (Queue → Digests) is one click to the section and
sometimes one more for the screen. The second row costs ~36 px of height on Push/Social/Email screens.
Editors have to relearn the menu once (a short guide update).

Not proposed: **a left sidebar.** It solves the count problem but takes 200 px from every screen, and the
widest screens (Campaigns with 10 columns, the Reports heat tables) need that width most. It would also be
the biggest change to the settled look.

## 3. Recommendation

**Option C — section bar plus tabs for the current section.** It is the only option that fixes the 1430 px
problem for good (ordinary laptops get a real menu again), keeps the daily Push loop one click, shortens
the phone menu to one screen, and absorbs Telegram and later channels without anyone measuring pixels again.
It reuses things editors already know: the group names stay (PUSH/SOCIAL/EMAIL become the sections), the
Admin ▾ panel stays as it is, and the tab row looks like the one on Reports.

Rules carried over unchanged: Social shows only while at least one channel is on
(`features.*`, `NavBar.vue:32-38`); Admin ▾ only for ADMIN; routes untouched.

Cost to build (one ui-developer brief, client only, no backend or flag):
- `admin/src/components/NavBar.vue` — template rewrite; the group path lists (`:19-22`) become the section
  definitions; "last screen per section" in `sessionStorage`; new Account ▾ reusing the Admin ▾ code
  (Escape / outside click / route change already handled, `:40-69`); close ☰ on route change too (today it
  only closes on a link click, so Back leaves it open).
- `admin/src/styles/app.css` — the nav block (`:308-520`, `:861-945`): one tab-row style; the 1430/1700
  width tuning (`:423-475`) is deleted; hamburger moves from 1429 px to 720 px.
- `admin/e2e/nav-groups.spec.ts` — the only test that pins the menu. Its first test expects all 9 screen
  links visible at 1440 px (`:57-59`); under C only the current section's tabs are visible, so that loop is
  rewritten. The `.nav-label[data-group=…]` active checks (`:100-104`) keep working if the section links keep
  `data-group` and `active`. The Admin ▾ tests (`:60-95`) should pass unchanged. `src/__tests__` has no nav tests.
- Guide: `docs/Taxscan-Push-Admin-Guide.html:170-175` (menu tip) and `:1153` (fold width, already wrong),
  plus the SOCIAL "menu:" mentions (`:905`, `:960`, `:1037`) read fine as-is; rebuild/check the PDF pages.
- Sequencing: build after `build/telegram-channel` merges — both edit `NavBar.vue`.
- Risk: low (no data, no routes, no send path). Verify in a real browser at 1280, 1366, 1440, 1920 and in a
  390 px iframe, as ADMIN and PUBLISHER, with Social on and off; check the tab row doesn't clip inside its box.

If the owner wants something smaller first, Option A's **Account ▾** is a free part of C and can ship alone.

## 4. Questions for the owner

1. Is "Queue → Digests is one click to Email, then maybe one more" acceptable, given Compose/Queue/Review stay
   one click apart? (If moving between Push and Email all morning matters more, Option A is the safer choice.)
2. Should clicking a section open the screen you last used there (proposed), or always its first screen
   (Push → Compose, Email → Digests)?
3. Do you want a small marker on **Email** when a digest is waiting for approval, so it is visible from any
   screen? (New meaning, needs a check of what the server already reports; not part of the cost above.)
