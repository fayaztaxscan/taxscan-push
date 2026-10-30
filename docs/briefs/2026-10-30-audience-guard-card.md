# Brief: CMS audience sync tasks 7–8 — digest wiring + send guard, Audience card + Resume

- **Date / name:** 2026-10-30-audience-guard-card  →  branch `build/audience-guard-card`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first)
- **Design:** `docs/CMS_AUDIENCE_SYNC_DESIGN.md` — §7.1, §7.2 (task 7), §10.2 + §3.1 + §8.2 (task 8), §11 build plan.
  The design is the spec; this brief only fixes scope, adds one correction, and sets the tests.

## Goal
With `DIGEST_AUDIENCE_FROM_CMS=true` the digest derives its Premium/Free targets from the audience config and every
send door (scheduled 07:30, Send now, Retry) passes `audienceGuard` first. Digests gets an **Audience card**; an ADMIN
can review the breaker's counts and press **Resume**. With the flag off (as in production today) the digest behaves
exactly as now — except that the breaker alert stops claiming Premium is held.

## Why
- Hard prerequisite for digest stage 3 (owner, 24 Oct: Premium only from CMS data).
- 29 Oct 23:00 UTC the first complete full load opened the breaker (`first_load`, by design). The alert email says
  "The Premium digest is held" and "press Resume on the Audience card" — neither exists yet. Today's Premium
  went out to the staff list, correctly. The record must not lie, and the first-load review needs the card.

## Scope
**In — task 7 (design §7.1, §7.2):**
- `src/services/audience/guard.ts` → `audienceGuard(audience, now)`, pure over `AudienceSyncState` + counts, returning
  `{ ok: true } | { ok: false, check: <code>, plain: <sentence> }`. Every PREMIUM and FREE check in §7.2, thresholds
  from `env.audience` (`AUDIENCE_MAX_STALE_HOURS` 26, 3 h liveness, pending `max(1%,10)`,
  `AUDIENCE_PREMIUM_DEVIATION_PCT` 2 % / 25; FREE: Premium tag count 0 or > 72 h stale). A missing input (no
  Mailercloud count yet, no CMS `meta.counts`) fails closed for PREMIUM and names itself.
- `runner.ts`: when the flag is on, `audienceTarget()` derives tag ids (Premium tag; Free = `DIGEST_FREE_LIST_IDS` +
  Former tag, excludes Premium tag + No-marketing tag, always) — the "set one, not both" boot check already exists
  (task 1), reuse it. Call the guard **inside `scheduleStep()` before the claim**, so a refusal never spends the
  first-call marker; it applies equally to Send now and Retry. Refusal: variant stays CREATED, `nextAttemptAt` =
  next minute, `audience_unverified` alert once per run (existing alert plumbing), at 17:00 SKIPPED
  `audience_unverified` and rolls forward. Approval does not override it.
- Digests status payload: per-variant guard result (so the run card can say "Held — <plain sentence>").

**In — task 8 (design §10.2):**
- `GET /api/digest/audience` (any signed-in user; PUBLISHER gets the one-line status only, ADMIN gets the full
  counts): Premium CMS / ours / Mailercloud; Former; No-marketing; pending writes; last webhook / incremental /
  full pull; errors in the last 24 h by kind; breaker open?, reason, `pendingReview` counts, opened at; whether
  Mailercloud writes are live or dry-run; whether the guard is active (flag). Postgres only — never calls the CMS
  or Mailercloud on the request path.
- `POST /api/digest/audience/resume` — `requireUser(['ADMIN'])` (cookie session only, not the bearer), calls the
  existing `resumeBreaker(portal, userId)` (already audits `AUDIENCE_SYNC_RESUMED` with reason + counts); 409
  `not_open` when the breaker is closed.
- **Audience card on `admin/src/views/Digests.vue`** (new component): counts in the settled table style, breaker
  block with reason in plain words + the counts, **Resume** behind `ConfirmPush.vue`-style confirm ("Resume
  audience sync? Mailercloud writes restart on the next run." Cancel focused). Phone ≤720 px: `stack` table.
  Publishers see one line. Hidden entirely when `AUDIENCE_SYNC_ENABLED` is off.

**In — the correction:**
- `src/services/digest/alerts.ts` `audience_breaker_open` copy: the "Premium is held" sentence only when
  `DIGEST_AUDIENCE_FROM_CMS` is on; otherwise "Premium is not held yet (the send guard is off); today's digest goes
  to its configured lists as usual." Same pattern for `audience_full_incomplete` if it claims a hold.

**Out (do not build):**
- Tasks 9–10 (backup v3, retention, runbook/guide rewrite) — separate briefs.
- No role editor, no per-reader screen, no address shown anywhere (design §8.2).
- No change to the writer, pulls, ingest, breaker thresholds or any flag default. No Railway change.
- `DIGEST_PREMIUM_SEGMENT_IDS` / stage-3 segment logic beyond what §7.1 already names for derivation.

## Acceptance tests
Each one must PASS in the REPORT.
1. Flag OFF: `audienceTarget()` output and the whole digest runner suite are unchanged; the guard is never called
   (spy).
2. Guard units, one per §7.2 check, each at limit and limit+1: stale full load 26 h; no activity 3 h; breaker open;
   pending > max(1 %,10); Mailercloud vs ours > max(2 %,25); CMS vs ours > same; missing input → PREMIUM refuses.
   FREE: refuses only on Premium tag count 0 or > 72 h stale; passes with the breaker open.
3. Runner with flag ON: a refused PREMIUM stays CREATED with `scheduleAttemptedAt` null, `nextAttemptAt` = next
   minute, one `audience_unverified` alert per run; clears and schedules on the first minute the guard passes;
   at 17:00 → SKIPPED `audience_unverified`. Send now and Retry meet the same refusal. FREE unaffected by a PREMIUM
   refusal.
4. Flag ON: derived Free excludes always contain the Premium and No-marketing tags; config cannot remove them.
5. `GET /api/digest/audience`: ADMIN full payload; PUBLISHER one-line only (no counts beyond the line); no email,
   hash or account id in either payload (assert on the serialized JSON).
6. `POST …/resume`: PUBLISHER 403, bearer-only 401/403, ADMIN 200 → breaker cleared + one `AUDIENCE_SYNC_RESUMED`
   audit row with reason + counts; second call 409 `not_open`.
7. Alert copy: flag off → no "held" claim; flag on → the held sentence.
8. UI: Audience card renders breaker + counts for ADMIN, one line for PUBLISHER, hidden when sync is off; Resume
   confirm has Cancel focused. Verified in a real browser at desktop and 375 px width (screenshots in the REPORT).
9. `tsc --noEmit`, lint, and the full suite green (known flaky "metrics warmer" may be re-run alone).

## Files
- New: `src/services/audience/guard.ts`, `admin/src/components/AudienceCard.vue` (name may vary).
- `src/services/digest/runner.ts` (`audienceTarget`, `scheduleStep`), `src/services/digest/status.ts`/`screen.ts`
  (guard result in the payload), `src/services/digest/alerts.ts` (copy), `src/routes/digest.ts` (two routes),
  `admin/src/views/Digests.vue`.
- Tests: new `src/__tests__/audienceGuard.test.ts`; extend digest runner + digest route tests.
- `docs/CMS_AUDIENCE_SYNC_DESIGN.md` §11 — "Task 7 — built" / "Task 8 — built" notes.

## Constraints
- Flag: `DIGEST_AUDIENCE_FROM_CMS` (exists, default off) gates the guard + derived targets. The card is gated by
  `AUDIENCE_SYNC_ENABLED`; Resume needs no extra flag.
- Migrations: none expected. If one is unavoidable: additive only, stop and say why in the REPORT.
- Never log or return an address, hash or account id. Counts and reason codes only.
- The guard must be called before the claim — it must never consume `scheduleAttemptedAt`.
- Docs: admin guide page for the card is task 10; just leave a TODO line in the REPORT.

## Context the builder needs
- Breaker state + `resumeBreaker` + `todaysCounters`: `src/services/audience/breaker.ts` (resume already audits).
- Alerts: `raiseAudienceAlert` in `src/services/audience/alerts.ts` (dedupes per IST day per kind); copy in
  `src/services/digest/alerts.ts` (~line 400).
- `scheduleStep` + `scheduleBlocker`: `src/services/digest/runner.ts` ~1368 — the guard fits naturally as another
  blocker, but it must also raise the alert and drive the 17:00 skip reason.
- Role gates: the digest routes use `requireUser([...])` / `requireBearerOrUser([...])`; Resume is cookie-ADMIN only.
- Production right now: breaker OPEN (`first_load`), writes dry-run, `DIGEST_AUDIENCE_FROM_CMS` off — so shipping this
  changes nothing for readers; the card will show the first-load counts for the owner's review.
- Local DB: run `npx prisma migrate dev` first if your DB lags (the 29 Oct migrations).
