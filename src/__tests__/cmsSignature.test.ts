/**
 * CMS audience sync, task 2: src/lib/cmsSignature.ts against the CMS's own A.6 vectors
 * (contract v1.2, fixtures in ./fixtures/cms-feed-v1.2) plus the negative cases.
 */
import {
  CMS_WEBHOOK_PATH,
  buildCanonicalQuery,
  canonicalizeQuery,
  classifyWebhookReplay,
  hmacHex,
  newNonce,
  rfc3986Encode,
  signCmsWebhook,
  signPushGet,
  signatureHeader,
  signedBytes,
  verifyCmsWebhook,
  verifyPushGet,
} from '../lib/cmsSignature';
import {
  CHECK_VECTORS,
  LIST_GET_FULL,
  LIST_GET_INCREMENTAL,
  TEST_SECRET,
  WEBHOOK_POST,
  WITHDRAWN_V11_POST_SIGNATURE,
} from './fixtures/cms-feed-v1.2/vectors';
import { CMS_EVENT_BODIES, CMS_LIST_PAGE_1 } from './fixtures/cms-feed-v1.2/payloads';

const at = (ts: string | number, deltaS = 0) => new Date((Number(ts) + deltaS) * 1000);
const OTHER = 'other-secret-for-rotation-tests-xxxxxxxxxxxxxxxx';

describe('the CMS A.6 vectors (byte for byte)', () => {
  it('§8.1 webhook POST: body 345 bytes, signed string 390 bytes, signature cec94bc3…', () => {
    const body = Buffer.from(WEBHOOK_POST.body, 'utf8');
    expect(body.length).toBe(WEBHOOK_POST.bodyBytes);
    const msg = signedBytes(WEBHOOK_POST.ts, 'POST', WEBHOOK_POST.path, body);
    expect(msg.length).toBe(WEBHOOK_POST.signedStringBytes);
    expect(hmacHex(TEST_SECRET, msg)).toBe(WEBHOOK_POST.signature);
    expect(WEBHOOK_POST.path).toBe(CMS_WEBHOOK_PATH);
  });

  it('§8.1 verifies through verifyCmsWebhook; the withdrawn v1.1 signature does not', () => {
    const base = { secrets: [TEST_SECRET], rawBody: Buffer.from(WEBHOOK_POST.body), timestampHeader: WEBHOOK_POST.ts, now: at(WEBHOOK_POST.ts) };
    expect(verifyCmsWebhook({ ...base, signatureHeader: `sha256=${WEBHOOK_POST.signature}` })).toEqual({
      ok: true,
      ts: Number(WEBHOOK_POST.ts),
      matched: 'current',
    });
    expect(verifyCmsWebhook({ ...base, signatureHeader: `sha256=${WITHDRAWN_V11_POST_SIGNATURE}` })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('§8.1 signCmsWebhook reproduces the CMS headers', () => {
    expect(signCmsWebhook(TEST_SECRET, WEBHOOK_POST.body, at(WEBHOOK_POST.ts))).toEqual({
      'X-CMS-Timestamp': WEBHOOK_POST.ts,
      'X-CMS-Signature': `sha256=${WEBHOOK_POST.signature}`,
    });
  });

  it.each([
    ['§8.2 full pull', LIST_GET_FULL],
    ['§8.3 incremental (percent-encoding)', LIST_GET_INCREMENTAL],
  ])('%s: canonical query, signed string, signature, and our signPushGet', (_n, v) => {
    expect(buildCanonicalQuery(v.params)).toBe(v.canonicalQuery);
    const msg = signedBytes(v.ts, 'GET', v.path, v.canonicalQuery);
    expect(msg.toString('utf8')).toBe(v.signedString);
    expect(msg.length).toBe(v.signedStringBytes);
    expect(hmacHex(TEST_SECRET, msg)).toBe(v.signature);

    const { nonce, ...rest } = v.params;
    const signed = signPushGet({ secret: TEST_SECRET, path: v.path, params: rest, nonce, now: at(v.ts) });
    expect(signed.canonicalQuery).toBe(v.canonicalQuery);
    expect(signed.pathAndQuery).toBe(`${v.path}?${v.canonicalQuery}`);
    expect(signed.headers).toEqual({ 'X-Push-Timestamp': v.ts, 'X-Push-Signature': `sha256=${v.signature}` });
  });

  it.each([
    ['§8.2', LIST_GET_FULL],
    ['§8.3', LIST_GET_INCREMENTAL],
  ])('%s verifies on the CMS side (verifyPushGet) from the wire query', (_n, v) => {
    const r = verifyPushGet({
      secrets: [TEST_SECRET],
      path: v.path,
      rawQuery: v.canonicalQuery,
      timestampHeader: v.ts,
      signatureHeader: `sha256=${v.signature}`,
      now: at(v.ts),
    });
    expect(r.ok).toBe(true);
    expect(r.nonce).toBe(v.params.nonce);
  });

  it.each(CHECK_VECTORS.map((c) => [c.signedString, c.signature]))('§8.4 check vector %s', (s, sig) => {
    expect(hmacHex(TEST_SECRET, s)).toBe(sig);
  });

  it('§8.4 empty-query rule: a GET with no query signs "<ts>.GET.<path>." ', () => {
    expect(canonicalizeQuery('')).toEqual({ ok: true, canonical: '', params: {} });
    expect(signatureHeader(TEST_SECRET, '1799613300', 'GET', '/api/v1/push-feed/subscribers', '')).toBe(`sha256=${CHECK_VECTORS[1].signature}`);
  });

  it('every A.5 fixture body is one line with an erasure key (v1.2)', () => {
    for (const body of Object.values(CMS_EVENT_BODIES)) {
      expect(body).not.toMatch(/\n/);
      expect(typeof JSON.parse(body).erasure).toBe('boolean');
    }
    expect(Object.keys(CMS_EVENT_BODIES)).toHaveLength(10);
    expect(JSON.parse(CMS_LIST_PAGE_1).data).toHaveLength(3);
  });
});

describe('our outbound vectors (docs/cms-signature-vectors.md — keep in step)', () => {
  const P = '/api/v1/push-feed/subscribers';
  it.each([
    ['P1', 1792818000, '0f1e2d3c4b5a69788796a5b4c3d2e1f0', { limit: '5000' }, 'limit=5000&nonce=0f1e2d3c4b5a69788796a5b4c3d2e1f0', 94, '3a78227d07217acd4d4f194e035509b6c9060ce20d3fb347c4bb530b7d97719f'],
    [
      'P2',
      1792818012,
      'a1b2c3d4e5f60718293a4b5c6d7e8f90',
      { limit: '5000', cursor: 'MjAyNy0wMS0xMFQwOTo1MTo0NC4xMjNaLDkwMDAwMg==' },
      'cursor=MjAyNy0wMS0xMFQwOTo1MTo0NC4xMjNaLDkwMDAwMg%3D%3D&limit=5000&nonce=a1b2c3d4e5f60718293a4b5c6d7e8f90',
      150,
      '101047ab993d1bacc2732fec468d5fa958d5fbeea6493270579ec9e63f734a09',
    ],
    [
      'P3',
      1792818600,
      '5e4d3c2b1a0f9e8d7c6b5a4938271605',
      { updated_since: '2026-10-24T13:20:00+05:30', limit: '5000' },
      'limit=5000&nonce=5e4d3c2b1a0f9e8d7c6b5a4938271605&updated_since=2026-10-24T13%3A20%3A00%2B05%3A30',
      142,
      '295862ea1a7185c911d59ea5f7bf7fcc5827b6e69ec4c1ae46902a31977b0db0',
    ],
  ] as const)('%s', (_n, ts, nonce, params, canonical, bytes, hex) => {
    const s = signPushGet({ secret: TEST_SECRET, path: P, params, nonce, now: at(ts) });
    expect(s.canonicalQuery).toBe(canonical);
    expect(signedBytes(s.ts, 'GET', P, s.canonicalQuery).length).toBe(bytes);
    expect(s.headers['X-Push-Signature']).toBe(`sha256=${hex}`);
  });
});

describe('door W verification — negative cases', () => {
  const body = Buffer.from(WEBHOOK_POST.body, 'utf8');
  const sig = `sha256=${WEBHOOK_POST.signature}`;
  const ok = { secrets: [TEST_SECRET], rawBody: body, timestampHeader: WEBHOOK_POST.ts, signatureHeader: sig, now: at(WEBHOOK_POST.ts) };

  it('a body changed by one byte → bad_signature', () => {
    const tampered = Buffer.from(body);
    tampered[tampered.length - 2] ^= 0x01;
    expect(verifyCmsWebhook({ ...ok, rawBody: tampered })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyCmsWebhook({ ...ok, rawBody: Buffer.concat([body, Buffer.from('\n')]) })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('signed for another method or path → bad_signature (the path is our constant)', () => {
    const asGet = signatureHeader(TEST_SECRET, WEBHOOK_POST.ts, 'GET', CMS_WEBHOOK_PATH, body);
    expect(verifyCmsWebhook({ ...ok, signatureHeader: asGet })).toEqual({ ok: false, reason: 'bad_signature' });
    for (const p of ['/api/integrations/cms/events/', '/integrations/cms/events', '/api/integrations/cms/Events']) {
      const other = signatureHeader(TEST_SECRET, WEBHOOK_POST.ts, 'POST', p, body);
      expect(verifyCmsWebhook({ ...ok, signatureHeader: other })).toEqual({ ok: false, reason: 'bad_signature' });
    }
  });

  it('a wrong secret → bad_signature; no usable secret → no_secret', () => {
    expect(verifyCmsWebhook({ ...ok, secrets: [OTHER] })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyCmsWebhook({ ...ok, secrets: [] })).toEqual({ ok: false, reason: 'no_secret' });
    expect(verifyCmsWebhook({ ...ok, secrets: ['', ''] })).toEqual({ ok: false, reason: 'no_secret' });
  });

  it('rotation: the previous secret verifies and says so; current still wins when both match', () => {
    expect(verifyCmsWebhook({ ...ok, secrets: [OTHER, TEST_SECRET] })).toMatchObject({ ok: true, matched: 'previous' });
    expect(verifyCmsWebhook({ ...ok, secrets: [TEST_SECRET, OTHER] })).toMatchObject({ ok: true, matched: 'current' });
    expect(verifyCmsWebhook({ ...ok, secrets: ['', TEST_SECRET] })).toMatchObject({ ok: true, matched: 'previous' });
  });

  it('skew edges: ±300 s accepted, ±301 s refused', () => {
    expect(verifyCmsWebhook({ ...ok, now: at(WEBHOOK_POST.ts, 300) }).ok).toBe(true);
    expect(verifyCmsWebhook({ ...ok, now: at(WEBHOOK_POST.ts, -300) }).ok).toBe(true);
    expect(verifyCmsWebhook({ ...ok, now: at(WEBHOOK_POST.ts, 301) })).toEqual({ ok: false, reason: 'skew' });
    expect(verifyCmsWebhook({ ...ok, now: at(WEBHOOK_POST.ts, -301) })).toEqual({ ok: false, reason: 'skew' });
    // Sub-second: 300.999 s later still floors to 300.
    expect(verifyCmsWebhook({ ...ok, now: new Date((Number(WEBHOOK_POST.ts) + 300) * 1000 + 999) }).ok).toBe(true);
  });

  it('missing or malformed headers', () => {
    expect(verifyCmsWebhook({ ...ok, timestampHeader: undefined })).toEqual({ ok: false, reason: 'missing_headers' });
    expect(verifyCmsWebhook({ ...ok, signatureHeader: '' })).toEqual({ ok: false, reason: 'missing_headers' });
    for (const ts of ['1792640705.0', '+1792640705', ' 1792640705', '1792640705000000000', '-5', 'abc']) {
      expect(verifyCmsWebhook({ ...ok, timestampHeader: ts })).toEqual({ ok: false, reason: 'bad_timestamp' });
    }
    for (const s of [WEBHOOK_POST.signature, `sha256=${WEBHOOK_POST.signature.toUpperCase()}`, `sha1=${WEBHOOK_POST.signature}`, `sha256=${WEBHOOK_POST.signature}0`, 'sha256=']) {
      expect(verifyCmsWebhook({ ...ok, signatureHeader: s })).toEqual({ ok: false, reason: 'bad_signature_format' });
    }
  });

  it('a timestamp header that differs from the signed one → bad_signature', () => {
    expect(verifyCmsWebhook({ ...ok, timestampHeader: String(Number(WEBHOOK_POST.ts) + 1) })).toEqual({ ok: false, reason: 'bad_signature' });
  });
});

describe('door W replay rule', () => {
  it('no receipt → new; same ts → exact_replay; another ts → retry (2xx, not applied)', () => {
    expect(classifyWebhookReplay(null, 1792640705)).toBe('new');
    expect(classifyWebhookReplay(undefined, 1792640705)).toBe('new');
    expect(classifyWebhookReplay(BigInt(1792640705), 1792640705)).toBe('exact_replay');
    expect(classifyWebhookReplay(1792640705, 1792640765)).toBe('retry');
  });
});

describe('canonical query (contract §2.1)', () => {
  it('reordered keys canonicalise identically and verify', () => {
    const v = LIST_GET_INCREMENTAL;
    const reordered = 'updated_since=2027-01-11T02%3A05%3A00%2B05%3A30&nonce=8b04d1e6c3a95f72e1d0b4c7a6f38e25&limit=1000';
    expect(canonicalizeQuery(reordered)).toMatchObject({ ok: true, canonical: v.canonicalQuery });
    const r = verifyPushGet({ secrets: [TEST_SECRET], path: v.path, rawQuery: reordered, timestampHeader: v.ts, signatureHeader: `sha256=${v.signature}`, now: at(v.ts) });
    expect(r.ok).toBe(true);
  });

  it('lower-case %xx and unencoded safe chars normalise to the upper-case canonical form', () => {
    expect(canonicalizeQuery('updated_since=2027-01-11T02%3a05%3a00%2b05%3a30')).toMatchObject({
      canonical: 'updated_since=2027-01-11T02%3A05%3A00%2B05%3A30',
    });
    expect(canonicalizeQuery('a=2027-01-11T02:05:00')).toMatchObject({ canonical: 'a=2027-01-11T02%3A05%3A00' });
  });

  it('a raw "+" is a literal plus (→ %2B), never a space', () => {
    expect(canonicalizeQuery('t=05+05')).toMatchObject({ canonical: 't=05%2B05', params: { t: '05+05' } });
    expect(canonicalizeQuery('t=a%20b')).toMatchObject({ canonical: 't=a%20b', params: { t: 'a b' } });
  });

  it('a raw "+" on the wire does NOT verify a signature made over a space', () => {
    const v = LIST_GET_INCREMENTAL;
    const wire = v.canonicalQuery.replace('%2B', '+'); // still decodes to "+": verifies
    expect(verifyPushGet({ secrets: [TEST_SECRET], path: v.path, rawQuery: wire, timestampHeader: v.ts, signatureHeader: `sha256=${v.signature}`, now: at(v.ts) }).ok).toBe(true);
    const asSpace = v.canonicalQuery.replace('%2B', '%20');
    expect(verifyPushGet({ secrets: [TEST_SECRET], path: v.path, rawQuery: asSpace, timestampHeader: v.ts, signatureHeader: `sha256=${v.signature}`, now: at(v.ts) })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('empty segments dropped; a segment with no "=" has an empty value; splits at the FIRST "="', () => {
    expect(canonicalizeQuery('&&b=2&&a&')).toMatchObject({ canonical: 'a=&b=2' });
    expect(canonicalizeQuery('k=a=b')).toMatchObject({ canonical: 'k=a%3Db', params: { k: 'a=b' } });
  });

  it('duplicate keys are refused, including an encoded duplicate', () => {
    expect(canonicalizeQuery('limit=3&limit=4')).toEqual({ ok: false, reason: 'duplicate_key' });
    expect(canonicalizeQuery('a=1&%61=2')).toEqual({ ok: false, reason: 'duplicate_key' });
    expect(canonicalizeQuery('a&a=')).toEqual({ ok: false, reason: 'duplicate_key' });
  });

  it('bad escapes and invalid UTF-8 are refused', () => {
    expect(canonicalizeQuery('a=%G1')).toEqual({ ok: false, reason: 'bad_encoding' });
    expect(canonicalizeQuery('a=%4')).toEqual({ ok: false, reason: 'bad_encoding' });
    expect(canonicalizeQuery('a=%FF')).toEqual({ ok: false, reason: 'bad_encoding' });
    expect(canonicalizeQuery('a=%C3')).toEqual({ ok: false, reason: 'bad_encoding' });
  });

  it('UTF-8 and RFC 3986 reserved characters encode with upper-case hex; sort is byte-wise on the encoded key', () => {
    expect(canonicalizeQuery('q=%c3%a9')).toMatchObject({ canonical: 'q=%C3%A9', params: { q: 'é' } });
    expect(rfc3986Encode("!'()*~-._ ")).toBe('%21%27%28%29%2A~-._%20');
    expect(buildCanonicalQuery({ b: '1', B: '2', _: '3', a: '4' })).toBe('B=2&_=3&a=4&b=1');
  });
});

describe('door L GET — our signer and the CMS-side checks', () => {
  const now = new Date('2026-10-24T10:00:00Z');
  const path = '/api/v1/push-feed/subscribers';

  it('every request gets a fresh 32-hex nonce inside the signed query', () => {
    const a = signPushGet({ secret: TEST_SECRET, path, params: { limit: '5000' }, now });
    const b = signPushGet({ secret: TEST_SECRET, path, params: { limit: '5000' }, now });
    expect(a.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.canonicalQuery).toContain(`nonce=${a.nonce}`);
    expect(newNonce()).toMatch(/^[0-9a-f]{32}$/);
  });

  it('refuses a caller-supplied nonce param, a malformed nonce, a bad path or no secret', () => {
    expect(() => signPushGet({ secret: TEST_SECRET, path, params: { nonce: 'x' } })).toThrow(/nonce/);
    expect(() => signPushGet({ secret: TEST_SECRET, path, nonce: 'ABC' })).toThrow(/32 lower-case hex/);
    expect(() => signPushGet({ secret: TEST_SECRET, path: `${path}?limit=1` })).toThrow(/path/);
    expect(() => signPushGet({ secret: TEST_SECRET, path: 'api/v1' })).toThrow(/path/);
    expect(() => signPushGet({ secret: '', path })).toThrow(/no secret/);
  });

  it('round-trips through verifyPushGet; method, path, query and secret are all bound', () => {
    const s = signPushGet({ secret: TEST_SECRET, path, params: { limit: '1000', updated_since: '2027-01-11T02:05:00+05:30' }, now });
    const rawQuery = s.pathAndQuery.split('?')[1];
    const v = (o: Partial<Parameters<typeof verifyPushGet>[0]>) =>
      verifyPushGet({ secrets: [TEST_SECRET], path, rawQuery, timestampHeader: s.ts, signatureHeader: s.headers['X-Push-Signature'], now, ...o });
    expect(v({})).toMatchObject({ ok: true, nonce: s.nonce, params: { limit: '1000', updated_since: '2027-01-11T02:05:00+05:30' } });
    expect(v({ path: '/api/v1/push-feed/article-views' })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(v({ rawQuery: rawQuery.replace('limit=1000', 'limit=5000') })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(v({ secrets: [OTHER] })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(v({ secrets: [OTHER, TEST_SECRET] })).toMatchObject({ ok: true, matched: 'previous' });
    expect(v({ rawQuery: `${rawQuery}&limit=3` })).toEqual({ ok: false, reason: 'bad_query' });
    expect(v({ bodyLength: 2 })).toEqual({ ok: false, reason: 'get_with_body' });
    expect(v({ now: new Date(now.getTime() + 301_000) })).toEqual({ ok: false, reason: 'skew' });
    expect(v({ now: new Date(now.getTime() + 300_000) }).ok).toBe(true);
    // The same canonical string signed as a POST is not a GET signature.
    const asPost = signatureHeader(TEST_SECRET, s.ts, 'POST', path, s.canonicalQuery);
    expect(v({ signatureHeader: asPost })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('a correctly signed GET without a nonce is refused (the §8.4 empty-query string is not a door-L request)', () => {
    const r = verifyPushGet({
      secrets: [TEST_SECRET],
      path,
      rawQuery: '',
      timestampHeader: '1799613300',
      signatureHeader: `sha256=${CHECK_VECTORS[1].signature}`,
      now: at('1799613300'),
    });
    expect(r).toEqual({ ok: false, reason: 'bad_query' });
  });
});
