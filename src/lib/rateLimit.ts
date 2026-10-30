import { isIP } from 'node:net';
import rateLimit, { ipKeyGenerator, type RateLimitRequestHandler } from 'express-rate-limit';
import type { Request } from 'express';
import { requestClientIp } from './clientIp';

export type RateLimitOptions = {
  publicPerMin?: number;
  loginPerMin?: number;
};

/**
 * Public endpoint limiter — for /api/subscribe, /api/track, /api/unsubscribe,
 * /api/config. Counts per IP. Burst-tolerant for legitimate readers; blocks
 * obvious automation.
 */
/**
 * The bucket a request counts against: the REAL client (`requestClientIp`), not `req.ip` — behind Cloudflare and
 * Railway's two hops `req.ip` is a handful of shared Railway addresses, so every reader would share one bucket.
 * IPv6 clients are grouped by /56 (`ipKeyGenerator`), as the library recommends. An unreadable client shares one
 * `'unknown'` bucket: it fails towards limiting, never towards unlimited.
 */
export function clientKey(req: Request): string {
  const ip = requestClientIp(req);
  if (ip === null) return 'unknown';
  return isIP(ip) === 6 ? ipKeyGenerator(ip) : ip;
}

/** `xForwardedForHeader` off: reading X-Forwarded-For ourselves, positionally, is the point (see `clientKey`). */
const VALIDATE = { xForwardedForHeader: false } as const;

export function makePublicLimiter(perMin: number): RateLimitRequestHandler {
  return rateLimit({
    windowMs: 60_000,
    max: perMin,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'rate_limited' },
    keyGenerator: clientKey,
    validate: VALIDATE,
  });
}

/**
 * Strict limiter for /api/auth/login — caps brute-force attempts per IP.
 * 5/min by default. A determined attacker can still rotate IPs; the goal here
 * is to make naive brute force infeasible.
 */
export function makeLoginLimiter(perMin: number): RateLimitRequestHandler {
  return rateLimit({
    windowMs: 60_000,
    max: perMin,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: false,
    message: { error: 'rate_limited' },
    keyGenerator: clientKey,
    validate: VALIDATE,
  });
}
