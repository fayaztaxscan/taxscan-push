# REPORT: 2026-10-30-real-client-ip

- **Code commit:** b7e684d — branch `build/real-client-ip` (base `origin/develop` dc7bb4a)

## Files changed
- `src/lib/clientIp.ts` — `clientIpFrom(xff, cfConnectingIp)` (PR #86's rule, body unchanged), `cmsClientIp = clientIpFrom`, new `requestClientIp(req)`: headers first; with NO XFF the socket address, canonicalised, outside production; null in production. XFF present but unparseable → null (never the socket).
- `src/lib/rateLimit.ts` — `clientKey(req)` as `keyGenerator` on both limiters: IPv4 as is, IPv6 via `ipKeyGenerator` (/56), null → shared `'unknown'` bucket. `validate: { xForwardedForHeader: false }` (see below).
- `src/routes/{api,auth,users,digest,digestAds,digestTemplates,staffPush}.ts` — every `req.ip ?? null` → `requestClientIp(req)` (auth, users incl. the two `issueInvite` calls, digest ×4, ads ×3, templates, api, staffPush's `ip()`). The CMS fence-detail log still prints `peer=req.ip`.
- `src/__tests__/clientIp.test.ts` (new, 16 tests); `SECURITY.md` §3 paragraph.

## Migrations / flags
None / none.

## Results
- tsc: clean. lint: clean.
- New tests: `Tests: 16 passed, 16 total`.
- Full suite: `Test Suites: 81 passed, 81 total` / `Tests: 1646 passed, 1646 total` (the PR #86 `cmsEvents.test.ts` cases pass unchanged).

## Acceptance tests
1 helper units (two-hop CF incl. 79.127 hop, single-hop CF, direct + forged, IPv6 CF edge, garbage → null; `cmsClientIp` cases unchanged) — PASS · 2 reader A limited at 61 (60 allowed), reader B 200 behind the same Railway hop — PASS · 3 direct caller forging CF-Connecting-IP + left part stays in one bucket, limited at 61 — PASS · 4 login: A blocked after 5, B gets 401 not 429 — PASS · 5 IPv6 same /56 shares, other /56 does not; no `ERR_ERL`/express-rate-limit line logged — PASS · 6 failed login → `LOGIN_FAILED` with CF-Connecting-IP (`198.51.100.77`) — PASS · 7 no XFF: limiter + audit use the socket address (`127.0.0.1`) — PASS · 8 tsc / lint / full suite — PASS.

## Agents run
None.

## Deviations
- **`process.env.NODE_ENV`, not `env.nodeEnv`**, in `requestClientIp`: `env.ts` imports `clientIp.ts` (`canonicalIp`), so importing `env` back would be a circular import. Same value; it is read at call time, which also makes the production branch testable.
- **`validate: { xForwardedForHeader: false }`** added to both limiters. express-rate-limit logs `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` when an XFF header arrives while `trust proxy` is unset (dev/test, and every test that sends production-shaped headers). Reading XFF ourselves is the design; in production `trust proxy 1` is set so the warning would not fire there. Its other validations stay on.

## Worth remembering
- The staff-push test limiter is keyed per user (`staff-test:<id>`), not per IP, so it is unaffected.
- Nothing else in `src` reads `req.ip` now except the CMS fence's diagnostic line.
- Behaviour change to expect after deploy: audit rows (and LOGIN_FAILED in particular) show the person's address; a reader behind a shared NAT still shares a bucket (60/min is per address, as before). Existing rate-limit counters reset on deploy (in-memory).

## Clean-up
```sh
git worktree remove ../taxscan-push-worktrees/real-client-ip
dropdb taxscan_push_build_real-client-ip; dropdb taxscan_push_build_real-client-ip_shadow
git branch -D build/real-client-ip; git push origin --delete build/real-client-ip
```
