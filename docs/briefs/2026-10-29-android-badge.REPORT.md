# REPORT: 2026-10-29-android-badge

- **Branch:** `build/android-badge` (base `origin/develop` at `9e10fd2`)
- **Code commit:** `30f65efe8e9ac90acf93106eb183a8ebc75b4bab`
- **Result:** all 4 acceptance items PASS. The real-phone check (Android status bar) is for after deploy, as the brief says.

## The asset

`/Users/bestdoc/Downloads/Untitled-1.png` → `public/brand/taxscan-badge-96.png`, byte for byte (`cmp`: identical).
```
shasum -a 256: b391bcd70032b45f8f4154c90eaa466b786bc1a777c36330ed44239cef0c9ecc
file: PNG image data, 96 x 96, 8-bit/color RGBA, non-interlaced   (692 bytes)
```

## Files changed

- `public/brand/taxscan-badge-96.png` (new): the designer's white "T".
- `src/services/send.ts`: `DEFAULT_NOTIFICATION_BADGE = 'https://push.taxscan.in/brand/taxscan-badge-96.png'` (same form as `DEFAULT_NOTIFICATION_ICON`); the reader payload's `badge` is **always** this, even when the campaign has its own icon. The "Phase 1 … same URL as the badge" comments are replaced with the new reasoning (Android draws a badge from alpha only; a campaign icon is colour artwork).
- `src/routes/api.ts`: "Test on this device" (`POST /api/send/test-device`) sends the same badge a reader gets (it was `icon || default`).
- `src/routes/staffPush.ts`: the "Notify me on this device" test notification.
- `src/services/digest/alerts.ts`: `buildStaffPushPayload`, the real digest staff pushes (ready for approval, still waiting, …).
- `public/admin/sw-staff.js`: new `BADGE` constant; `badge: payload.badge || BADGE` (was `|| ICON`).
- **Not edited:** `public/sw.js` (the readers' worker; taxscan.in serves its own copy, and the payload's `badge` overrides its fallback).
- Tests: `send.test.ts`, `staffPush.test.ts`, `staffPushQa.test.ts`, `api.test.ts`, `digestTemplates.test.ts`.

## Migrations / flags / env

None.

## Test results (verbatim)

- `npx tsc -p tsconfig.json --noEmit`: exit 0.
- `npm run lint`: exit 0 (0 errors).
- Touched suites (`send`, `staffPush*`, `api`, `digestTemplates`): `Tests: 131 passed, 131 total`.
- **Full suite (`--maxWorkers=1`):** `Test Suites: 75 passed, 75 total` · `Tests: 1512 passed, 1512 total` (1,509 on `develop` + 3 net new).
- Mutation check: pointing the reader badge back at the campaign icon fails 2 tests in `send.test.ts`; restored.

## Acceptance tests

1. **PASS.** A reader payload's `badge` is the new URL with no campaign icon (icon = the default logo) **and** with one (icon = the campaign's, `badge` still the T and explicitly not the icon). `icon` is unchanged in both. The `test-device` preview does the same with and without an icon.
2. **PASS.** `buildStaffPushPayload` (the digest staff push) has the new badge; so does the payload the `/api/staff-push/devices/test` route hands the transport; and the staff worker, loaded in a VM, shows `badge = origin + /brand/taxscan-badge-96.png` when the payload has none and keeps a payload's own.
3. **PASS.** Real local server (`PORT=3917`, build DB): both files `200 image/png`, same headers. The two header sets, pasted (Date/ETag/Last-Modified/Content-Length removed):
   ```
   GET /brand/taxscan-icon-192.png        GET /brand/taxscan-badge-96.png
   HTTP/1.1 200 OK                        HTTP/1.1 200 OK
   Cross-Origin-Opener-Policy: same-origin        (same)
   Cross-Origin-Resource-Policy: cross-origin     (same)   <- the load-bearing one
   Origin-Agent-Cluster: ?1                       (same)
   Referrer-Policy: no-referrer                   (same)
   Strict-Transport-Security: max-age=31536000; includeSubDomains   (same)
   X-Content-Type-Options: nosniff                (same)
   X-DNS-Prefetch-Control: off                    (same)
   X-Download-Options: noopen                     (same)
   X-Frame-Options: SAMEORIGIN                    (same)
   X-Permitted-Cross-Domain-Policies: none        (same)
   X-XSS-Protection: 0                            (same)
   Vary: Origin                                   (same)
   Accept-Ranges: bytes                           (same)
   Cache-Control: public, max-age=31536000, immutable   (same)
   Content-Type: image/png                        (same)
   ```
   The served bytes equal the committed file (`cmp`). With `Origin: https://www.taxscan.in` the badge also answers `Access-Control-Allow-Origin: https://www.taxscan.in` (the same CORS middleware serves `/brand/`). A test pins the equality of these headers for the two files and reads the PNG header (96 × 96, 8-bit RGBA, 692 bytes).
4. **PASS.** tsc, lint 0 errors, full suite green.

## Agents run

None.

## Deviations from the brief

1. **Three places beyond the brief's two named ones now send the T:** the `test-device` preview (`api.ts`), the "Notify me" staff test route (`routes/staffPush.ts`) and the digest staff alert payload (`digest/alerts.ts`). The brief says "every push notification (readers' and staff's)" and "wherever it builds one"; leaving them on the colour logo would have left three notification types with the blob.

## Worth remembering

- **Readers only get the T once the payload says so.** The readers' `sw.js` on taxscan.in is not edited and keeps its own fallback; it uses `payload.badge` when present, which every server send now carries. Notifications already queued or sent before deploy keep the old badge.
- The badge URL is absolute on the production host (`push.taxscan.in`), like the icon. A local or staging build still points readers' devices at production's file, which only exists after this ships.
- Android may cache a notification's badge per URL; a new filename (`-badge-96`) means no stale copy. Do not overwrite the file in place later (the existing note in `app.ts` says the same for `/brand/`).
- The colour logo is still the **icon** everywhere; nothing about it changed.

## Clean-up

```sh
git worktree remove ../taxscan-push-worktrees/android-badge
dropdb taxscan_push_build_android-badge; dropdb taxscan_push_build_android-badge_shadow
git branch -D build/android-badge; git push origin --delete build/android-badge
```
