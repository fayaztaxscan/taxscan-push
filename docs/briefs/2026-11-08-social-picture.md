# Brief: a picture uploaded on Compose goes on the LinkedIn and Facebook posts

- **Date / name:** 2026-11-08-social-picture  →  branch `build/social-picture`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first)

## Goal
On Compose, the writer can attach one picture to a push. When a push has a picture, its LinkedIn posts (both pages) and its Facebook post show that picture large, with the post text and the link, the way the team's hand-made Diwali post did. A push without a picture posts exactly as today. The setting is off by default.

## Why (owner's words)
> "How we could have posted something like this in linkedin and also facebook?" (owner, 8 Nov, with a screenshot of the hand-made Diwali Premium post: a large 1:1 creative, the text, "…more")
> Owner chose "go with recommendation" (8 Nov): a picture upload on Compose, plus the CMS adding share pictures to its site pages.

The `/pricing` push on 8 Nov 07:45 posted on all three pages as text plus a bare `taxscan.in` link card. A push has no picture field, and `/pricing` has no `og:image`, so `storePage.ts` had none to borrow.

## Scope
**In:**
1. **Setting:** `SOCIAL_PICTURE_ENABLED`, default off. When off, Compose shows no upload and the workers ignore any stored picture.
2. **Storage:** a new table `SocialImage` with the same shape as `DigestAdImage` (`id` = sha256 of the bytes, sniffed `mime`, `width`, `height`, `size`, `bytes`), plus `Campaign.socialImageId` (nullable). Both are additive.
   - Reuse the sniff and size logic in `src/services/digest/adImages.ts`; don't copy it.
   - Serve the image at a public, cache-friendly URL on push.taxscan.in, the way ad assets are served (`assetUrl` / `readAsset`).
   - Not in the backup: same rule as `WhatsAppPost` and the social post rows. Say so in `docs/BACKUPS.md`.
3. **Upload rules**, shown on screen as plain text before the person picks a file, with clear refusals:
   - Formats: JPEG or PNG.
   - Size: at most 2 MB.
   - Width: at least 1080 px.
   - Shape: square (1:1) up to wide (1.91:1). Taller than 4:5 is refused.
   - Recommended: **1080 × 1080** (square, like the Diwali post) or **1200 × 627** (wide).
4. **Compose (ui-developer):** an optional "Picture for LinkedIn and Facebook" field, with a preview and a Remove button. It says the picture is used only on the social posts and not in the notification itself.
   - It works for Send now, Schedule, and "Test on this device" (where it is ignored: test sends never post to social).
   - The picture stays with the campaign. A scheduled push keeps it.
5. **LinkedIn worker:** when the campaign has a picture, post an image post.
   - Upload our bytes through the Images API we already use. These are our own bytes, so no host allowlist applies.
   - The commentary keeps today's text and hashtags and adds the tagged link (same UTMs as today) on its own line.
   - No picture: today's post, unchanged.
   - Both pages (Taxscan and Academy) follow their existing per-page rules.
6. **Facebook worker:** when the campaign has a picture, post to `/<page-id>/photos` with `url` = the public image URL and `caption` = today's message plus the tagged link on its own line.
   - No picture: today's `/feed` link post, unchanged.
   - Pacing, the policy stop and the 30/day cap are unchanged.
7. **Repeats:** a repeat of the same campaign (Push now from the queue, a re-send) uses the campaign's picture. Morning backfill clones copy `socialImageId`.
8. **WhatsApp queue:** no change. Note in the guide that the WhatsApp post is still shared by hand: the person can download the picture from Compose or Campaigns. A small "Download picture" link on the WhatsApp row is in scope if it is trivial; say in the REPORT whether you added it.
9. **Docs:** `docs/LINKEDIN_POSTING.md`, `docs/FACEBOOK_POSTING.md` (picture path), the admin guide (Compose section, sizes; version bump), `docs/BACKUPS.md`.

**Out (do not build):**
- A big image in the push notification itself (`public/sw.js` stays untouched).
- Pictures for automatic RSS pushes. Articles keep their CMS cover picture.
- Editing a picture after the push is sent; more than one picture.
- Any Railway setting or CMS change.

## Acceptance tests
Each one must PASS in the REPORT.
1. Setting off: Compose payload and workers behave exactly as today, even for a campaign row that has `socialImageId`.
2. Upload: a 1080×1080 JPEG and a 1200×627 PNG are accepted. A 900 px wide image, a 1080×1600 image (taller than 4:5), a 3 MB file, a GIF and a file renamed `.png` that is really text are each refused with a plain reason.
3. The same bytes uploaded twice make one `SocialImage` row (sha256 id).
4. LinkedIn, picture set: the worker uploads the image bytes and creates an image post whose commentary contains the tagged link. No picture: the request is byte-for-byte today's.
5. Facebook, picture set: the call goes to `/photos` with `url` = our public image URL and the caption containing the tagged link. No picture: today's `/feed` call, unchanged.
6. A scheduled Compose push keeps its picture until it sends. A morning-backfill clone carries the same `socialImageId`.
7. A failed image upload on LinkedIn falls back to today's link post for that page, and says why in the post row's error/log. It must not drop the post.
8. The public image URL serves the bytes with the right content type and needs no login. An unknown id answers 404.
9. Test on this device with a picture attached creates no social post rows.

## Files
- `prisma/schema.prisma` + one additive migration (`SocialImage`, `Campaign.socialImageId`).
- `src/lib/env.ts`: `SOCIAL_PICTURE_ENABLED`.
- A small `src/services/social/picture.ts` (validate + store, reusing `adImages.ts`), plus an upload route next to the Compose/send routes. ADMIN + PUBLISHER, the same as Compose.
- `src/services/linkedin/post.ts` / `worker.ts`, `src/services/facebook/post.ts` / `client.ts` / `worker.ts`: the picture path.
- Morning backfill clone: copy `socialImageId`.
- `admin/src/views/Compose.vue` (ui-developer).
- Docs as listed.
- Tests: the linkedin*, facebook*, social*, compose/send and backfill test files + new ones.

## Constraints
- Flag: `SOCIAL_PICTURE_ENABLED` default off.
- Migrations: additive only.
- Full suite: **yes**, because this touches schema, config/env and the send path (`/api/send` carries the image id).
- Never log image bytes. The upload route has its own size limit (as `/ad-images` does), and the global body limit is unchanged.
- The social pages' post-from times and the owner's "every push posts" rule are unchanged.

## Context the builder needs
- Image storage, sniffing, size checks and the public asset route: `src/services/digest/adImages.ts`, `src/routes/digestAds.ts` (`/ad-images`).
- LinkedIn picture upload today: `src/services/linkedin/image.ts` (cover image fetched by URL; for us the bytes are already in hand) and the encoded image URN fix from PR #99.
- Facebook post today: `src/services/facebook/client.ts` (`/feed` with `message` + `link`). Use the Page token, as today.
- Every push posts: `src/services/social/allPushes.ts` and `publicCampaign.ts` decide which pushes post; this brief only changes how a post looks.

## Follow-up 1 (planning review, 8 Nov): three small fixes before merge
1. **Compose clears the picture after a successful Send now or Schedule.** Unlike the text fields, a picture left attached would silently go on the NEXT push's LinkedIn and Facebook posts, which is a real risk of a Diwali poster on a court ruling. On a failed or refused send it stays attached. Draft autosave (if Compose has one) must not bring it back after a send.
2. **Picture upload uses a longer timeout:** 90 s, like `PUSH_REQUEST` in `useApi`, instead of the shared 15 s. The upload is a POST: no retry, and a timeout says "may still be uploading, check the preview", never "try again".
3. **Fix the flaky `audienceFreeReaders` test 9:** it compares a global Premium count, so rows from other test files leak in. Scope it to the test's own rows (e.g. a test-only hash prefix or `onlyHashes`), so it passes inside the full suite as it does alone.

**Acceptance (add to the REPORT):** 14. After a successful send/schedule, Compose shows no picture; after a refused send it still shows it. 15. The upload request uses the 90 s budget and no retry. 16. `audienceFreeReaders` passes inside a full-suite run.
Run the area tests (social*, compose, audience*) plus one full suite at the end.
