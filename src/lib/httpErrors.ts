import type { NextFunction, Request, Response } from 'express';
import { AUDIENCE_SECRET_NAMES, env } from './env';
import { redactText } from './redact';

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
  404: 'not_found',
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

/** Secrets a log line must never repeat verbatim (each ≥ 8 chars is masked by `redactText`). */
export function logSecrets(): string[] {
  return [
    env.adminToken,
    env.sessionCookieSecret,
    env.email.apiKey,
    env.digest.mailercloud.apiKey,
    env.digest.mailercloud.webhookToken,
    env.digest.mailercloud.webhookTokenPrevious,
    // CMS audience sync (design §8.2: `redactText` gets every secret).
    env.audience.cms.inboundSecret,
    env.audience.cms.inboundSecretPrevious,
    env.audience.cms.pullSecret,
    env.audience.mailercloud.syncApiKey,
    // The RAW values as well: one under 32 characters counts as unset above, yet is still a secret.
    ...AUDIENCE_SECRET_NAMES.map((name) => (process.env[name] ?? '').trim()),
  ].filter((x, i, all): x is string => typeof x === 'string' && x !== '' && all.indexOf(x) === i);
}

/**
 * A Prisma client error (known request, validation, unknown request, init, panic). Their
 * messages quote the query's arguments — a validation error prints the whole `where`/`data`
 * object, which can hold an email address or a subscription endpoint — so only the
 * structured fields are ever logged.
 */
function isPrismaError(e: ErrLike & { clientVersion?: unknown }): boolean {
  return (typeof e.name === 'string' && e.name.startsWith('PrismaClient')) || typeof e.clientVersion === 'string';
}

/** Only the "    at …" frames: a stack's first line repeats the message. */
function framesOnly(stack: string): string {
  return stack
    .split('\n')
    .filter((l) => /^\s+at\s/.test(l))
    .join('\n');
}

/**
 * What a log line may hold about an error, and nothing more:
 *  - a Prisma error: name, code, `meta.target` / `meta.modelName` and the stack frames —
 *    NEVER its message (it quotes query arguments; 2026-10-23);
 *  - anything else: name, message (passed through the email/secret redactor), type, status,
 *    and the stack when asked (redacted the same way — its first line repeats the message).
 * Never the object itself, so a `body`, `rawBody`, request or response hung on the error is
 * never written out.
 */
export function safeErrorLog(err: unknown, opts: { stack?: boolean } = {}): Record<string, unknown> {
  if (!err || typeof err !== 'object') return { message: redactText(String(err), logSecrets()) };
  const e = err as ErrLike & { code?: unknown; meta?: unknown; clientVersion?: unknown };
  const out: Record<string, unknown> = {};
  if (typeof e.name === 'string') out.name = e.name;
  if (isPrismaError(e)) {
    if (typeof e.code === 'string') out.code = e.code;
    const meta = e.meta && typeof e.meta === 'object' ? (e.meta as Record<string, unknown>) : null;
    if (meta) {
      const target = meta.target;
      if (typeof target === 'string' || (Array.isArray(target) && target.every((t) => typeof t === 'string'))) out.target = target;
      if (typeof meta.modelName === 'string') out.model = meta.modelName;
    }
    if (opts.stack && typeof e.stack === 'string') out.stack = framesOnly(e.stack);
    return out;
  }
  if (typeof e.message === 'string') out.message = redactText(e.message, logSecrets());
  if (typeof e.type === 'string') out.type = e.type;
  const status = typeof e.status === 'number' ? e.status : typeof e.statusCode === 'number' ? e.statusCode : undefined;
  if (status !== undefined) out.status = status;
  if (typeof e.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(e.code)) out.code = e.code;
  // The stack's first line repeats the message: redacted the same way.
  if (opts.stack && typeof e.stack === 'string') out.stack = redactText(e.stack, logSecrets());
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
