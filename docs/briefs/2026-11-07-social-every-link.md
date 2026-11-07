# Brief: every push reaches social, whatever page it links to

- **Date / name:** 2026-11-07-social-every-link  →  branch `build/social-every-link`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first)

## Goal
From a new start time, a push to any allowed link also goes to LinkedIn (both pages), Facebook and the WhatsApp list: a shop collection, the pricing page, a home or section page. With the setting unset, nothing changes.

## Why (owner's words)
> "why this post did not go to linked, facebook, whatsapp?" (owner, 2026-11-07, about a push to `https://shop.taxscan.in/collections/all`)

Asked whether the rule should change so every push posts, including collection and site pages, the owner answered yes (2026-11-07). It matches the standing rule of 2026-11-04: "Just follow it as we follow in push notification."

Today `isAllPushesCampaign` accepts only articles, `/course/<slug>` and `/products/<slug>`. Since 4 Nov this missed pushes to `shop…/collections/all`, `/subscription` and `/trackers`.

## Scope
**In:**
- `SOCIAL_ANY_LINK_FROM`: one ISO time for all four channels, default unset. Parse it strictly, like the existing all-pushes times.
- A shared "other page" rule in `src/services/social/allPushes.ts`, the only place that decides it:
  - A push qualifies when its URL is on `ALLOWED_PUSH_HOSTS`, it is not an article, course or product, it is not test-segment-only, its `lastSentAt` is at or after `SOCIAL_ANY_LINK_FROM`, and that channel's page already follows the all-pushes rule at that send time.
  - Articles, courses and products keep their exact current behaviour and wording.
- Row key: the existing `push:<campaignId>:<lastSentAt ms>`.
- Link and UTMs: the push's own URL, with that channel's UTMs set by the existing helpers. `utm_content` is the URL's path segments joined by `-`, cut to `UTM_CONTENT_MAX`, or `home` for the root path.
- LinkedIn and Facebook posts: built as a course or product post is built (the push's own title and body, the page's og tags for the card and picture). Failing to fetch or read the page stays fail-open: post with the push's own wording and no picture.
- WhatsApp: the same post shape as a course or product (bold title, short line, link).
- Small labels: `kind=page` in the worker log lines, and `kind: 'page'` on the WhatsApp row and in `admin/src/views/WhatsApp.vue`.
- The Channels marks on Campaigns must read such a push as posted or waiting, not leave it blank.
- Page fetch for the card: allow any `ALLOWED_PUSH_HOSTS` host for this kind, keeping https only, no redirects, the 5 s limit and the capped read.
- Docs: `docs/LINKEDIN_POSTING.md`, `docs/FACEBOOK_POSTING.md`, `docs/BACKUPS.md` (restore step below), admin guide (one line, version bumped).

**Out (do not build):**
- Any change to which pushes go out, or to the pacing and stops on LinkedIn or Facebook.
- Any posting of pushes sent before `SOCIAL_ANY_LINK_FROM`.
- Page-specific filtering, or filtering against posts the team made by hand.
- Any change to `isPublicArticleCampaign` or to the digest.
- Any change to Railway settings.

## Acceptance tests
Each one must PASS in the REPORT.
1. Setting unset: `shop.taxscan.in/collections/all`, `www.taxscan.in/pricing`, `www.taxscan.in/` make no row on any channel, and articles, courses and products behave exactly as today.
2. Setting set: each of those three, sent at or after the time, makes one row on LinkedIn Taxscan, LinkedIn Academy, Facebook and WhatsApp.
3. **The same pushes sent one second before the time make no row on any channel, however old or new. Switching it on posts nothing from the past.**
4. A page that has not switched on its all-pushes rule gets no row for these pushes.
5. A link off `ALLOWED_PUSH_HOSTS` and a test-segment-only push make no row, with the setting on.
6. The link carries one set of the channel's UTMs: the push's own `utm_*` are gone and other query parameters stay. `utm_content` is correct for `/collections/all` (`collections-all`), `/pricing` (`pricing`) and `/` (`home`).
7. A resend of the same campaign makes a new row, and two overlapping ticks post one.
8. A failed, slow or redirecting page fetch still posts, with the push's wording and no picture (LinkedIn and Facebook).
9. An unchanged article, course and product post gives byte-identical text and link to today's, on all channels.
10. WhatsApp shows the row with its label and working Copy, Posted and Skip. Campaigns shows its Channels marks. Check both in a browser against a stubbed API, with screenshots in `docs/briefs/2026-11-07-social-every-link.shots/`.
11. Removing the setting reposts nothing, and rows already made keep their status.

## Files
- `src/lib/env.ts` — the setting
- `src/services/social/allPushes.ts`, `src/services/social/storePage.ts` — the rule; the fetch's allowed hosts
- `src/services/linkedin/post.ts`, `src/services/linkedin/worker.ts`
- `src/services/facebook/post.ts`, `src/services/facebook/worker.ts`
- `src/services/whatsapp/pushText.ts`, `src/services/whatsapp/queue.ts`, `admin/src/views/WhatsApp.vue`
- The Campaigns channel-mark code (find it from `isAllPushesCampaign`'s callers)
- Tests: the existing `linkedin`, `facebook`, `whatsapp` and `allPushes` test files, or a new `src/__tests__/socialEveryLink.test.ts`

## Constraints
- Flag: `SOCIAL_ANY_LINK_FROM`, default unset. Not set by this build.
- Migrations: none.
- Full suite: yes — touches config/env.
- Docs that ship with it: those listed under Scope.
- **Every caller of `isAllPushesCampaign` must apply the time check.** The all-pushes times are already in the past and there is no age limit, so a missed caller would post old pushes at release. This is the main risk here: list every caller in the REPORT with how it was covered.
- The fetch's protections stay: never follow a redirect off the allowlist, and never log a URL, body or header.

## Context the builder needs
- Read the header comment in `src/services/social/allPushes.ts`.
- `storeLinkOf` is course or product only. Keep it that way; add a sibling for the other pages rather than widening it, because the course and product post text must not change.
- `newRuleFrom` gives a page's real start time. The all-pushes rows are not in the backup, so a restore must set the post-from times to the restore time first; `SOCIAL_ANY_LINK_FROM` joins that list.
- `/pricing` and `/subscription` on the new CMS have one path segment, so `articleContentOf` returns null for them. A two-segment non-article path (`/gst/some-page`) already counts as an article; leave that alone.
- `docs/briefs/2026-11-07-free-digest-segment.md` is being built separately and also touches `src/lib/env.ts`. Expect a small merge at planning.

## Switch-on (planning + owner, not this build)
The owner sets `SOCIAL_ANY_LINK_FROM` once it has shipped. The value is the moment of switch-on unless the owner asks otherwise. Never move it earlier later.
