import net from 'net';
import dotenv from 'dotenv';

dotenv.config();

// Every test server asked to listen with NO host binds 127.0.0.1 (brief 2026-11-27-test-port-loopback). With no host
// Node binds `::`, and on macOS the system can give that a port another program already holds on 127.0.0.1. Supertest's
// `request(app)` listens that way and then calls 127.0.0.1, so the OTHER program answered: stray 404s in route tests.
// Adding `host: '127.0.0.1'` to the call is not enough: Node then looks the host up first, so `address()` is null until
// later, while supertest reads it at once. So the socket is bound here and handed to `listen`, which stays immediate.
// A call naming a host, a path or a handle is left as it is. testPortLoopback.test.ts proves all of this.
// `net._createServerHandle` is a Node INTERNAL (the helper `cluster` uses), accepted for TEST code only; checked on
// Node 24.18.0. If a later Node drops it, this file throws before any test runs.
type Listen = (this: net.Server, ...args: unknown[]) => net.Server;
const serverProto = net.Server.prototype as unknown as { listen: Listen; unpatchedListen?: Listen };
const { _createServerHandle: bindSocket } = net as unknown as {
  _createServerHandle?: (address: string, port: number, addressType: 4) => object | number;
};
if (!bindSocket) {
  throw new Error('setup.ts: net._createServerHandle is gone in this Node version (brief 2026-11-27-test-port-loopback)');
}

/** What a TCP `listen` that names no host asks for (`()`, `(cb)`, `(port, …)`, `({ port })`), else null. */
function withoutHost([first, second, third]: unknown[]): { port: number; backlog?: number } | null {
  const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
  if (first === undefined || first === null || typeof first === 'function') return { port: 0 };
  if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    if (typeof second === 'string') return null; // (port, host, …)
    return { port: Number(first), backlog: num(second) ?? num(third) };
  }
  if (typeof first !== 'object' || !('port' in first)) return null; // a pipe path, a handle, another server
  const o = first as net.ListenOptions & { fd?: number };
  if (o.host || o.path || o.fd !== undefined) return null;
  return { port: Number(o.port ?? 0), backlog: o.backlog };
}

// Jest runs this file before every test file, and `net` can outlive one: always wrap the original, never a wrapper.
const unpatched = (serverProto.unpatchedListen ??= serverProto.listen);
serverProto.listen = function loopbackListen(this: net.Server, ...args: unknown[]) {
  const asked = withoutHost(args);
  if (!asked) return unpatched.apply(this, args);
  const handle = bindSocket('127.0.0.1', asked.port, 4);
  // A taken port is reported by `listen` itself, as the usual 'error' event.
  if (typeof handle === 'number') throw new Error(`setup.ts: could not create a 127.0.0.1 socket (${handle})`);
  const callback = args.length > 0 && typeof args[args.length - 1] === 'function' ? [args[args.length - 1]] : [];
  return unpatched.call(this, handle, ...(asked.backlog === undefined ? [] : [asked.backlog]), ...callback);
};

// Jest must never send real email. The local .env can carry a live ElasticEmail
// key, and the default senders (invites, report emails, digest alerts — which
// advanceRun calls by default) would then mail the dev DB's real users. Tests
// that exercise email inject an in-memory EmailSender instead.
process.env.ELASTICEMAIL_API_KEY = '';
// Same for staff push (digest task 14): the default transport is real web-push, and
// sendDigestAlerts runs in many digest tests. Tests that exercise it inject
// `staffPush: { enabled: true, transport }` with a recording fake.
process.env.DIGEST_STAFF_PUSH_ENABLED = 'false';

if (!process.env.ADMIN_TOKEN) {
  process.env.ADMIN_TOKEN = 'test-admin-token';
}
if (!process.env.SESSION_COOKIE_SECRET) {
  process.env.SESSION_COOKIE_SECRET =
    'test-session-cookie-secret-must-be-at-least-32-chars-long';
}
