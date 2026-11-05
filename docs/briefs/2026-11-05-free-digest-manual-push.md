# Brief: Free digest goes only on a manual push

- **Date / name:** 2026-11-05-free-digest-manual-push  →  branch `build/free-digest-manual-push`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first)

## Goal
With `DIGEST_FREE_MANUAL` on, the Premium digest keeps its daily routine, and the Free digest is built each morning but goes out only when a person presses **Send Free** on the Digests screen before the cut-off. With the flag off, nothing changes.

## Why (owner's words)
> "Let us go live for paid subscribers now. And for free subscribers, let the newsletter only on a manual push. Means it need not go every day. Only when the users manually push it." (owner, after speaking with Abdullah, 2026-11-05)
> "We also spoke about having a manual push button for free subscribers." (owner, 2026-11-05)

The definition below (built daily, pressed before 17:00, no reminder) is planning's recommendation. If the owner changes it, it arrives as a Follow-up in this brief.

## Scope
**In:**
- `DIGEST_FREE_MANUAL` (default off), read in `src/lib/env.ts` with the other digest flags.
- Flag on, Free variant:
  - Built, frozen, rendered and drafted in Mailercloud each morning, exactly as today.
  - Never scheduled by the tick, in any approval mode (including `DIGEST_APPROVAL_REQUIRED=false`).
  - Not covered by the run's Approve. Approve covers Premium only, both in the route and in the `audiences` the screen sends.
  - Goes out only through a new action, `POST /api/digest/runs/:id/send-free`.
- `send-free`:
  - Cookie session only, ADMIN or PUBLISHER (the same people who may approve); the bearer token is refused.
  - Runs at most once. Two presses or two tabs give one send; the second gets a clear 409.
  - Reuses the existing schedule step and every gate on it (see Constraints). It does not write its own send path.
  - Writes one audit row with the audience and who pressed it. No address and no headline.
- Digests screen, Free version:
  - A **Send Free** button with the confirm dialog (`ConfirmPush.vue`, Cancel focused), saying it goes to Free readers now.
  - The button stays available after Premium has been sent, until the cut-off.
  - When it can't be pressed, the button shows why (`off(reason)`), like the other actions.
  - After 17:00 an unsent Free reads as a calm "Not sent today", never amber or red.
- Alerts, flag on:
  - `ready_for_approval` and `not_approved_yet` speak only about Premium, and `not_approved_yet` never fires because Free is unsent.
  - The staff push and the email follow the same rule.
  - The cut-off skip of an unpressed Free uses a new routine reason, `manual_not_sent`, with no alert and no failure banner.
- Admin guide: a short section on Send Free, with the version bumped.

**Out (do not build):**
- Any change to Free's or Premium's recipients, lists or tags. Those are Railway settings the owner changes separately.
- Choosing stories or editing content at push time.
- Sending after 17:00, or more than once a day.
- Switching the flag on.
- Stopping the hand-made digest (not code).

## Acceptance tests
Each one must PASS in the REPORT.
1. Flag off: Approve, the tick, Send now, alerts and the screen behave as before, and the existing digest tests pass unchanged.
2. Flag on, Approve pressed: Premium schedules and sends; Free stays unscheduled through every tick up to the cut-off.
3. Flag on with `DIGEST_APPROVAL_REQUIRED=false`: Premium goes automatically; Free still waits for the button.
4. Send Free pressed before `DIGEST_SEND_AT` and after quiet hours: Free is scheduled from the press, and does not wait for Premium's approval or send.
5. Send Free pressed after Premium was sent: Free goes; Premium isn't touched.
6. Two concurrent presses: exactly one provider schedule call; the other press gets 409.
7. Refused, with the reason shown and nothing sent: quiet hours, past the cut-off, editor hold, complaint hold, no draft yet, `DIGEST_SEND_LIVE` off, and an invalid Free target or a refused audience guard.
8. Unpressed at 17:00: Free is SKIPPED with `manual_not_sent`, no alert is raised, and no failure banner shows. Premium's own skip or failure still alerts as today.
9. The top stories of an unsent Free roll forward as the existing skip does (ICYMI).
10. A Premium skip does not stop Free being pressed, and a Free skip does not affect Premium.
11. Roles: bearer → refused; signed out → 401; PUBLISHER and ADMIN → allowed. The audit row is written once per real send, with no address and no headline.
12. A restart between press and schedule neither double-sends nor loses the press: the write-ahead markers and provider lookup still apply.
13. Screen, checked in a real browser at desktop and at 390 px: the button and its confirm work, disabled reasons read properly, and "Not sent today" looks calm.

## Files
- `src/lib/env.ts` — the flag.
- `src/services/digest/holds.ts` — the ONE definition of "this variant is manual-only", used by the runner, screen and status.
- `src/services/digest/runner.ts` — tick gate, the press path, `cutoffReason`.
- `src/services/digest/screen.ts`, `status.ts` — action and banner.
- `src/services/digest/scheduler.ts`, `alerts.ts` — reminder and alert copy.
- `src/routes/digest.ts` — the route; Approve's covered variants.
- `admin/src/views/Digests.vue` — button and states (UI items go to the `ui-developer` agent).
- The admin guide, and `docs/EMAIL_DIGEST_DESIGN.md` §5 for the flag.
- Tests: new `src/__tests__/digestFreeManual.test.ts`.

## Constraints
- Flag: `DIGEST_FREE_MANUAL`, default off.
- Migrations: additive only. A new `AuditAction` value if needed; a marker column on `DigestSend` only if no existing field can carry the press. Say which in the REPORT.
- Full suite: yes, it touches the digest send path and possibly a migration.
- Docs that ship with it: admin guide; design doc flag table.
- The press must pass every gate the normal schedule passes: night rule, cut-off, approval and complaint holds, `DIGEST_SEND_LIVE`, the audience guard, the one-a-day rule, and `audienceTarget()`'s Premium exclude. An editor's HOLD or a complaint hold stops Free too (owner: one version's breach holds both).
- Never re-send and never send late: both existing rules still apply.
- No second send path, and no direct Mailercloud call from the route.
- Never log an address or a provider message; use `safeErrorLog`.

## Context the builder needs
- `src/services/digest/holds.ts` is the single definition of who must approve. Add the manual rule there, not in three places.
- The trap in `screen.ts → digestActions`: `open` goes false once any variant is handed over, and `sendNow` needs `!skipped`. Send Free must not inherit either, or the button disappears as soon as Premium is sent.
- `ownApprovalRequired` / `approvedAt` is a per-variant approval that already exists, but `variantNeedsOwnApproval` depends on approval mode, so it doesn't cover test 3. Reuse what fits.
- `advanceRun(id, 'send_now')` moves the send instant earlier for the run; Free must move without moving Premium.
- `alerts.ts:111` `PREVIEW_ROUTINE_SKIPS` shows the pattern for skips that aren't alarms.
- Design: `docs/EMAIL_DIGEST_DESIGN.md`. Runbook: `docs/DIGEST_PILOT_RUNBOOK.md` §4.
