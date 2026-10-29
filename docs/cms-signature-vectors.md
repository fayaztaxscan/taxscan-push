# Push → CMS signature vectors (door L), for the CMS to cross-check

Push side, 24 Oct 2026. Contract **v1.2** (`push-feed-contract-v1.2-artefacts-2026-10-24.md` §2, §8; the GET rule is
unchanged since v1.1). Produced by our signer, `src/lib/cmsSignature.ts → signPushGet()`, and cross-checked with
`printf '%s' "<signed string>" | openssl dgst -sha256 -hmac test-secret`. The values are pinned in
`src/__tests__/cmsSignature.test.ts`, so this file and the code cannot drift apart.

All values are fake. The secret is **`test-secret`**, and the timestamps and nonces are fixed for the example. Real
requests use a new timestamp and a new random nonce every time, including on a retry.

**Our side also reproduces every CMS vector in v1.2 §8:**

- POST `cec94bc3…4bab` (the 345-byte `account.created` body, with `"erasure":false`);
- GET `4f5d3c77…baf1` and `debee9a3…0d38`;
- the two check vectors `4c8a36e7…4999` and `5994b47b…ee68`.

The withdrawn v1.1 POST signature (`58e4dc92…`) does **not** verify against the v1.2 body.

## What we send

```
GET https://api.taxscan.in<path>?<canonical query>
X-Push-Timestamp: <unix seconds>
X-Push-Signature: sha256=<64 lower-case hex>
```

- No body. No other auth header.
- The query on the wire **is** the canonical query: sorted, RFC 3986, upper-case `%XX`, and `+` sent as `%2B`.
- `nonce` is 32 lower-case hex characters, inside the signed query.
- Signed string: `<ts>.GET.<path>.<canonical query>`.

## P1: full pull, first page

- Timestamp `1792818000` (2026-10-24 10:30:00 IST)
- Parameters: `limit=5000`, `nonce=0f1e2d3c4b5a69788796a5b4c3d2e1f0`

```
GET /api/v1/push-feed/subscribers?limit=5000&nonce=0f1e2d3c4b5a69788796a5b4c3d2e1f0 HTTP/1.1
Host: api.taxscan.in
X-Push-Timestamp: 1792818000
X-Push-Signature: sha256=3a78227d07217acd4d4f194e035509b6c9060ce20d3fb347c4bb530b7d97719f
```

Signed string (94 bytes): `1792818000.GET./api/v1/push-feed/subscribers.limit=5000&nonce=0f1e2d3c4b5a69788796a5b4c3d2e1f0`

## P2: full pull, next page (a cursor with `=` padding)

This case tests whether `=` inside a value is encoded as `%3D`. We do not know whether your real cursors end in `=`;
your A.7 example cursor does not.

- Timestamp `1792818012`
- Parameters: `limit=5000`, `cursor=MjAyNy0wMS0xMFQwOTo1MTo0NC4xMjNaLDkwMDAwMg==`,
  `nonce=a1b2c3d4e5f60718293a4b5c6d7e8f90`

```
GET /api/v1/push-feed/subscribers?cursor=MjAyNy0wMS0xMFQwOTo1MTo0NC4xMjNaLDkwMDAwMg%3D%3D&limit=5000&nonce=a1b2c3d4e5f60718293a4b5c6d7e8f90 HTTP/1.1
Host: api.taxscan.in
X-Push-Timestamp: 1792818012
X-Push-Signature: sha256=101047ab993d1bacc2732fec468d5fa958d5fbeea6493270579ec9e63f734a09
```

Signed string (150 bytes):
`1792818012.GET./api/v1/push-feed/subscribers.cursor=MjAyNy0wMS0xMFQwOTo1MTo0NC4xMjNaLDkwMDAwMg%3D%3D&limit=5000&nonce=a1b2c3d4e5f60718293a4b5c6d7e8f90`

## P3: hourly incremental (`updated_since` with `+05:30`)

- Timestamp `1792818600`
- Parameters: `updated_since=2026-10-24T13:20:00+05:30`, `limit=5000`, `nonce=5e4d3c2b1a0f9e8d7c6b5a4938271605`

```
GET /api/v1/push-feed/subscribers?limit=5000&nonce=5e4d3c2b1a0f9e8d7c6b5a4938271605&updated_since=2026-10-24T13%3A20%3A00%2B05%3A30 HTTP/1.1
Host: api.taxscan.in
X-Push-Timestamp: 1792818600
X-Push-Signature: sha256=295862ea1a7185c911d59ea5f7bf7fcc5827b6e69ec4c1ae46902a31977b0db0
```

Signed string (142 bytes):
`1792818600.GET./api/v1/push-feed/subscribers.limit=5000&nonce=5e4d3c2b1a0f9e8d7c6b5a4938271605&updated_since=2026-10-24T13%3A20%3A00%2B05%3A30`

## How we verify your webhooks (door W), for reference

We check, in this order:

1. the IP fence;
2. that both headers are present;
3. `|now − ts| ≤ 300 s`;
4. the HMAC over `<ts>.POST./api/integrations/cms/events.<raw body bytes>`.

Step 4 is checked in constant time against the current secret and the previous one during a rotation. The path is
our constant, never the path the request arrived on. After that comes the `X-CMS-Event-Id` = body `event_id` check
and the replay rule:

- same `event_id` and same timestamp → `401`;
- same `event_id` and a different timestamp → your retry → `2xx`, not applied again.

The timestamp must be plain decimal digits. The signature must be `sha256=` followed by 64 **lower-case** hex
characters. Upper-case hex is refused.
