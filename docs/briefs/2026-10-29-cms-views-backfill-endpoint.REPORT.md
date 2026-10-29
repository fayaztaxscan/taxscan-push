# REPORT: cms-views-backfill-endpoint

- Branch `build/cms-views-backfill-endpoint` (base `origin/develop` @ 088a6d0); code commit `cd6c291ee756a129d32a404860edc797decf9c54`.

## Files changed
- `src/services/cmsViews/backfill.ts` (new): shared backfill — date rules (`validateBackfillRange`), config check, `startBackfill` (chunks via `runViewsSync`, in-memory run state, per-chunk + final log lines), last 20 runs kept.
- `src/services/cmsViews/sync.ts`: the sync's lock is now exported (`isViewsSyncRunning`, `acquireViewsLock`, `releaseViewsLock`) and `runViewsSync` takes `lockHeld`, so a backfill holds the lock for all its chunks and the routine cron can't interleave.
- `scripts/cms-views-backfill.ts`: refactored onto the shared function (no copy); header says the endpoint exists.
- `src/routes/api.ts`: `POST /api/admin/cms-views/backfill`, `GET /api/admin/cms-views/backfill/:id` (`requireBearerOrUser(['ADMIN'])`).
- `prisma/schema.prisma` + migration `…_cms_views_backfill_audit_action`: additive enum value `CMS_VIEWS_BACKFILL_STARTED`.
- `admin/src/views/Activity.vue`: the value added to the filter list (an existing test requires every AuditAction there). No other UI.
- `src/__tests__/cmsViewsBackfill.test.ts` (new, 10 tests).

## Use
```
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"from":"2026-10-08","dryRun":true}' https://push.taxscan.in/api/admin/cms-views/backfill
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://push.taxscan.in/api/admin/cms-views/backfill/<id>
```
POST returns 202 + the run record (`id, state running|done|failed, chunks, chunksDone, rowsFetched, rowsInserted, rowsUpdated, error, startedAt, finishedAt`). Errors: 400 `invalid_range`, 409 `cms_views_disabled` / `cms_views_config_invalid` / `sync_running`, 401, 403, GET unknown id 404.

## Results
- tsc 0; lint 0 errors; `build:admin` ok.
- Full suite (`--maxWorkers=1`): Test Suites: 79 passed, 79 total / Tests: 1593 passed, 1593 total.

## Acceptance
1. PASS (3 chunks 28 Sep–20 Dec under a faked clock; 7 rows; rerun 0 new / 7 updated, identical rows).
2. PASS (dryRun: state done at once, the chunk plan, no CMS request, nothing stored, no lock taken).
3. PASS (409 disabled / invalid config / backfill running / routine sync running; 400 on 8 bad bodies; 401; 403 publisher).
4. PASS (chunk 2 fails → `failed`, chunk 1's 7 rows stay, error redacted, lock released).
5. PASS (audit row: actor, from/to, dryRun).
6. PASS.

## Notes
- **Restart mid-run:** state is in memory, so the run stops and GET returns 404 for its id. Rerun the same range: chunks are all-or-nothing upserts, so it is safe and idempotent.
- **Dry run** reports the plan only (no CMS call), so it also doesn't need the lock; it still needs the config valid.
- The failing-chunk alert is the routine `cms_views_failed` alert (as the script did).
- Design-doc line: no design doc describes the script (only `docs/BACKUPS.md`, which the brief says to leave), so I put the note in the script's header comment instead.
- Agents: none.

## Clean-up
```sh
git worktree remove ../taxscan-push-worktrees/cms-views-backfill-endpoint
dropdb taxscan_push_build_cms-views-backfill-endpoint; dropdb taxscan_push_build_cms-views-backfill-endpoint_shadow
git branch -D build/cms-views-backfill-endpoint; git push origin --delete build/cms-views-backfill-endpoint
```
