import { Router } from 'express';
import { requireBearerOrUser } from '../lib/auth';
import type { DigestEnv } from '../lib/env';
import { digestStatus } from '../services/digest/status';

/**
 * Email digest routes (docs/EMAIL_DIGEST_DESIGN.md §6), mounted at
 * `/api/digest`. Task 6 adds only `GET /status`; the Digests screen's routes
 * arrive with task 7.
 */
export type DigestRouterOptions = {
  /** Tests inject config, clock and portal; production reads env and the wall clock. */
  cfg?: DigestEnv;
  clock?: () => Date;
  portal?: string;
};

export function createDigestRouter(opts: DigestRouterOptions = {}): Router {
  const router = Router();

  // Banner + Today card payload. Any logged-in user or the ADMIN_TOKEN bearer,
  // like /api/backup-status. No reader data, no html bodies.
  router.get('/status', requireBearerOrUser(), async (_req, res, next) => {
    try {
      const payload = await digestStatus({
        ...(opts.cfg ? { cfg: opts.cfg } : {}),
        ...(opts.portal ? { portal: opts.portal } : {}),
        now: opts.clock ? opts.clock() : new Date(),
      });
      res.setHeader('Cache-Control', 'no-store');
      return res.json(payload);
    } catch (err) {
      return next(err);
    }
  });

  return router;
}
