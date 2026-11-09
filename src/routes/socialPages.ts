import { Router } from 'express';
import { requireBearerOrUser } from '../lib/auth';
import { activeSocialPages, type SocialPage } from '../services/social/pages';

/**
 * The social pages Compose can untick for one push (brief 2026-11-09-compose-skip-pages). ADMIN or PUBLISHER, the same people as Compose.
 *
 *   GET /api/social/pages   { pages: [{ key, label }] }   the ACTIVE destinations in display order (LinkedIn pages, Facebook pages,
 *                           WhatsApp); an empty list when no social channel is on. Nothing is hard-coded in the SPA: it renders this.
 *
 * `POST /api/send` takes `socialSkip: string[]` and refuses (400 `unknown_social_page`) any key that is not in this list at send time.
 */
const STAFF = requireBearerOrUser(['ADMIN', 'PUBLISHER']);

export type SocialPagesRouterOptions = { pages?: () => SocialPage[] };

export function createSocialPagesRouter(o: SocialPagesRouterOptions = {}): Router {
  const router = Router();
  const pagesOf = o.pages ?? activeSocialPages;
  router.get('/pages', STAFF, (_req, res) => {
    res.json({ pages: pagesOf() });
  });
  return router;
}
