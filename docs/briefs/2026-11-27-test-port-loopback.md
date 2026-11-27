# Brief: test servers listen on 127.0.0.1 (end the stray-404 route-test failures)

- **Date / name:** 2026-11-27-test-port-loopback  →  branch `build/test-port-loopback`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first)

## Goal
Every HTTP server the test suite starts listens on `127.0.0.1` explicitly, so a route test's request can never reach
another program that holds the same port on 127.0.0.1. The "404 where 200/400/401/409 expected, passes alone" family
stops failing Release checks.

## Why (owner's words)
> 27 Nov 2026: "yes, write the port fix brief"

Facts (27 Nov, build session `taxscan-push-63`, surfaces-clicked-only REPORT note 1 + Release check of 08c1672):
- Release check runs 1 and 2 on 08c1672 failed only in `whatsAppAllPushes` route tests (404 for 200; a queue GET with no
  rows); the build's own run failed `facebookWorker` (404 for 400) and `digestScreen` (404 for 409). Each passes alone.
  Earlier members of the same family: `socialPause`, `telegramWorker`, `socialComposeSkip #10` (BUILD-SESSION §4).
- Shown on this Mac: `listen(0)` with no host binds `::` and can be handed a port another program already holds on
  `127.0.0.1`; a request to `127.0.0.1:<port>` then reaches the OTHER program (one hit in ~16k tries). Supertest's
  `request(app)` does exactly that: it listens with no host and calls `127.0.0.1`. Other local listeners exist (Claude
  Code sessions, headless Chrome). Not proven that this caused each failure — the fix removes the possibility.
- Test code: 58 files import supertest (~550 `request(<app>)` calls); `cmsNoticesDoor.test.ts:46` and
  `audienceQa.test.ts:300` call `a.listen(0)` with no host; the fake CMS/Mailercloud servers already use `127.0.0.1`.

## Scope
**In:**
1. **One central fix in test setup**, not 58 edited files: in `src/__tests__/setup.ts` (already in `setupFiles`), make a
   test-time server that is asked to listen on a port with **no host** bind `127.0.0.1`. Suggested: wrap
   `net.Server.prototype.listen` for the `(port)` / `(port, cb)` / `({port})` forms without a host → add
   `host: '127.0.0.1'`; leave calls that name a host untouched. Document why in a comment (this brief). If a cleaner
   supported hook exists (e.g. supertest accepting a listening server), you may use it instead, but it must cover every
   `request(app)` without per-file edits — say what you chose.
2. Fix the two explicit `a.listen(0)` calls to pass `'127.0.0.1'` anyway (clear at the call site).
3. **Guard test:** a small test proving the rule — a server started via `request(app)` and via `listen(0)` reports
   address `127.0.0.1`; and a reproduction: with a decoy server holding a port on `127.0.0.1`, an app server asked for that
   same port (no host) does NOT answer as the decoy (or fails to bind) — whatever shows the hole is closed.
4. `docs/briefs/BUILD-SESSION.md` §4: remove the 404 family from the flaky list ONLY in the REPORT's suggestion (the
   planner edits that file) and say how many full runs you did.

**Out (do not build):**
- No application code change (`src/index.ts`/production `listen` untouched — production binds as today).
- No change to the other flaky families (eventRetention, cmsEvents, cmsNoticesDoor "30 an hour", AudienceMember lock).
- No jest worker/parallelism change.

## Acceptance tests
Each one must PASS in the REPORT.
1. Guard test (item 3) passes; with the setup change reverted it fails (say so).
2. The listed suites pass: `whatsAppAllPushes`, `facebookWorker`, `digestScreen`, `socialPause`, `telegramWorker`,
   `socialComposeSkip`, `cmsNoticesDoor`, `audienceQa`, `api`.
3. **Full suite three times in a row** on the final code, all green (owner's machine rule: one run at a time, `nice`).
   Report each result line and the load average.
4. No production file changed (show `git diff --stat` limited to `src/__tests__`, the brief/report and BUILD-SESSION if any).

## Files
- `src/__tests__/setup.ts`, `src/__tests__/cmsNoticesDoor.test.ts`, `src/__tests__/audienceQa.test.ts`
- New `src/__tests__/testPortLoopback.test.ts`

## Constraints
- Flag: none — tests only.
- Migrations: none.
- Full suite: yes, ×3 (acceptance 3) — this is the point of the change.
- Never touch other processes on the Mac.

## Context the builder needs
- Your own REPORT note 1 in `docs/briefs/2026-11-27-surfaces-clicked-only.REPORT.md` and the 08c1672 Release check runs.
- `jest.config.js` (`setupFiles`, `maxWorkers: 2`), `jest.environment.js` (advisory lock — leave it).
