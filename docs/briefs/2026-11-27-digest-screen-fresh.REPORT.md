# REPORT: Digests screen stays fresh + honest Audience card

- **Brief:** `docs/briefs/2026-11-27-digest-screen-fresh.md`, including **Follow-up 1** (read from `origin/develop` 483a321)
- **Branch:** `build/digest-screen-fresh`, cut from `origin/develop` b9729ea
- **Code commit:** `cd5f424`
- **Result:** items 1–4 and Follow-up 1 built; acceptance 1–10 and 13–15 PASS (the brief has no 11 or 12)

`develop` has since gained docs-only brief commits (Follow-up 1 and the Facebook Academy brief). This branch was not
rebased; it touches none of those files.

## Files changed
- `admin/src/views/Digests.vue` — reload on return (visibility / persisted `pageshow`, 30 s throttle, skipped while loading, a press or subject save is busy, or a confirm box is open); reload after every Approve/Hold and send press, keeping the red message; scroll + focus on it; load sequence numbers so older loads cannot overwrite a press; subject save sends the `from` seen when the box opened.
- `admin/src/components/AudienceCard.vue` — "Would hold the Premium digest if the send guard were on: …" while the guard is off.
- `admin/e2e/digests-fresh.spec.ts` — new Playwright spec, 47 tests, all `/api` replies mocked with `page.route`.
- `src/services/audience/guard.ts` — new `REFUSED_WHERE`; `pendingPremiumWhere()` leaves refused (FATAL + address) and suppressed members out of "Premium without the tag"; docstrings.
- `src/services/audience/adminView.ts` — the three refused counts (Premium, Former, Free) use `REFUSED_WHERE` (same condition as before).
- `src/__tests__/audienceGuard.test.ts` — 10 new tests (nine `pendingPremiumWhere` cases; the 79 + 3 guard-and-card case).
- `docs/Taxscan-Push-Admin-Guide.html` — refresh paragraph, "held / would hold" section, version **2.38** (27 November 2026).

## Migrations
None.

## Flags / env
None.

## Test results (final code, run by the build session)
- tsc: `npx tsc -p tsconfig.json --noEmit` → no output, `tsc exit 0`
- lint: `eslint "src/**/*.ts"` → no findings, `lint exit 0`
- admin build: `✓ 145 modules transformed.` / `✓ built in 12.32s`, `build:admin exit 0`
- new jest tests (`audienceGuard.test.ts -t 'pending Premium'`): `Tests:       30 skipped, 10 passed, 40 total`
- browser specs (`playwright test digests-fresh nav-groups`, 47 + 19): `66 passed (5.0m)`
- area jest (every `audience*` and `digest*` file, plus `api`, `audit`, `adminLoginFeatures`, `reports`): `Test Suites: 47 passed, 47 total` / `Tests:       1345 passed, 1345 total`
- Full suite: **not run** (brief: no; no schema, auth, send path, config or `useApi` change)
- Not run: `compose-send.spec.ts`, `users.spec.ts` (neither visits these screens)

**Do the new tests fail without the change?**
- Backend: with the old `pendingPremiumWhere` put back, `Tests: 3 failed, 30 skipped, 7 passed, 40 total`.
- UI (ui-developer's runs): old `Digests.vue` + `AudienceCard.vue`, first version of the spec: `21 failed`, `6 passed`; the final spec against the pre-follow-up screen: `25 failed` / `22 passed`. The passes are "must not happen" or unchanged behaviour. Single safeguards removed one at a time were each caught.

## Acceptance
| # | Result | How checked |
|---|---|---|
| 1 | PASS | spec; real app: approved by a second request, returned after 31 s, Approve gone |
| 2 | PASS | spec: 29 s / 31 s, load in flight, press busy, confirm open, subject saving, both events together |
| 3 | PASS | spec; real back-forward-cache restore at both widths (one load) |
| 4 | PASS | spec (409, 400, Hold, failed reload, no reply); real 409s at both widths |
| 5 | PASS | spec only (mocked): Send now, Send Free, Retry, refused and unanswered |
| 6 | PASS | spec: leave the screen, events load nothing; come back, one load |
| 7 | PASS | jest: FATAL + address → not pending; suppressed → not pending; clean → pending; FATAL without address → pending; non-Premium with the tag → pending (also when refused or suppressed) |
| 8 | PASS | jest: 79 refused + 3 suppressed add nothing, guard ok, card line "Audience sync is healthy; the Premium list is verified. (the send guard is off)" for ADMIN and PUBLISHER; also seen in the real app |
| 9 | PASS | spec: guard off and on, failing and passing; real app: guard-off wording |
| 10 | PASS | area jest above. **No existing test assumed refused or suppressed rows count as pending, so none was changed.** There was no Digests view test; the Playwright spec is new |
| 13 | PASS | real app, real refused Approve, scrolled down at the button (numbers below) |
| 14 | PASS | real app + spec: successful Approve shows no red message and moves no focus |
| 15 | PASS | real app (old reload failed late with a 500, refusal stayed) + spec (status or detail, failing or landing) |

**13, measured (px from the top of the window)**

| View | scrollY before | message top / bottom after | scrollY after | focused, uncovered |
|---|---|---|---|---|
| Phone 375×812 | 1122 | 12 / 97 | 167 | yes |
| Desktop 1280×900 | 680 | 12 / 57 | 155 | yes |
| Phone, reduced motion | 1144 | 12 / 97 | 167 | yes |

14: scrollY changes by +57 on success on both widths. That is the browser holding its place as the "Approved." notice is
inserted above; the visible content does not move.

**Browser limits:** headless Chromium on a local backend (build DB, mock sender, no provider keys). A tab switch gives no
real `visibilitychange` headless, so the event was dispatched. Send buttons were exercised with mocked replies only. Not
tried on a real iPhone or Home Screen window.

## Agents run
- `ui-developer` (one, background; resumed once for Follow-up 1): items 1, 2, 4, Follow-up 1, the admin guide, the new spec and the real-browser checks. It reports its server stopped, seeded rows removed and build artifacts deleted; ports 3000 / 5173 were free when I checked.

## Deviations
1. **Item 3 built as written, although FATAL is wider than "address refused"** (planning decided: option a, no change in this build). `mcContacts.ts` classes any other 4xx on a contact write (for example a quota 403 or a 400) as FATAL, so such members now drop out of `pending_writes` too. The other guard checks compare applied-vs-Mailercloud and CMS-vs-desired, so I see none that replaces it. Planning's condition: the send guard must **not** be switched on until refusals are split into "address refused" and other FATAL (option b, with its migration), in the later send-guard brief. **Correction to my first note to planning:** it also named a bad key. A bad key normally fails the tag lookup that runs before every write tick (`resolveTagNames`), which marks **no** member; only a refusal on the write itself does.
2. **A limit on the safety net planning relied on** (read in code after that decision): the `audience_writer_fatal` email goes out **once per IST day**. `raiseAudienceAlert` keeps the day's marker, and `sendAudienceAlerts` skips a marker already emailed. So if one blocked address has raised it earlier that day, a later mass refusal updates the stored count but sends **no second email**. The "check the key / quota" advice for refused writes also needs more than 10 refusals (`WRITER_FATAL_MANY`) in the tick that is emailed.
3. Item 3's backend was built by the build session itself, not by `backend-developer` (a two-file change).
4. A **failed** load does not start the 30 s window, so the next return retries at once.
5. The return reload also waits while a load is in flight or a subject is saving.
6. Subject edit now sends the subject as it was when the box opened; otherwise a reload under an open box would defeat the "someone else changed it" check. After such a change, Save keeps refusing until Cancel and reopen (the screen's Refresh does not clear it; the server's message says "reload").
7. Only the newest run-detail request may write to the screen (a slow older reply cannot put Approve back).
8. A press that answers 200 but leaves a version failed also shows a red message, so it is scrolled to as well.
9. The guide gained a short section, not one line each. Its footer said 2.36 while the cover said 2.37; both now say 2.38. **The Facebook Academy brief may also bump the guide version: check at merge.**

## Suggestions, not built
- The Audience card loads only when the screen opens: neither Refresh nor the return reload refreshes it.
- A tab left from yesterday reloads into yesterday's run with "Back to today" (same as Refresh; read from code, not tested).
- Test send is not one of the five presses: a return reload already in flight that fails late can still replace its message.
- Guide section 9 still says "Not switched on yet" and gives 06:30 / 07:30 / 08:30; live times are 08:00 / 09:00 / 10:00.

## Worth remembering
- Prisma/SQL: `NOT` on the nullable `lastErrorKind` silently drops rows with no error; spell out `{ lastErrorKind: null }` beside it.
- The admin SPA's only test tool is Playwright. `digests-fresh.spec.ts` mocks the API, so it needs no seeded digest.
- Under load from other programs on this Mac (load average reached about 21 once, mostly not ours) `nav-groups` took 3 minutes instead of under 1.

## Clean-up (planning runs after merging)
```sh
git worktree remove ../taxscan-push-worktrees/digest-screen-fresh
dropdb taxscan_push_build_digest-screen-fresh; dropdb taxscan_push_build_digest-screen-fresh_shadow
git branch -D build/digest-screen-fresh; git push origin --delete build/digest-screen-fresh
```
