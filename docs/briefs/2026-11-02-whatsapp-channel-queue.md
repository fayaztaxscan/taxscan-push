# Brief: WhatsApp channel queue — every pushed article, ready to copy or share, with WhatsApp UTMs

- **Date / name:** 2026-11-02-whatsapp-channel-queue  →  branch `build/whatsapp-channel-queue`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first). UI parts go to **ui-developer**.

## Goal
A new admin screen, **WhatsApp**, lists every taxscan.in article the push system sent, in the order it was pushed.
Each one has a ready-made WhatsApp post (headline, one short line, a UTM-tagged link) with **Copy** and **Share**
buttons. The team marks each item **Posted** or **Skipped**. Nothing posts to WhatsApp by itself.

## Why (owner's words)
> 2 Nov: "Just like we post the article using push notification, in the same order and priority … can we also [post]
> those articles to our WhatsApp channel?" (channel: whatsapp.com/channel/0029Va9RYVk3wtb3zqgIpS1u)
> Then: "go with option 1, let team decide if they want to skip any articles. We need to ensure right UTMs are in place
> to track them effectively in our analytics."

Option 1 because WhatsApp has **no official API to post to a Channel**. The unofficial gateways log in as the owner's
WhatsApp and risk a ban that would take the channel with it. So a person posts, and we make it one tap.

## Scope
**In:**
1. **The list (`GET /api/whatsapp/queue?date=YYYY-MM-DD`, IST day, default today):** every `Campaign` with
   `status = SENT`, `portal = 'taxscan'`, a `www.taxscan.in` article URL, and `lastSentAt` inside that IST day.
   Order: by `lastSentAt` ascending, which is the order the pacer pushed them (its priority is already baked in).
   - **One row per article**: collapse re-sends (morning-backfill clone, manual re-push) by `articleKey()`
     (`src/services/reports.ts:348`). Keep the FIRST push's position and show "pushed again HH:MM" if there's a later one.
   - academy/shop links are excluded. Manual Compose pushes to taxscan.in articles are included (the team can skip them).
   - Each row: pushed time (IST), headline, authority/category if known, status (To do / Posted / Skipped) with who
     and when, the post text preview, and the buttons.
2. **The post text** (one function, unit-tested; the server builds it, the client never assembles links):
   ```
   *<headline>*

   <short line>

   <link>
   ```
   - Headline = `Campaign.title`. Strip `*`, `_`, `~` and backticks so WhatsApp formatting can't break.
   - Short line = `Campaign.body`, whitespace-collapsed, cut at a word boundary to ≤ 160 characters with "…". Omit the
     line (and its blank line) if the body is empty or equals the headline.
   - Link = the clean `Campaign.url` with the UTMs below. Never the push's own UTM-tagged URL.
3. **UTMs (owner: "right UTMs"; house pattern `taxscan-<channel>` like `taxscan-push` / `taxscan-digest`):**
   `utm_source=taxscan-whatsapp`, `utm_medium=social`, `utm_campaign=whatsapp-channel`, `utm_content=<article id>`
   (`articleKey`'s trailing taxscan id).
   - `medium=social` puts these visits in GA4's **Organic Social** channel group.
   - `source=taxscan-whatsapp` separates our channel from readers forwarding links in their own chats, which arrive
     as `whatsapp` / `l.wl.co` referrals.
   - SET, never duplicate: replace any existing utm_* on the URL. Keep other query params and the fragment.
   - Constants live in one place (e.g. `src/services/whatsapp/utm.ts`). The allowlist check (`ALLOWED_PUSH_HOSTS`)
     runs on the final URL.
4. **Status (`POST /api/whatsapp/queue/:campaignId` with `{status: 'POSTED' | 'SKIPPED' | 'TODO'}`):** the team marks
   each article, and TODO undoes a mistake. Stored per **article** (articleKey), so a re-push can't reappear as To do.
   Who and when are recorded on the row.
5. **Screen `WhatsApp`** (menu: PUSH group, after Campaigns; ADMIN + PUBLISHER):
   - Date picker (today / yesterday / any date ≤ 14 days back) and filter chips To do · Posted · Skipped · All
     (default **To do**, shown in push order).
   - **Copy** (clipboard; the button says "Copied" for 2 s), **Share** (Web Share API, shown only where
     `navigator.share` exists, i.e. phones; shares the same text), **Posted** and **Skip**. Pressing Copy or Share
     does NOT mark Posted, so the team confirms.
   - A one-line rule on screen: "Post in this order. Skip anything you don't want on the channel. Links carry
     WhatsApp tracking — don't edit them."
   - Phones (≤720 px): one card per row using the existing `class="stack"` pattern. Phone-first matters: the team
     posts from the WhatsApp app.
   - Empty state: "Nothing pushed yet today."
6. **Migration (additive, one):** new table `WhatsAppPost` (`id`, `portal`, `articleKey` unique per portal,
   `campaignId` (first push), `status` enum POSTED/SKIPPED, `actedByUserId`, `actedAt`, `createdAt`). TODO = no row
   (delete on undo).
7. **Flag `WHATSAPP_QUEUE_ENABLED`** (default off). When it's off, the menu item is hidden and the API answers 404.
8. **Admin guide:** one short section "WhatsApp channel" (what the list is, order, Copy/Share/Posted/Skip, don't edit
   links). Bump the guide version.

**Out (do not build):**
- Any automatic posting to WhatsApp, any unofficial WhatsApp gateway, any WhatsApp library.
- Notifications to staff when a new item arrives (later, if the team asks).
- A WhatsApp column on Campaigns or Reports. Measurement comes later, once GA4/CMS has data.
- Backup inclusion (state is short-lived, only "who posted what"). Note it in `docs/BACKUPS.md` as deliberately excluded.
- Changing the push's own UTMs.

## Acceptance tests
Each one must PASS in the REPORT.
1. The post text for a fixture campaign equals the expected string exactly: bold headline, ≤160-char line, UTM link.
   `*_~` and backticks are stripped from the headline. An empty body or one equal to the headline drops the middle line.
2. The link has exactly one each of `utm_source=taxscan-whatsapp`, `utm_medium=social`, `utm_campaign=whatsapp-channel`,
   `utm_content=<id>`. It replaces a pre-existing `utm_source=taxscan-push`, and other params and the fragment survive.
3. The queue for a seeded IST day returns only SENT taxscan.in campaigns from that IST day (boundary: 23:59 and
   00:00 IST), in `lastSentAt` order, with academy/shop excluded.
4. A backfill clone of an earlier article appears once, at the first push's position, with "pushed again" set.
5. POSTED → visible as Posted with user + time. TODO deletes the row. A re-push of a Posted article stays Posted.
6. Roles: PUBLISHER and ADMIN can read and mark. No session → 401. Flag off → 404 on both endpoints and the menu item
   is hidden.
7. ui-developer, real browser: desktop and 375 px screenshots. Copy puts the exact server text on the clipboard.
   The Share button is hidden on desktop. Cards stack on the phone.
8. `tsc`, lint and the new test files pass. Migration applies cleanly on an empty DB and on a copy of develop's schema.

## Files
- `prisma/schema.prisma` + one migration `2026110x…_whatsapp_post`.
- `src/services/whatsapp/` (`utm.ts`, `postText.ts`, `queue.ts`), a route file (follow the existing route/auth pattern).
- `src/config` / env: `WHATSAPP_QUEUE_ENABLED`.
- `admin/src/views/WhatsApp.vue`, menu entry, guide section.
- Tests: `src/__tests__/whatsapp*.test.ts`.

## Constraints
- Flag: `WHATSAPP_QUEUE_ENABLED`, default off.
- Migrations: additive only (one new table + its enum).
- The request path reads Postgres only. Count nothing per campaign from `Event`; this screen needs no delivery stats.
- Docs that ship with it: admin guide section + `docs/BACKUPS.md` exclusion line + `.env.example` entry.

## Context the builder needs
- `articleKey()`: `src/services/reports.ts:348`. Same article = same trailing taxscan id.
- Push UTMs for comparison: `appendUtm` in `src/services/send.ts` (source/medium from env; push = `taxscan-push`).
  Digest UTMs: `withUtm` + `UTM_SOURCE`/`UTM_MEDIUM` in `src/services/digest/renderer.ts`. Reuse the SET-not-append
  behaviour of `withUtm`, not `appendUtm`'s "keep existing".
- "Recently pushed" must read `Campaign.lastSentAt` (memory rule), never group Events.
- Phone tables: `class="stack"` + `data-label` (see Campaigns.vue).
