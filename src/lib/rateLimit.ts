import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit';

export type RateLimitOptions = {
  publicPerMin?: number;
  loginPerMin?: number;
};

/**
 * Public endpoint limiter — for /api/subscribe, /api/track, /api/unsubscribe,
 * /api/config. Counts per IP. Burst-tolerant for legitimate readers; blocks
 * obvious automation.
 */
export function makePublicLimiter(perMin: number): RateLimitRequestHandler {
  return rateLimit({
    windowMs: 60_000,
    max: perMin,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'rate_limited' },
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
  });
}
