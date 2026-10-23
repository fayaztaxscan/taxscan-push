import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A local fake of the Mailercloud API on an ephemeral port, for the
 * Mailercloud client tests (docs/EMAIL_DIGEST_DESIGN.md §13 task 2). Real HTTP,
 * no mocks of fetch: the client is pointed at `base.v1` / `base.v2`.
 *
 * Default behaviour is a tiny stateful provider (create → Draft, schedule →
 * Scheduled, GET campaign, list search). `script(route, …)` overrides the next
 * replies of one route, in order:
 *   { status, body }      — reply with JSON
 *   'hang'                — read the request, never answer (client timeout)
 *   'reset'               — read the request, then destroy the socket
 *
 * Routes: 'GET /v1/client/plan', 'POST /v2/campaign/save', 'POST /v1/campaign/schedule',
 * 'GET /v1/campaign', 'POST /v1/campaign/list', 'POST /v1/campaign/testmail',
 * 'GET /v1/webhooks/detail' (task 13; `webhooks` holds id → status word).
 */

export type FakeReply = { status: number; body?: unknown } | 'hang' | 'reset';
export type FakeRequest = { method: string; path: string; route: string; headers: http.IncomingHttpHeaders; body: unknown };
export type FakeCampaign = {
  id: string;
  name: string;
  status: string;
  body: Record<string, unknown>;
  summary: { queued_total: number | string; sent: number | string; opens: number; clicks: number };
};

export class FakeMailercloud {
  readonly requests: FakeRequest[] = [];
  readonly campaigns = new Map<string, FakeCampaign>();
  /** Webhook id → its status as Mailercloud would show it ("Active" / "Inactive"). */
  readonly webhooks = new Map<string, string | number>();
  private readonly scripts = new Map<string, FakeReply[]>();
  private server: http.Server | null = null;
  private seq = 0;
  base = { v1: '', v2: '' };

  async start(): Promise<this> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    const { port } = this.server.address() as AddressInfo;
    this.base = { v1: `http://127.0.0.1:${port}/v1`, v2: `http://127.0.0.1:${port}/v2` };
    return this;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server!.close(() => r()));
    this.server = null;
  }

  script(route: string, ...replies: FakeReply[]): this {
    (this.scripts.get(route) ?? this.scripts.set(route, []).get(route)!).push(...replies);
    return this;
  }

  /** Requests made to one route. */
  to(route: string): FakeRequest[] {
    return this.requests.filter((r) => r.route === route);
  }

  /** Adds a campaign directly (as if made earlier, e.g. by a lost-reply create). */
  addCampaign(name: string, status = 'Draft'): FakeCampaign {
    const id = `mc${++this.seq}`;
    const c: FakeCampaign = { id, name, status, body: {}, summary: { queued_total: 0, sent: 0, opens: 0, clicks: 0 } };
    this.campaigns.set(id, c);
    return c;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      const path = (req.url ?? '').split('?')[0];
      const route = routeOf(req.method ?? '', path);
      this.requests.push({ method: req.method ?? '', path, route, headers: req.headers, body });

      const scripted = this.scripts.get(route)?.shift();
      const reply = scripted ?? this.defaultReply(req.method ?? '', path, body);
      if (reply === 'hang') return; // never answer
      if (reply === 'reset') {
        req.socket.destroy();
        return;
      }
      res.writeHead(reply.status, { 'Content-Type': 'application/json' });
      res.end(reply.body === undefined ? '' : JSON.stringify(reply.body));
    });
  }

  private defaultReply(method: string, path: string, body: unknown): Exclude<FakeReply, 'hang' | 'reset'> {
    const b = (body ?? {}) as Record<string, unknown>;
    const notFound = { status: 404, body: { errors: [{ field: 'id', message: 'Record not found with the given Id' }] } };
    let m: RegExpExecArray | null;
    if (method === 'GET' && path === '/v1/client/plan') {
      return { status: 200, body: { data: { plan: 'Test plan', remaining_contacts: 1 } } };
    }
    if (method === 'POST' && path === '/v2/campaign/save') {
      const c = this.addCampaign(String(b.name), b.is_publish === '0' ? 'Draft' : 'Scheduled');
      c.body = b;
      return { status: 201, body: { id: c.id } };
    }
    if (method === 'POST' && (m = /^\/v1\/campaign\/schedule\/([^/]+)$/.exec(path))) {
      const c = this.campaigns.get(decodeURIComponent(m[1]));
      if (!c) return notFound;
      c.status = 'Scheduled';
      return { status: 200, body: { message: 'Campaign has been scheduled' } };
    }
    if (method === 'POST' && (m = /^\/v1\/campaign\/testmail\/([^/]+)$/.exec(path))) {
      return this.campaigns.has(decodeURIComponent(m[1]))
        ? { status: 200, body: { message: 'Test mail was successfully sent' } }
        : notFound;
    }
    if (method === 'POST' && path === '/v1/campaign/list') {
      const search = String(b.search ?? '');
      const limit = Number(b.limit);
      const page = Number(b.page);
      const all = [...this.campaigns.values()].filter((c) => c.name.includes(search));
      const slice = all.slice((page - 1) * limit, page * limit);
      // Documented shape: data is an object keyed "0", "1", …
      const data = Object.fromEntries(slice.map((c, i) => [String(i), { id: c.id, name: c.name, status: c.status }]));
      return { status: 200, body: { count: [{ count: all.length }], data } };
    }
    if (method === 'GET' && (m = /^\/v1\/webhooks\/detail\/([^/]+)$/.exec(path))) {
      const id = decodeURIComponent(m[1]);
      const st = this.webhooks.get(id);
      if (st === undefined) return notFound;
      return { status: 200, body: { data: { id, url: 'https://push.taxscan.in/api/webhooks/mailercloud/<token>', status: st } } };
    }
    if (method === 'GET' && (m = /^\/v1\/campaign\/([^/]+)$/.exec(path))) {
      const c = this.campaigns.get(decodeURIComponent(m[1]));
      if (!c) return notFound;
      return { status: 200, body: { data: { '0': { id: c.id, name: c.name, status: c.status, report_summary: c.summary } } } };
    }
    return { status: 404, body: { message: 'no such route' } };
  }
}

function routeOf(method: string, path: string): string {
  const m = /^\/v1\/campaign\/(schedule|testmail)\/[^/]+$/.exec(path);
  if (m) return `${method} /v1/campaign/${m[1]}`;
  if (method === 'GET' && /^\/v1\/campaign\/[^/]+$/.test(path)) return 'GET /v1/campaign';
  if (method === 'GET' && /^\/v1\/webhooks\/detail\/[^/]+$/.test(path)) return 'GET /v1/webhooks/detail';
  return `${method} ${path}`;
}
