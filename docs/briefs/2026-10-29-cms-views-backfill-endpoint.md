# Brief: Run the CMS views backfill from inside the running app

- **Date / name:** 2026-10-29-cms-views-backfill-endpoint → branch `build/cms-views-backfill-endpoint`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first)

## Goal
An ADMIN can start the one-off CMS views backfill in the running production app, without a shell into the
container, and see its progress and result.

## Why (29 Oct)
- The backfill (`npm run cms-views:backfill -- --from 2026-10-08 --yes`) must run from our Railway static egress
  IPs, because the CMS fences door V on them.
- Since we enabled Railway **Static Outbound IPs** (29 Oct), `railway ssh` and the dashboard **Console** fail for the
  taxscan-push service ("An error occurred connecting to your service"). The Postgres service's ssh still works, so
  the cause is static IPs.
- The routine 2-hourly sync only fetches today − 2 … today. Without the backfill, 8–26 Oct would show no CMS data, so
  `READS_SOURCE=cms` must wait for it.

## Scope
**In:**
- `POST /api/admin/cms-views/backfill` with body `{ from: "YYYY-MM-DD", to?: "YYYY-MM-DD", dryRun?: boolean }`.
  Auth: `requireBearerOrUser(['ADMIN'])` (the `ADMIN_TOKEN` bearer or an ADMIN session; a publisher gets 403).
  - Validates dates with the same rules as the script: `from` ≥ 2026-09-28, `to` ≤ today IST, `from` ≤ `to`.
  - Refuses (409) unless `CMS_VIEWS_ENABLED` is on and the config is valid. Refuses (409) if a backfill or a
    routine sync is already running: one at a time, sharing the sync's lock.
  - Starts the backfill **asynchronously, in-process**, reusing the script's chunking code: refactor the script
    into a function both use, and don't copy it. Returns **202** with a run id.
- `GET /api/admin/cms-views/backfill/:id`, same auth: state (`running` / `done` / `failed`), chunks done/total, rows
  inserted/updated, the first error (redacted via `safeErrorLog`), startedAt / finishedAt. In-memory is fine (it's a
  one-off). Say in the REPORT what happens if the app restarts mid-run: the backfill is idempotent, so re-running is
  safe.
- One log line per chunk and one at the end: `[cms-views] backfill chunk=… rows=… ms=…` / `… backfill done …`.
- An `AUDIT` row for the start (actor, from/to, dryRun), using the existing audit path and a new AuditAction if needed.
- `docs/BACKUPS.md` / the guide: nothing. Add one line to `docs/CMS_AUDIENCE_SYNC_DESIGN.md` or the design note for
  cms-views, wherever the script is described: "can also be run via the admin endpoint".
- **No UI**: curl with the bearer is enough (planning runs it).

**Out:** any change to the routine sync, the readers, or `READS_SOURCE`; any new UI.

## Acceptance tests
1. Fake CMS (the existing `cmsViewsFake.ts`): POST with a 3-chunk range → 202 → GET eventually `done` with the right
   counts; the rows are in `CmsArticleView`; a rerun gives the same rows (idempotent).
2. `dryRun: true` writes nothing and reports what it would fetch.
3. 409 when `CMS_VIEWS_ENABLED` is off, when one is already running, and when the routine sync is running. 400 on bad
   dates. 401 with no auth, 403 for a publisher.
4. A failing chunk → `failed` with a redacted error; earlier chunks stay written (as the script does).
5. Audit row on start.
6. tsc, lint (0 errors), the full suite: green.

## Constraints
No flag beyond `CMS_VIEWS_ENABLED`, no migration (unless a new AuditAction value needs one, which is additive), no
new env. Small: one commit.
