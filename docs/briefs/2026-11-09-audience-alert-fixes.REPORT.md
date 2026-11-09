# REPORT: 2026-11-09-audience-alert-fixes

- **Branch:** `build/audience-alert-fixes` (base `origin/develop` 6a79531)
- **Code commit:** `33635b9` — `fix(audience-alerts): IST date on audience alert emails + honest "refused" advice`
- **Built exactly to the brief. All 8 acceptance tests PASS.** One thing the brief did not foresee needs a planning decision before merge (next section).

## ⚠️ Needs a planning decision (not built — outside the brief)

`audience_writer_fatal` is raised from **two** places in `src/services/audience/writer.ts`, not one:

| Site | Payload | Meaning |
|---|---|---|
| `writer.ts:318` | `{ count: report.fatal, reason: 'contact_write' }` | contacts Mailercloud refused (the case the brief is about) |
| `writer.ts:298` | `{ count: 1, reason: 'tags_<http>' \| 'tag_ids' }` | the **tag-name lookup** failed fatally, i.e. a bad key, bad tag ids or a rejected request — nothing to do with any reader's address |

With the new copy, the second case (always `count: 1`) now says "Usually this is an address Mailercloud blocks because it
hard-bounced…" and **"Nothing to do"**. Before this change it correctly said to check `MAILERCLOUD_SYNC_API_KEY` and the tag/list ids.
So a rejected key or wrong tag id at lookup time would now be told to the admins as "nothing to do". The reason code
(`tags_401` / `tag_ids`) does still appear in the first sentence, but the advice contradicts it.

I did not change this, as the brief says what `todo` is keyed on (the count only) and asks for no more. A minimal fix, if you want it as
**Follow-up 1** on this brief: keep the key/ids/quota `todo` (and drop the hard-bounce sentence) when `m.reason` is `tag_ids` or starts with `tags_`,
in the same `case` in `src/services/digest/alerts.ts`; ~6 lines + 2 tests. Also worth knowing: because the same-day marker is refreshed with
`{ ...cur, ...detail }`, a later tag-lookup failure on the same IST day overwrites an earlier real count with `1` (and its reason), so the count at
email time is "the latest raise", not a day total. Not changed.

## Files changed
- `src/services/audience/alerts.ts` — import `istDateOf`; `sendAudienceAlerts` passes `istDateOf(now)` (not `now`) to `buildAlertEmail`, which dates by runDate (00:00 UTC of the IST day). This fixes the date for **every** audience alert kind (`audience_breaker_open`, `seq_conflict`, `unknown_status`, `audience_writer_fatal`, `audience_writer_failing`, `audience_drift`, `audience_full_incomplete`, `cms_views_failed`), not only the writer one. Comment explains why.
- `src/services/digest/alerts.ts` — `export const WRITER_FATAL_MANY = 10` next to `alertCopy`; `audience_writer_fatal` copy: `what` = the old sentence + "Usually this is an address Mailercloud blocks because it hard-bounced in the past (its API calls it "Invalid email")."; `todo` = "Nothing to do: …" when count ≤ 10, "Many refusals at once: check the sync key (MAILERCLOUD_SYNC_API_KEY), the tag/list ids and the contact quota in Mailercloud, then press Retry refused on Admin → Digests (Audience card)." when count > 10. `short` and `did` unchanged; missing count still = 1; `reason` still goes through `safeDetail`. The digest caller (`alerts.ts:785`, `run.runDate`) is untouched.
- `src/__tests__/audienceAlerts.test.ts` (new, 9 tests) — dates through the real `raiseAudienceAlert` → `sendAudienceAlerts` path, plus end-to-end copy.
- `src/__tests__/digestAlerts.test.ts` (+9 tests) — copy for counts 1 / 11 / 10 / missing, redaction, `WRITER_FATAL_MANY`, and the digest-date regression.

## Migrations
None.

## Flags / env
None (internal admin email wording and a date; no reader-facing change).

## Test results (verbatim)
- `npx tsc -p tsconfig.json --noEmit` — no output, exit 0
- `npm run lint` — `eslint "src/**/*.ts"`, no output (clean)
- New + digest alert tests (one jest process): `Test Suites: 2 passed, 2 total` / `Tests: 66 passed, 66 total`
- Area: `audiencePull` + `audienceWriter`: `Test Suites: 2 passed, 2 total` / `Tests: 70 passed, 70 total`
- Other tests that reference the alert functions (`audienceGuard`, `digestRestoreAdopt`, `digestAds`, `digestFreeManual`, `digestWebhook`): `Test Suites: 5 passed, 5 total` / `Tests: 238 passed, 238 total`
- **Full suite: not run** (brief: `Full suite: no`; nothing in the schema/auth/send path/config/`useApi` was touched).
- Proof the date tests bite: with the original `buildAlertEmail(kind, m, now, cfg)` restored temporarily, `audienceAlerts.test.ts` gave `Tests: 3 failed, 6 passed, 9 total` — `…needs review — 2026-11-07` instead of `2026-11-08` for 04:31 IST, and the 00:01 IST and `18:29:59Z/18:30:00Z` boundary cases off by a day. The 22:02 IST case passes either way (it was never wrong). The fix was put back before committing.

## Acceptance tests
1. 2026-11-07T23:01:00Z → subject `[Taxscan digest] Audience sync paused — needs review — 2026-11-08`, first line `Daily email digest, 2026-11-08` — **PASS** (`audienceAlerts.test.ts`, also checks the HTML)
2. 2026-11-08T16:32:00Z → `2026-11-08`; 2026-11-08T18:31:00Z → `2026-11-09` — **PASS** (plus the 18:29:59Z / 18:30:00Z boundary)
3. Digest alert from a run with `runDate` 2026-11-09 still dated `2026-11-09` — **PASS** (`buildAlertEmail` directly, and a real run created 06:30 IST on 9 Nov driven through a forced 401 → `Mailercloud rejected the digest — 2026-11-09`)
4. `count: 1` → "hard-bounced in the past" + "Nothing to do", no `MAILERCLOUD_SYNC_API_KEY` — **PASS** (text and HTML; unit and end-to-end)
5. `count: 11` → `MAILERCLOUD_SYNC_API_KEY` + "Retry refused" — **PASS**
6. `count: 10` → "Nothing to do" variant — **PASS**
7. No address in any email text or log line; existing redaction tests — **PASS** (existing "no API key and no reader address" test still green; new tests put an address and the API key in the stored `reason` and check subject, text, HTML and every captured log line)
8. tsc + lint clean — **PASS**

## Agents run
None. Small enough to do directly; no UI.

## Deviations from the brief
None in code. One test addition beyond the listed ones: a same-IST-day refresh test (count 1 raised, then 25) showing the email uses the refreshed count, since the brief says the count is refreshed.

## Worth remembering
- `buildAlertEmail(kind, m, runDate, cfg)` takes a **runDate**, not an instant. Its only two non-test callers are `digest/alerts.ts:785` (`run.runDate`, correct) and `audience/alerts.ts:103` (now `istDateOf(now)`).
- The admin guide does not quote the alert text (`grep` for "refused a contact write" in `docs/` and `admin/src` found only the brief and the source), so no docs change.
- The date bug hit every audience alert raised 00:00–05:29 IST (e.g. the nightly 04:30 full-load alert), not just the 8 Nov one.

## Clean-up (planning runs this after merging)
```sh
git worktree remove ../taxscan-push-worktrees/audience-alert-fixes
dropdb taxscan_push_build_audience-alert-fixes; dropdb taxscan_push_build_audience-alert-fixes_shadow
git branch -D build/audience-alert-fixes; git push origin --delete build/audience-alert-fixes
```
