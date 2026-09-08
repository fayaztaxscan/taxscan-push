/**
 * Minimal S3-compatible client for Cloudflare R2 — PUT, LIST and DELETE only.
 *
 * DELIBERATELY ZERO-DEPENDENCY. AWS SigV4 is ~80 lines of HMAC over a canonical
 * string, and `node:crypto` already has everything it needs. This follows the
 * same call the GA sync made (no `@google-analytics/data`): every dependency
 * added here churns package-lock.json, and a package-lock change is what
 * invalidates the Nixpacks Docker cache and re-exposes latent build problems.
 *
 * Only the pieces the backup job uses are implemented. This is not a general
 * S3 client and should not grow into one — if something needs multipart
 * uploads or presigned URLs, that is the moment to reach for a real library.
 */

import crypto from 'node:crypto';

export type R2Config = {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Overrides the derived Cloudflare endpoint. Used by the tests. */
  endpoint?: string;
};

const SERVICE = 's3';
/** R2 has no regions, but SigV4 requires one and R2 expects this literal. */
const REGION = 'auto';

const sha256Hex = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string) => crypto.createHmac('sha256', key).update(data).digest();

/** `https://<account>.r2.cloudflarestorage.com`, unless overridden. */
export function endpointFor(cfg: R2Config): string {
  const raw = cfg.endpoint || `https://${cfg.accountId}.r2.cloudflarestorage.com`;
  return raw.replace(/\/+$/, '');
}

/**
 * Each path segment is encoded separately so "/" stays a delimiter. S3 requires
 * the stricter RFC 3986 set, which encodeURIComponent leaves alone: ! ' ( ) *
 */
function encodeKey(key: string): string {
  return key
    .split('/')
    .map((seg) =>
      encodeURIComponent(seg).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`),
    )
    .join('/');
}

/** Query strings must be sorted by key, with both halves RFC 3986 encoded. */
function canonicalQuery(query: Record<string, string>): string {
  return Object.keys(query)
    .sort()
    .map((k) => `${encodeKey(k)}=${encodeKey(query[k])}`)
    .join('&');
}

/**
 * Signs one request with AWS Signature Version 4 and returns the headers.
 *
 * `payloadHash` is the SHA-256 of the body — R2 rejects UNSIGNED-PAYLOAD on
 * these calls, so it is always computed, never elided.
 */
export function signRequest(opts: {
  cfg: R2Config;
  method: 'PUT' | 'GET' | 'DELETE';
  path: string;
  query?: Record<string, string>;
  payload: Buffer;
  now: Date;
  extraHeaders?: Record<string, string>;
}): Record<string, string> {
  const { cfg, method, path, payload, now } = opts;
  const query = opts.query ?? {};
  const host = new URL(endpointFor(cfg)).host;

  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20260908T065500Z
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(payload);

  const headers: Record<string, string> = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...(opts.extraHeaders ?? {}),
  };

  // Signed headers are sorted, lowercased, and their values trimmed.
  const sortedKeys = Object.keys(headers)
    .map((k) => k.toLowerCase())
    .sort();
  const canonicalHeaders = sortedKeys
    .map((k) => `${k}:${String(headers[Object.keys(headers).find((h) => h.toLowerCase() === k)!]).trim()}\n`)
    .join('');
  const signedHeaders = sortedKeys.join(';');

  const canonicalRequest = [
    method,
    encodeKey(path),
    canonicalQuery(query),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const signingKey = hmac(hmac(hmac(hmac(`AWS4${cfg.secretAccessKey}`, dateStamp), REGION), SERVICE), 'aws4_request');
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  return {
    ...headers,
    Authorization:
      `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

async function send(opts: {
  cfg: R2Config;
  method: 'PUT' | 'GET' | 'DELETE';
  path: string;
  query?: Record<string, string>;
  payload?: Buffer;
  extraHeaders?: Record<string, string>;
  timeoutMs?: number;
}): Promise<{ status: number; body: string }> {
  const payload = opts.payload ?? Buffer.alloc(0);
  const headers = signRequest({
    cfg: opts.cfg,
    method: opts.method,
    path: opts.path,
    query: opts.query,
    payload,
    now: new Date(),
    extraHeaders: opts.extraHeaders,
  });

  const qs = opts.query && Object.keys(opts.query).length ? `?${canonicalQuery(opts.query)}` : '';
  const url = `${endpointFor(opts.cfg)}${encodeKey(opts.path)}${qs}`;

  const res = await fetch(url, {
    method: opts.method,
    headers,
    body: opts.method === 'PUT' ? new Uint8Array(payload) : undefined,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
  });
  const body = await res.text().catch(() => '');
  return { status: res.status, body };
}

/** Uploads one object. Throws with the provider's message on a non-2xx. */
export async function putObject(
  cfg: R2Config,
  key: string,
  body: Buffer,
  contentType = 'application/gzip',
): Promise<void> {
  const r = await send({
    cfg,
    method: 'PUT',
    path: `/${cfg.bucket}/${key}`,
    payload: body,
    extraHeaders: { 'content-type': contentType, 'content-length': String(body.length) },
  });
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`R2 PUT ${key} failed: ${r.status} ${r.body.slice(0, 300)}`);
  }
}

/** Object keys under a prefix. Follows continuation tokens. */
export async function listObjects(cfg: R2Config, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const query: Record<string, string> = { 'list-type': '2', prefix };
    if (token) query['continuation-token'] = token;
    const r = await send({ cfg, method: 'GET', path: `/${cfg.bucket}`, query, timeoutMs: 30_000 });
    if (r.status < 200 || r.status >= 300) {
      throw new Error(`R2 LIST failed: ${r.status} ${r.body.slice(0, 300)}`);
    }
    for (const m of r.body.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(decodeXml(m[1]));
    const next = r.body.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
    token = r.body.includes('<IsTruncated>true</IsTruncated>') && next ? decodeXml(next[1]) : undefined;
  } while (token);
  return keys;
}

export async function deleteObject(cfg: R2Config, key: string): Promise<void> {
  const r = await send({ cfg, method: 'DELETE', path: `/${cfg.bucket}/${key}`, timeoutMs: 30_000 });
  // 204 on success; S3 also answers 404 as success-ish for deletes.
  if (r.status !== 204 && r.status !== 200 && r.status !== 404) {
    throw new Error(`R2 DELETE ${key} failed: ${r.status} ${r.body.slice(0, 200)}`);
  }
}

function decodeXml(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** True when every credential the uploader needs is present. */
export function isR2Configured(cfg: R2Config): boolean {
  return Boolean(cfg.bucket && cfg.accessKeyId && cfg.secretAccessKey && (cfg.accountId || cfg.endpoint));
}
