/**
 * A fake CMS door V for the cms-reads tests: a local Express server that serves Feed 2 (A.8) from the rows it is
 * given, verifies OUR signature with `verifyPushGet` against the VIEWS secret ONLY (a request signed with any other
 * secret gets the same 401 the CMS gives), refuses a reused nonce, and can fail a page, never end its cursor, or
 * serve a bad row on demand. Records every request. No network beyond 127.0.0.1.
 */
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { verifyPushGet } from '../lib/cmsSignature';
import { VIEWS_PATH } from '../services/cmsViews/client';
import type { A8Row } from './fixtures/cms-views-a8/rows';

export type RecordedViewsRequest = { path: string; rawQuery: string; ok: boolean; reason?: string; params?: Record<string, string> };

export class FakeViewsCms {
  rows: A8Row[] = [];
  asOf = '2026-10-29T11:07:03+05:30';
  /** Page index (0-based) → HTTP status to answer instead, `times` times (Infinity = always). */
  failPage = new Map<number, { status: number; times: number }>();
  /** Every page carries the SAME next_cursor (a chain that never ends). */
  endlessCursor = false;
  /** Replace the row at this overall index with this raw object (a bad row). */
  badRow: { index: number; row: unknown } | null = null;
  /** Serve this exact (date, article) twice. */
  duplicateFirstRow = false;
  requests: RecordedViewsRequest[] = [];
  private nonces = new Set<string>();
  private hits = new Map<number, number>();
  private server: Server | null = null;

  constructor(private readonly secrets: string[]) {}

  async start(): Promise<string> {
    const app = express();
    app.get(VIEWS_PATH, (req, res) => {
      const rawQuery = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?') + 1) : '';
      const v = verifyPushGet({
        secrets: this.secrets,
        path: req.path,
        rawQuery,
        timestampHeader: req.get('X-Push-Timestamp'),
        signatureHeader: req.get('X-Push-Signature'),
      });
      const rec: RecordedViewsRequest = { path: req.path, rawQuery, ok: v.ok, params: v.ok ? v.params : undefined };
      this.requests.push(rec);
      if (!v.ok || !v.nonce || this.nonces.has(v.nonce)) {
        rec.ok = false;
        rec.reason = v.ok ? 'nonce_reused' : v.reason;
        res.status(401).json({ code: 'UNAUTHORISED' });
        return;
      }
      this.nonces.add(v.nonce);
      const p = v.params ?? {};
      if (!/^\d{4}-\d{2}-\d{2}$/.test(p.from ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(p.to ?? '')) {
        res.status(400).json({ code: 'VALIDATION_ERROR', message: 'from/to' });
        return;
      }
      const limit = Number(p.limit ?? '1000');
      const ENDLESS = 'ZW5kbGVzcw'; // a chain that never ends: after page 1 every page is empty and points at itself
      if (this.endlessCursor && p.cursor === ENDLESS) {
        res.status(200).json({ data: [], meta: { next_cursor: ENDLESS, as_of: this.asOf } });
        return;
      }
      const offset = p.cursor ? Number(Buffer.from(p.cursor, 'base64url').toString()) : 0;
      const page = Math.floor(offset / limit);
      const fail = this.failPage.get(page);
      const hits = (this.hits.get(page) ?? 0) + 1;
      this.hits.set(page, hits);
      if (fail && hits <= fail.times) {
        res.status(fail.status).json({ code: 'ERR' });
        return;
      }
      let rows: unknown[] = this.rows.filter((r) => r.date >= p.from && r.date <= p.to).sort((a, b) => (a.date === b.date ? (a.article_id < b.article_id ? -1 : 1) : a.date < b.date ? -1 : 1));
      if (this.duplicateFirstRow && rows.length > 0) rows = [rows[0], ...rows];
      if (this.badRow) rows = rows.map((r, i) => (i === this.badRow!.index ? this.badRow!.row : r));
      const data = rows.slice(offset, offset + limit);
      const more = offset + limit < rows.length;
      const next = this.endlessCursor ? ENDLESS : more ? Buffer.from(String(offset + limit)).toString('base64url') : null;
      res.status(200).json({ data, meta: { next_cursor: next, as_of: this.asOf } });
    });
    await new Promise<void>((resolve) => {
      this.server = app.listen(0, '127.0.0.1', () => resolve());
    });
    return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  reset(): void {
    this.failPage.clear();
    this.hits.clear();
    this.endlessCursor = false;
    this.badRow = null;
    this.duplicateFirstRow = false;
    this.requests = [];
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}
