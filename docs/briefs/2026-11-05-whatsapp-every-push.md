# Brief: WhatsApp queue: every push gets a row, like LinkedIn and Facebook

- **Date / name:** 2026-11-05-whatsapp-every-push  →  branch `build/whatsapp-every-push`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first). UI parts go to **ui-developer**.

## Goal
From a time set in `WHATSAPP_ALL_PUSHES_FROM`, SOCIAL → WhatsApp lists **every push**: taxscan.in articles, academy.taxscan.in courses and shop.taxscan.in products, one row per push, repeats included. Unset, the queue behaves exactly as today. Posting stays manual (Copy, Share, Posted, Skip).

## Why (owner's words)
> "Yesterday we change how articles are placed in linkedin and facebook. I want to do the same with whatsapp section also" (owner, 2026-11-05)
> "This will be the same in case of facebook or linked or any other social pages when we add in future. Just follow it as we follow in push notification." / "You do not have to filter even if it duplicate." (owner, 2026-11-04)

## Scope
**In:**
- **Switch:** `WHATSAPP_ALL_PUSHES_FROM`, strict ISO, parsed like the other `*_ALL_PUSHES_FROM` variables. Unset or invalid = today's rule, with one boot line saying so.
- **What qualifies under the new rule:** a push with `lastSentAt` at or after the time that passes `isAllPushesCampaign()` (`src/services/social/allPushes.ts`). Reuse that predicate; do not write a second one. Test-segment-only pushes, home pages, section pages, non-course academy pages and shop collections make no row.
- **One row per push:** identity is `pushKey()` (`push:<campaignId>:<lastSentAt ms>`), stored in `WhatsAppPost.articleKey` when marked. A repeat (morning backfill clone, a resend, the same campaign row sent again) is its own row with its own status. Marking one never marks another.
- **Before the time:** a push before the time follows today's rule forever, so switching on creates no flood. An article first pushed before the time and repeated after it gets one new row for the repeat.
- **Which day a row is on:** the IST day of that push. Today's "first push" grouping and the "pushed again" note apply only to old-rule rows.
- **Post text:**
  - Articles: exactly as today (`buildPostText`).
  - Courses and products: `*<push title>*`, a blank line, the push body cut with the existing `shortLine`, a blank line, the link. Use `cleanHeadline` so WhatsApp's formatting characters can't break the bold; emoji must survive.
  - Every link: `withWhatsAppUtm(url, content)`, exactly one set of UTMs, the push's own `utm_*` gone. `content` for a course or product is the slug (`storeUtmContent`).
- **Mark route:** Posted, Skip and undo work on one push under the new rule, by campaign and that push's key. A campaign that isn't eligible under either rule gives the existing `not_found`.
- **Nudge:** `waiting=` counts the new rows, through `getQueue` as it does today. No change to pacing, tag or opt-in.
- **Screen:** new-rule rows show the push's time and a small kind label (Article, Course or Shop) only where it helps. Row counts and filters stay correct. Phone and desktop.
- **Campaigns Channels:** a push under the new rule shows the status of its own WhatsApp row through the same batched query. With the switch off, the output is byte-identical to today.
- **Docs:** admin guide WhatsApp section + version bump, `.env.example`, and `docs/BACKUPS.md`: after a restore, set `WHATSAPP_ALL_PUSHES_FROM` to the restore time, because `WhatsAppPost` is not in the backup.

**Out (do not build):**
- Automatic WhatsApp posting: no official Channel API exists, and unofficial gateways risk the channel.
- Any dedupe or filter of repeats, or detection of the team's manual posts.
- Changes to LinkedIn or Facebook.
- Pictures in WhatsApp posts, or editing post text on the screen.
- Switching the flag on.

## Acceptance tests
Each one must PASS in the REPORT.
1. Variable unset or invalid: no new-rule row; the queue, nudge, marks and Channels behave as today; every existing WhatsApp test passes unchanged.
2. **No flood at switch-on:** past articles, past clones and past course and product pushes before the time make no new row. A pre-time article still shows under today's rule with its mark intact.
3. After the time: the same article pushed twice gives two rows. The same course with the same wording pushed twice gives two rows. A backfill clone of an already-posted article gives a new row.
4. An article first pushed before the time and repeated after it: one new row, for the repeat. Its old row and mark are untouched.
5. A shop product and an academy course each get one row with the right text and link.
6. A non-course academy page, a shop collection, a home or section page, and a test-segment-only push make no row.
7. Each link carries exactly one set of UTMs: `taxscan-whatsapp / social / whatsapp-channel / <id|slug>`.
8. Text: emoji, `*`, `_`, `~`, a backtick and line breaks in a real course title and body give a correct post; an over-long body is cut and the title kept.
9. Marks: Posted, Skip and undo on one repeat leave the other untouched; a double press leaves one row; a non-eligible campaign gives `not_found`.
10. A row stays on its push's IST day across midnight, and the 14-day limit holds.
11. Nudge: `waiting=` matches the screen's Todo count with the switch on.
12. Channels: a new-rule push shows its own row's status; with the switch off the output is unchanged.
13. LinkedIn and Facebook tests pass unchanged.
14. Screen in a real browser, phone and desktop: mixed rows, Copy, Share and marks work, with real titles from the Context section.

## Files
- `src/services/whatsapp/queue.ts`, `postText.ts`, `nudge.ts` if needed
- `src/services/social/allPushes.ts` only to reuse or export, not to change its rule
- `src/lib/env.ts`, the WhatsApp route, `src/services/metrics.ts` (Channels)
- `admin/src/views/` WhatsApp view
- `docs/Taxscan-Push-Admin-Guide.html`, `docs/BACKUPS.md`, `.env.example`
- Tests: new `src/__tests__/whatsappAllPushes.test.ts`

## Constraints
- Flag: `WHATSAPP_ALL_PUSHES_FROM` unset by default.
- Migrations: none expected (`WhatsAppPost.articleKey` already holds a string, unique per portal). If you think one is needed, stop and say why in the REPORT.
- Full suite: yes, it touches config/env.
- Reads Campaign and WhatsAppPost only, never Event.
- The time must never be moved earlier once set; say so in the guide's admin note and `.env.example`, as for the other pages.

## Context the builder needs
- `src/services/social/allPushes.ts`: `isAllPushesCampaign`, `pushKey`, `storeLinkOf`, `storeTitle`, `storeBodyLines`, `storeUtmContent`.
- Worked example: `docs/briefs/2026-11-04-academy-store-posts.md` and `src/services/facebook/post.ts`. Its follow-up 1 matters: removing a switch must not repost or re-list as new anything already handled. Apply the same care to rows and marks.
- `src/services/whatsapp/queue.ts` keys by `articleKey()` and groups repeats. That stays for old-rule rows; new-rule rows bypass the grouping.
- Real titles from production, for tests: "📘  Zero to AI (2026) | COD AVAILABLE" (shop), "🔥 Reconcile Right. Report Accurately. Stay GST Ready!" (academy), "📘 Looking for a Complete Guide to TDS & TCS Compliance?" (shop).
- Current URLs often have no trailing id (`/<section>/<slug>`); `articleContentOf` handles both shapes.
