# Brief: Compose says the picture clears after a send

- **Date / name:** 2026-11-08-picture-clears-note  →  branch `build/picture-clears-note`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first)

## Goal
The Compose picture field tells the writer, on screen, that the picture clears after a successful send.

## Why (owner's words)
> "Or as a note there which they can easily see?" then "go with recommendation" (owner, 8 Nov). Today only the Guide says the picture clears after a send.

## Scope
**In:**
- `admin/src/views/Compose.vue`, picture field (`pic-side`): one more muted line under "Used only on the LinkedIn and Facebook posts, not in the notification itself.", reading exactly:
  **"Clears after a successful send, so attach it again for the next push if needed."**
  Same `muted pic-note` style. Shown whenever the field is shown.
- Admin guide: no wording change needed (it already says this). Bump the version (v2.29 → v2.30) only if your standing rules require a bump for any UI change; say which in the REPORT.

**Out (do not build):** any other change.

## Acceptance tests
1. With `SOCIAL_PICTURE_ENABLED` on, Compose shows the new line under the "Used only on…" line, with and without a picture attached. With it off, the field and line are absent.
2. Admin build passes. Checked in a real browser at desktop width and at 375 px: the line wraps cleanly and doesn't push the buttons off-screen.

## Files
- `admin/src/views/Compose.vue`

## Constraints
- No flag (copy only, inside an already-flagged field). No migrations.
- Full suite: no. Run tsc, lint and the admin build. There are no SPA unit tests.
