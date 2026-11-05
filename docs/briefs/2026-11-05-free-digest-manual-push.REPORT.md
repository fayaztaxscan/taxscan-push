# REPORT: Free digest goes only on a manual push (`DIGEST_FREE_MANUAL`)

- **Brief:** `docs/briefs/2026-11-05-free-digest-manual-push.md` (on `origin/develop` at `21f1688`)
- **Branch:** `build/free-digest-manual-push` (base `origin/develop` `21f1688`)
- **Code commit:** `d31b824`
- **Flag:** off by default. Nothing was switched on; nothing touched Railway, production, `main`, `develop` or the stash.

## What was built
With `DIGEST_FREE_MANUAL` on: Premium keeps its routine; Free is still built, frozen, rendered and drafted each morning but
**never scheduled by the tick, Send now, Retry now or the health resume, in any approval mode**. Its only door is
`POST /api/digest/runs/:id/send-free`.

- **One definition** `isManualOnly(cfg, audience)` in `holds.ts` (+ `awaitingManualPress`, `approvalAudiences`, `MANUAL_NOT_SENT`,
  `freePressRefusal`), used by the runner, screen, status, alerts, scheduler and the Approve route.
- **One gate** in `scheduleBlocker` (`runner.ts`): `awaiting_manual_press`, in the same place as the other schedule gates, so
  every door meets it. Editor / sanity / complaint holds above it still apply to Free.
- **The press** (`pressSendFree`, `runner.ts`): checks the same gates as the schedule step (it calls `scheduleBlocker` on the
  version "as if pressed"), the audience target and the audience guard; refuses with a plain reason **before stamping anything**;
  then stamps `approvedAt` / `approvedByUserId` / `sendAfter = now` with a conditional update (`approvedAt IS NULL`), so two presses
  give one winner; then `advanceRun(runId, 'send_free')`, which advances **Free only** through the existing create → schedule
  steps. No second send path, no Mailercloud call from the route.
- **Cut-off:** unpressed Free is SKIPPED with `lastError = 'manual_not_sent'`: no alert, no run `skipReason`, audit row kept
  (`DIGEST_SKIPPED`, reason `manual_not_sent`). Its stories roll forward as any skip does (`builder.ts` `rollsForward` reads the
  version's SKIPPED state, per audience).
- **Run state** (`runState.ts`): with the flag a waiting or routine-skipped Free is left out of the mix, so Premium sent + Free
  unsent reads "sent", not "created" / "partly sent". `digestRunState` gained an optional third argument; every caller passes it.
- **Alerts:** `ready_for_approval` lists Premium only; `not_approved_yet` ignores an unpressed Free and names Premium; staff
  pushes say "Premium"; `manual_not_sent` has skip wording.
- **Approve** covers Premium only, in the route (`approvalAudiences` filters the named `audiences`) and on the screen
  (`variantsAwaitingOwnApproval`, via `awaitingOwnApproval` which returns false for a manual-only version).
- **Screen:** `actions.sendFree` (hidden with the flag off; stays on offer after Premium is handed over or skipped; disabled with a
  reason from the SAME wording the route uses); per-version `manual`, `pressedAt`, `pressedBy`, `notSentToday`.
- **UI** (`ui-developer`): Send Free button on Free's own line with the `ConfirmPush` dialog, disabled reasons as visible text,
  "Send Free pressed by … at …", calm grey "Not sent today"; run-level approval line reads "Premium: …".

## Files changed
- `src/lib/env.ts` — `freeManual` (`DIGEST_FREE_MANUAL`, default false).
- `src/services/digest/holds.ts` — the single manual-only rule, press wording.
- `src/services/digest/runner.ts` — gate, `send_free` trigger, `pressSendFree`, cut-off reason, ready-alert audiences, `makeCtx` extracted from `advanceRunInner` (no behaviour change).
- `src/services/digest/runState.ts` — leaves waiting / routine-skipped Free out of the run state.
- `src/services/digest/screen.ts` — `sendFree` action, manual fields, Approve exclusion, server-only checks (target, guard) for the button.
- `src/services/digest/status.ts`, `scheduler.ts`, `alerts.ts` — banners, reminder and copy speak only about Premium; recovery check passes the flag.
- `src/routes/digest.ts` — `POST /runs/:id/send-free`, Approve ignores manual Free, one audit row per real press.
- `prisma/schema.prisma` + migration — `AuditAction` value `DIGEST_FREE_PRESSED`.
- `admin/src/views/Digests.vue`, `admin/src/composables/digestView.ts` — button, confirm, states, helpers.
- `admin/src/views/Activity.vue` — `DIGEST_FREE_PRESSED` in the digest filter list (the file has no label map).
- `docs/Taxscan-Push-Admin-Guide.html` — Send Free subsection in section 9, **v2.23, 5 November 2026**.
- `docs/EMAIL_DIGEST_DESIGN.md` — §5 flag row.
- Tests: new `src/__tests__/digestFreeManual.test.ts` (50), 4 added to `digestScreen.test.ts`.

## Migrations
- `20261105060334_digest_free_pressed_audit` — `ALTER TYPE "AuditAction" ADD VALUE 'DIGEST_FREE_PRESSED'`. **Additive.** No column added: the press is carried by the existing `DigestSend.approvedAt` / `approvedByUserId`.

## Flags / env
- `DIGEST_FREE_MANUAL` — default **off**.

## Results (verbatim)
- `npx tsc -p tsconfig.json --noEmit` → `tsc exit 0` (no output)
- `npm run lint` → `eslint "src/**/*.ts"` … `lint exit 0`
- `npm run build:admin` → `✓ built in 2.08s`, `admin exit 0`
- New tests: `digestFreeManual.test.ts` → `Tests: 47 passed, 47 total` at first green, then 3 tick tests added → 50 passed (run inside the full suite below).
- Area tests (all `digest*` files, flag off, before the new tests existed): `Test Suites: 25 passed, 25 total`, `Tests: 765 passed, 765 total`.
- **Full suite (Full suite: yes — touches the digest send path, a migration, env):** `Test Suites: 100 passed, 100 total`, `Tests: 2320 passed, 2320 total`, `Time: 73.093 s`. eventRetention was not flaky this run.

## Acceptance tests
1. **Flag off unchanged — PASS.** All 765 existing digest tests passed unchanged after the backend change; `1. flag off` test: both versions schedule, `send-free` refused `not_manual`; `sendFree` hidden.
2. **Flag on, Approve pressed — PASS.** Ticks 07:30 … 16:59: only PREMIUM scheduled; Free stays `CREATED`, `scheduleAttemptedAt` null. (2b: Send now / Retry / health never send an unpressed Free.)
3. **`DIGEST_APPROVAL_REQUIRED=false` — PASS.** Premium goes automatically; Free waits.
4. **Press before send time, after quiet hours — PASS.** Free scheduled from the press at 07:10; Premium untouched (state, `sendAfter`, `approvedAt`).
5. **Press after Premium sent — PASS.** Free scheduled; Premium's `scheduledAt` unchanged.
6. **Two concurrent presses — PASS.** Runner level and HTTP level: one 200 / one 409, `schedule` called once, one audit row.
7. **Refusals — PASS** (nothing stamped, nothing scheduled, plain reason): quiet hours, past cut-off, editor hold, complaint hold, sanity hold, no draft, `DIGEST_SEND_LIVE` off, invalid Free target, refused audience guard (CMS audience on, no sync = fail closed). Also covered in `digestActions` as disabled-button reasons.
8. **Unpressed at 17:00 — PASS.** SKIPPED + `manual_not_sent`, no `skipped` alert, `skipReason` null, `digestStatus.attention` null, run state "sent", no "was skipped" email; Premium's own skip still alerts exactly as today (8b); the same day with the flag off still nags and skips.
9. **Roll-forward — PASS (by state).** The unsent Free ends SKIPPED, which is what `rollsForward` (per audience) reads. I did not run a two-day builder scenario; the existing builder tests cover SKIPPED rolling.
10. **Skips independent — PASS.** A Premium SKIPPED row does not stop the press; Free's skip leaves Premium SENT.
11. **Roles / audit — PASS.** Signed out 401; bearer refused; no `confirm` 400; PUBLISHER and ADMIN allowed; exactly one `DIGEST_FREE_PRESSED` row per real press, keys `audience, state, scheduled`, no address, no headline; a refused press writes none.
12. **Restart between press and schedule — PASS.** Press stamped, no schedule call, next ticks → one schedule call. A reply lost after `schedule()` (AMBIGUOUS applied) → no second `schedule()`.
13. **Screen in a real browser — PASS (with limits).** Desktop 1280 and 390 px (same-origin iframe, no horizontal overflow): button + confirm (Cancel focused), after-press line and notice, held reason, calm "Not sent today". Screenshots in `docs/briefs/2026-11-05-free-digest-manual-push.shots/` (9 files). Limits: quiet-hours and past-cut-off reasons not reproduced live (it was 11:50 IST; the UI prints the server's string and the held case shows that); headlines are the seed script's "Sample:" text; the guide HTML was edited but not opened in a browser. I looked at 01 and 09 myself.

## Agents run
- `ui-developer` (one, foreground): `Digests.vue`, `digestView.ts`, `Activity.vue`, the guide section, 4 small tests, browser check with Playwright's Chromium, screenshots. It changed no backend file.

## Deviations from the brief
- **`confirm: true` is required in the body** of `send-free` (400 `confirm_required` otherwise), following Send now's precedent. Not in the brief.
- **Press marker = `approvedAt` / `approvedByUserId`** (the brief allowed an existing field). Consequence: for Free, `approvedAt` means "pressed", and the Approve route is filtered so it can never write it.
- **Send Free is not in the screen's `anyButton` check** and its disabled reason sits under Free's own button, not in the shared `disabledReasons` list (the button lives on Free's line; adding it would render an empty run-level row). The button hides once Free is scheduled / sent / partly sent (the Free line already says it).
- **"Not sent today" is also the badge label** for that Free instead of "Skipped" (calmer).
- **Audit action is new** (`DIGEST_FREE_PRESSED`), not `DIGEST_SEND_NOW`, so Activity can show "Send Free pressed".

## Worth remembering
- **A complaint hold or sanity hold on the run is lifted by Premium's Approve, and then Free may be pressed** (the existing "Approve lifts the hold" rule applied to Free, as "one version's breach holds both"). If Premium is already sent by then, nobody can Approve any more; a held day's Free is therefore refused until Approve, and after Premium's send the run's approval is APPROVED so Free passes.
- **Subject lock:** `subjectLock` returns `approved` once the run is approved, so with the flag on Free's subject locks when Premium is approved even though Free is not pressed yet. Not changed (out of scope). Suggest: let a manual Free's subject stay editable until it is pressed.
- **Run-level lead line:** after a Free press the screen's lead state is still the server's run state (e.g. "Drafts ready" in the seed); unchanged.
- **History table:** the Free badge for an unpressed day still reads "Skipped" there; showing "Not sent today" would need `notSentToday` on the history rows (suggestion, not built).
- **Adopted foreign draft:** a press also satisfies the "foreign draft needs a person" rule for Free (same weakness as Approve).
- **`makeCtx`** was extracted from `advanceRunInner` so the press can build the same context; behaviour unchanged (765 digest tests passed).
- `railway ssh` etc. were never used; the build database is `taxscan_push_build_free-digest-manual-push`.

## Follow-up 1 (owner, 2026-11-05): Free's subject stays editable until Send Free is pressed
- **Code commit:** `20e50ce`, same branch. No migration, no new flag. No UI file changed: the Digests screen shows the edit control from the server's `subjectEdit` field, which comes from `subjectLock`, so it follows the new rule by itself.
- **Change:** `subjectLock` (`src/services/digest/subjectEdit.ts`) uses `isManualOnly` from `holds.ts`. For a manual-only Free the "approved" lock is `approvedAt` (the press) alone; the run's Approve no longer locks it. Premium's rule is untouched. Not-today, not-built, past-cut-off, scheduled and create-in-flight locks all still apply to Free. `SubjectLockSend` gained an optional `audience` so older callers and tests compile unchanged.
- **Race (test 6):** the existing conditional update (state CREATED, no schedule attempt, subject still the old one) did **not** cover a press: the press stamps `approvedAt` but changes neither state nor `scheduleAttemptedAt` until the schedule step claims. So `editSubject` now adds `approvedAt: null` to that guard for a manual-only Free. The test forces a press between the lock check and the write (spy on `digestSend.updateMany`); I confirmed it **fails without the guard (edit returned 200)** and passes with it (409 `changed`, subject unchanged, no provider call).
- **Guide:** one sentence added to the Send Free section ("You can still Edit subject on the Free version after Premium is approved; it locks when Free is pressed, or at the cut-off"). Version left at 2.23 (same release day); bump it if you want one per change.
- **Results (verbatim):** `npx tsc -p tsconfig.json --noEmit` clean; `npm run lint` clean; all `digest*` tests: `Test Suites: 26 passed, 26 total`, `Tests: 826 passed, 826 total` (includes the unchanged `digestSubjectEdit.test.ts`). No full suite, as the brief says.
- **Acceptance:** 1 PASS (Premium approved, Free unpressed → 200, DB and provider draft both updated). 2 PASS (pressed → 409 `approved`, the existing text). 3 PASS (Premium after Approve still locked). 4 PASS (past cut-off, scheduled, not today, not built still refuse Free). 5 PASS (flag off: both versions lock on Approve as before; existing subject tests unchanged). 6 PASS (see Race above). Extra: the screen payload for the run shows Free editable after Approve and locked after the press, Premium locked.
- **Not done:** no browser check of the edit control (no UI code changed; covered through the run-detail API test). Remaining window, same as for every edit today: a provider `updateSubject` already in flight when a press schedules the campaign (about a second, unchanged by this).
- **Surprise:** `editSubject`'s existing guard never looked at approval at all; the lock check alone kept approved versions out. Only the manual-only Free needed the extra condition because its press is not a state change.

## Clean-up (planning runs this after merging)
```sh
git worktree remove ../taxscan-push-worktrees/free-digest-manual-push
dropdb taxscan_push_build_free-digest-manual-push; dropdb taxscan_push_build_free-digest-manual-push_shadow
git branch -D build/free-digest-manual-push; git push origin --delete build/free-digest-manual-push
```
