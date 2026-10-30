# Brief: digest ad images — one exact size, stated and enforced

- **Date / name:** 2026-10-30-ad-image-size  →  branch `build/ad-image-size`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first)

## Goal
The Ads screen states the one image size a digest ad must have — **1200 × 628 px** — where the picture is chosen,
and the upload refuses any other size with a message naming both sizes. Ads already running at another size keep
running but are marked "Old size — replace" on the list.

## Why (owner, 30 Oct)
> "If image size was the problem, then mention the exact image size in the interface or else fix it."

Anagha's first-send feedback (#6): ads are hard to read on phones. Today's four active ads are 800×190, 800×190,
800×200, 800×210 — thin strips that render ~340 × 80 px on a phone. The screen only *suggests* "Best size:
1200 × 628" in muted text (`admin/src/views/Ads.vue:434–435`) and `adImages.ts` accepts anything ≤ 1200 px wide and
≤ 2:1 tall. A 1200 × 628 picture shows at 552 × 289 on desktop and full-width (~340 × 178) on a phone.

## Scope
**In:**
- `src/services/digest/adImages.ts`: new rule — width **exactly 1200** and height **exactly 628**
  (`AD_IMAGE_WIDTH` / `AD_IMAGE_HEIGHT` constants, exported). New `ImageProblem` `'wrong_size'` with the message
  "This picture is W × H px. Digest ads must be exactly 1200 × 628 px (a wide rectangle) so they read well on phones
  and desktop. Ask the designer to export it at that size." Keep the existing type / 150 KB / header checks. The
  older width/height/ratio checks become unreachable for valid uploads — remove what is dead, keep tests honest.
- `admin/src/views/Ads.vue`: at the image picker, a clear (not muted) line: **"Required size: exactly 1200 × 628 px,
  JPEG or PNG, up to 150 KB."** Replace the "Best size" line. After a successful upload keep showing the
  `W × H px, N KB` info. Show the server's refusal message as is.
- Ads list: an ad whose image is not 1200 × 628 shows a small **"Old size — replace"** tag (computed from the
  stored width/height the list already returns). No blocking: the ad keeps rendering and still counts toward
  coverage.
- Ad edit: saving an existing ad WITHOUT changing its picture still works (old images are grandfathered); choosing a
  new picture must meet the rule.
- Admin guide (Ads page): the size rule in one sentence; bump the guide's minor version.

**Out (do not build):**
- No square/mobile second image, no media-query image swap (owner: not now).
- No server-side resize or crop, no new dependency.
- No change to how ads render in the email, to coverage rules, or to the four existing ads' data.

## Acceptance tests
Each one must PASS in the REPORT.
1. Upload 1200×628 PNG and JPEG → accepted.
2. Upload 800×190, 1200×630, 1199×628, 628×1200 → 4xx `wrong_size`, message contains both "W × H" and "1200 × 628".
3. Existing size/type/150 KB/unreadable tests still pass (adjusted where the new rule supersedes them).
4. Editing an ad whose stored image is 800×190 without touching the picture saves OK; replacing it with 800×190 is
   refused.
5. Ads list API data → UI shows "Old size — replace" for non-1200×628, nothing for 1200×628.
6. Ads screen shows the "Required size" line (not muted); verified in a real browser at desktop and 375 px.
7. `tsc --noEmit`, lint, admin `vue-tsc`, full suite green (known flaky "metrics warmer" may be re-run alone).

## Files
- `src/services/digest/adImages.ts`, its tests.
- `src/routes/digestAds.ts` only if the error mapping needs the new code.
- `admin/src/views/Ads.vue`.
- The admin guide HTML (Ads section) + version.

## Constraints
- Flag: none — upload validation + copy; existing ads untouched.
- Migrations: none.
- Both ADMIN and PUBLISHER use Ads (owner, 29 Oct) — no role change.

## Context the builder needs
- Image header parsing already exists (`pngSize` / `jpegSize` in `adImages.ts`); dedupe by content is in the same
  file (`deduped` flag) — a re-upload of an old 800×190 file must also be refused for a NEW selection.
- Email display width is `AD_IMAGE_DISPLAY_WIDTH = 552` in `renderer.ts` — leave it.
