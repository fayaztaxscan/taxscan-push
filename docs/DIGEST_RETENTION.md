# Digest retention

The email-digest twin of [`EVENT_RETENTION.md`](EVENT_RETENTION.md): same rule, same
shape, much smaller tables. Design: `docs/EMAIL_DIGEST_DESIGN.md` §3 (lifecycle table)
and §13 task 11. Code: `src/sweepers/digestRetention.ts`.

## The rule

**Every digest statistic = rolled-up (deleted rows) + live (remaining rows).**

| Statistic | Rolled-up half | Live half |
|---|---|---|
| per-send unsubscribes / bounces / complaints (Digests history) | `DigestSend.rolledUnsub` / `rolledBounce` / `rolledSpam` | `EmailEvent` rows of type UNSUBSCRIBE / HARD_BOUNCE / SPAM with that `sendId` |
| "the webhook was receiving" proof (number vs "—") | `DigestSend.webhookProofAt` | a CAMPAIGN_SENT / CAMPAIGN_ERROR `EmailEvent` for that send (`sendId` or `mcCampaignId`) |

`digestSendStats()` in `src/services/digest/stats.ts` is the **single implementation**.
Do not count `EmailEvent` per send anywhere else. Only the sweeper writes the rolled half,
in the same transaction as the delete.

A send with no proof shows "—", never 0. Folded counts alone are **not** proof (a reader
event is not proof while it is live, so it does not become proof by being folded); the
parity test pins that the stats map is identical before and after a fold.

## What the sweeper does, nightly

1. **`EmailEvent` older than `EMAIL_EVENT_RETENTION_DAYS` (90)**, oldest first, in batches
   of `DIGEST_RETENTION_BATCH`. Each batch is one transaction (`timeout: 60 s`):
   - UNSUBSCRIBE / HARD_BOUNCE / SPAM linked to a send → `rolled*` += n.
   - CAMPAIGN_SENT / CAMPAIGN_ERROR → `webhookProofAt` stamped on every send they prove
     (by `sendId` or `mcCampaignId`, the stats rule) before they are deleted.
   - **NO_ADDRESS** (the daily counter of opt-outs without a readable address) and every
     other type are deleted **without** folding. Account-wide events (hand-made digests,
     promotions: `sendId` null) were never counted per send and are simply deleted.
2. **`DigestSend.html` / `text`** of runs whose IST date is older than
   `DIGEST_HTML_RETENTION_DAYS` (30) are nulled and `htmlPurgedAt` is stamped. The preview
   answers 410 "No longer stored: a digest email is kept for 30 days. Its stories, ads and
   counts are kept."; the Digests screen shows the same words. Subject, preheader, size,
   `DigestItem` and `DigestAdPlacement` stay.

**Never touched:** `EmailSuppression` (an opt-out outlives every window; only the owner's
re-subscribe rule, built with the CMS Feed 1 task, removes a row), `DigestRun`,
`DigestItem` (90-day dedupe and roll-forward), placements, templates, ads.

## Configuration

| Variable | Default | |
|---|---|---|
| `DIGEST_RETENTION_ENABLED` | `false` | Deletes rows, so it is switched on deliberately. Off: boot logs `[digest-retention] disabled (set DIGEST_RETENTION_ENABLED=true to enable)`. |
| `DIGEST_RETENTION_CRON` | `45 3 * * *` | 03:45 IST: after the audit sweep (03:00) and event/feed retention (03:30); clear of the reconciler (:00/:20/:40) and the backup (02:20). |
| `EMAIL_EVENT_RETENTION_DAYS` | `90` | |
| `DIGEST_HTML_RETENTION_DAYS` | `30` | |
| `DIGEST_RETENTION_BATCH` | `1000` | Rows per transaction. |
| `DIGEST_RETENTION_MAX_BATCHES` | `50` | Per night; 0 = until clear. ~50 events/day, so this never binds. |

One log line per run: `[digest-retention] deleted unsubscribe=… folded=… proof_stamped=… html_nulled=… batches=… ms=…`.

## Running it by hand

```
npm run digest-retention                                   # DRY RUN: counts only
npm run digest-retention -- --yes                          # apply
npm run digest-retention -- --yes --events 90 --html 30 --batches 0
```

It prints the target database (credentials masked) first.

## Tests (`src/__tests__/digestRetention.test.ts`)

- `digestSendStats()` before and after the fold `toEqual` — with proof by `mcCampaignId`
  only, proof by `sendId`, a live proof kept, a send with feedback but no proof ("—" on
  both sides), multiple batches, a second run, and the live half ageing out later.
- NO_ADDRESS and account-wide rows are deleted, not folded; `EmailSuppression` count unchanged.
- Dry run writes nothing.
- html nulled only before the window; stories kept; preview 410 "No longer stored".

## Backups

`EmailSuppression`, `DigestTemplate`, `DigestAdImage` (bytes), `DigestAd`, `DigestRun`,
`DigestSend` (with `rolled*` and `webhookProofAt`), `DigestItem`, `DigestAdPlacement` and
`EmailEvent` are in the off-platform export since 2026-10-23 (format v2); see
[`BACKUPS.md`](BACKUPS.md).

## Not built

No run row: like the push event sweeper, a failed night shows only in the log
(`[digest-retention] tick failed`). With ~50 events a day a missed night costs nothing; if
that changes, give it a `…Run` row and a banner like `BackupRun`.
