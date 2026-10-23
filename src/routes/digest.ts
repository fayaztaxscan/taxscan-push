import { Router, type Request, type Response } from 'express';
import type { DigestAudience } from '@prisma/client';
import { requireBearerOrUser, requireUser } from '../lib/auth';
import { env, type DigestEnv } from '../lib/env';
import { prisma } from '../lib/prisma';
import { recordAudit } from '../lib/audit';
import { digestStatus } from '../services/digest/status';
import { advanceRun, type DigestTrigger, type SelectItems } from '../services/digest/runner';
import { selectDigest } from '../services/digest/builder';
import { isPastCutoff } from '../services/digest/retryPolicy';
import { createMailercloudSender } from '../services/digest/mailercloud';
import { redactError, type DigestSender } from '../services/digest/sender';
import type { BuildContent } from '../services/digest/renderer';
import { digestActions, digestHistory, digestRunDetail } from '../services/digest/screen';
import { createDigestAdsRouter } from './digestAds';
import { createDigestTemplatesRouter } from './digestTemplates';
import type { MjmlCompiler } from '../services/digest/templates';

/**
 * Email digest routes (docs/EMAIL_DIGEST_DESIGN.md §6), mounted at
 * `/api/digest`. Task 6: `GET /status`. Task 7: the Digests screen's routes.
 *
 * Roles: every logged-in user (ADMIN and PUBLISHER — owner decision, like
 * Push now) may approve, hold, Send now, Retry now and test-send. Approve,
 * hold and test send need a person (a session): an approval is attributed,
 * and a test goes to the viewer's own address. Send now and Retry now also
 * accept the ADMIN_TOKEN bearer (the "bearer curl" door of §2.1).
 *
 * Send now / Retry now add NO send logic: they call `advanceRun`, which
 * enforces every gate (flag, quiet hours, cut-off, approval, one per day,
 * sanity / complaint hold, provider-FAILED terminal, preview only). The route
 * adds auth, audit, the provider-configured check and, for Send now only, the
 * DIGEST_SEND_LIVE refusal. Owner decision (2026-10-23): Retry now works in
 * preview mode too — the runner then resumes a failed variant up to and
 * including the Mailercloud draft and never schedules (`preview_only`).
 *
 * No route returns a reader address or an html body; the html is served only
 * by the preview route, under a CSP that blocks scripts, for a sandboxed iframe.
 */
export type DigestRouterOptions = {
  /** Tests inject config, clock and portal; production reads env and the wall clock. */
  cfg?: DigestEnv;
  clock?: () => Date;
  portal?: string;
  /** Provider client. Default: the real Mailercloud client when MAILERCLOUD_API_KEY is set. */
  sender?: DigestSender;
  /** Builder for a retried failed build. Default: `selectDigest`. */
  selectItems?: SelectItems;
  buildContent?: BuildContent;
  quiet?: { start: string; end: string };
  /** Passed to advanceRun (`false` turns the alert mailer off — tests). */
  alerts?: false;
  /** Minimum seconds between two test sends by one user (default 20). */
  testSendGapSeconds?: number;
  /** Templates: an injected MJML compiler (tests); null = "not installed". Default: the installed one, if any. */
  mjml?: MjmlCompiler | null;
};

/** The CSP on the frozen preview: no scripts, no fetches, no forms; inline styles and https images only. */
export const PREVIEW_CSP = "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; frame-ancestors 'self'; sandbox";

function parseAudience(raw: string): DigestAudience | null {
  const a = raw.toUpperCase();
  return a === 'FREE' || a === 'PREMIUM' ? a : null;
}

const SEND_LIVE_OFF =
  'Sending is switched off (preview only). DIGEST_SEND_LIVE must be on before a digest can be sent.';
const PROVIDER_OFF = 'Mailercloud is not configured (MAILERCLOUD_API_KEY is not set).';

export function createDigestRouter(opts: DigestRouterOptions = {}): Router {
  const router = Router();
  const cfgOf = () => opts.cfg ?? env.digest;
  const nowOf = () => (opts.clock ? opts.clock() : new Date());
  const portalOf = () => opts.portal ?? env.rss.portal;
  const quietOf = () => opts.quiet ?? { start: env.send.quietStart, end: env.send.quietEnd };
  const senderOf = (cfg: DigestEnv): DigestSender | null =>
    opts.sender ?? (cfg.mailercloud.apiKey.trim() ? createMailercloudSender(cfg) : null);
  const lastTestAt = new Map<string, number>();
  const testGapMs = (opts.testSendGapSeconds ?? 20) * 1000;

  const viewerCanTest = (req: Request, cfg: DigestEnv) =>
    Boolean(req.user && cfg.testRecipients.includes(req.user.email.toLowerCase()));

  // Ads (task 9): ADMIN only, works with the digest switched off so ads can be prepared first.
  router.use(createDigestAdsRouter({ cfg: cfgOf, clock: nowOf, portal: portalOf }));
  // Templates (task 10): ADMIN only, raw HTML; previews under the same sandbox CSP as the frozen digest.
  router.use(
    createDigestTemplatesRouter({ cfg: cfgOf, clock: nowOf, portal: portalOf, previewCsp: PREVIEW_CSP, ...(opts.mjml !== undefined ? { mjml: opts.mjml } : {}) }),
  );

  const notEnabled = (res: Response) =>
    res.status(409).json({ error: 'digest_disabled', message: 'The email digest is switched off (DIGEST_ENABLED).' });

  // Banner + Today card payload. Any logged-in user or the ADMIN_TOKEN bearer,
  // like /api/backup-status. No reader data, no html bodies.
  router.get('/status', requireBearerOrUser(), async (_req, res, next) => {
    try {
      const payload = await digestStatus({
        ...(opts.cfg ? { cfg: opts.cfg } : {}),
        ...(opts.portal ? { portal: opts.portal } : {}),
        now: nowOf(),
      });
      res.setHeader('Cache-Control', 'no-store');
      return res.json(payload);
    } catch (err) {
      return next(err);
    }
  });

  // 14-day history (status only carries date + state).
  router.get('/runs', requireBearerOrUser(), async (req, res, next) => {
    try {
      const days = Number(req.query.days ?? 14);
      const runs = await digestHistory({ portal: portalOf(), days: Number.isFinite(days) ? days : 14, now: nowOf(), cfg: cfgOf() });
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ runs });
    } catch (err) {
      return next(err);
    }
  });

  router.get('/runs/:id', requireBearerOrUser(), async (req, res, next) => {
    try {
      const cfg = cfgOf();
      const detail = await digestRunDetail(req.params.id, {
        cfg,
        now: nowOf(),
        quiet: quietOf(),
        providerReady: senderOf(cfg) !== null,
        viewerCanTest: viewerCanTest(req, cfg),
      });
      if (!detail) return res.status(404).json({ error: 'not_found' });
      res.setHeader('Cache-Control', 'no-store');
      return res.json(detail);
    } catch (err) {
      return next(err);
    }
  });

  // The FROZEN html exactly as stored (never re-rendered), for a sandboxed iframe.
  router.get('/runs/:id/preview/:audience', requireBearerOrUser(), async (req, res, next) => {
    try {
      const audience = parseAudience(req.params.audience);
      if (!audience) return res.status(400).json({ error: 'bad_audience' });
      const send = await prisma.digestSend.findUnique({
        where: { runId_audience: { runId: req.params.id, audience } },
        select: { html: true, contentPendingAt: true },
      });
      res.setHeader('Content-Security-Policy', PREVIEW_CSP);
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      if (!send) return res.status(404).type('text/plain').send('No digest for this audience.');
      if (!send.html && send.contentPendingAt) {
        return res.status(409).type('text/plain').send('Not built yet: an ad slot could not be filled. Fix it on the Ads screen, then press Retry now.');
      }
      if (!send.html) return res.status(410).type('text/plain').send('No longer stored: a digest email is kept for 30 days. Its stories, ads and counts are kept.');
      return res.status(200).type('text/html; charset=utf-8').send(send.html);
    } catch (err) {
      return next(err);
    }
  });

  /**
   * Approve / hold: a conditional update, refused once the run is past the point where it matters.
   *
   * Approve covers the run's variants that were frozen at the build. A variant rendered LATER
   * (its ads were fixed after the build) is never covered by the run's approval (owner,
   * 2026-10-23): it is approved only when the request names it in `audiences` — the screen
   * sends the variants it showed as built and waiting — and only if it has content at the
   * instant of the update. So an approval pressed before (or while) a variant was rendered
   * can never count for it; the editor must see it and press Approve again.
   */
  async function setApproval(req: Request, res: Response, kind: 'approve' | 'hold') {
    const cfg = cfgOf();
    if (!cfg.enabled) return notEnabled(res);
    const run = await prisma.digestRun.findUnique({
      where: { id: req.params.id },
      include: {
        sends: {
          select: {
            audience: true,
            state: true,
            lastError: true,
            nextAttemptAt: true,
            mcCampaignId: true,
            contentPendingAt: true,
            ownApprovalRequired: true,
            approvedAt: true,
            adoptedDraftAt: true,
          },
        },
      },
    });
    if (!run) return res.status(404).json({ error: 'not_found' });
    const actions = digestActions({
      cfg,
      now: nowOf(),
      quiet: quietOf(),
      providerReady: true,
      viewerCanTest: false,
      run,
      sends: run.sends.map((s) => ({ ...s, hasHtml: s.contentPendingAt === null })),
    });
    const allowed = kind === 'approve' ? actions.approve.show : actions.hold.show;
    if (!allowed) {
      return res.status(409).json({
        error: 'not_allowed',
        message:
          kind === 'approve'
            ? 'This digest cannot be approved now: it is not waiting for approval, or it is already sent, skipped or past the cut-off.'
            : 'This digest cannot be held now: it is already held, handed to Mailercloud, skipped or past the cut-off.',
      });
    }
    const userId = req.user!.id;
    const now = nowOf();
    if (kind === 'hold') {
      const r = await prisma.digestRun.updateMany({
        where: { id: run.id, approval: { in: ['PENDING', 'APPROVED', 'NOT_REQUIRED'] } },
        data: { approval: 'HELD' },
      });
      if (r.count !== 1) return res.status(409).json({ error: 'changed', message: 'Someone else changed it a moment ago. Refresh.' });
      await recordAudit({
        userId,
        action: 'DIGEST_HELD',
        resourceType: 'DigestRun',
        resourceId: run.id,
        metadata: { runDate: run.runDate.toISOString().slice(0, 10), from: run.approval },
        ipAddress: req.ip ?? null,
      });
      return res.json({ ok: true, approval: 'HELD' });
    }

    const raw: unknown = req.body?.audiences;
    const listed = (Array.isArray(raw) ? raw : []).map((a) => (typeof a === 'string' ? parseAudience(a) : null)).filter((a): a is DigestAudience => a !== null);
    const outcome = await prisma.$transaction(async (tx) => {
      const r = await tx.digestRun.updateMany({
        where: { id: run.id, approval: { in: ['PENDING', 'HELD'] } },
        data: { approval: 'APPROVED', approvedByUserId: userId, approvedAt: now },
      });
      // Only a later-rendered variant that the editor saw (listed) and that has content NOW.
      const stamped = listed.length
        ? await tx.digestSend.updateManyAndReturn({
            where: {
              runId: run.id,
              audience: { in: listed },
              ownApprovalRequired: true,
              approvedAt: null,
              html: { not: null },
              contentPendingAt: null,
              state: { in: ['PENDING', 'CREATED', 'FAILED'] },
            },
            data: { approvedAt: now, approvedByUserId: userId },
            select: { audience: true },
          })
        : [];
      return { runApproved: r.count === 1, variants: stamped.map((x) => x.audience) };
    });
    if (!outcome.runApproved && outcome.variants.length === 0) {
      return res.status(409).json({ error: 'changed', message: 'Nothing was waiting for approval any more (someone else approved it, or it changed). Refresh.' });
    }
    await recordAudit({
      userId,
      action: 'DIGEST_APPROVED',
      resourceType: 'DigestRun',
      resourceId: run.id,
      metadata: {
        runDate: run.runDate.toISOString().slice(0, 10),
        from: run.approval,
        ...(outcome.runApproved ? {} : { scope: 'variant' }),
        ...(outcome.variants.length ? { audiences: outcome.variants } : {}),
      },
      ipAddress: req.ip ?? null,
    });
    return res.json({ ok: true, approval: 'APPROVED', variants: outcome.variants });
  }

  router.post('/runs/:id/approve', requireUser(['ADMIN', 'PUBLISHER']), async (req, res, next) => {
    try {
      return await setApproval(req, res, 'approve');
    } catch (err) {
      return next(err);
    }
  });

  router.post('/runs/:id/hold', requireUser(['ADMIN', 'PUBLISHER']), async (req, res, next) => {
    try {
      return await setApproval(req, res, 'hold');
    } catch (err) {
      return next(err);
    }
  });

  /** Send now / Retry now: one call into the runner, audited whatever it decided. */
  async function door(req: Request, res: Response, trigger: Extract<DigestTrigger, 'send_now' | 'retry'>) {
    const cfg = cfgOf();
    if (!cfg.enabled) return notEnabled(res);
    if (trigger === 'send_now' && req.body?.confirm !== true) {
      return res.status(400).json({ error: 'confirm_required', message: 'Send now must be confirmed.' });
    }
    // Send now is a send: refused while sending is off. Retry now is allowed (drafts only then).
    if (trigger === 'send_now' && !cfg.sendLive) return res.status(409).json({ error: 'send_live_off', message: SEND_LIVE_OFF });
    const sender = senderOf(cfg);
    if (!sender) return res.status(409).json({ error: 'provider_not_configured', message: PROVIDER_OFF });
    const exists = await prisma.digestRun.findUnique({ where: { id: req.params.id }, select: { id: true, runDate: true } });
    if (!exists) return res.status(404).json({ error: 'not_found' });

    const now = nowOf();
    // The runner re-reads this clock right before each schedule() (quiet hours /
    // cut-off). It must be a LIVE clock: a slow create must not let a variant be
    // scheduled after 17:00 on the strength of the request's start time.
    const clock = opts.clock ?? (() => new Date());
    const result = await advanceRun(req.params.id, trigger, {
      sender,
      now,
      clock,
      cfg,
      quiet: quietOf(),
      ...(opts.buildContent ? { buildContent: opts.buildContent } : {}),
      selectItems: opts.selectItems ?? ((run, at) => selectDigest(run, at, { cfg })),
      ...(opts.alerts === false ? { alerts: false as const } : {}),
    });
    await recordAudit({
      userId: req.user?.id ?? null,
      action: trigger === 'send_now' ? 'DIGEST_SEND_NOW' : 'DIGEST_RETRY',
      resourceType: 'DigestRun',
      resourceId: req.params.id,
      metadata: {
        outcome: result.outcome,
        state: result.state,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(cfg.sendLive ? {} : { previewOnly: true }),
        via: req.user ? 'session' : 'bearer',
      },
      ipAddress: req.ip ?? null,
    });
    if (result.outcome === 'refused') {
      return res.status(409).json({ error: 'refused', message: `Not sent: ${result.reason ?? 'refused by the digest rules'}.`, result });
    }
    if (result.outcome === 'not_found') return res.status(404).json({ error: 'not_found' });
    if (result.outcome === 'disabled') return notEnabled(res);
    // A press that ran into the cut-off must not read as "done".
    if (isPastCutoff(clock(), exists.runDate, cfg.cutoff)) {
      const sends = await prisma.digestSend.findMany({ where: { runId: exists.id }, select: { audience: true, state: true } });
      const handed = sends.filter((s) => s.state === 'SCHEDULED' || s.state === 'SENT' || s.state === 'PARTIALLY_SENT');
      if (handed.length < sends.length || sends.length === 0) {
        const names = handed.map((s) => (s.audience === 'FREE' ? 'Free' : 'Premium'));
        return res.status(409).json({
          error: 'cutoff_passed',
          message: handed.length
            ? `Only the ${names.join(' and ')} digest went out; the rest missed the ${cfg.cutoff} IST cut-off and is not sent today.`
            : `Not sent — past the ${cfg.cutoff} IST cut-off. The top stories roll into the next digest.`,
          result,
        });
      }
    }
    return res.json({ ok: true, result });
  }

  router.post('/runs/:id/send-now', requireBearerOrUser(['ADMIN', 'PUBLISHER']), async (req, res, next) => {
    try {
      return await door(req, res, 'send_now');
    } catch (err) {
      return next(err);
    }
  });

  router.post('/runs/:id/retry', requireBearerOrUser(['ADMIN', 'PUBLISHER']), async (req, res, next) => {
    try {
      return await door(req, res, 'retry');
    } catch (err) {
      return next(err);
    }
  });

  // Test send to the viewer's OWN address, only if it is in DIGEST_TEST_RECIPIENTS.
  // Calls only sender.testSend on the variant's existing draft: nothing is created or scheduled.
  router.post('/runs/:id/test-send/:audience', requireUser(['ADMIN', 'PUBLISHER']), async (req, res, next) => {
    try {
      const cfg = cfgOf();
      if (!cfg.enabled) return notEnabled(res);
      const audience = parseAudience(req.params.audience);
      if (!audience) return res.status(400).json({ error: 'bad_audience' });
      const user = req.user!;
      if (!viewerCanTest(req, cfg)) {
        return res.status(403).json({
          error: 'not_a_test_recipient',
          message: 'Test sends go only to addresses in DIGEST_TEST_RECIPIENTS, and yours is not listed.',
        });
      }
      const sender = senderOf(cfg);
      if (!sender) return res.status(409).json({ error: 'provider_not_configured', message: PROVIDER_OFF });
      const send = await prisma.digestSend.findUnique({
        where: { runId_audience: { runId: req.params.id, audience } },
        select: { id: true, mcCampaignId: true, html: true },
      });
      if (!send) return res.status(404).json({ error: 'not_found' });
      if (!send.mcCampaignId) {
        return res.status(409).json({ error: 'no_draft', message: 'The Mailercloud draft has not been created yet.' });
      }
      if (!send.html) return res.status(409).json({ error: 'expired', message: 'No longer stored: a digest email is kept for 30 days. Its stories, ads and counts are kept.' });
      const last = lastTestAt.get(user.id) ?? 0;
      if (Date.now() - last < testGapMs) {
        return res.status(429).json({ error: 'too_soon', message: 'A test was just sent. Wait a few seconds before sending another.' });
      }
      lastTestAt.set(user.id, Date.now());
      try {
        await sender.testSend(send.mcCampaignId, [user.email.toLowerCase()]);
      } catch (err) {
        return res.status(502).json({ error: 'provider_error', message: `Mailercloud refused the test send: ${redactError(err, [cfg.mailercloud.apiKey])}` });
      }
      // The address is not written to the audit row: userId identifies who it went to.
      await recordAudit({
        userId: user.id,
        action: 'DIGEST_TEST_SENT',
        resourceType: 'DigestRun',
        resourceId: req.params.id,
        metadata: { audience },
        ipAddress: req.ip ?? null,
      });
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}
