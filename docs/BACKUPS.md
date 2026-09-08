# Backups and disaster recovery

Two layers, protecting different things. Neither substitutes for the other.

## What is actually irreplaceable

The database is ~1.4 GB, but almost none of that matters:

| Table | Size | Replaceable? |
|---|---|---|
| `Event` | 1,208 MB (86%) | Yes — delivery history. Losing it costs reporting depth, nothing operational. |
| `ArticleReadStat`, `ArticleSurfaceStat` | 170 MB | Yes — mirrors of GA and Search Console; both syncs backfill. |
| `Campaign`, `FeedItem` | ~4 MB | Mostly — but `FeedItem` is the GUID dedupe ledger (see below). |
| **`Subscriber`** | **10 MB, ~2,954 active** | **No. Never.** |

A web-push subscription is created by the browser and bound to our VAPID key.
We cannot recreate one from our side — the same reason iZooto's ~3M base could
never be migrated onto this platform. Lose the subscriber rows and every
subscriber must opt in again from zero.

`FeedItem` is worth keeping for a non-obvious reason: it is the GUID dedupe
ledger. Restore without it and the poller treats every article currently in the
feeds as new, re-pushing stories subscribers already received.

## ⚠️ The VAPID keypair is half of every restore

`VAPID_PRIVATE_KEY` is 43 characters and lives in Railway's variables and in
`.env`. **It is deliberately not in any backup file**, because a backup that
carries its own key is one leak away from being useless anyway.

A perfect subscriber dump plus a lost private key is 2,954 rows you can never
send to. Keep the keypair in a password manager. Never run `npm run gen:vapid`
for this project: deploying a new keypair orphans every existing subscriber
instantly and irreversibly.

Verify a copy is the right one:

```
pbpaste | tr -d '\n' | shasum -a 256 | cut -c1-12
```

## Layer 1 — Railway volume backups (a rollback, not a backup)

Enabled 2026-09-08 on the Postgres volume: **daily (6 days), weekly (27 days),
monthly (89 days)**, plus a permanent manual snapshot `Manual baseline
2026-09-08`. Cost is about two cents a month, because they are copy-on-write
and bill only on blocks exclusive to the snapshot.

**Know the limits — they are structural, not incidental:**

- *"Wiping a volume deletes all backups."* They share the lifecycle of the very
  thing they protect.
- *"Restores only work within the same project and environment."* They are not
  portable and can never leave Railway.
- They are copy-on-write. A fresh snapshot here reported `usedMB: 2` while
  referencing 1,803 MB — it is pointers into the live volume plus deltas, not a
  second copy of the data.

So layer 1 covers a bad migration, an accidental delete, corruption — restored
in minutes. It covers **none** of: volume wipe, account suspension for
non-payment (which happened on 2026-09-01 and lasted 2.5 days, with the data
healthy and completely unreachable), account termination, or moving hosts.

Manage it via the Railway GraphQL API. Note it takes the **volumeInstance** id,
not the volume id — the volume id answers "Not Authorized", which looks like a
permissions problem and is not:

```
volumeInstanceBackupScheduleList(volumeInstanceId: "306ce3d5-431a-437b-88bf-39b752c41dbd")
volumeInstanceBackupScheduleUpdate(volumeInstanceId: "...", kinds: [DAILY, WEEKLY, MONTHLY])
```

`ScheduleUpdate` **replaces** the whole set — always resend every kind you want
to keep.

## Layer 2 — off-platform export to Cloudflare R2

`src/services/backup.ts`, weekly cron, flag-gated. Writes gzipped NDJSON of
`Subscriber`, `User`, `ReportRecipient`, `Campaign`, `FeedItem` (~3 MB) to an
S3-compatible bucket. Free at this size: R2 gives 10 GB and charges nothing for
egress, so this layer cannot be switched off by a failed payment.

The uploader (`src/lib/r2.ts`) signs SigV4 by hand with `node:crypto` — no new
dependency, following the same call the GA sync made, because a
`package-lock.json` change invalidates the Nixpacks build cache.

### Configuration

| Variable | Notes |
|---|---|
| `BACKUP_ENABLED` | `true` to start the cron. Default off. |
| `BACKUP_CRON` | Default `20 2 * * 0` — Sunday 02:20 IST. |
| `R2_BUCKET` | Bucket name. |
| `R2_ACCOUNT_ID` | Cloudflare account id; the endpoint is derived from it. |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | From an R2 API token, **Object Read & Write**, scoped to this bucket. |
| `BACKUP_PREFIX` | Key prefix, default `taxscan-push`. |
| `BACKUP_KEEP_DAYS` | Prune older objects after a successful upload. Default 180. |

Keep the bucket **private** — no `r2.dev` public domain. Push endpoints are
delivery keys for real people.

### Running it by hand

```
npm run backup:now                          # export + upload
npm run backup:now -- --out backup.gz       # local file, no R2 credentials needed
```

The local mode is the escape hatch: with `DATABASE_PUBLIC_URL` you can take a
copy from a laptop before any cloud plumbing exists.

## Restoring

```
npm run restore:backup -- --file backup.ndjson.gz                  # dry run
npm run restore:backup -- --file backup.ndjson.gz --yes            # apply
npm run restore:backup -- --file backup.ndjson.gz --only Subscriber --yes
```

It prints the target database and refuses to write without `--yes`, because the
realistic way to cause harm is running it against the wrong database while
panicking. Every row is upserted on its natural key (`Subscriber.endpoint`,
`User.email`, `FeedItem.guid`), so re-running is safe and a partial restore can
simply be repeated.

The format is one JSON object per line behind a header line. It restores with
this script, with `psql`, or by hand — a backup you can only read with the
software that just failed is not a backup.

### Full recovery from nothing

1. The VAPID keypair from the password manager.
2. The newest object from the R2 bucket.
3. Any Postgres. `prisma migrate deploy`, then `restore:backup --yes`.
4. Deploy the app from Git with the original `VAPID_PUBLIC_KEY` and
   `VAPID_PRIVATE_KEY`. Anything else (`ADMIN_TOKEN`, GA and ElasticEmail keys)
   can be reissued.
5. Confirm `GET /api/config` returns the **original** public key. If it does
   not, restored subscribers are inert and will fail silently at send time.

## Rehearsals

An unrehearsed restore is a hypothesis. Drill run 2026-09-08 against the local
dev database: seeded 3 subscribers, exported, deleted them, restored from the
file, confirmed `endpoint`, `p256dh`, `auth`, `topics` and `status` came back
identical. Repeat after any change to the export format.

## Failure visibility

Every scheduled run writes a `BackupRun` row and `GET /api/backup-status`
serves the newest one; the Dashboard warns when the last run failed or is
overdue. This exists because a silent weekly job is a job nobody notices has
stopped — exactly how two report emails failed unnoticed for a week in
August 2026.
