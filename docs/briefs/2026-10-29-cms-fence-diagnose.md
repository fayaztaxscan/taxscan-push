# Brief: Diagnose (and, if clear-cut, fix) the CMS webhook IP fence refusing the CMS

- **Date / name:** 2026-10-29-cms-fence-diagnose → branch `build/cms-fence-diagnose`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first)

## The incident (29 Oct, 13:28:01Z)
The CMS's first real webhook (`evt_01M63XFAWNANZ9ZA7F9J06M3C6`) got **401**. Our log: `[audience] webhook refused
(step=fence)`.
- Railway's HTTP log for that request: `srcIp: 148.113.0.114` (the CMS's real egress), `host: push.taxscan.in`,
  `edgeRegion: asia-southeast1`, `downstreamProto: HTTP/2.0`, upstream to the app over an internal IPv6 address.
- `CMS_FEED_ALLOWED_IPS=148.113.0.114` is set and loaded (the route passed the `off` step).

So the address our code derives (`cmsClientIp(req.ip, cf-connecting-ip)` in `src/lib/clientIp.ts`, with `trust proxy 1`
in `src/app.ts`) is **not** `148.113.0.114`. Likely candidates:
- Railway's edge now adds a hop, so `req.ip` (the last X-Forwarded-For entry) is a Railway or internal address that
  isn't Cloudflare. Then `CF-Connecting-IP` is ignored and that address is returned.
- An IPv4-mapped / IPv6 form.
- A Cloudflare range missing from `src/lib/cloudflareIps.ts`.

Note: Railway's log shows the real client IP even for requests through Cloudflare, so Railway reads the forwarding
headers itself.

## Goal
1. **Log, on a fence refusal only,** exactly what the fence saw, so one retry from the CMS shows the cause:
   `[audience] fence detail peer=<req.ip> peerIsCloudflare=<bool> cfConnectingIp=<value|none> xff=<raw X-Forwarded-For>
   xRealIp=<value|none> remote=<req.socket.remoteAddress>`. These are server or network addresses, not reader
   data. Cap it at 20 lines an hour.
2. **If** the cause is clear-cut from the code plus Railway's documented header behaviour (e.g. Railway sets
   `X-Real-IP` / appends a known proxy hop), propose the minimal correct fix **in the REPORT**. Implement it only if it
   keeps the security property: **a client that connects to the Railway origin directly must not be able to choose
   its own fence address by sending headers.** If you can't be sure without the production log line, ship only the
   logging; planning will brief the fix once the line is seen.

## Scope
**In:** `src/routes/cmsEvents.ts` (the refusal path), `src/lib/clientIp.ts` (only if the fix is implemented), and
tests: the log line appears on a fence refusal with the fields, never on success; rate cap. If the fix is
implemented: tests for the real chain (`Cloudflare → Railway edge → app`) and for a forged header from a non-Cloudflare
peer still being refused.
**Out:** the signature, skew, nonce and seq steps; any other route's IP handling; `trust proxy` for the whole app
(unless that is the clear-cut fix; explain why).

## Acceptance tests
1. Unit: a fence refusal logs exactly one detail line with the six fields; success logs none; more than 20 an hour are
   suppressed.
2. If the fix is shipped: a request whose chain matches production passes for `148.113.0.114`; a direct-origin request
   with a forged `CF-Connecting-IP`/`X-Real-IP` is still refused.
3. tsc, lint (0 errors), the full suite: green.

## Constraints
Urgent but small: one commit. No flag, no migration, no env. The CMS retries automatically with backoff, so after
deploy the next retry produces the log line.

## Deadline and a hint (CMS, 29 Oct)
- The CMS retries `evt_01M63XFAWNANZ9ZA7F9J06M3C6` at +1/+5/+30 min, then hourly, and marks it **dead at
  2026-10-30T13:28Z** (18:58 IST). The fix must be live before then, or planning asks them to re-queue it.
- CMS suggestion: "derive the client from CF-Connecting-IP only when the immediate peer is a Cloudflare address,
  rather than counting X-Forwarded-For hops (Railway's hop count can change)." That's our intended rule already.
  The open question is *which* X-Forwarded-For entry is Cloudflare's address once Railway's edge adds its own
  hop(s). A robust option: walk X-Forwarded-For from the right, skipping Railway's own and internal addresses, and
  take the first non-Railway entry as "the immediate peer". Only if it's Cloudflare, trust CF-Connecting-IP. Use the
  detail log to confirm the shape before relying on it.
