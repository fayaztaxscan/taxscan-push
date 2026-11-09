# Brief: Small fixes — "push" wording, a missing boot line, a leaking test

- **Date / name:** 2026-11-09-small-fixes  →  branch `build/small-fixes`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first).
- **Order:** after `build/menu-sections` is merged (it may touch the same admin files).

## Goal
Clear the small items left on the board, so they ship with the menu release.

## Why (owner's words)
> "let us complete all other activities and push it to live" (9 Nov 2026)

## Scope
**In:**
1. **Channels column tooltip** (`admin/src/views/Campaigns.vue:406`): every push posts now (articles, courses, products, pages),
   so it says "Whether **this push** was also posted to …", not "the article". Build the channel list from the channels that are
   on (WhatsApp, LinkedIn, Facebook, Telegram) instead of two hard-coded strings.
2. **WhatsApp nudge wording** (`src/services/whatsapp/nudge.ts`): the title is "WhatsApp: N posts waiting", not "articles",
   whatever the kinds. Keep the body (the newest waiting headline). Update the code comment and the guide line that quotes it.
3. **Boot line for `SOCIAL_ANY_LINK_FROM`**: one line at start-up, like the other every-push variables:
   `[social] any allowed link posts (from <ISO>)`, or `[social] any-link rule off: SOCIAL_ANY_LINK_FROM <is not set | is not a
   valid ISO time>`. Names only, never other values.
4. **The leaking test:** every full run logs one "A worker process has failed to exit gracefully" warning. Find the file
   (suspects: the `metricsWarmer` tests and `campaignChannels.test`) with `--detectOpenHandles` on the suspects. Fix the leak
   (clear the timer, close the handle). Also make `campaignChannels.test` clean up the "Chan home" rows it leaves behind. Test-only
   changes; no production code unless the leak is in production code (then say so).

**Out (do not build):** anything else on the board, and any change to what posts where.

## Acceptance tests
Each one must PASS in the REPORT.
1. Channels tooltip says "this push" and names exactly the channels that are on (with Telegram on and off).
2. Nudge title "WhatsApp: 3 posts waiting" for 3 waiting rows of any kinds; existing nudge tests updated, not deleted.
3. The boot line, for set / unset / invalid (unit test on the pure formatter).
4. A full run shows **no** "failed to exit gracefully" warning; `campaignChannels.test` leaves no rows (count before = after).
5. tsc, lint and the admin build are clean.

## Files
- `admin/src/views/Campaigns.vue`, `src/services/whatsapp/nudge.ts`, the boot wiring (`src/index.ts` or the social module),
  the leaking test file(s), `docs/Taxscan-Push-Admin-Guide.html` (+ version) if it quotes the nudge.

## Constraints
- Flag: none (wording, a log line, tests).
- Migrations: none.
- Full suite: yes, once — item 4 can only be proven by a full run.
