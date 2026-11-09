# Brief: Compose: untick social pages for one push

- **Date / name:** 2026-11-09-compose-skip-pages  →  branch `build/compose-skip-pages`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first). UI parts go to `ui-developer`.
- **Order:** build AFTER `build/linkedin-shopscan-page` is merged to `develop` (both touch the LinkedIn worker and screen).

## Goal
Compose shows a **"Post to"** list of every active social page, all ticked. Unticking a page means that page gets nothing for
this one push. Every other door (pacer, Push now, Breaking, morning backfill) keeps posting everywhere, exactly as today.

## Why (owner's words)
> "Also in compose, we need to give option to skip a page say academy of linkedin page and academy of facebook page." (9 Nov 2026)
> On the follow-up questions: "I was citing example, today this is applicable to linkedin only. I will be adding academy and
> shopscan pages of facebook soon." Chose: **every social page** can be unticked (LinkedIn pages, Facebook page(s), WhatsApp).

This narrows the standing rule "every page posts every push" (4 Nov) for Compose only, on the sender's explicit untick.

## Scope
**In:**
- **One list of social destinations, built from what is active — never hard-coded in the UI.** A server helper
  `activeSocialPages()` (e.g. `src/services/social/pages.ts`) returns `[{ key, label }]` in display order:
  - LinkedIn: every active page from `portalPages()` → `linkedin:taxscan` "LinkedIn · Taxscan", `linkedin:academy` "LinkedIn ·
    Academy", `linkedin:shopscan` "LinkedIn · Shopscan" (each only while active);
  - Facebook: each active Facebook page → `facebook:taxscan` "Facebook · Taxscan" (only while `FACEBOOK_POSTING_ENABLED`). Key by
    the Facebook page's name so later pages (`facebook:academy`, `facebook:shopscan`) join the list with no Compose change;
  - WhatsApp: `whatsapp` "WhatsApp channel" (only while the queue is on).
  `GET /api/social/pages` (any signed-in user who can Compose) returns it.
- **Campaign stores the choice.** Additive migration: `Campaign.socialSkip String[] @default([])`. `/api/send` (and the
  scheduled-send path) accept `socialSkip: string[]`; every key must be in `activeSocialPages()` at send time, else **400
  `unknown_social_page`** and nothing is sent. Empty / missing = today's behaviour. Stored as sent; never edited afterwards.
- **Each worker honours it.** A campaign whose `socialSkip` contains a page's key gets no post on that page: write the page's
  normal SKIPPED row with reason **`compose_skip`** (so screens and Channels show it as deliberately skipped), make no API
  call, and treat it like a manual Skip everywhere (an exact repeat pushed later from another door is a new push and posts
  normally). WhatsApp: a `WhatsAppPost` SKIPPED row, so it never shows as To do. Check every unique key (`(page, articleKey)`
  vs per-push rows) so a `compose_skip` row can never block a later legitimate post of a different push.
- **Compose UI (`ui-developer`):** under the picture field, a "Post to" group of checkboxes from `GET /api/social/pages`, all
  ticked on open and after each successful send (like the one-time send id). Hidden when the list is empty. When anything is
  unticked, the Send-now confirm adds one line: "Not posted to: LinkedIn · Academy, …". **Test on this device** and a
  test-segment-only send ignore it (they post nowhere already). Phone layout: one checkbox per line, 16 px.
- **Screens:** SOCIAL → LinkedIn / Facebook / WhatsApp show `compose_skip` rows as "Skipped in Compose" (not a raw code);
  Campaigns Channels marks read the same.
- **Audit:** the send's audit entry records the skipped keys (keys only).
- **Docs:** `docs/LINKEDIN_POSTING.md`, `docs/FACEBOOK_POSTING.md`, admin guide Compose + Social sections, guide version bump.

**Out (do not build):**
- Any skip on Push now, Queue, Review, Breaking, the pacer or the backfill.
- Adding Facebook Academy / Shopscan pages (owner will bring those; a later brief). The list must simply pick them up.
- Editing the choice after sending; per-page text or pictures.
- A flag: the list defaults to all-ticked, so an untouched Compose behaves exactly as today.

## Acceptance tests
Each one must PASS in the REPORT. All LinkedIn/Facebook calls mocked.
1. `GET /api/social/pages` lists exactly the active pages in order; an inactive LinkedIn page (Academy/Shopscan unset) or Facebook
   off is absent.
2. A Compose send with no `socialSkip` posts to every active page (regression for all workers).
3. `socialSkip: ['linkedin:academy']`: Taxscan + Shopscan LinkedIn and Facebook post; Academy gets one SKIPPED `compose_skip`
   row and **no** API call.
4. `socialSkip: ['facebook:taxscan','whatsapp']`: no Facebook call, a `compose_skip` Facebook row; a SKIPPED WhatsApp row, not To do.
5. Unknown or inactive key → 400 `unknown_social_page`, no campaign, no send, no rows.
6. A later push of the same URL from Push now / the pacer posts on the page that was skipped in Compose.
7. Scheduled Compose send keeps its `socialSkip` and honours it when it fires.
8. Pacer, Push now and Breaking campaigns have `socialSkip = []` and post everywhere.
9. Compose screen (real browser, phone + desktop): list shown and all ticked; untick → confirm names the pages; after a
   successful send all are ticked again; empty list hides the group.
10. Screens show "Skipped in Compose" on LinkedIn, Facebook, WhatsApp and the Channels mark.
11. Audit entry carries the skipped keys.

## Files
- `prisma/schema.prisma` + one additive migration (`…_campaign_social_skip`)
- `src/services/social/` (new helper), `src/routes/send*` (or wherever `/api/send` lives), scheduled-send path
- `src/services/linkedin/worker.ts`, `src/services/facebook/` worker, WhatsApp queue service, `src/routes/social*`
- `admin/src/views/Compose.vue`, LinkedIn / Facebook / WhatsApp views, Campaigns Channels mark
- Docs as above. Tests: send route, each worker, Channels, Compose.

## Constraints
- Flag: none (default = all ticked = today). Say so in the REPORT.
- Migrations: additive only (one column, default empty).
- Full suite: yes — schema + the send path.
- Never call LinkedIn/Facebook from a test. Never log a token.

## Context the builder needs
- Compose's one-time `clientRequestId` and picture-clears-after-send behaviour (PR #73, #108/#109) are the pattern for "reset
  after a successful send".
- Every-push rules: `docs/briefs/2026-11-04-academy-store-posts.md`; any-link rule `SOCIAL_ANY_LINK_FROM` (PR #106).
- Standing rule to keep for all non-Compose doors: `memory feedback_social_follows_push` — every page posts every push.
