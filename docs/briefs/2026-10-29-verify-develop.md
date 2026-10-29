# Brief: Verify the merged develop (no code changes)

- **Date / name:** 2026-10-29-verify-develop → branch `build/verify-develop`, base `origin/develop` at `d92063e` or later
- **Standing rules:** `docs/briefs/BUILD-SESSION.md`

## Goal
`develop` now combines the importer (tasks 5–6), the digest look-alike and Activity-admin-only. Each passed
on its own branch, but the combination has never had a full run. Prove it's green before production.

## Do
1. Set up the worktree and a fresh build DB as usual, then `npx prisma migrate dev` (applies every migration,
   including `…_audience_writer_columns` and the look-alike's `DigestItem.imageUrl`).
2. `npx tsc -p tsconfig.json --noEmit`, `npm run lint`, `npm run build:admin`.
3. The full suite once, under `nice`, with `--maxWorkers=1` if the machine is loaded. Copy the `Tests:` line
   verbatim. If a suite fails, re-run it alone and report both results.
4. **No code changes.** If something fails because of the combination, stop and describe it. Don't fix it.

## Finish
No code commit. Commit only `docs/briefs/2026-10-29-verify-develop.REPORT.md` (results + clean-up commands),
push `build/verify-develop`, stop.
