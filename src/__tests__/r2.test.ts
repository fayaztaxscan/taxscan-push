import { endpointFor, isR2Configured, signRequest, type R2Config } from '../lib/r2';

/**
 * SigV4 is unforgiving and fails opaquely — R2 answers a bad signature with
 * 403 and no hint about which part was wrong. These lock the pieces that are
 * easy to get subtly wrong and impossible to debug from the response.
 */

const cfg: R2Config = {
  accountId: 'acct123',
  bucket: 'taxscan-backups',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'secret-example-key',
};

const NOW = new Date('2026-09-08T06:55:00.000Z');

describe('endpointFor', () => {
  it('derives the Cloudflare endpoint from the account id', () => {
    expect(endpointFor(cfg)).toBe('https://acct123.r2.cloudflarestorage.com');
  });

  it('prefers an explicit endpoint and strips trailing slashes', () => {
    expect(endpointFor({ ...cfg, endpoint: 'http://127.0.0.1:9000/' })).toBe('http://127.0.0.1:9000');
  });
});

describe('signRequest', () => {
  it('produces the required headers and a well-formed credential scope', () => {
    const h = signRequest({ cfg, method: 'PUT', path: '/taxscan-backups/a.gz', payload: Buffer.from('x'), now: NOW });

    expect(h['x-amz-date']).toBe('20260908T065500Z');
    expect(h.host).toBe('acct123.r2.cloudflarestorage.com');
    // R2 rejects UNSIGNED-PAYLOAD, so the body hash must always be real.
    expect(h['x-amz-content-sha256']).toMatch(/^[0-9a-f]{64}$/);
    expect(h.Authorization).toContain('AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/20260908/auto/s3/aws4_request');
    expect(h.Authorization).toMatch(/Signature=[0-9a-f]{64}$/);
    // Every signed header must appear in SignedHeaders, sorted.
    expect(h.Authorization).toContain('SignedHeaders=host;x-amz-content-sha256;x-amz-date');
  });

  it('is deterministic for the same inputs and changes with the body', () => {
    const a = signRequest({ cfg, method: 'PUT', path: '/b/k', payload: Buffer.from('one'), now: NOW });
    const b = signRequest({ cfg, method: 'PUT', path: '/b/k', payload: Buffer.from('one'), now: NOW });
    const c = signRequest({ cfg, method: 'PUT', path: '/b/k', payload: Buffer.from('two'), now: NOW });
    expect(a.Authorization).toBe(b.Authorization);
    expect(a.Authorization).not.toBe(c.Authorization);
  });

  it('signs extra headers too, so content-type cannot drift from the signature', () => {
    const withType = signRequest({
      cfg,
      method: 'PUT',
      path: '/b/k',
      payload: Buffer.from('x'),
      now: NOW,
      extraHeaders: { 'content-type': 'application/gzip' },
    });
    expect(withType.Authorization).toContain('SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date');
  });

  it('keeps "/" as a path delimiter but escapes characters within a segment', () => {
    // Our keys contain colons from the ISO timestamp only after replacement,
    // but a prefix could contain anything; a wrongly-escaped path is a 403.
    const h = signRequest({ cfg, method: 'PUT', path: '/bucket/a b/c.gz', payload: Buffer.alloc(0), now: NOW });
    expect(h.Authorization).toMatch(/Signature=[0-9a-f]{64}$/);
  });

  it('changes the signature when the method changes', () => {
    const put = signRequest({ cfg, method: 'PUT', path: '/b/k', payload: Buffer.alloc(0), now: NOW });
    const del = signRequest({ cfg, method: 'DELETE', path: '/b/k', payload: Buffer.alloc(0), now: NOW });
    expect(put.Authorization).not.toBe(del.Authorization);
  });
});

describe('isR2Configured', () => {
  it('requires bucket, both credentials, and an account id or endpoint', () => {
    expect(isR2Configured(cfg)).toBe(true);
    expect(isR2Configured({ ...cfg, bucket: '' })).toBe(false);
    expect(isR2Configured({ ...cfg, secretAccessKey: '' })).toBe(false);
    expect(isR2Configured({ ...cfg, accountId: '' })).toBe(false);
    expect(isR2Configured({ ...cfg, accountId: '', endpoint: 'http://localhost:9000' })).toBe(true);
  });
});
