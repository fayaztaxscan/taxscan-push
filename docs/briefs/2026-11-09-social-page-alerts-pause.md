# Brief: Social pages — alert when a page stops posting, and a Pause switch per page

- **Date / name:** 2026-11-09-social-page-alerts-pause  →  branch `build/social-page-alerts-pause`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first). UI parts go to `ui-developer`.
- **Order:** after `build/small-fixes` is merged (it adds the LinkedIn `org_daily_limit` hold this brief alerts on).

## Goal
When any automatic social page stops posting, the admins hear about it the same day without anyone watching logs. Any admin
can pause and resume a single page from its Social screen, with no Railway change.

## Why (owner's words)
> "We need to have a way to handle situation like we now faced for linkedin shopscan page." then "go with recommendation"
> (9 Nov 2026). Recommendation = (1) an alert when a page stops posting, (2) a Pause / Resume switch per page. The Dashboard
> health strip is left for later. Shopscan stays on the every-push rule (no priority for shop/academy pushes).

What happened: LinkedIn refused the Shopscan page ("Organization post creation limit reached") from 15:18 IST on 9 Nov. Each push
retried 4 times then FAILED, and nobody was told. The only way to stop it was Skip, row by row.

**Pages in scope:** LinkedIn `taxscan` / `academy` / `shopscan`, Facebook `taxscan` (and any later Facebook page), Telegram
`taxscan`. WhatsApp is posted by hand, so it is out.

## Scope
**In:**
1. **One page-status helper** (`src/services/social/pageStatus.ts`, new). For every active page it reports one of:
   - `ok`
   - `paused` (by an admin)
   - `stopped` (the existing auth / policy stops: LinkedIn 401/403, Facebook 368/auth, Telegram 401/403/chat-not-found)
   - `held` (LinkedIn `org_daily_limit` until <time>; the headroom guard `quota_headroom` is NOT a hold for this purpose: it is
     expected, so no alert)
   - `failing` (the page's last **2** finished posts are FAILED, with no POSTED after them)

   Each status carries a reason code, a since-time and, when known, a resumes-at time. All workers and screens read it; it is the single definition.
2. **Alert email** (`ElasticEmail`, admins, like the existing social stop alerts) when a page enters `held` or `failing`: one email
   per page per kind per IST day, saying the page, the reason in words, since when, when it resumes (if known), and what to do.
   The existing `stopped` alerts stay as they are (do not double-send). Remember what was sent in `DigestSetting` like the existing
   stop markers. A page that recovers (a POSTED row) clears `failing`.
3. **Banner on the page's Social screen** (LinkedIn page switch, Facebook, Telegram) for `paused` / `held` / `failing`, in words:
   "Paused by <name> at <time>", "Held by LinkedIn's daily limit for this page until 05:30 IST", "Last 2 posts failed — <short reason>".
4. **Pause / Resume per page (ADMIN only):** a button on each page's screen.
   - Stored in `DigestSetting` (`social:pause:<channel>:<page>`), with no new table: who, when, and an optional note ≤ 200 chars.
   - Audit `SOCIAL_PAGE_PAUSED` / `SOCIAL_PAGE_RESUMED` (additive enum migration; add the Activity filter entry).
   - **While paused:** every push for that page gets its row SKIPPED with reason `page_paused` and **no API call**. Rows are never
     posted later, the same rule as `compose_skip` / `quota_headroom` (a late post of an old push is worse than none). Retries of
     rows already waiting are skipped too.
   - **Resume:** posts from the next push. Nothing missed is backfilled.
   - Survives restarts (it is stored). It never touches the env go-live times.
5. **Compose "Post to":** a paused page shows unticked and disabled, with "(paused)" next to it. The send still works for the
   other pages, and `/api/send` with a paused key in `socialSkip` is accepted (the result is the same: not posted).
6. **Screens:** `page_paused` rows read "Skipped — page paused". The Campaigns Channels mark reads the same.
7. **Docs:** `docs/LINKEDIN_POSTING.md`, `docs/FACEBOOK_POSTING.md`, `docs/TELEGRAM_POSTING.md` (a "When a page stops" section),
   admin guide + version.

**Out (do not build):**
- The Dashboard health strip (later).
- Any priority or filtering for Shopscan (owner kept the every-push rule).
- Alerts for `quota_headroom`, `compose_skip` or WhatsApp.
- Changing the existing auth / policy stop logic or its Resume.

## Acceptance tests
Each one must PASS in the REPORT. All platform calls mocked.
1. Page status: each of ok / paused / stopped / held / failing from fixtures. `failing` clears after a POSTED row; `held` clears at its resume time.
2. Alert: `held` (LinkedIn org limit) and `failing` (2 FAILED in a row) each send one email per page per kind per IST day. A
   second occurrence the same day sends nothing. A new IST day sends again. Existing stop alerts are not duplicated.
3. Pause on Shopscan: the next push makes SKIPPED `page_paused` rows on Shopscan with no API call, while the other pages post. A
   waiting retry on Shopscan is skipped. Resume, then the next push posts. Nothing earlier is posted.
4. Pause / Resume: ADMIN only (PUBLISHER → 403), audited with who and when, and survives a restart.
5. Pause works for Facebook and Telegram the same way.
6. Compose: a paused page is shown disabled "(paused)". A send with or without its key does not post there and is not refused.
7. Banners and the skipped wording (real browser, desktop + 375 px).
8. No token or provider secret appears in an alert email, banner or audit entry.

## Files
- `src/services/social/pageStatus.ts` (new), the LinkedIn / Facebook / Telegram workers, `src/services/social/pages.ts`
  (Post-to), the routes for each screen, `prisma/schema.prisma` (enum) + migration
- `admin/src/views/LinkedIn.vue`, `Facebook.vue`, `Telegram.vue`, `Compose.vue`, Campaigns Channels mark, Activity filter
- Docs as above. Tests: new `socialPageStatus.test.ts` and `socialPause.test.ts`, plus the affected worker / Compose / Channels tests.

## Constraints
- Flag: none for the Pause (nothing changes until an admin presses it). The alerts are on: they only fire when a page is held or
  failing. Say so in the REPORT.
- Migrations: additive (enum values).
- Full suite: yes — schema + workers.
- Never call a platform from a test. Never put a token or provider message beyond a short reason code in an email.

## Context the builder needs
- The existing stop markers + alerts: `linkedin:auth:<page>` and `facebook:auth:<page>` in `DigestSetting`
  (`src/services/linkedin/worker.ts` ~118–135, `src/services/facebook/worker.ts` ~85–161), and Telegram's equivalent.
- `org_daily_limit` comes from `build/small-fixes` item 5. `compose_skip` and the Post-to list are in `src/services/social/`.
