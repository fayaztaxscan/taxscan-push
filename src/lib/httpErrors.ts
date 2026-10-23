import type { NextFunction, Request, Response } from 'express';

/**
 * The app's last error handler, and the one rule for what an error log line
 * may contain.
 *
 * body-parser (express.json / express.raw) rejects a request BEFORE any route
 * runs, with an error that carries the raw request body (`err.body`) and, for
 * a JSON syntax error on Node ≥ 20, a message that quotes part of it. Logging
 * that object wrote reader data (an address, a subscription) to the logs, and
 * the client got a 500 for its own mistake. Now:
 *
 *  - a body-parser error (or any http-errors 4xx) answers its own 4xx with a
 *    small JSON error and logs ONE line: type, status, method and path — never
 *    the body, never the message;
 *  - anything else is a 500 `internal_error`, logged as name, message, type,
 *    status and stack only (`safeErrorLog`) — never the error object itself,
 *    so `body`/`rawBody`/request fields hung on it never reach a log line.
 */

/** body-parser's error types and the status each answers (its own documented mapping). */
const BODY_PARSER_STATUS: Record<string, number> = {
  'entity.too.large': 413,
  'entity.parse.failed': 400,
  'entity.verify.failed': 403,
  'request.aborted': 400,
  'request.size.invalid': 400,
  'parameters.too.many': 413,
  'charset.unsupported': 415,
  'encoding.unsupported': 415,
};

const CODE_OF: Record<number, string> = {
  400: 'bad_request',
  403: 'forbidden',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
};

type ErrLike = { name?: unknown; message?: unknown; type?: unknown; status?: unknown; statusCode?: unknown; expose?: unknown; stack?: unknown };

/** The 4xx a client error should answer, or null for a server error (500). */
export function clientErrorStatus(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as ErrLike;
  const type = typeof e.type === 'string' ? e.type : '';
  if (type in BODY_PARSER_STATUS) return BODY_PARSER_STATUS[type];
  const status = typeof e.status === 'number' ? e.status : typeof e.statusCode === 'number' ? e.statusCode : 0;
  // Other http-errors 4xx (expose: true) — e.g. a raw-body read error on a route parser.
  if (status >= 400 && status < 500 && e.expose === true) return status;
  return null;
}

/** The small JSON error for a client error status. */
export function clientErrorBody(status: number, err: unknown): { error: string } {
  const type = (err as ErrLike | null)?.type;
  if (type === 'entity.parse.failed') return { error: 'invalid_json' };
  return { error: CODE_OF[status] ?? 'bad_request' };
}

/**
 * What a log line may hold about an error: name, message, type, status, and
 * the stack when asked (server errors). Never the object itself, so a `body`,
 * `rawBody`, request or response hung on the error is never written out.
 */
export function safeErrorLog(err: unknown, opts: { stack?: boolean } = {}): Record<string, unknown> {
  if (!err || typeof err !== 'object') return { message: String(err) };
  const e = err as ErrLike;
  const out: Record<string, unknown> = {};
  if (typeof e.name === 'string') out.name = e.name;
  if (typeof e.message === 'string') out.message = e.message;
  if (typeof e.type === 'string') out.type = e.type;
  const status = typeof e.status === 'number' ? e.status : typeof e.statusCode === 'number' ? e.statusCode : undefined;
  if (status !== undefined) out.status = status;
  if (opts.stack && typeof e.stack === 'string') out.stack = e.stack;
  return out;
}

/** The catch-all error handler (mounted last in `createApp`). */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function appErrorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const status = clientErrorStatus(err);
  if (status !== null) {
    const type = (err as ErrLike).type;
    // eslint-disable-next-line no-console
    console.warn(`[http] ${status} ${typeof type === 'string' ? type : 'client_error'} ${req.method} ${req.path}`);
    if (!res.headersSent) res.status(status).json(clientErrorBody(status, err));
    return;
  }
  // eslint-disable-next-line no-console
  console.error('unhandled error:', safeErrorLog(err, { stack: true }));
  if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
}
