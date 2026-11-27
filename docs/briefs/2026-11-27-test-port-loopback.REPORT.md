# Report: test servers listen on 127.0.0.1

- **Brief:** `docs/briefs/2026-11-27-test-port-loopback.md` with Follow-up 1
- **Branch:** `build/test-port-loopback`, base `9d64001` (develop has since gained the Follow-up and BUILD-SESSION edits)
- **Code commit:** `cbf3ec3` `test(setup): test servers bind 127.0.0.1 (brief 2026-11-27-test-port-loopback)`
- **Built:** 27 Nov 2026. All four acceptance tests and Follow-up 1 PASS. Tests only; no release needed.

## What I chose
`setup.ts` wraps `net.Server.prototype.listen`. A TCP listen that names no host (`()`, `(cb)`, `(port, …)`,
`({ port })`) gets a socket bound to `127.0.0.1` and handed to the original `listen`. Calls naming a host, a path or a
handle go through untouched. It covers every `request(app)` with no per-file edit.

**The brief's suggested form does not work.** Adding `host: '127.0.0.1'` makes Node look the host up first, so
`address()` is `null` for a moment; supertest reads it at once and every route test would crash (checked on Node
24.18.0). The socket is therefore bound with `net._createServerHandle`, a **Node internal**, accepted for test code only
(Follow-up 1). If a Node upgrade removes it, `setup.ts` throws before any test; a change in its behaviour shows in the
guard test.

## Files changed (all under `src/__tests__/`)
- `setup.ts`: the rule, with the reason and Node version in a comment.
- `testPortLoopback.test.ts` (new, 13 tests): supertest and each no-host form report `127.0.0.1` at once and serve;
  the callback runs once; a named host is left alone; with a decoy holding a port on `127.0.0.1`, an app asked for it
  gets `EADDRINUSE` instead of listening beside it.
- `cmsNoticesDoor.test.ts`, `audienceQa.test.ts`: the two explicit calls name `127.0.0.1` and **wait for
  `listening`** (needed: with a host named, `address()` is not ready at once).
- `cmsEvents.test.ts`: one expected string, `remote=::ffff:127.0.0.1` → `remote=127.0.0.1` (Follow-up 1).

## Migrations
None.

## Flags / env
None.

## Test results (verbatim)
- `npm run lint`: exit 0. `npx tsc -p tsconfig.json --noEmit`: exit 0 (it excludes the tests; Jest type-checks them).
- **Full suite three times in a row, final code**, one at a time under `nice`, on a freshly created build database; file
  checksums unchanged afterwards:

  | Run (IST) | Result | Load average at start → end (1, 5, 15 min) |
  |---|---|---|
  | 17:54:00–17:55:19 | `Test Suites: 125 passed, 125 total` / `Tests:       3053 passed, 3053 total` | 5.46 4.12 4.34 → 5.15 4.34 4.40 |
  | 17:55:19–17:56:30 | `Test Suites: 125 passed, 125 total` / `Tests:       3053 passed, 3053 total` | 5.15 4.34 4.40 → 4.50 4.32 4.39 |
  | 17:56:30–17:57:44 | `Test Suites: 125 passed, 125 total` / `Tests:       3053 passed, 3053 total` | 4.50 4.32 4.39 → 4.04 4.16 4.32 |

  No "worker failed to exit" or "did not exit" warning in any of the three.

**Earlier runs, for the record.** Three full runs before Follow-up 1 all failed, none with a stray 404:
- each: `cmsEvents` fence-log line (the `remote=` string above) and `adminLoginFeatures` "suite failed to run"
  (`Cannot find module 'vue'`: my build worktree had no `admin/node_modules`; fixed with `cd admin && npm ci`);
- the second also: `digestRetention` "EmailEvent fold" (`Expected: 2`, `Received: 0`).
  Results: 3042/3043, 3041/3043, 3042/3043. A further set was stopped part-way to add the Node version to the comment;
  I then recreated the build database and ran the three above.

## Acceptance tests
1. **PASS.** With `setup.ts` reverted to the base version: `Tests:       11 failed, 2 passed, 13 total` (the two that
   pass name a host); restored, checksum identical.
2. **PASS.** `whatsappAllPushes`, `facebookWorker`, `digestScreen`, `socialPause`, `telegramWorker`,
   `socialComposeSkip`, `cmsNoticesDoor`, `audienceQa`, `api` and the guard test:
   `Test Suites: 10 passed, 10 total` / `Tests:       316 passed, 316 total` (before the comment edit; all are also in
   the three full runs).
3. **PASS.** Table above.
4. **PASS.** `git diff --stat` of the code commit: 5 files, all under `src/__tests__/` (154 insertions, 4 deletions); no
   file outside it. `src/index.ts` untouched.
- **Follow-up 1 PASS:** only the one string changed in `cmsEvents.test.ts`; the comment names the internal and Node
  24.18.0; `digestRetention` reported only.

## Deviations
- The binding method (above) instead of adding `host`.
- The two explicit calls also await `listening`.
- `cmsEvents.test.ts` (Follow-up 1).

## Agents run
None.

## Notes and suggestions
1. **Flaky list (BUILD-SESSION §4, yours to edit).** The cause of the 404 family is removed, but three green runs cannot
   prove it was the cause of every one. Suggestion: take `whatsAppAllPushes`, `facebookWorker`, `digestScreen`,
   `socialPause`, `telegramWorker` and `socialComposeSkip #10` off the list now, so that a 404 there is treated as real.
   Keep `eventRetention`, the `cmsEvents` log line and `cmsNoticesDoor` "30 an hour" (not this cause).
2. `digestRetention` "EmailEvent fold" compares a count of **every** `EmailSuppression` row before and after, so any
   suite writing that table in the other worker can break it. A fix would count only the test's own rows.
3. The local Node is 24.18.0 and the Dockerfile's is 24.22.1. Tests never run in the image, so nothing there changes.
4. A test that fails early while holding a server open can keep Jest running for ever (my own guard test did, with the
   rule reverted, until it closed supertest's server in all paths).

## Clean-up (planning session, after merging)
```sh
git worktree remove ../taxscan-push-worktrees/test-port-loopback
dropdb taxscan_push_build_test-port-loopback; dropdb taxscan_push_build_test-port-loopback_shadow
git branch -D build/test-port-loopback; git push origin --delete build/test-port-loopback
```
