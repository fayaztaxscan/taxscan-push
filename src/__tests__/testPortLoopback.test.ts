/**
 * Brief 2026-11-27-test-port-loopback (the rule lives in setup.ts): a test server asked to listen with no host binds
 * 127.0.0.1, so a request to 127.0.0.1 can never reach another program that holds the same port there.
 */
import http from 'node:http';
import type { AddressInfo, Server } from 'node:net';
import express from 'express';
import request from 'supertest';

const open: Server[] = [];
const server = (reply = 'app', status = 200) => {
  const s = http.createServer((_q, res) => {
    res.statusCode = status;
    res.end(reply);
  });
  open.push(s);
  return s;
};
const addressOf = (s: Server) => (s.address() as AddressInfo | null)?.address;
const portOf = (s: Server) => (s.address() as AddressInfo).port;
/** Resolves when the server is listening; rejects with the 'error' it raised instead. */
const listening = (s: Server) =>
  new Promise<void>((resolve, reject) => {
    s.once('error', reject);
    if (s.listening) resolve();
    else s.once('listening', () => resolve());
  });
const get = (port: number) =>
  new Promise<string>((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, agent: false }, (res) => {
        let text = '';
        res.on('data', (d) => (text += d));
        res.on('end', () => resolve(text));
      })
      .on('error', reject);
  });

afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => new Promise((done) => s.close(done))));
});

describe('a test server asked to listen with no host binds 127.0.0.1', () => {
  it('supertest’s `request(app)`: bound the moment the request is made, and answered by the app', async () => {
    const app = express();
    app.get('/', (_q, res) => void res.send('app'));
    const pending = request(app).get('/');
    const own = (pending as unknown as { _server: Server })._server;
    open.push(own); // closed even if the next line fails, so a failing run still ends
    expect(addressOf(own)).toBe('127.0.0.1');
    expect((await pending).text).toBe('app');
  });

  it.each<[string, (s: http.Server) => unknown]>([
    ['listen()', (s) => s.listen()],
    ['listen(cb)', (s) => s.listen(() => undefined)],
    ['listen(0)', (s) => s.listen(0)],
    ['listen("0")', (s) => s.listen('0' as unknown as number)],
    ['listen(0, cb)', (s) => s.listen(0, () => undefined)],
    ['listen(0, backlog, cb)', (s) => s.listen(0, 16, () => undefined)],
    ['listen({ port: 0 })', (s) => s.listen({ port: 0 })],
    ['listen({ port: 0 }, cb)', (s) => s.listen({ port: 0 }, () => undefined)],
  ])('%s: address() is 127.0.0.1 at once, and it serves', async (_form, start) => {
    const s = server();
    start(s);
    expect(addressOf(s)).toBe('127.0.0.1');
    await listening(s);
    expect(await get(portOf(s))).toBe('app');
  });

  it('express `app.listen(0, cb)` too, and the callback runs once', async () => {
    const calls: string[] = [];
    const s = express().listen(0, () => calls.push('listening'));
    open.push(s);
    expect(addressOf(s)).toBe('127.0.0.1');
    await listening(s);
    await new Promise((r) => setImmediate(r));
    expect(calls).toEqual(['listening']);
  });

  it.each<[string, (s: http.Server) => unknown]>([
    ['listen(0, host)', (s) => s.listen(0, '0.0.0.0')],
    ['listen({ port, host })', (s) => s.listen({ port: 0, host: '0.0.0.0' })],
  ])('%s: a call that names a host is left alone', async (_form, start) => {
    const s = server();
    start(s);
    await listening(s);
    expect(addressOf(s)).toBe('0.0.0.0');
  });

  it('the hole is closed: an app asked for a port a decoy holds on 127.0.0.1 cannot take it, so the decoy never answers for it', async () => {
    const decoy = server('decoy', 404);
    decoy.listen(0, '127.0.0.1');
    await listening(decoy);
    const app = server();
    app.listen(portOf(decoy)); // no host, as supertest does
    // Without the rule this binds `::` beside the decoy, "listens" happily, and requests to 127.0.0.1 get the decoy.
    await expect(listening(app)).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(app.listening).toBe(false);
    expect(await get(portOf(decoy))).toBe('decoy');
  });
});
