# Event retention

## The problem it corrects

`Event` is one row per thing that happened to one subscriber. At ~2,950
subscribers × ~21 pushes a day that is ~62,000 `SENT` rows a day, and by
2026-09-22 the table held **6.4M rows / 1.45 GB**, with the 5 GB Railway volume
on course to fill in about four months.

Two things were designed wrong at go-live:

1. **`DISMISSED` was recorded and never read.** 1.17M rows — 18% of the table —
   with no consumer anywhere in the codebase. Data with no reader.
2. **The delivery log had no lifecycle.** One row per delivery is the standard,
   correct model — it is what gives per-campaign CTR, delivery rate, and the
   daily cap. But nothing reads a `SENT` row older than **7 days** except to
   *count* it. We were storing millions of rows to hold a few thousand integers.

## The rule

**Every statistic = rolled-up (deleted rows) + live (remaining rows).**

| Statistic | Rolled-up half | Live half |
|---|---|---|
| per-campaign sent / clicked / failed / sentAt | `Campaign.rolledSent` / `rolledClicked` / `rolledFailed` / `rolledFirstSentAt` | `Event` rows with that `campaignId` |
| lifetime totals on the Dashboard | `EventRollup(type).count` | `groupBy type` over remaining rows (the metrics warmer) |

`campaignStats()` in `src/services/metrics.ts` is the single implementation of
the per-campaign rule; both the Dashboard and the Campaigns list call it. The
send path never writes a roll-up. **Only the sweeper does, in the same
transaction as the delete**, so a crash mid-run leaves the numbers consistent
and a re-run is safe.

## What the sweeper does (`src/sweepers/eventRetention.ts`)

Nightly at 03:30 IST, flag-gated, batched (5,000 rows per transaction):

- **Purges** `SENT` / `CLICKED` / `FAILED` older than `EVENT_RETENTION_DAYS`
  (default **30**; the longest any reader looks back is 7 days, the cap and the
  pacer ceiling look at *today*).
- **Purges `DISMISSED` at any age** — the one deliberate exception to the
  window, because it has no reader. `/api/track` no longer stores it either
  (still answers 204, so older service workers don't retry).
- **Never touches** `SUBSCRIBED` / `UNSUBSCRIBED` / `PROMPT_SHOWN` /
  `PROMPT_ACCEPTED`: ~45k rows, they carry subscriber provenance, and the
  funnel reads them by content.
- Caps a nightly run at `EVENT_RETENTION_MAX_BATCHES` (default 400 → 2M rows)
  so the first pass over a large backlog is bounded; the next night continues.

## Configuration

| Variable | Default | |
|---|---|---|
| `EVENT_RETENTION_ENABLED` | `false` | It deletes rows; switched on deliberately. |
| `EVENT_RETENTION_DAYS` | `30` | |
| `EVENT_RETENTION_CRON` | `30 3 * * *` | 03:30 IST, after the audit sweep. |
| `EVENT_RETENTION_BATCH` | `5000` | Rows per transaction. |
| `EVENT_RETENTION_MAX_BATCHES` | `400` | Per run; `0` = until clear. |

## Running it by hand

```
npm run event-retention                          # DRY RUN — counts only
npm run event-retention -- --yes                 # apply, up to the batch cap
npm run event-retention -- --yes --batches 0     # clear the whole backlog
```

It prints the target database first. Dry run against production on
2026-09-22: **would delete 4,666,625 of 6,434,456 rows (73%)** — SENT
3,469,947 · DISMISSED 1,170,061 · FAILED 14,483 · CLICKED 12,134.

## What this guarantees, and how it is tested

`src/__tests__/eventRetention.test.ts` seeds campaigns with rows on both sides
of the window and asserts, before vs after a sweep:

- per-campaign `sent`, `clicked`, `failed`, `ctr` **and `sentAt`** are identical
  (`toEqual`, not approximately)
- Dashboard lifetime totals are identical
- the Campaigns list shows the same figures for a campaign whose rows are
  entirely rolled up
- no windowed row younger than the window is ever deleted (the exact-cutoff
  row stays — the comparison is strict)
- the permanent types survive at any age
- a dry run writes nothing; a second sweep is a no-op; a backlog larger than
  one batch is processed correctly across bounded runs

One bug this caught before it shipped: a first version wrote
`rolledFirstSentAt` through raw SQL with a `::timestamp` cast, and the value
came back shifted by the session's IST offset (+05:30). The parity test on
`sentAt` failed; the write now goes through Prisma's typed update.

## After this, the table is bounded

~30 days × ~75k rows ≈ **2.3M rows, ~530 MB, flat forever.** Disk growth from
this table stops. The five indexes (105 bytes/row, the text-cuid primary key
alone 305 MB) are a separate, lower-priority tidy-up once the table is small.

## Backups

`EventRollup` is included in the off-platform export — once the rows are gone,
those lifetime counts cannot be re-derived. `Campaign.rolled*` travels with the
`Campaign` rows already exported.
