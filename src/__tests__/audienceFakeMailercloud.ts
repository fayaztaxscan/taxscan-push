/**
 * A fake Mailercloud CONTACTS API for the task-6 tests (docs/CMS_AUDIENCE_SYNC_DESIGN.md §6.4, §10.3).
 * Contact semantics are switchable for the M-tests, so the writer is tested against BOTH behaviours:
 *  - m1: 'fail'   — create on an existing address answers 400 "already exists"   (assumed)
 *        'upsert' — create on an existing address silently updates it (and re-activates it)
 *  - m2: 'keep'   — PUT {tags} leaves an unsubscribed contact unsubscribed          (assumed)
 *        'resubscribe' — PUT {tags} re-activates it
 *  - m3: 'append' — PUT {tags} adds to the contact's tags
 *        'replace' — PUT {tags} replaces them
 *  - tagsOut: 'names-csv' (GET returns "a,b") | 'ids-array' (GET returns ["id1","id2"])
 * Tags are stored by NAME; requests may name tags by name (PUT/create) or by id (tag/remove).
 * Auth: `Authorization` must equal the key exactly (no "Bearer"). Records every request.
 */
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type FakeContact = { id: string; email: string; status: 'active' | 'unsubscribed'; tags: Set<string>; lists: Set<string> };
export type FakeRequest = { method: string; path: string; body: unknown };

export class FakeMailercloud {
  m1: 'fail' | 'upsert' = 'fail';
  m2: 'keep' | 'resubscribe' = 'keep';
  m3: 'append' | 'replace' = 'append';
  tagsOut: 'names-csv' | 'ids-array' = 'names-csv';
  contacts = new Map<string, FakeContact>();
  tags: { id: string; tag_name: string; contact_count?: number }[] = [];
  segments: { id: string; name: string; active_count: number }[] = [];
  requests: FakeRequest[] = [];
  /** Next N requests (any path) answer this status. */
  failNext: { status: number; times: number; body?: unknown } | null = null;
  /** Requests about these addresses answer this status (every time) — one member failing, not the whole API. */
  failEmails = new Map<string, number>();
  /** Called before a create is answered (to simulate the M-1 race). */
  beforeCreate: ((email: string) => void) | null = null;
  private server: Server | null = null;
  private seq = 0;

  constructor(private readonly key: string) {}

  tagName(idOrName: string): string {
    return this.tags.find((t) => t.id === idOrName)?.tag_name ?? idOrName;
  }

  addContact(email: string, opts: { status?: 'active' | 'unsubscribed'; tags?: string[]; list?: string } = {}): FakeContact {
    const c: FakeContact = { id: `c${++this.seq}`, email, status: opts.status ?? 'active', tags: new Set(opts.tags ?? []), lists: new Set(opts.list ? [opts.list] : ['hand-list']) };
    this.contacts.set(email, c);
    return c;
  }

  async start(): Promise<string> {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      this.requests.push({ method: req.method, path: req.path, body: req.body });
      if (req.get('Authorization') !== this.key) {
        res.status(401).json({ errors: [{ field: '', message: 'Authorization failed' }] });
        return;
      }
      if (this.failNext && this.failNext.times > 0) {
        this.failNext.times -= 1;
        res.status(this.failNext.status).json(this.failNext.body ?? { error: { message: 'injected' } });
        return;
      }
      const about = req.method === 'GET' || req.method === 'PUT' ? decodeURIComponent(req.path.split('/').pop() ?? '') : String((req.body as Record<string, unknown>)?.email ?? (req.body as Record<string, unknown>)?.id ?? '');
      const status = this.failEmails.get(about);
      if (status !== undefined) {
        res.status(status).json({ errors: [{ field: '', message: 'injected for one address' }] });
        return;
      }
      next();
    });
    app.get('/v1/contacts/:id', (req, res) => {
      const c = this.contacts.get(req.params.id);
      if (!c) {
        res.status(404).json({ errors: [{ field: 'id', message: 'Record not found with the given Id' }] });
        return;
      }
      const names = [...c.tags];
      const tags = this.tagsOut === 'names-csv' ? names.join(',') : names.map((n) => this.tags.find((t) => t.tag_name === n)?.id ?? n);
      res.json({ data: { id: c.id, email: c.email, tags } });
    });
    app.post('/v1/contacts', (req, res) => {
      const b = req.body as Record<string, unknown>;
      const email = String(b.email);
      this.beforeCreate?.(email);
      const existing = this.contacts.get(email);
      if (existing) {
        if (this.m1 === 'fail') {
          res.status(400).json({ error: { field: 'email', message: 'Contact already exists' } });
          return;
        }
        // upsert behaviour: updates the contact and (contact_type default active) re-activates it.
        existing.status = 'active';
        for (const t of (b.tags as string[]) ?? []) existing.tags.add(this.tagName(t));
        existing.lists.add(String(b.list_id));
        res.status(201).json({ id: existing.id });
        return;
      }
      const c = this.addContact(email, { tags: ((b.tags as string[]) ?? []).map((t) => this.tagName(t)), list: String(b.list_id) });
      if (b.contact_type && b.contact_type !== 'active') c.status = 'unsubscribed';
      res.status(201).json({ id: c.id });
    });
    app.put('/v1/contacts/:id', (req, res) => {
      const c = this.contacts.get(req.params.id);
      if (!c) {
        res.status(404).json({ errors: [{ field: 'id', message: 'Record not found with the given Id' }] });
        return;
      }
      const b = req.body as Record<string, unknown>;
      if (Array.isArray(b.tags)) {
        const names = (b.tags as string[]).map((t) => this.tagName(t));
        if (this.m3 === 'replace') c.tags = new Set(names);
        else for (const n of names) c.tags.add(n);
        if (this.m2 === 'resubscribe') c.status = 'active';
      }
      if (b.contact_type === 'active') c.status = 'active';
      res.json({ message: 'Contact updated' });
    });
    app.post('/v1/contact/tag/remove', (req, res) => {
      const b = req.body as Record<string, unknown>;
      const c = this.contacts.get(String(b.id));
      if (!c) {
        res.status(400).json({ error: 'Contact does not exist' });
        return;
      }
      for (const t of (b.tag_ids as string[]) ?? []) c.tags.delete(this.tagName(t));
      res.json({ message: 'Contact tag removed successfully' });
    });
    app.post('/v1/tags/search', (_req, res) => res.json({ count: this.tags.length, data: this.tags }));
    app.post('/v1/segment/search', (_req, res) => res.json({ count: this.segments.length, data: this.segments }));
    app.use((req, res) => res.status(405).json({ error: `unexpected ${req.method} ${req.path}` }));
    await new Promise<void>((resolve) => {
      this.server = app.listen(0, '127.0.0.1', () => resolve());
    });
    return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}/v1`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}
