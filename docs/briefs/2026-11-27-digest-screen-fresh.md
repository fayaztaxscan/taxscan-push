# Brief: Digests screen stays fresh + honest Audience card

- **Date / name:** 2026-11-27-digest-screen-fresh  →  branch `build/digest-screen-fresh`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first)

## Goal
The Digests screen never offers Approve for a digest that is already approved, and the Audience card no longer
says "needs attention" / "Premium digest held" for Premium members that are untagged **on purpose**.

## Why (owner's words)
> 27 Nov 2026: "When I approve the daily newsletter for premium users I see some issues" — on the phone at 09:00:42 IST
> the Approve button was still active and pressing it gave the red "This digest cannot be approved now…". "Usually
> approval button stay grey after approving. But not now." "I did every thing from same device. do 1 and 2. do the
> brief for misleading message." / "why does it still says 'Audience need attention'?"

Facts (prod, read-only, 27 Nov):
- Run 2026-11-27 APPROVED 08:04:03 IST by the owner (audit `DIGEST_APPROVED`); Premium SCHEDULED by cron 09:00:00.
  Only one approve door exists (`POST /api/digest/runs/:id/approve`), so the 09:00 press came from a screen holding
  pre-08:04 data (phone: second tab / Home Screen window / a reload that failed). `digestActions()` hides Approve
  correctly once APPROVED — the server is right, the **screen was stale**. `Digests.vue` reloads only on mount,
  Refresh, or after its own successful press; a refused press (`act()` catch) leaves the stale buttons up.
- Audience card: `pending_writes` refuses with "82 Premium members are still waiting to be tagged (limit 27)".
  The 82 = **79 FATAL** (Mailercloud refuses them: past hard bounces, final — already shown on the card as "79 Premium
  readers were refused by Mailercloud") **+ 3 suppressed** (the writer deliberately never adds tags to a suppressed
  member, `diffMember()` in `writer.ts`). None of the 82 will ever be tagged, so the check can never clear.
  The send guard is OFF (`DIGEST_AUDIENCE_FROM_CMS` unset), so nothing was actually held — yet the card says
  "Premium digest held: …".

## Scope
**In:**
1. **Reload when the screen comes back.** `Digests.vue` reloads (same `load()` as Refresh) on `visibilitychange` →
   visible and on `pageshow` with `persisted` (iOS back-forward cache), throttled (no reload if the last load finished
   < 30 s ago; never while a press is `busy` or a confirm dialog is open). Remove the listeners on unmount.
2. **Reload after a refused press.** After an `act()` (Approve/Hold) or a door (Send now / Send Free / Retry) comes
   back refused (4xx), reload the screen and keep the server's red message visible **after** the reload (mind
   `load()` clearing `error` — see the existing comment at the `confirmDoor` path, ~line 298). A network timeout /
   no reply keeps today's "may still be sending" wording and also reloads.
3. **Pending count excludes the untaggable.** `pendingPremiumWhere()` (`src/services/audience/guard.ts`, THE single
   definition) leaves out, from its "Premium without the tag" half, members that are `lastErrorKind = FATAL` with an
   email (they are counted under `refused` already) and members that are `suppressed` (the writer never tags them).
   The "tag on a non-Premium member" half is unchanged. Update the docstring.
4. **No "held" while the guard is off.** `AudienceCard.vue`: when `guardActive` is false, the detail line reads
   `Would hold the Premium digest if the send guard were on: <plain>.` instead of `Premium digest held: <plain>.`
   (guard on → unchanged).

**Out (do not build):**
- No change to `digestActions()` / the approve route — they are correct.
- No auto-polling on a timer.
- No change to the refused/Retry refused lines, the drift check, or any other guard check.
- Not the larger "send guard" brief (target = segment, drift, meta.counts) — later.

## Acceptance tests
Each one must PASS in the REPORT.
1. Digests screen: page loaded with Approve on offer → server state becomes approved → `visibilitychange` to visible
   → screen reloads and Approve is hidden/disabled.
2. A second `visibilitychange` within 30 s does not reload again; none while `busy`.
3. `pageshow` with `persisted: true` reloads; `persisted: false` does not double-load on first mount.
4. Approve pressed on a stale screen → server answers 409/400 → the red message stays visible AND the screen has
   reloaded (Approve gone).
5. Send now / Send Free refused → same: message kept, screen reloaded.
6. Listeners removed on unmount (no reload after leaving the screen).
7. `pendingPremiumWhere`: a PREMIUM member untagged with `lastErrorKind=FATAL` + email → not pending; untagged and
   `suppressed=true` → not pending; untagged with no error, not suppressed → pending; FATAL with `email=null` → still
   pending (it is not counted as refused either); non-PREMIUM carrying the Premium tag → pending (unchanged).
8. Guard with 79 FATAL + 3 suppressed untagged Premium, everything else healthy → `ok: true`; the card line reads
   "Audience sync is healthy; the Premium list is verified. (the send guard is off)".
9. AudienceCard with `guardActive=false` and a failing guard → "Would hold the Premium digest if the send guard were
   on: …"; with `guardActive=true` → "Premium digest held: …" (unchanged).
10. The existing `audienceGuard`, `digestScreen`, audience card and Digests view tests still pass (update any that
    assumed FATAL/suppressed rows count as pending, and say which in the REPORT).

## Files
- `admin/src/views/Digests.vue` — visibility/pageshow reload; reload after refused press keeping the message.
- `admin/src/components/AudienceCard.vue` — guard-off wording.
- `src/services/audience/guard.ts` — `pendingPremiumWhere()`.
- Tests: `src/__tests__/audienceGuard.test.ts`, the audience card test (`adminView`), `src/__tests__/digestScreen.test.ts`,
  and the Digests view's admin tests (find them; add one if none exists).

## Constraints
- Flag: none — a screen refresh and a count/wording correction; no send behaviour changes while the guard is off, and
  with the guard on it stops refusing for rows that can never clear.
- Migrations: none.
- Full suite: no — area tests: `audienceGuard|audience.*[Cc]ard|adminView|digestScreen|Digests` + admin view tests.
- Docs that ship with it: admin guide — one line on the Digests page: "The screen refreshes itself when you come back
  to it"; and the Audience card's "Would hold … if the send guard were on" meaning. Bump the guide version.
- UI items (1, 2, 4) go to the `ui-developer` agent.
- Never print an address in tests' output or the REPORT.

## Context the builder needs
- `digestActions()` in `src/services/digest/screen.ts` is the server's button logic; leave it.
- `audienceCard()` in `src/services/audience/adminView.ts` builds `line` via `lineOf()` and `refused` counts with the
  same FATAL+email condition you exclude in item 3 — keep the two in step (reuse one `where`, don't copy it).
- `loadGuardSnapshot()` counts `pendingPremiumWhere(tag)`; the jest advisory lock (`jest.environment.js`) already
  serialises suites naming AudienceMember.
