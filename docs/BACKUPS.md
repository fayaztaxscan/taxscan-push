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

**Email digest (added 2026-10-23, backup format v2).** The export also carries:

| Table | Why |
|---|---|
| **`EmailSuppression`** | Who must not be mailed. An opt-out cannot be re-derived; restoring without it would re-mail people who unsubscribed, bounced or complained. Holds addresses. |
| `DigestTemplate`, `DigestAd`, `DigestAdImage` | Creative work. Image bytes are included as `{"$base64": …}` (each ≤ 150 KB, so a few MB for a few dozen ads), so a restored system can still draw every ad. |
| `DigestRun`, `DigestSend`, `DigestItem`, `DigestAdPlacement` | The run ledger: history, the Mailercloud campaign id of every past variant, and the frozen html (≤ 30 days). `DigestItem` is the 90-day dedupe: without it yesterday's stories come back. Placements drive ad rotation and the per-ad report. **The ledger does NOT stop a same-day second digest** — see "What stops a second digest after a restore" below. |
| `EmailEvent` | The live half of the digest counts and the webhook proof (hashes only, ≤ 90 days). |

Restore order is the export order (foreign keys): `DigestAdImage` → `DigestAd`, and
`DigestRun` → `DigestSend` → `DigestItem` / `DigestAdPlacement`.

### What stops a second digest after a restore

The backup runs at **02:20 IST** and the digest is built at **06:30** and sent at
**07:30**. So the newest backup never contains today's run: a database restored
mid-day has no record that this morning's digest went out, and the scheduler
simply makes a fresh run for today. The restored ledger cannot help with that.

What does stop it (since 2026-10-23) is **Mailercloud itself**:

1. Campaign names are fixed per day and audience: `TS-DIGEST-2026-10-23-FREE`,
   `TS-DIGEST-2026-10-23-PREMIUM` (another portal than taxscan adds its name:
   `TS-DIGEST-academy-2026-10-23-FREE`). A fresh run computes exactly the names
   the lost run used.
2. Before creating a campaign for the first time, the runner always looks that name
   up in Mailercloud (`findCampaignByName`; one list call per audience per day). If
   it exists, the runner **adopts** it instead of creating a second one, and
   Mailercloud's status decides what happens: sent, sending or scheduled → recorded
   as such, **never scheduled again**; failed → final for the day; a draft →
   scheduled at the normal time after one more status check. An adopted campaign
   that was already sent or scheduled raises an "already in Mailercloud" alert.
3. If the lookup fails, nothing is created; it is retried on the usual schedule.

Two limits remain, which is why the runbook step below exists: (a) whether
Mailercloud's list search finds drafts and sent campaigns by exact name is not yet verified (design §12, open
question 3), and (b) someone may have duplicated or renamed the campaign by hand in
Mailercloud, which no lookup can see (two campaigns with exactly today's name make the lookup inconclusive: nothing is created or adopted, and the version is skipped at 17:00 unless someone deletes the copy). Older rows named `TS-DIGEST-<date>-<AUDIENCE>-<runId>`
keep working: the webhook links by the stored name.

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

`src/services/backup.ts`, daily cron, flag-gated. Writes gzipped NDJSON of
`Subscriber` (live rows only), `User`, `ReportRecipient`, `Campaign` and
`FeedItem` — about 1 MB — to an S3-compatible bucket.

**EXPIRED subscribers are excluded**, and that is safe rather than merely
smaller. A row expires when the push service answers 404/410, which means the
endpoint has been *permanently* retired and can never be presented again, so
the row can never be revived. (The other path, `/api/unsubscribe`, has fired
once in the platform's history.) Even then nothing is lost: `/api/subscribe`
upserts on endpoint, so a returning endpoint with no row simply creates a fresh
`ACTIVE` one — the same outcome. Excluding them drops ~72% of the rows and stops
us storing thousands of dead push endpoints, which are personal data with no
remaining purpose. The header line in each file records the exclusion.

**Staff notification devices (`StaffPushSubscription`, digest task 14) are not
backed up either**: a handful of rows, useless without the VAPID key, and each
approver re-subscribes with one tap (Digests → *Notify me on this device*).
After a restore, ask the approvers to do that once. Free at this size: R2 gives 10 GB and charges nothing for
egress, so this layer cannot be switched off by a failed payment.

The uploader (`src/lib/r2.ts`) signs SigV4 by hand with `node:crypto` — no new
dependency, following the same call the GA sync made, because a
`package-lock.json` change invalidates the Nixpacks build cache.

### Configuration

| Variable | Notes |
|---|---|
| `BACKUP_ENABLED` | `true` to start the cron. Default off. |
| `BACKUP_CRON` | Default `20 2 * * *` — daily 02:20 IST. |
| `R2_BUCKET` | Bucket name. |
| `R2_ACCOUNT_ID` | Cloudflare account id; the endpoint is derived from it. |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | From an R2 API token, **Object Read & Write**, scoped to this bucket. |
| `BACKUP_PREFIX` | Key prefix, default `taxscan-push`. |
| `BACKUP_KEEP_DAYS` | Prune older objects after a successful upload. Default 180; **set to 14 in production**. |

Keep the bucket **private** — no `r2.dev` public domain. Push endpoints are
delivery keys for real people.

### Getting a backup back out

```
npm run backup:fetch                      # newest object, saved under its own name
npm run backup:fetch -- --list            # what is in the bucket
npm run backup:fetch -- --key <key>       # a specific one
```

Keys are ISO-timestamped, so lexical order is chronological and "newest" is the
last one. This exists so recovery never depends on the Cloudflare dashboard
being reachable, or on anyone reconstructing an `aws-cli` command under
pressure. Locally, `railway run --service taxscan-push npm run backup:fetch`
supplies the credentials without copying them anywhere.

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
`User.email`, `FeedItem.guid`, `EmailSuppression.email`, `EmailEvent.dedupeKey`;
the id elsewhere), so re-running is safe and a partial restore can simply be
repeated. A row that fails is reported by table, Prisma error name and code only
(never its values, which can hold an address). An `EmailSuppression` row that already
exists is never weakened by an older backup: the higher-ranked reason (MANUAL is never
rewritten), the earliest `firstSeenAt` and the latest `lastSeenAt` are kept
(`mergeSuppressionForRestore` in `src/services/digest/webhook.ts`).

**Templates: one known skip.** The database allows one ACTIVE template per
audience. Restoring onto a database that already has a *different* ACTIVE
template for that audience fails that `DigestTemplate` row on the
`one_active_template_per_audience` index; it is reported as skipped (table and
error code only) and the existing ACTIVE template stays. Into an empty database
this cannot happen. If you need the backed-up one, archive the current ACTIVE
template on the Templates screen and run the restore again with
`--only DigestTemplate`.

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

### After ANY restore: the email digest stays off until Mailercloud is checked

Applies to a full rebuild and to a partial restore alike.

1. Before the app starts against the restored database, set **`DIGEST_ENABLED=false`**
   and **`DIGEST_SEND_LIVE=false`** in Railway (keep `DIGEST_WEBHOOKS_ENABLED` as it
   was: webhooks only record opt-outs and never send).
2. In Mailercloud → Campaigns, search `TS-DIGEST-` and look for **today's** date
   (or, read-only, `npm run digest:lookup -- --date <today>` in the service).
   Note whether each of `…-FREE` and `…-PREMIUM` exists and its status (Draft,
   Scheduled, Sending, Finished). Make sure there is at most one of each.
   **Delete today's draft in Mailercloud before switching sending back on**: a draft
   may hold content from before the restore. Leave a scheduled, sending or finished
   campaign alone.
3. Only then switch `DIGEST_ENABLED` back on, and `DIGEST_SEND_LIVE` if it was on.
   The runner adopts what you saw in step 2 and never sends a second copy. Admin →
   Digests should show today's variants as sent/scheduled within a minute; an
   "already in Mailercloud" alert for them is expected. A draft left in place is
   adopted but **held for an Approve of that version, even with auto-send on** (owner
   decision, 23 Oct 2026), because nothing can confirm its content matches today's
   frozen email; deleting it instead lets a fresh draft be made at the next check.
   (Narrowed the same day: the hold applies when THIS database never tried to create
   the version — always true after a restore, which has no create marker for today.
   A draft found after our own create's reply was lost is ours and carries on.)
4. If step 2 shows a campaign renamed or duplicated by hand, leave `DIGEST_SEND_LIVE`
   off for the rest of the day.

### Retention in production

`BACKUP_KEEP_DAYS=14` with a daily cadence — about 14 recovery points, ~44 MB
total, comfortably inside R2's 10 GB free tier. Retention here is not about
storing history: the newest copy is the one you would ever restore. It buys
**detection time** — the window in which a silent corruption can still be found
in an uncorrupted copy. Fourteen days assumes damage would be noticed inside a
fortnight.

Pruning runs only after a **successful** upload, so a broken export can never
delete the good copies before it, and objects whose key carries no date in our
format are never touched.

## Rehearsals

An unrehearsed restore is a hypothesis. Repeat both after any change to the
export format.

**Drill 1 — round trip (2026-09-08).** Seeded 3 subscribers in dev, exported,
deleted them, restored from the file: `endpoint`, `p256dh`, `auth`, `topics`
and `status` all came back identical.

**Drill 2 — full rebuild from nothing (2026-09-08).** The real thing, end to
end, on a scratch database with no schema:

1. `createdb` → 0 tables.
2. `prisma migrate deploy` → 15 tables.
3. `npm run backup:fetch` — downloaded the **actual production object** from R2
   (`2026-09-08T07-25-00Z.ndjson.gz`, 3,154,171 bytes).
4. `npm run restore:backup --yes` → Subscriber 10,430 · Campaign 2,995 ·
   FeedItem 2,355 · User 7 · ReportRecipient 1.
5. Booted `node dist/index.js` against it with every dispatcher explicitly off.
6. `/healthz` 200; `/api/metrics` reported **2,954 active subscribers** and the
   campaign history; **`/api/config` returned the ORIGINAL VAPID public key**
   (fingerprint `195c52144fda`, matching production) — the check that decides
   whether restored subscribers are pushable at all.

Production held 10,434 rows at that moment against 10,430 restored: the 4-row
gap is drift since the snapshot, which is the recovery point behaving exactly
as designed.

The scratch database and the downloaded file were destroyed afterwards — both
held real subscriber endpoints.

**Drill 3 — digest tables, full rebuild into an empty database (2026-10-23,
local only, no R2).** After format v2:

1. Seeded the LOCAL dev database (`taxscan_push_dev`) with rehearsal rows on top of
   the sample digest data: 4 `EmailSuppression` (UNSUBSCRIBE, HARD_BOUNCE, SPAM,
   MANUAL; `@rehearsal.example.invalid`), 1 template, 1 ad on an existing image, 1
   placement, `EmailEvent` rows with and without `meta` (a null Json column).
2. `npm run backup:now -- --out <scratch>/local-backup.ndjson.gz` → 80 rows, 9,526 bytes.
3. `createdb taxscan_push_restore_test` (empty) → `prisma migrate deploy` → all migrations.
4. `restore:backup --yes` → 0 skipped: EmailSuppression 4 · DigestTemplate 1 ·
   DigestAdImage 2 · DigestAd 1 · DigestRun 6 · DigestSend 12 · DigestItem 39 ·
   DigestAdPlacement 1 · EmailEvent 4 (plus Subscriber 2, User 2, Campaign 2, EventRollup 4).
5. Compared every restored table with the source: same count AND the same md5 over
   `row_to_json` of every row in id order — **identical for all 13 tables**, including
   image bytes, Json columns and timestamps. A second `restore --yes` changed nothing
   (idempotent).
6. Dropped the scratch database, deleted the file and the rehearsal rows.

**Not yet rehearsed:** an actual push send from a rebuilt deployment, because
that would deliver real notifications to real people.

## Failure visibility

Every scheduled run writes a `BackupRun` row and `GET /api/backup-status`
serves the newest one; the Dashboard warns when the last run failed or is
overdue. This exists because a silent scheduled job is a job nobody notices has
stopped — exactly how two report emails failed unnoticed for a week in
August 2026.
