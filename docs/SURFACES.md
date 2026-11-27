# Reports → Surfaces (Google Discover, Search News tab, Google News)

What Google picked up, counted as **clicks and impressions** from the Search Console Search Analytics API. Never
pageviews: they are not comparable with "Reads" and are never added to them. Internal report only.

## The three surfaces

| On screen | Stored as `SearchSurface` | Search Console `type` | What it is |
|---|---|---|---|
| Discover | `DISCOVER` | `discover` | the feed Google shows without a search |
| Google Search · News | `GOOGLE_SEARCH_NEWS` | `news` | the News tab in Google Search |
| Google News | `GOOGLE_NEWS` | `googleNews` | the Google News app and news.google.com |

`news` and `googleNews` are different surfaces despite the names.

## How it is filled

- `src/services/searchSurfaces.ts`: every 6 hours (`SEARCH_CONSOLE_CRON`), flag `SEARCH_CONSOLE_ENABLED`, the last
  `SEARCH_CONSOLE_LOOKBACK_DAYS` days into `ArticleSurfaceStat`. All three queries finish before anything is deleted;
  one failure writes nothing for that pass. Only the fetched surfaces' rows are replaced, date by date. A response at
  the page cap fails rather than being stored truncated. Log: `[surfaces] synced rows=… dates=… discover=…
  searchNews=… googleNews=…`.
- Google reports 2-3 days late, so the newest days are empty and the current month is marked as still filling.
- The report (`src/services/surfacesReport.ts`) reads Postgres only and counts article pages only (`isArticlePath`:
  an old address ending in the article id, or `/<section>/<slug>` in an article section).

## History backfill

Search Console keeps about 16 months. One surface at a time, so the others are not re-fetched.

**Production** (ADMIN session, or the bearer `ADMIN_TOKEN`):

```sh
curl -sS -X POST https://push.taxscan.in/api/admin/surfaces/backfill \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"surface":"news","from":"2026-01-01"}'
# → 202 { "id": "…", "state": "running", "chunks": [ … ] }
curl -sS -H "Authorization: Bearer $ADMIN_TOKEN" https://push.taxscan.in/api/admin/surfaces/backfill/<id>
```

- `surface`: `discover`, `news` or `googleNews`. `from` / `to`: `YYYY-MM-DD`; `to` defaults to today (IST).
- Calendar-month chunks, oldest first. The first failing chunk stops the run; earlier months stay stored. Rerunning a
  range is safe.
- `409 sync_running`: the routine sync or another backfill is running; try again shortly. A routine pass that falls due
  during a backfill is skipped.
- `409 search_console_disabled` / `search_console_not_configured`: flag, site URL or credentials missing.
- Run state is held in memory: after a restart the id is gone (`404`); rerun the same range.
- One audit entry per start: surface, range, chunk count.

**Locally / where the database is reachable:** `scripts/backfill-surfaces.ts --from 2026-01 --surface news --yes`
(without `--yes` it only prints the plan).
