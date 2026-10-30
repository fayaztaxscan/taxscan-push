# REPORT: 2026-10-30-audience-guard-card

- **Code commit:** d62fde1 — branch `build/audience-guard-card` (base `origin/develop` 7d3a0db)

## Files changed
- `src/services/audience/guard.ts` (new) — `audienceGuard(audience, snapshot, now, thresholds)` pure; `loadGuardSnapshot` (Postgres only); `checkAudienceGuard`; `GUARD_SHORT` number-free phrases.
- `src/services/audience/adminView.ts` (new) — Audience card payload (ADMIN full / PUBLISHER one line).
- `src/services/digest/runner.ts` — `audienceTarget(cfg, audience, aud)` derives tags when `digestFromCms`; guard called in `scheduleStep()` after `scheduleBlocker`, before the claim; cut-off skip reason `audience_unverified`; `AdvanceDeps.audience` + `Ctx.aud`; new alert kind.
- `src/services/digest/alerts.ts` — copy for `audience_unverified`; breaker / writer-failing copy no longer claims a hold with the guard off (`alertCopy` gained a 4th param, default env); skip words; `audience_unverified` is a BLOCKING kind.
- `src/services/digest/screen.ts` — run detail `variants[].audienceHold`.
- `src/routes/digest.ts` — `GET /audience`, `POST /audience/resume`; `audience` option (tests inject).
- `admin/src/components/AudienceCard.vue` (new), `admin/src/views/Digests.vue` (card + "Held — …" variant note), `admin/src/components/ConfirmPush.vue` (optional `busyLabel`, default unchanged).
- `src/__tests__/audienceGuard.test.ts` (new, 30 tests), `docs/CMS_AUDIENCE_SYNC_DESIGN.md` §11 "Task 7 / Task 8 — built".

## Migrations / flags
None. No new flag: `DIGEST_AUDIENCE_FROM_CMS` (exists, off) gates guard + derived targets; the card is gated by `AUDIENCE_SYNC_ENABLED`.

## Results
- tsc: clean. lint: clean. `vue-tsc --noEmit` (admin): clean.
- New tests: `Tests: 30 passed, 30 total`.
- Full suite: `Test Suites: 80 passed, 80 total` / `Tests: 1630 passed, 1630 total`.

## Acceptance tests
1 flag off, guard spy never called, targets unchanged — PASS · 2 guard units at limit / limit+1 for every §7.2 check, missing inputs, FREE rules — PASS · 3 runner flag on (stays CREATED, marker null, next minute, one alert, FREE unaffected, clears by itself, 17:00 SKIPPED `audience_unverified`, Send now + Retry refused) — PASS · 4 derived Free excludes always carry Premium + No-marketing — PASS · 5 GET: ADMIN full, PUBLISHER `{enabled, ok, line}` only, no email/hash/id — PASS · 6 Resume: PUBLISHER 403, bearer 401, ADMIN 200 + one audit row with reason + counts, then 409 `not_open` — PASS · 7 alert copy — PASS · 8 UI — PASS (browser, local dev server, build DB): ADMIN desktop `/var/folders/6p/7cdddtbx7690lgfqzd2ykhrr0000gn/T/claude-chrome-screenshots-ur1AGN/screenshot-1793352065459-0.jpg`, confirm with Cancel focused (verified `document.activeElement` = Cancel) `…-1793352073613-1.jpg`, 375 px iframe (no horizontal overflow) `…-1793352081531-2.jpg`, PUBLISHER one line `…-1793352092342-3.jpg` (same folder). "Hidden when sync off" is covered by the route test (`{enabled:false}` → card `v-if`), not by a screenshot · 9 PASS.

## Agents run
None.

## Deviations / decisions to check
- **Mailercloud comparison uses the drift check's own pair** (`premiumMailercloud` vs the `premiumOurs` saved with it), not a live applied count, so both are the same instant. The drift value is only as fresh as the nightly check; the guard does not look at `drift.at` age (not in the brief).
- **"No successful pull or webhook for 3 h" counts the full pull too** (newest of full / incremental / webhook).
- Free target: the configured `DIGEST_FREE_EXCLUDE_TAG_IDS` are ignored when derived (boot already refuses both set); configured exclude *lists* are kept; Premium keeps its configured lists/segments and replaces only `tagIds`.
- Guard read that throws → refusal (`guard_unreadable`), fail closed.
- Resume answers 409 `not_open` also when the sync is switched off.
- `audience_unverified` added to BLOCKING_KINDS so a later success sends the usual "resolved" note — say if you'd rather it did not.

## Worth remembering
- With this deployed and the flag still off, nothing changes for readers except the corrected breaker/writer alert copy. Turning the flag on in production today would refuse Premium (breaker open, drift never run, no Mailercloud count) and **FREE too while no member carries the Premium tag** (writes are dry-run) — the stage-3 order matters.
- `AudienceMember` has no portal column, so the guard's counts are table-wide (fine for one portal; tests stub `checkAudienceGuard` for runner scenarios because the table is shared across parallel test workers).
- Local gotcha: `npm run gen:vapid | grep` into `.env` needs `2>/dev/null`; the first attempt wrote nothing here.
- TODO (task 10): admin guide page for the Audience card.

## Clean-up
```sh
git worktree remove ../taxscan-push-worktrees/audience-guard-card
dropdb taxscan_push_build_audience-guard-card; dropdb taxscan_push_build_audience-guard-card_shadow
git branch -D build/audience-guard-card; git push origin --delete build/audience-guard-card
```
