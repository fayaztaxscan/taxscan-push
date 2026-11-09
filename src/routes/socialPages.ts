import { Router } from 'express';
import { requireBearerOrUser } from '../lib/auth';
import { activeSocialPagesWithPause, type SocialPageState } from '../services/social/pages';

/**
 * The social pages Compose can untick for one push (brief 2026-11-09-compose-skip-pages). ADMIN or PUBLISHER, the same people as Compose.
 *
 *   GET /api/social/pages   { pages: [{ key, label, paused? }] }   the ACTIVE destinations in display order (LinkedIn pages, Facebook pages,
 *                           WhatsApp); an empty list when no social channel is on. Nothing is hard-coded in the SPA: it renders this.
 *
 * `POST /api/send` takes `socialSkip: string[]` and refuses (400 `unknown_social_page`) any key that is not in this list at send time.
 */
const STAFF = requireBearerOrUser(['ADMIN', 'PUBLISHER']);

export type SocialPagesRouterOptions = { pages?: () => SocialPageState[] | Promise<SocialPageState[]> };

export function createSocialPagesRouter(o: SocialPagesRouterOptions = {}): Router {
  const router = Router();
  const pagesOf = o.pages ?? activeSocialPagesWithPause;
  router.get('/pages', STAFF, async (_req, res) => {
    // `paused: true` appears only on a page an ADMIN paused (brief 2026-11-09-social-page-alerts-pause); every other entry is as before.
    res.json({ pages: await pagesOf() });
  });
  return router;
}
