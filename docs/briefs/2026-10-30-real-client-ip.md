# Brief: rate limits and audit IPs use the real client, not Railway's hop

- **Date / name:** 2026-10-30-real-client-ip  →  branch `build/real-client-ip`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first)

## Goal
Every place that keys or records "who is calling" uses the real client address derived the same way the CMS fence
does (PR #86), so readers stop sharing a rate-limit bucket per Railway hop, and the audit log records the person's
address instead of Railway's.

## Why
PR #86 found Railway now puts two hops in front of the app: XFF ends `<cloudflare edge>, <railway hop>` (hops seen:
152.233.0.0/17, 79.127.228.x). With `trust proxy 1`, `req.ip` = the Railway hop, so:
- `makePublicLimiter` (60/min: `/api/subscribe`, `/unsubscribe`, `/track`, `/config`; also the CMS + Mailercloud
  webhook failure limiters) counts **all of taxscan.in's readers** behind a handful of Railway hop addresses.
  Measured 30 Oct 09:37–09:40Z: ~34 `/track` + ~17 `/config` a minute in total, no 429 yet — the headroom is a
  traffic spike, not a design.
- `makeLoginLimiter` (5/min) counts every editor's login behind the same hops — five typos anywhere block everyone.
- Every `recordAudit(... ipAddress: req.ip)` (auth, users, digest, ads, templates, api, staffPush) records Railway's
  address, so LOGIN_FAILED rows can't tell an attacker from an editor.

## Scope
**In:**
- `src/lib/clientIp.ts`: generalise PR #86's rule into one exported `requestClientIp(req)` (or `clientIpFrom(xff,
  cfConnectingIp)` + a thin req wrapper): last two XFF hops; CF-Connecting-IP believed only when one of them is
  Cloudflare; else `hop2` (or `hop1` when single); canonicalised; `null` when unparseable. `cmsClientIp` becomes a
  call to it (behaviour unchanged — the PR #86 tests must stay green as they are).
- Dev/test (no proxy, no XFF): fall back to `req.socket.remoteAddress` canonicalised, **only when
  `env.nodeEnv !== 'production'`**. In production a missing XFF → `null`. (The CMS fence keeps its own rule: missing
  XFF → refuse, in every environment.)
- `src/lib/rateLimit.ts`: both limiters get a `keyGenerator` using it. IPv6 keys go through express-rate-limit 8's
  `ipKeyGenerator(ip)` (/56 subnet; the library's validation warns otherwise). A `null` client → one shared
  `'unknown'` bucket (fail towards limiting, never towards unlimited). Keep `validate` happy — no warnings at boot.
- Audit: replace `req.ip ?? null` with the helper in every `recordAudit` call site (`grep -rn "req.ip" src` lists
  them: auth, users, digest, digestAds, digestTemplates, api, staffPush). The CMS fence-detail log keeps printing
  `peer=req.ip` (it is diagnostic).

**Out (do not build):**
- No change to `app.set('trust proxy', 1)` (the HTTPS redirect and `req.protocol` rely on it).
- No change to the limits themselves (`RATE_LIMIT_PUBLIC_PER_MIN` 60, `_LOGIN_PER_MIN` 5) or new flags.
- No Cloudflare/WAF rules, no Railway changes, no IP-range list for Railway hops.

## Acceptance tests
Each one must PASS in the REPORT.
1. Helper units with the production fixture shapes from `cmsEvents.test.ts` (two-hop CF, single-hop CF, direct to
   origin with forged left part + forged CF-Connecting-IP, IPv6 CF edge, garbage → null); `cmsClientIp` tests unchanged
   and green.
2. Public limiter: two requests with the same Railway hop but different CF-Connecting-IP (behind a Cloudflare hop2)
   land in **different** buckets — 60 from reader A then 1 from reader B → B gets 200, A's 61st gets 429.
3. Public limiter: a direct-to-origin caller forging different CF-Connecting-IP values on each request stays in
   **one** bucket (its real `hop2`) and is limited at 61.
4. Login limiter: same as 2 for 5/min — editor B is not blocked by editor A's failures.
5. IPv6 clients in the same /56 share a bucket; no express-rate-limit validation warning is logged in tests.
6. A failed login writes `LOGIN_FAILED` with the CF-Connecting-IP address (route test with production headers).
7. Dev/test with no XFF: limiter + audit still work (remote address).
8. `tsc --noEmit`, lint, full suite green (known flaky "metrics warmer" may be re-run alone).

## Files
- `src/lib/clientIp.ts`, `src/lib/rateLimit.ts`
- `src/routes/{auth,users,digest,digestAds,digestTemplates,api,staffPush}.ts` — audit `ipAddress` only.
- Tests: `src/__tests__/clientIp.test.ts` (new), extend the rate-limit / auth tests.
- `SECURITY.md` — one paragraph: how the client address is derived and why `req.ip` is not used.

## Constraints
- Flag: none — it only changes the key of an existing limit and the value recorded in audit rows; fails towards
  limiting.
- Migrations: none.
- Never believe CF-Connecting-IP without a Cloudflare address in the last two hops. Never look left of `hop2`.

## Context the builder needs
- PR #86 (`build/cms-fence-fix`, merged in `f617efa`): `cmsClientIp` + its tests are the reference behaviour.
- express-rate-limit is **8.5.2**: `keyGenerator(req, res)`, `ipKeyGenerator` exported from the package.
- `makePublicLimiter` is also used by `src/routes/cmsEvents.ts` (failure limiter) and `src/routes/webhooks.ts`
  (Mailercloud). Mailercloud's webhooks come through Cloudflare; with the new key they bucket per Mailercloud
  address, which is what the comment at `webhooks.ts:31` wanted.
