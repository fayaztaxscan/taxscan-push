# Brief: Notifications use the designer's monochrome "T" badge

- **Date / name:** 2026-10-29-android-badge → branch `build/android-badge`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first)

## Goal
Every push notification (readers' and staff's) carries the designer's white "T" as its **badge**, the small
status-bar icon Android shows. The coloured logo stays as the **icon**.

## Why (owner's words)
> 2026-10-23: the full logo is unusable at 24 px as a badge; a single white "T" was requested from the designer.
> 2026-10-29: "Here is the icon for android from the designer."

Planning checked the file: 96 × 96 PNG, RGBA, 692 bytes, a white "T" on transparent. It reads clearly at 24 px.

## Scope
**In:**
- Copy `/Users/bestdoc/Downloads/Untitled-1.png` → `public/brand/taxscan-badge-96.png`, byte for byte. Check
  with `shasum` and put the hash in the REPORT.
- `src/services/send.ts`: add `DEFAULT_NOTIFICATION_BADGE` (`https://push.taxscan.in/brand/taxscan-badge-96.png`,
  built the same way as `DEFAULT_NOTIFICATION_ICON`). The payload's `badge` is **always** this, even when a
  campaign has its own icon, since a campaign icon is colour artwork and never a badge. Replace the "Phase 1 …
  same URL as the badge" comments with the new reasoning.
- Staff push: `public/admin/sw-staff.js` default badge → `/brand/taxscan-badge-96.png`, and the staff payload
  (`src/services/staffPush.ts`, wherever it builds one) sends it too.
- `public/sw.js` (the readers' worker): **don't edit it.** taxscan.in serves its own copy, and the payload's `badge`
  already overrides its fallback.
- `/brand/*` must keep the same cross-origin headers as the icon. The CORP header is load-bearing (see
  `CLAUDE.md` / memory). Verify the new file gets them.

**Out:** the icon itself; the readers' `sw.js`; any per-portal badge (Phase 2).

## Acceptance tests
1. Unit: a reader payload has `badge` = the new URL with and without a campaign icon; `icon` is unchanged.
2. Unit: the staff push payload has the new badge.
3. Local server: `GET /brand/taxscan-badge-96.png` → 200 `image/png` with the same CORP/CORS headers as
   `/brand/taxscan-icon-192.png`. Paste both header sets.
4. tsc, lint (0 errors), the full suite: green.

## Constraints
No flag, no migration, no env. The real-phone check (Android status bar) happens after deploy. Planning will
arrange it with the owner.
