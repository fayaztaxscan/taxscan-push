/**
 * A fake CMS door L for the task-5 tests (docs/CMS_AUDIENCE_SYNC_DESIGN.md §10.3): a local Express
 * server that serves the paged subscriber list with `next_cursor` / `as_of` (and optional
 * `meta.counts`), verifies OUR signature with `verifyPushGet` (the CMS side of the contract) and
 * refuses a reused nonce, and can fail, truncate or redirect on demand. Records every request.
 */
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { verifyPushGet } from '../lib/cmsSignature';
import { LIST_PATH } from '../services/audience/cmsClient';

export type ListRow = Record<string, unknown> & { account_id: string; updated_at: string };

export type RecordedRequest = {
  path: string;
  rawQuery: string;
  ok: boolean;
  reason?: string;
  params?: Record<string, string>;
};

export class FakeCms {
  rows: ListRow[] = [];
  asOf = '2027-01-11T02:05:00+05:30';
  counts: Record<string, number> | null = null;
  /** Page index (0-based) → HTTP status to answer instead, `times` times (Infinity = always). */
  failPage = new Map<number, { status: number; times: number }>();
  /** Answer `next_cursor: null` after this page index (a truncated feed). */
  stopAfterPage: number | null = null;
  /** The last page still carries a `next_cursor` (the same one again: a feed that never ends). */
  lastPageKeepsCursor = false;
  /** Hold every answer this long (a hung CMS, for the client's timeout). */
  delayMs = 0;
  /** Answer every request with a redirect. */
  redirectTo: string | null = null;
  requests: RecordedRequest[] = [];
  private nonces = new Set<string>();
  private server: Server | null = null;
  private pageHits = new Map<number, number>();

  constructor(
    private readonly secrets: string[],
    private readonly prefix = '',
  ) {}

  setRows(rows: ListRow[]): void {
    this.rows = [...rows].sort((a, b) => (a.updated_at === b.updated_at ? (a.account_id < b.account_id ? -1 : 1) : a.updated_at < b.updated_at ? -1 : 1));
  }

  async start(): Promise<string> {
    const app = express();
    app.get(`${this.prefix}${LIST_PATH}`, (req, res) => {
      const rawQuery = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?') + 1) : '';
      const v = verifyPushGet({
        secrets: this.secrets,
        path: req.path,
        rawQuery,
        timestampHeader: req.get('X-Push-Timestamp'),
        signatureHeader: req.get('X-Push-Signature'),
      });
      const rec: RecordedRequest = { path: req.path, rawQuery, ok: v.ok, params: v.ok ? v.params : undefined };
      this.requests.push(rec);
      if (!v.ok || !v.nonce || this.nonces.has(v.nonce)) {
        rec.ok = false;
        rec.reason = v.ok ? 'nonce_reused' : v.reason;
        res.status(401).json({ code: 'UNAUTHORISED' });
        return;
      }
      this.nonces.add(v.nonce);
      if (this.redirectTo) {
        res.redirect(302, this.redirectTo);
        return;
      }
      const p = v.params ?? {};
      const limit = Number(p.limit ?? '1000');
      const offset = p.cursor ? Number(Buffer.from(p.cursor, 'base64url').toString()) : 0;
      const pageIndex = Math.floor(offset / limit);
      const fail = this.failPage.get(pageIndex);
      const hits = (this.pageHits.get(pageIndex) ?? 0) + 1;
      this.pageHits.set(pageIndex, hits);
      if (fail && hits <= fail.times) {
        res.status(fail.status).json({ code: 'ERR' });
        return;
      }
      const since = p.updated_since ? Date.parse(p.updated_since) : null;
      const rows = since === null ? this.rows : this.rows.filter((r) => Date.parse(r.updated_at) >= since);
      const data = rows.slice(offset, offset + limit);
      const more = offset + limit < rows.length && !(this.stopAfterPage !== null && pageIndex >= this.stopAfterPage);
      const next = more ? Buffer.from(String(offset + limit)).toString('base64url') : this.lastPageKeepsCursor ? Buffer.from(String(offset)).toString('base64url') : null;
      const meta: Record<string, unknown> = { next_cursor: next, as_of: this.asOf };
      if (this.counts) meta.counts = this.counts;
      const answer = () => res.status(200).json({ data, meta });
      if (this.delayMs > 0) setTimeout(answer, this.delayMs);
      else answer();
    });
    app.get('/elsewhere', (_req, res) => res.json({ data: [], meta: { next_cursor: null, as_of: this.asOf } }));
    await new Promise<void>((resolve) => {
      this.server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (this.server!.address() as AddressInfo).port;
    return `http://127.0.0.1:${port}${this.prefix}`;
  }

  resetFaults(): void {
    this.failPage.clear();
    this.pageHits.clear();
    this.stopAfterPage = null;
    this.redirectTo = null;
    this.lastPageKeepsCursor = false;
    this.delayMs = 0;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}
