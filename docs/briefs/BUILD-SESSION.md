# Build session — standing rules

You are the **build session**. A planning session (talking with the owner) writes one brief per change in
`docs/briefs/<date>-<name>.md`. You build exactly what that brief says, test it, write a REPORT, push your
own branch and stop. This file is edited only by the planning session; if a rule here seems wrong, say so in
your REPORT — do not change it.

## Never
- Never edit the project record: `CLAUDE.md`, `NEXT_STEP.md`, `KNOWN_ISSUES.md`, the memory directory
  (`~/.claude/projects/-Users-bestdoc-Documents-taxscan-push/memory/`), or anything in `docs/briefs/` except
  your own `.REPORT.md`.
- Never commit to, merge into, rebase or push `main` or `develop`. Never open or merge a PR.
- Never touch production: no `railway` command of any kind, no request to `push.taxscan.in` that writes, no
  Mailercloud / ElasticEmail / GA / Search Console / R2 call with a real key.
- Never use the main checkout (`/Users/bestdoc/Documents/taxscan-push`) or its `.env`, `ga-service-account.json`,
  or its databases (`taxscan_push_dev`, `taxscan_push_shadow`). Those belong to the planning session.
- Never `git stash pop/apply/drop`. The stash is shared by every worktree, and `stash@{0}` is the owner's paused
  CMS-importer work. If a brief needs it, the brief will say exactly how.
- Never build more than the brief asks. A useful extra goes in the REPORT as a suggestion, not in the code.

## 1. Set up (once per brief)
`<name>` = the brief's file name without the date and `.md`.

```sh
cd /Users/bestdoc/Documents/taxscan-push
git fetch origin
git worktree add -b build/<name> ../taxscan-push-worktrees/<name> origin/develop
cd ../taxscan-push-worktrees/<name>
createdb taxscan_push_build_<name>
createdb taxscan_push_build_<name>_shadow
```

The base is **`origin/develop`** (integration branch; holds unreleased work), unless the brief names another.
Production is `main`; you never touch it.

Write a **minimal** `.env` in the worktree (it's gitignored). No real provider keys, ever:

```
NODE_ENV=development
DATABASE_URL=postgresql://localhost:5432/taxscan_push_build_<name>
SHADOW_DATABASE_URL=postgresql://localhost:5432/taxscan_push_build_<name>_shadow
ADMIN_TOKEN=test-admin-token
SESSION_COOKIE_SECRET=test-session-cookie-secret-must-be-at-least-32-chars-long
VAPID_SUBJECT=mailto:dev@example.com
SEND_MODE=dry
```

Then add fresh dev VAPID keys (`npm run gen:vapid`, paste the two lines in), and:

```sh
npm ci --no-audit --no-fund
npx prisma generate
npx prisma migrate dev        # applies every migration to the empty build DB
```

(`prisma migrate deploy` is blocked by the auto-mode classifier even locally. Use `migrate dev`, and for a new
migration use `migrate dev --name <x>`.) If the brief touches the admin SPA, also run `cd admin && npm ci`.
There is no Redis in this project.

## 2. Machine (owner's standing rule)
This 4-core / 8 GB Mac is shared with the planning session. **At most two agents/programs run at once, together using no
more than half the machine.** That means:
- Run heavy commands under `nice` (`nice -n 10 npx jest …`). Jest is already capped at `maxWorkers: 2`.
- Run one test run, one dev server and one browser at a time, never two together.
- Use at most one subagent at a time (project roles are in `.claude/agents/`: backend-developer, ui-developer,
  qa-verifier, …). The planning session does not run the full suite, so the build owns the heavy job.

## 3. Build
- Follow the project's conventions in `CLAUDE.md` (read it; don't edit it). Behaviour changes go behind a
  flag that defaults off, unless the brief says otherwise.
- Write tests as you go. Match the surrounding code's style, naming and comment density.
- Docs that ship with the code (the admin guide when a screen changes, a design doc's "Built" note, the
  runbook) are part of the build **only if the brief lists them**.
- **If the brief doesn't match the code** (a file isn't where it says, an assumption is false, the acceptance
  test can't pass as written): stop. Commit nothing half-done. Write the REPORT explaining the mismatch, push it,
  and stop.

## 4. Verify
- `npx tsc -p tsconfig.json --noEmit`, `npm run lint`, then the new tests, then the **full suite once** under `nice`.
  Run `npm run build:admin` only if the SPA changed.
- Every acceptance test in the brief must pass, or be marked FAILED in the REPORT with its output.
- Known flaky test: eventRetention "lifetime totals" under parallel workers. Re-run it alone before calling it
  a failure, and say you did.

## 5. Finish
1. **One code commit** on `build/<name>`, message `<type>(<area>): <what> (brief <date>-<name>)`, ending with
   the attribution line from the session's system reminder.
2. Write `docs/briefs/<date>-<name>.REPORT.md` and commit it as a **second** commit, `report: <name>`:
   - Commit hash of the code commit; branch name.
   - Files changed (one line each, what and why).
   - Migrations added (name + what they do; additive or not).
   - Flags/env added (name, default).
   - Test result lines, copied verbatim: tsc, lint, new tests, full suite (`Tests: N passed, N total`).
   - Each acceptance test → PASS / FAILED (+ output).
   - Agents run (role, what for).
   - Deviations from the brief, and why.
   - Anything worth remembering (traps, surprises, facts about the code). Planning decides what becomes record.
   - Clean-up commands (below).
3. `git push -u origin build/<name>`. Then **stop**, and tell the owner: `REPORT ready: <name>`.

Clean-up (the planning session runs this after merging; you just list it):
```sh
git worktree remove ../taxscan-push-worktrees/<name>
dropdb taxscan_push_build_<name>; dropdb taxscan_push_build_<name>_shadow
git branch -D build/<name>; git push origin --delete build/<name>
```
