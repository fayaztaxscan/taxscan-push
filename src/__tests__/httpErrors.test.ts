import express from 'express';
import request from 'supertest';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { appErrorHandler, clientErrorStatus, safeErrorLog } from '../lib/httpErrors';

/**
 * Body-parser errors on any route (pre-existing, found by QA 2026-10-23): a
 * JSON body over the global 64 KB limit returned 500 `internal_error`, and the
 * catch-all handler logged the error object — which carries the raw body (and,
 * for a syntax error on Node ≥ 20, a message quoting it). Now the right 4xx,
 * and no body ever reaches a log line. Nothing here touches the database.
 */

const SENTINEL = 'reader-sentinel-7f3a@example.com';
const logged: string[] = [];
const capture = (...a: unknown[]) => void logged.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
jest.spyOn(console, 'log').mockImplementation(capture);
jest.spyOn(console, 'warn').mockImplementation(capture);
jest.spyOn(console, 'error').mockImplementation(capture);
jest.spyOn(console, 'info').mockImplementation(capture);

const app = createApp({ rateLimit: { publicPerMin: 10000, loginPerMin: 10000 } });
const bigJson = () => JSON.stringify({ subscription: { endpoint: `https://fcm.googleapis.com/fcm/send/${SENTINEL}` }, pad: `${SENTINEL} `.repeat(3000) });

beforeEach(() => {
  logged.length = 0;
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('oversized JSON → 413, never logged', () => {
  it.each(['/api/track', '/api/subscribe', '/api/auth/login', '/api/digest/runs/x/retry'])('%s', async (path) => {
    const body = bigJson();
    expect(Buffer.byteLength(body)).toBeGreaterThan(64 * 1024);
    const res = await request(app).post(path).set('Content-Type', 'application/json').send(body);
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: 'payload_too_large' });
    expect(JSON.stringify(res.body)).not.toContain(SENTINEL);
    expect(logged.join('\n')).not.toContain(SENTINEL);
    expect(logged.join('\n')).toContain(`[http] 413 entity.too.large POST ${path}`);
  });
});

describe('malformed JSON → 400, never logged', () => {
  it.each(['/api/track', '/api/subscribe'])('%s', async (path) => {
    const res = await request(app)
      .post(path)
      .set('Content-Type', 'application/json')
      .send(`{"subscription":{"endpoint":"https://fcm.googleapis.com/${SENTINEL}", oops`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_json' });
    expect(logged.join('\n')).not.toContain(SENTINEL);
    expect(logged.join('\n')).not.toContain('oops');
    expect(logged.join('\n')).toContain(`[http] 400 entity.parse.failed POST ${path}`);
  });

  it('an unsupported charset → 415', async () => {
    const res = await request(app).post('/api/track').set('Content-Type', 'application/json; charset=iso-8859-1').send(`{"x":"${SENTINEL}"}`);
    expect(res.status).toBe(415);
    expect(res.body).toEqual({ error: 'unsupported_media_type' });
    expect(logged.join('\n')).not.toContain(SENTINEL);
  });

  it('a well-formed but wrong-shaped body still gets the route\'s own 400 (SDK contract unchanged)', async () => {
    const res = await request(app).post('/api/subscribe').send({ nope: true });
    expect(res.status).toBe(400);
    expect(res.body.error).not.toBe('invalid_json');
  });
});

describe('a genuine server error is still a 500 and still logs its stack — but no body', () => {
  it('logs name, message and stack; never the body hung on the error', async () => {
    const mini = express();
    mini.get('/boom', () => {
      const e = new Error('database exploded') as Error & { body?: string; rawBody?: string; status?: number };
      e.body = SENTINEL;
      e.rawBody = SENTINEL;
      throw e;
    });
    mini.use(appErrorHandler);
    const res = await request(mini).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal_error' });
    const out = logged.join('\n');
    expect(out).toContain('unhandled error:');
    expect(out).toContain('database exploded');
    expect(out).toMatch(/"stack":"Error: database exploded\\n\s+at /);
    expect(out).not.toContain(SENTINEL);
  });

  it('a 5xx http error with a body is a server error (500), not echoed', async () => {
    const mini = express();
    mini.get('/x', () => {
      throw Object.assign(new Error('stream not readable'), { type: 'stream.not.readable', status: 500, body: SENTINEL });
    });
    mini.use(appErrorHandler);
    const res = await request(mini).get('/x');
    expect(res.status).toBe(500);
    expect(logged.join('\n')).not.toContain(SENTINEL);
  });
});

describe('the rules, pure', () => {
  it('clientErrorStatus: body-parser types and exposed 4xx; null for everything else', () => {
    expect(clientErrorStatus({ type: 'entity.too.large', status: 413 })).toBe(413);
    expect(clientErrorStatus({ type: 'entity.parse.failed', status: 400 })).toBe(400);
    expect(clientErrorStatus({ type: 'encoding.unsupported', status: 415 })).toBe(415);
    expect(clientErrorStatus({ status: 404, expose: true })).toBe(404);
    expect(clientErrorStatus({ status: 404 })).toBeNull();
    expect(clientErrorStatus({ type: 'stream.not.readable', status: 500 })).toBeNull();
    expect(clientErrorStatus(new Error('x'))).toBeNull();
    expect(clientErrorStatus(null)).toBeNull();
  });
  it('safeErrorLog keeps name/message/type/status (+stack on request), drops everything else', () => {
    const e = Object.assign(new Error('m'), { type: 't', status: 400, body: SENTINEL, rawBody: SENTINEL, req: { headers: { cookie: SENTINEL } } });
    const out = safeErrorLog(e);
    expect(out).toEqual({ name: 'Error', message: 'm', type: 't', status: 400 });
    expect(Object.keys(safeErrorLog(e, { stack: true }))).toContain('stack');
    expect(JSON.stringify(safeErrorLog(e, { stack: true }))).not.toContain(SENTINEL);
    expect(safeErrorLog('plain')).toEqual({ message: 'plain' });
  });
});
