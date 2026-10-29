# REPORT: cms-fence-diagnose

- Branch `build/cms-fence-diagnose` (base `origin/develop` @ b57db3a); code commit `26b91d69632beba94c41fe5f35c7917bf7d7f3b4`. **Logging only; no fix shipped** (reason below).

## What changed
- `src/routes/cmsEvents.ts`: on a **fence** refusal only (`step=fence`), one extra line before the existing `webhook refused (step=fence)`:
  `[audience] fence detail peer=<req.ip> peerIsCloudflare=<bool> cfConnectingIp=<v|none> xff=<raw X-Forwarded-For|none> xRealIp=<v|none> remote=<req.socket.remoteAddress>`
  Values are printable ASCII only (control characters → `?`, so a header can't forge a log line) and cut at 200 chars. At most **20 lines per hour per router** (sliding window; the rest are dropped). No body, secret or signature; success and every other refusal step log nothing extra.
- `src/__tests__/cmsEvents.test.ts`: 5 new tests (six fields exact; `none`/Cloudflare-peer/flattening; none on success; none on signature/off refusals; cap of 20 then the window reopens).
- No flag, migration, env, or change to `clientIp.ts`.

## Results
- tsc 0; lint 0 errors; `cmsEvents.test.ts` 43 passed; full suite (`--maxWorkers=1`): Test Suites: 78 passed, 78 total / Tests: 1588 passed, 1588 total.

## Acceptance
1. PASS (one line with six fields on refusal; none on success; 25 refusals → 20 lines, then the window reopens an hour later).
2. NOT APPLICABLE: no fix shipped.
3. PASS.

## Why no fix yet / proposal
From the code alone: `req.ip` under `trust proxy 1` is the **last** `X-Forwarded-For` entry. `cmsClientIp` trusts `CF-Connecting-IP` only if that address is Cloudflare. Railway's log shows `srcIp: 148.113.0.114` (the CMS) and an internal IPv6 upstream, so the likely shapes are:
- (a) Railway's edge now appends its own hop, so the last XFF entry is a Railway/internal address (not Cloudflare), and `CF-Connecting-IP` is ignored → we derive a Railway address; or
- (b) the CMS doesn't pass through Cloudflare at all and Railway puts the real IP elsewhere (`X-Real-IP`), with XFF holding something else.
I can't tell which without the line, and the security property (a direct-to-origin client must not choose its fence address) depends on knowing which entries Railway itself writes. Proposal once the line is seen: compute the "immediate peer" by walking XFF **from the right**, skipping addresses that are private/loopback/link-local/unique-local (Railway internal), and take the first remaining entry; trust `CF-Connecting-IP` only if that entry is Cloudflare, else use it as the client. This keeps the property only if Railway always writes the right-hand entries itself (a direct client's forged XFF entries sit to the LEFT of Railway's), so the walk must stop at the first non-internal entry and never read further left. Planning should confirm that with the line.
- The next CMS retry after deploy produces the line (retries at +1/+5/+30 min then hourly; dead at 2026-10-30T13:28Z).

## Notes
- Agents: none. If the logs also show `remote` is an IPv6-mapped internal address, that matches Railway's "internal IPv6 upstream".

## Clean-up
```sh
git worktree remove ../taxscan-push-worktrees/cms-fence-diagnose
dropdb taxscan_push_build_cms-fence-diagnose; dropdb taxscan_push_build_cms-fence-diagnose_shadow
git branch -D build/cms-fence-diagnose; git push origin --delete build/cms-fence-diagnose
```
