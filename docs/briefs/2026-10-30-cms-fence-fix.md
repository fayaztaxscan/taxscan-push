# Brief: CMS webhook fence — see the Cloudflare hop behind Railway's new edge hop

- **Date / name:** 2026-10-30-cms-fence-fix  →  branch `build/cms-fence-fix`, base `origin/develop`
- **Standing rules:** `docs/briefs/BUILD-SESSION.md` (read first)
- **URGENT:** the CMS stops retrying event `evt_01M63XFAWNANZ9ZA7F9J06M3C6` at **2026-10-30 13:28 UTC**. Keep it small.

## Goal
A Feed 1 webhook from the CMS box (148.113.0.114, already in `CMS_FEED_ALLOWED_IPS`) that comes through
Cloudflare → Railway passes the IP fence, while a direct-to-Railway-origin request with a forged
`CF-Connecting-IP` is still refused.

## Why
PR #85's diagnostic shows every CMS call refused at `step=fence` with (18 lines, 29–30 Oct, all the same shape):
```
peer=152.233.15.121 peerIsCloudflare=false cfConnectingIp=148.113.0.114
xff=172.70.142.102, 152.233.15.121 xRealIp=148.113.0.114 remote=::ffff:100.64.0.8
```
Railway now has TWO layers in front of the app: its edge (sees Cloudflare, appends the Cloudflare IP) and an inner
hop (appends the edge's own address — seen as `152.233.0.0/17` (RIPE) and once `79.127.228.17` (CDN77 HKG), so
it can't be allow-listed by range). Under `trust proxy 1`, `req.ip` is that inner hop, never Cloudflare, so
`cmsClientIp` treats the Railway hop as the client and refuses. The second-from-right XFF entry is always a
Cloudflare edge (172.70/172.71/162.158/162.159/104.22/104.23 — all inside `cloudflareIps.ts`).

## Scope
**In:**
- `src/lib/clientIp.ts`: change the fence's client derivation to read the raw `X-Forwarded-For` positionally:
  - parse XFF into trimmed entries; take `hop1` = last entry, `hop2` = the one before it (may be absent);
  - if `hop1` is Cloudflare → believe `CF-Connecting-IP` (today's single-hop shape, keep working);
  - else if `hop2` is Cloudflare → believe `CF-Connecting-IP` (the new two-hop shape);
  - else → the client is `hop2` if present, otherwise `hop1` (direct to origin: Railway's edge appended the real
    caller as `hop2`; a forged `CF-Connecting-IP` is ignored because no Cloudflare hop was seen);
  - anything unparseable / missing → `null` (fence rejects). Never look further left than `hop2` — entries left of
    it are caller-supplied and forgeable.
  Keep the function pure and documented; a small signature change (e.g. `cmsClientIp(xff, cfConnectingIp)`) is fine.
- `src/routes/cmsEvents.ts`: the gate calls the new derivation; the fence-detail line additionally prints the
  derived `client=` value. Nothing else in the route changes.

**Out (do not build):**
- No change to `app.set('trust proxy', 1)` or to any rate limiter (follow-up, see Context).
- No relaxing of the fence, no "HMAC-only" mode, no new env var, no IP-range list for Railway hops.
- No change to the pull doors (L/V) or anything outbound.

## Acceptance tests
Each one must PASS in the REPORT.
1. Unit: XFF `172.70.142.102, 152.233.15.121` + CF-Connecting-IP `148.113.0.114` → `148.113.0.114`
   (use the real production lines above as fixtures, incl. the `79.127.228.17` one).
2. Unit: single-hop XFF `<cloudflare ip>` + CF-Connecting-IP → the CF-Connecting-IP (old shape still works).
3. Unit: direct to origin — XFF `148.113.0.114, 203.0.113.9, 152.233.15.121` (forged left part), CF-Connecting-IP
   `148.113.0.114` → `203.0.113.9` (refused by the fence).
4. Unit: XFF `203.0.113.9` alone + forged CF-Connecting-IP → `203.0.113.9`.
5. Unit: missing/empty/garbage XFF → `null`; Cloudflare hop seen but CF-Connecting-IP missing → `null`.
6. Route (supertest): a request carrying the production header shape and a valid signature passes the fence and
   reaches ingest; the same with a non-allow-listed CF-Connecting-IP is refused `step=fence`; the
   direct-to-origin forged case is refused.
7. Existing `cmsEvents.test.ts` suite green (update the old `cmsClientIp` unit cases to the new signature).
8. `npx tsc --noEmit` and lint clean.

## Files
- `src/lib/clientIp.ts` — new positional derivation + doc comment describing both header shapes.
- `src/routes/cmsEvents.ts` — gate uses it; `client=` in the fence-detail line; update the header comment step 2.
- Tests: `src/__tests__/cmsEvents.test.ts`.
- `docs/CMS_AUDIENCE_SYNC_DESIGN.md` §5.1/§8.2 — one paragraph on the two-hop shape.

## Constraints
- Flag: none — this is a fix to a fence that is already on (`AUDIENCE_SYNC_ENABLED`), and it only ever narrows
  what is believed to the hops Railway itself appended.
- Migrations: none.
- Must stay fail-closed. Must not log the body, signature or secrets.

## Context the builder needs
- Express `req.ip` with `trust proxy 1` = the last XFF entry; read `req.header('x-forwarded-for')` yourself.
- `isCloudflareIp` / `canonicalIp` already exist in `clientIp.ts` — reuse them (canonicalise every hop).
- The HMAC signature check after the fence is unchanged and remains the main gate.
- Follow-up for planning, NOT this build: with the extra hop every `req.ip`-keyed limiter now keys on a handful of
  Railway edge addresses.
