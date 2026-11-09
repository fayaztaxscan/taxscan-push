import type { Router } from 'express';
import { requireUser } from '../lib/auth';
import { recordAudit } from '../lib/audit';
import { requestClientIp } from '../lib/clientIp';
import { safeErrorLog } from '../lib/httpErrors';
import { NOTE_MAX, cleanNote, clearPause, labelOfEmail, setPause, type SocialChannel } from '../services/social/pause';
import { getPageStatus } from '../services/social/pageStatus';

/**
 * The Pause / Resume switch for ONE social page (brief 2026-11-09-social-page-alerts-pause), mounted on each channel's router so it is only
 * there while the channel is (the router's own gate answers 404 first). ADMIN only (a PUBLISHER gets 403).
 *
 *   POST /api/<channel>/page-pause    { page?, note? }   pause the page (default: the screen's first page). 409 `already_paused`.
 *   POST /api/<channel>/page-resume   { page? }          resume it. 409 `not_paused`.
 *
 * `page` must be one of the channel's ACTIVE pages (400 `invalid_page`); `note` is optional free text up to 200 characters (400
 * `note_too_long`). Both are audited (`SOCIAL_PAGE_PAUSED` / `SOCIAL_PAGE_RESUMED`: who, which page, the note). The answer carries the
 * page's new status. Nothing platform-side is called and no token is touched.
 *
 * The existing per-channel `/resume` (clearing a login / policy / channel STOP) is a different thing and is unchanged.
 */
const ADMIN = requireUser(['ADMIN']);

export type PauseRouteOptions = {
  channel: SocialChannel;
  /** The channel's ACTIVE page names, the screen's default first. */
  pages: () => string[];
  clock: () => Date;
};

export function addPauseRoutes(router: Router, o: PauseRouteOptions): void {
  const pageFrom = (body: unknown): string | null => {
    const wanted = (body as { page?: unknown } | undefined)?.page;
    const pages = o.pages();
    if (wanted === undefined || wanted === '') return pages[0] ?? null;
    return typeof wanted === 'string' && pages.includes(wanted) ? wanted : null;
  };

  router.post('/page-pause', ADMIN, async (req, res) => {
    try {
      const page = pageFrom(req.body);
      if (!page) return res.status(400).json({ error: 'invalid_page' });
      const rawNote = (req.body as { note?: unknown } | undefined)?.note;
      if (rawNote !== undefined && rawNote !== null && typeof rawNote !== 'string') return res.status(400).json({ error: 'invalid_note' });
      const note = cleanNote(rawNote);
      if (note !== null && note.length > NOTE_MAX) return res.status(400).json({ error: 'note_too_long', max: NOTE_MAX });
      const now = o.clock();
      const created = await setPause(o.channel, page, { byUserId: req.user?.id ?? null, by: labelOfEmail(req.user?.email ?? 'an administrator'), note, now });
      if (!created) return res.status(409).json({ error: 'already_paused' });
      await recordAudit({
        userId: req.user?.id ?? null,
        action: 'SOCIAL_PAGE_PAUSED',
        resourceType: 'social_page',
        resourceId: `${o.channel}:${page}`,
        metadata: { channel: o.channel, page, ...(note ? { note } : {}) },
        ipAddress: requestClientIp(req),
      });
      return res.json({ ok: true, status: await getPageStatus(o.channel, page, now) });
    } catch (err) {
      console.error(`[${o.channel}] pause failed`, safeErrorLog(err));
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  router.post('/page-resume', ADMIN, async (req, res) => {
    try {
      const page = pageFrom(req.body);
      if (!page) return res.status(400).json({ error: 'invalid_page' });
      const cleared = await clearPause(o.channel, page);
      if (!cleared) return res.status(409).json({ error: 'not_paused' });
      await recordAudit({
        userId: req.user?.id ?? null,
        action: 'SOCIAL_PAGE_RESUMED',
        resourceType: 'social_page',
        resourceId: `${o.channel}:${page}`,
        metadata: { channel: o.channel, page },
        ipAddress: requestClientIp(req),
      });
      return res.json({ ok: true, status: await getPageStatus(o.channel, page, o.clock()) });
    } catch (err) {
      console.error(`[${o.channel}] resume (page) failed`, safeErrorLog(err));
      return res.status(500).json({ error: 'internal_error' });
    }
  });
}
