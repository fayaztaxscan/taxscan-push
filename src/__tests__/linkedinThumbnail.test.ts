import fs from 'fs';
import path from 'path';
import { cardDescription, buildPost, parseCmsArticle, DESCRIPTION_MAX } from '../services/linkedin/post';
import { fetchCoverImage, isAllowedImageUrl, IMAGE_MAX_BYTES } from '../services/linkedin/image';
import { postBody, uploadImage, LINKEDIN_IMAGES_INIT_URL } from '../services/linkedin/client';
import { env } from '../lib/env';

/**
 * Brief 2026-11-02-linkedin-article-thumbnail: the link card's picture and description. All HTTP is mocked; no database.
 * (The worker-level scenarios, with the log line and the stored row, are in linkedinWorker.test.ts.)
 */
const cms = (n: string) => parseCmsArticle(JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/linkedin', `cms-${n}.json`), 'utf8')))!;
const TOKEN = 'SECRET-TOKEN-thumb-123456';

type Resp = { status?: number; headers?: Record<string, string>; bytes?: Uint8Array; chunks?: Uint8Array[]; json?: unknown };
function resp(r: Resp): Response {
  const status = r.status ?? 200;
  const body = r.chunks
    ? { getReader: () => { let i = 0; return { read: async () => (i < r.chunks!.length ? { done: false, value: r.chunks![i++] } : { done: true, value: undefined }) }; } }
    : undefined;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(r.headers ?? {}),
    body,
    arrayBuffer: async () => (r.bytes ?? new Uint8Array()).buffer,
    json: async () => r.json ?? {},
  } as unknown as Response;
}
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

describe('the cover picture and description come from the CMS article', () => {
  it('parseCmsArticle reads cover_image_url and excerpt (real 2 Nov fixtures)', () => {
    const a = cms('itat-panaji');
    expect(a.coverImageUrl).toMatch(/^https:\/\/documents\.taxscan\.in\/cms\/media\/.+\.jpg$/);
    expect(a.excerpt!.length).toBeGreaterThan(50);
    expect(parseCmsArticle({ keywords: [] })).toMatchObject({ coverImageUrl: null, excerpt: null });
  });
  it('the description is the excerpt, else the campaign body; whitespace-collapsed, ≤ 200 characters at a word boundary with "…"', async () => {
    const c = { id: 'c', title: 'T', url: 'https://www.taxscan.in/gst/the-slug-read-order', authority: null, categories: [], body: 'The campaign body.' };
    const withCms = await buildPost(c, 'taxscan', async () => cms('itat-panaji'));
    expect(withCms!.description).toBe(cms('itat-panaji').excerpt);
    expect(withCms!.coverImageUrl).toBe(cms('itat-panaji').coverImageUrl);
    const noCms = await buildPost(c, 'taxscan', async () => null);
    expect(noCms!.description).toBe('The campaign body.'); // the CMS failed: the body, and no picture
    expect(noCms!.coverImageUrl).toBeNull();
    const noExcerpt = await buildPost(c, 'taxscan', async () => ({ keywords: [], courts: [], category: null, coverImageUrl: 'https://documents.taxscan.in/a.jpg', excerpt: null }));
    expect(noExcerpt!.description).toBe('The campaign body.');
    const long = 'word '.repeat(80);
    const cut = cardDescription(long);
    expect(cut.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut).toMatch(/^(word )*word…$/);
    expect(cardDescription('a\n\n  b   c')).toBe('a b c');
    expect(cardDescription('y'.repeat(200))).toBe('y'.repeat(200));
    expect(cardDescription('x'.repeat(250))).toBe(`${'x'.repeat(199)}…`);
    expect(cardDescription(null)).toBe('');
    expect(cardDescription('[Read Order] (2)')).toBe('[Read Order] (2)'); // a plain JSON string: nothing is escaped
  });
});

describe('postBody', () => {
  const base = { orgUrn: 'urn:li:organization:1', commentary: 'c', title: 't', link: 'https://www.taxscan.in/a/b' };
  it('carries thumbnail and description in content.article only when present', () => {
    expect((postBody({ ...base, description: 'd', thumbnail: 'urn:li:image:C1' }).content as { article: unknown }).article).toEqual({ source: base.link, title: 't', description: 'd', thumbnail: 'urn:li:image:C1' });
    expect((postBody({ ...base, description: 'd' }).content as { article: unknown }).article).toEqual({ source: base.link, title: 't', description: 'd' });
    expect((postBody(base).content as { article: unknown }).article).toEqual({ source: base.link, title: 't' });
  });
});

describe('fetching the picture is safe', () => {
  const U = 'https://documents.taxscan.in/cms/media/x.jpg';
  it('A4: only https on documents.taxscan.in / www.taxscan.in / taxscan.in: anything else is refused WITHOUT a fetch', async () => {
    for (const bad of ['http://documents.taxscan.in/x.jpg', 'https://evil.example/x.jpg', 'https://documents.taxscan.in.evil.example/x.jpg', 'https://user:pw@documents.taxscan.in/x.jpg', 'https://documents.taxscan.in:8443/x.jpg', 'ftp://documents.taxscan.in/x.jpg', 'not a url']) {
      const f = jest.fn();
      expect(isAllowedImageUrl(bad)).toBe(false);
      expect(await fetchCoverImage(bad, f as never)).toEqual({ ok: false, reason: 'host' });
      expect(f).not.toHaveBeenCalled();
    }
    for (const good of [U, 'https://www.taxscan.in/a.png', 'https://taxscan.in/a.gif']) expect(isAllowedImageUrl(good)).toBe(true);
  });
  it('a good JPEG / PNG / GIF comes back with its bytes (a content-type with parameters is fine)', async () => {
    for (const type of ['image/jpeg', 'image/png', 'image/gif', 'IMAGE/JPEG; charset=binary']) {
      const r = await fetchCoverImage(U, (async () => resp({ headers: { 'content-type': type }, bytes: JPEG })) as never);
      expect(r).toMatchObject({ ok: true, contentType: type.split(';')[0].toLowerCase() });
      if (r.ok) expect(Array.from(r.bytes)).toEqual(Array.from(JPEG));
    }
  });
  it('A2: 404 / 5xx → http_<status>; text/html or webp → type; an empty body → type; no redirects; network and timeout have their own words', async () => {
    expect(await fetchCoverImage(U, (async () => resp({ status: 404 })) as never)).toEqual({ ok: false, reason: 'http_404' });
    expect(await fetchCoverImage(U, (async () => resp({ status: 503 })) as never)).toEqual({ ok: false, reason: 'http_503' });
    expect(await fetchCoverImage(U, (async () => resp({ headers: { 'content-type': 'text/html' }, bytes: JPEG })) as never)).toEqual({ ok: false, reason: 'type' });
    expect(await fetchCoverImage(U, (async () => resp({ headers: { 'content-type': 'image/webp' }, bytes: JPEG })) as never)).toEqual({ ok: false, reason: 'type' });
    expect(await fetchCoverImage(U, (async () => resp({ headers: { 'content-type': 'image/jpeg' }, bytes: new Uint8Array() })) as never)).toEqual({ ok: false, reason: 'type' });
    expect(await fetchCoverImage(U, (async () => { throw Object.assign(new TypeError('fetch failed'), { cause: new Error('unexpected redirect') }); }) as never)).toEqual({ ok: false, reason: 'redirect' });
    expect(await fetchCoverImage(U, (async () => { throw new Error('socket hang up'); }) as never)).toEqual({ ok: false, reason: 'network' });
    expect(await fetchCoverImage(U, (async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }) as never)).toEqual({ ok: false, reason: 'timeout' });
    let init: RequestInit | undefined;
    await fetchCoverImage(U, (async (_u: string, i: RequestInit) => { init = i; return resp({ headers: { 'content-type': 'image/jpeg' }, bytes: JPEG }); }) as never);
    expect(init!.redirect).toBe('error');
  });
  it('A2: 6 MB is refused: by content-length, by the body past the cap (the read stops), and by a body with no stream', async () => {
    const six = IMAGE_MAX_BYTES + 1024 * 1024;
    expect(await fetchCoverImage(U, (async () => resp({ headers: { 'content-type': 'image/jpeg', 'content-length': String(six) }, bytes: JPEG })) as never)).toEqual({ ok: false, reason: 'size' });
    let read = 0;
    const chunk = new Uint8Array(1024 * 1024);
    const stream = { ...resp({ headers: { 'content-type': 'image/jpeg' } }), body: { getReader: () => ({ read: async () => { read += 1; return read > 50 ? { done: true, value: undefined } : { done: false, value: chunk }; } }) } } as unknown as Response;
    expect(await fetchCoverImage(U, (async () => stream) as never)).toEqual({ ok: false, reason: 'size' });
    expect(read).toBeLessThanOrEqual(6); // stopped as soon as the 5 MB cap was passed, not after the whole 50 MB
    expect(await fetchCoverImage(U, (async () => resp({ headers: { 'content-type': 'image/jpeg' }, bytes: new Uint8Array(six) })) as never)).toEqual({ ok: false, reason: 'size' });
  });
});

describe('uploading to LinkedIn (Images API)', () => {
  const req = { orgUrn: 'urn:li:organization:99', accessToken: TOKEN, bytes: JPEG, contentType: 'image/jpeg' };
  const UPLOAD_URL = 'https://www.linkedin.com/dms-uploads/C4E10AQ/uploaded-image/0?ca=vector_ads&v=beta&ut=abc';
  type Call = { url: string; init: RequestInit };
  function fake(steps: Array<Resp | Error>) {
    const calls: Call[] = [];
    let i = 0;
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const s = steps[i++];
      if (s instanceof Error) throw s;
      return resp(s);
    }) as unknown as typeof fetch;
    return { f, calls };
  }
  const INIT_OK: Resp = { status: 200, json: { value: { uploadUrl: UPLOAD_URL, image: 'urn:li:image:C4E10AQFoyyAjHPMQuQ', uploadUrlExpiresAt: 1 } } };

  it('registers with the org as owner, PUTs the bytes with the Bearer token, and returns the image URN', async () => {
    const { f, calls } = fake([INIT_OK, { status: 201 }]);
    expect(await uploadImage(req, f)).toEqual({ kind: 'ok', urn: 'urn:li:image:C4E10AQFoyyAjHPMQuQ' });
    expect(calls[0].url).toBe(LINKEDIN_IMAGES_INIT_URL);
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ initializeUploadRequest: { owner: 'urn:li:organization:99' } });
    expect(calls[0].init.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}`, 'LinkedIn-Version': env.linkedin.apiVersion, 'X-Restli-Protocol-Version': '2.0.0', 'Content-Type': 'application/json' });
    expect(calls[1].url).toBe(UPLOAD_URL);
    expect(calls[1].init.method).toBe('PUT');
    expect(calls[1].init.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'image/jpeg' });
    expect(Array.from(calls[1].init.body as Uint8Array)).toEqual(Array.from(JPEG));
  });
  it('A3: initializeUpload 5xx / 4xx / a network error / a timeout, and a PUT that fails → soft (a picture problem), with a fixed reason', async () => {
    expect(await uploadImage(req, fake([{ status: 500 }]).f)).toEqual({ kind: 'soft', reason: 'init_http_500' });
    expect(await uploadImage(req, fake([{ status: 422 }]).f)).toEqual({ kind: 'soft', reason: 'init_http_422' });
    expect(await uploadImage(req, fake([new Error('socket hang up')]).f)).toEqual({ kind: 'soft', reason: 'init_network' });
    expect(await uploadImage(req, fake([Object.assign(new Error('x'), { name: 'AbortError' })]).f)).toEqual({ kind: 'soft', reason: 'init_timeout' });
    expect(await uploadImage(req, fake([INIT_OK, { status: 500 }]).f)).toEqual({ kind: 'soft', reason: 'put_http_500' });
    expect(await uploadImage(req, fake([INIT_OK, new Error('reset')]).f)).toEqual({ kind: 'soft', reason: 'put_network' });
  });
  it('A3: a 401 / 403 from initializeUpload is an AUTH verdict and nothing is uploaded', async () => {
    for (const status of [401, 403]) {
      const { f, calls } = fake([{ status, json: { message: `bad ${TOKEN}` } }]);
      const r = await uploadImage(req, f);
      expect(r).toMatchObject({ kind: 'auth', status });
      expect(JSON.stringify(r)).not.toContain(TOKEN);
      expect(calls).toHaveLength(1);
    }
  });
  it('the token is only ever sent to LinkedIn: an upload URL on another host (or http) is refused before the PUT', async () => {
    for (const uploadUrl of ['https://evil.example/steal', 'http://www.linkedin.com/dms-uploads/x', 'https://www.linkedin.com.evil.example/x', 'nope']) {
      const { f, calls } = fake([{ status: 200, json: { value: { uploadUrl, image: 'urn:li:image:C1' } } }]);
      expect(await uploadImage(req, f)).toEqual({ kind: 'soft', reason: 'init_bad_answer' });
      expect(calls).toHaveLength(1);
    }
    const { f, calls } = fake([{ status: 200, json: { value: { uploadUrl: UPLOAD_URL, image: 'urn:li:share:123' } } }]);
    expect(await uploadImage(req, f)).toEqual({ kind: 'soft', reason: 'init_bad_answer' });
    expect(calls).toHaveLength(1);
  });
});
