import { Router, type Request, type Response } from 'express';
import type { DigestAudience, DigestTemplate } from '@prisma/client';
import { z } from 'zod';
import { requireBearerOrUser } from '../lib/auth';
import { recordAudit } from '../lib/audit';
import { prisma } from '../lib/prisma';
import type { DigestEnv } from '../lib/env';
import { AdSlotError, loadAdPool, pickAds } from '../services/digest/ads';
import { toRenderAd } from '../services/digest/content';
import type { FrozenItem } from '../services/digest/builder';
import {
  BUILTIN_TEMPLATE_HTML,
  RenderError,
  TEMPLATE_PLACEHOLDERS,
  REQUIRED_PLACEHOLDERS,
  renderDigest,
  renderableMainCount,
  slotsForMainCount,
  type RenderAd,
} from '../services/digest/renderer';
import {
  BUILTIN_NAME,
  TEMPLATE_FORMATS,
  TEMPLATE_SOURCE_MAX,
  TemplateRefused,
  activateTemplate,
  archiveTemplate,
  failedChecks,
  prepareTemplate,
  resolveTemplate,
  revalidate,
  revertTemplate,
  scheduleTemplate,
  templateAuditMeta,
  worstCaseFixture,
  type MjmlCompiler,
  type TemplateValidation,
} from '../services/digest/templates';

/**
 * Digest Templates (docs/EMAIL_DIGEST_DESIGN.md §6, §7 Templates, §9; task 10).
 * Mounted inside `/api/digest`. Any signed-in staff user (ADMIN or PUBLISHER —
 * owner, 29 Oct 2026; reverses the 22 Oct "admins edit templates") or the
 * ADMIN_TOKEN bearer; no session is 401. Templates hold raw HTML (sanitised and
 * previewed under the sandbox CSP).
 *
 *   GET  /templates                       list + what each audience uses now + placeholders + built-in source
 *   GET  /templates/:id                   one, with source and its last checklist
 *   POST /templates                       create a DRAFT (source, or copyFrom an id / "builtin")   DIGEST_TEMPLATE_SAVED
 *   PUT  /templates/:id                   edit a DRAFT (compiles + checks at save)                  DIGEST_TEMPLATE_SAVED
 *   POST /templates/:id/validate          run the checklist again now
 *   GET  /templates/:id/preview           the template filled with recent or worst-case data      (sandbox CSP)
 *   GET  /templates/builtin/preview/:aud  the built-in template, same                              (sandbox CSP)
 *   POST /templates/:id/activate          {confirm} DRAFT → ACTIVE; refused while a check fails    DIGEST_TEMPLATE_ACTIVATED
 *   POST /templates/:id/schedule          {startsAt, endsAt} DRAFT → SCHEDULED override            DIGEST_TEMPLATE_ACTIVATED (mode scheduled)
 *   POST /templates/:id/archive           {confirm} DRAFT/SCHEDULED → ARCHIVED                     DIGEST_TEMPLATE_ARCHIVED
 *   POST /templates/revert/:audience      {confirm} ACTIVE → DRAFT, the one it replaced → ACTIVE   DIGEST_TEMPLATE_REVERTED
 *
 * Audit rows never hold the source or the html: name, audience, status,
 * format, source length, window and which checks failed.
 *
 * Every preview is served with the same sandbox CSP as the frozen-digest
 * preview, for a `sandbox` iframe: template HTML never runs in the SPA origin.
 */
export type DigestTemplatesRouterOptions = {
  cfg: () => DigestEnv;
  clock: () => Date;
  portal: () => string;
  previewCsp: string;
  /** Tests inject an MJML compiler (or null for "not installed"). Default: the installed one, if any. */
  mjml?: MjmlCompiler | null;
};

const STAFF = requireBearerOrUser(['ADMIN', 'PUBLISHER']);
const AUDIENCE = z.enum(['FREE', 'PREMIUM'], { error: 'Audience must be Free or Premium' });

const name = z
  .string({ error: 'Name is required' })
  .transform((s) => s.replace(/\s+/g, ' ').trim())
  .pipe(z.string().min(1, 'Name is required').max(80, 'Name is at most 80 characters'));
const source = z.string({ error: 'Source is required' }).max(TEMPLATE_SOURCE_MAX, `The template is longer than ${TEMPLATE_SOURCE_MAX.toLocaleString('en-IN')} characters`);

const CreateSchema = z.object({
  name,
  audience: AUDIENCE,
  format: z.enum(TEMPLATE_FORMATS, { error: 'Format must be HTML or MJML' }).default('HTML'),
  source: source.optional(),
  copyFrom: z.string().max(64).optional(),
});
const UpdateSchema = z.object({
  name: name.optional(),
  format: z.enum(TEMPLATE_FORMATS, { error: 'Format must be HTML or MJML' }).optional(),
  source: source.optional(),
});
const when = (label: string) =>
  z.string({ error: `${label} is required` }).transform((s, ctx) => {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({ code: 'custom', message: `${label} is not a date` });
      return z.NEVER;
    }
    return d;
  });
const ScheduleSchema = z.object({ startsAt: when('Start'), endsAt: when('End') });

function parseAudience(raw: string): DigestAudience | null {
  const a = raw.toUpperCase();
  return a === 'FREE' || a === 'PREMIUM' ? a : null;
}

/** live | upcoming | ended for a scheduled override at `now`. */
function windowState(t: { startsAt: Date | null; endsAt: Date | null }, now: Date): 'live' | 'upcoming' | 'ended' | null {
  if (!t.startsAt || !t.endsAt) return null;
  if (t.endsAt.getTime() <= now.getTime()) return 'ended';
  if (t.startsAt.getTime() > now.getTime()) return 'upcoming';
  return 'live';
}

export function createDigestTemplatesRouter(o: DigestTemplatesRouterOptions): Router {
  const router = Router();

  const summary = (t: DigestTemplate, now: Date) => {
    const v = t.validation as Partial<TemplateValidation> | null;
    return {
      id: t.id,
      name: t.name,
      audience: t.audience,
      status: t.status,
      format: t.format,
      startsAt: t.startsAt,
      endsAt: t.endsAt,
      window: t.status === 'SCHEDULED' ? windowState(t, now) : null,
      replacesId: t.replacesId,
      activatedAt: t.activatedAt,
      archivedAt: t.archivedAt,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      validationOk: v?.ok === true,
      failed: failedChecks(v as TemplateValidation),
      budgetBytes: v?.budgetBytes ?? null,
      compileError: t.compileError,
    };
  };
  const full = (t: DigestTemplate, now: Date) => ({ ...summary(t, now), source: t.source, validation: t.validation });

  async function listPayload() {
    const now = o.clock();
    const portal = o.portal();
    const rows = await prisma.digestTemplate.findMany({
      where: { portal },
      orderBy: [{ audience: 'asc' }, { updatedAt: 'desc' }],
    });
    const inUse = {} as Record<DigestAudience, { id: string | null; name: string; source: string; endsAt: Date | null }>;
    const revertTo = {} as Record<DigestAudience, { available: boolean; name: string | null }>;
    for (const a of ['FREE', 'PREMIUM'] as DigestAudience[]) {
      const r = await resolveTemplate(a, now, { portal });
      inUse[a] = { id: r.id, name: r.name, source: r.source, endsAt: r.endsAt };
      const active = rows.find((t) => t.audience === a && t.status === 'ACTIVE');
      const prev = active?.replacesId ? rows.find((t) => t.id === active.replacesId) : null;
      revertTo[a] = { available: !!active, name: active ? (prev ? prev.name : BUILTIN_NAME) : null };
    }
    return {
      templates: rows.map((t) => summary(t, now)),
      inUse,
      revertTo,
      placeholders: Object.entries(TEMPLATE_PLACEHOLDERS).map(([key, help]) => ({ key, help, required: REQUIRED_PLACEHOLDERS.includes(key as never) })),
      builtin: { name: BUILTIN_NAME, source: BUILTIN_TEMPLATE_HTML },
    };
  }

  const invalid = (res: Response, issues: { message: string; path?: PropertyKey[] }[]) =>
    res.status(400).json({ error: 'invalid_request', issues: issues.map((i) => ({ message: i.message, path: (i.path ?? []).map(String) })) });

  const refused = (res: Response, err: TemplateRefused) =>
    res.status(err.status).json({ error: err.code, message: err.message, ...(err.validation ? { validation: err.validation } : {}) });

  const find = (id: string) => prisma.digestTemplate.findFirst({ where: { id, portal: o.portal() } });

  const audit = (req: Request, action: 'DIGEST_TEMPLATE_SAVED' | 'DIGEST_TEMPLATE_ACTIVATED' | 'DIGEST_TEMPLATE_ARCHIVED' | 'DIGEST_TEMPLATE_REVERTED', id: string, metadata: Record<string, unknown>) =>
    recordAudit({ userId: req.user?.id ?? null, action, resourceType: 'DigestTemplate', resourceId: id, metadata, ipAddress: req.ip ?? null });

  router.get('/templates', STAFF, async (_req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      return res.json(await listPayload());
    } catch (err) {
      return next(err);
    }
  });

  // The built-in template's preview (registered before /templates/:id so "builtin" is not an id).
  router.get('/templates/builtin/preview/:audience', STAFF, async (req, res, next) => {
    try {
      const audience = parseAudience(req.params.audience);
      if (!audience) return res.status(400).json({ error: 'bad_audience' });
      return await sendPreview(req, res, audience, BUILTIN_TEMPLATE_HTML);
    } catch (err) {
      return next(err);
    }
  });

  router.get('/templates/:id', STAFF, async (req, res, next) => {
    try {
      const t = await find(req.params.id);
      if (!t) return res.status(404).json({ error: 'not_found' });
      res.setHeader('Cache-Control', 'no-store');
      return res.json(full(t, o.clock()));
    } catch (err) {
      return next(err);
    }
  });

  router.post('/templates', STAFF, async (req, res, next) => {
    try {
      const parsed = CreateSchema.safeParse(req.body ?? {});
      if (!parsed.success) return invalid(res, parsed.error.issues);
      const input = parsed.data;
      let src = input.source;
      let format = input.format;
      if (src === undefined && input.copyFrom) {
        if (input.copyFrom === 'builtin') {
          src = BUILTIN_TEMPLATE_HTML;
          format = 'HTML';
        } else {
          const from = await find(input.copyFrom);
          if (!from) return invalid(res, [{ message: 'The template to copy was not found', path: ['copyFrom'] }]);
          src = from.source;
          format = from.format as typeof format;
        }
      }
      if (src === undefined) return invalid(res, [{ message: 'Source is required (or copyFrom)', path: ['source'] }]);
      const now = o.clock();
      const prepared = await prepareTemplate({ audience: input.audience, format, source: src }, { cfg: o.cfg(), now, mjml: o.mjml });
      const t = await prisma.digestTemplate.create({
        data: {
          portal: o.portal(),
          name: input.name,
          audience: input.audience,
          status: 'DRAFT',
          format,
          source: src,
          compiledHtml: prepared.compiledHtml,
          compileError: prepared.compileError,
          validation: prepared.validation as never,
          validatedAt: now,
          createdByUserId: req.user?.id ?? null,
          updatedByUserId: req.user?.id ?? null,
        },
      });
      await audit(req, 'DIGEST_TEMPLATE_SAVED', t.id, templateAuditMeta(t, { created: true, copyFrom: input.copyFrom ?? null, validationOk: prepared.validation.ok, failed: failedChecks(prepared.validation) }));
      return res.status(201).json(full(t, now));
    } catch (err) {
      return next(err);
    }
  });

  router.put('/templates/:id', STAFF, async (req, res, next) => {
    try {
      const existing = await find(req.params.id);
      if (!existing) return res.status(404).json({ error: 'not_found' });
      if (existing.status !== 'DRAFT') {
        return res.status(409).json({ error: 'not_draft', message: `Only a draft can be edited; this template is ${existing.status.toLowerCase()}. Make a copy to change it.` });
      }
      const parsed = UpdateSchema.safeParse(req.body ?? {});
      if (!parsed.success) return invalid(res, parsed.error.issues);
      const input = parsed.data;
      const next_ = { name: input.name ?? existing.name, format: input.format ?? (existing.format as 'HTML' | 'MJML'), source: input.source ?? existing.source };
      const changed = (['name', 'format', 'source'] as const).filter((k) => next_[k] !== existing[k]);
      const now = o.clock();
      const prepared = await prepareTemplate({ audience: existing.audience, format: next_.format, source: next_.source }, { cfg: o.cfg(), now, mjml: o.mjml });
      // Conditional on still DRAFT: a concurrent activation is never undone by a save.
      const r = await prisma.digestTemplate.updateMany({
        where: { id: existing.id, status: 'DRAFT' },
        data: {
          ...next_,
          compiledHtml: prepared.compiledHtml,
          compileError: prepared.compileError,
          validation: prepared.validation as never,
          validatedAt: now,
          updatedByUserId: req.user?.id ?? null,
        },
      });
      if (r.count !== 1) return res.status(409).json({ error: 'not_draft', message: 'This template stopped being a draft a moment ago. Refresh.' });
      const t = await prisma.digestTemplate.findUniqueOrThrow({ where: { id: existing.id } });
      await audit(req, 'DIGEST_TEMPLATE_SAVED', t.id, templateAuditMeta(t, { changed, validationOk: prepared.validation.ok, failed: failedChecks(prepared.validation) }));
      return res.json(full(t, now));
    } catch (err) {
      return next(err);
    }
  });

  router.post('/templates/:id/validate', STAFF, async (req, res, next) => {
    try {
      const t = await find(req.params.id);
      if (!t) return res.status(404).json({ error: 'not_found' });
      const validation = await revalidate(t, { cfg: o.cfg(), now: o.clock() });
      return res.json({ id: t.id, validation });
    } catch (err) {
      return next(err);
    }
  });

  router.get('/templates/:id/preview', STAFF, async (req, res, next) => {
    try {
      const t = await find(req.params.id);
      if (!t) return res.status(404).json({ error: 'not_found' });
      if (!t.compiledHtml) {
        setPreviewHeaders(res);
        return res.status(422).type('text/plain').send(`No preview: ${t.compileError ?? 'the template did not compile.'}`);
      }
      return await sendPreview(req, res, t.audience, t.compiledHtml);
    } catch (err) {
      return next(err);
    }
  });

  router.post('/templates/:id/activate', STAFF, async (req, res, next) => {
    try {
      if (req.body?.confirm !== true) return res.status(400).json({ error: 'confirm_required', message: 'Activating needs confirm: true.' });
      const r = await activateTemplate(req.params.id, { portal: o.portal(), cfg: o.cfg(), now: o.clock() });
      await audit(
        req,
        'DIGEST_TEMPLATE_ACTIVATED',
        r.template.id,
        templateAuditMeta(r.template, { mode: 'active', replacedId: r.replaced?.id ?? null, replacedName: r.replaced?.name ?? BUILTIN_NAME }),
      );
      return res.json({ ok: true, template: full(r.template, o.clock()), ...(await listPayload()) });
    } catch (err) {
      if (err instanceof TemplateRefused) return refused(res, err);
      return next(err);
    }
  });

  router.post('/templates/:id/schedule', STAFF, async (req, res, next) => {
    try {
      const parsed = ScheduleSchema.safeParse(req.body ?? {});
      if (!parsed.success) return invalid(res, parsed.error.issues);
      const r = await scheduleTemplate(req.params.id, parsed.data, { portal: o.portal(), cfg: o.cfg(), now: o.clock() });
      await audit(req, 'DIGEST_TEMPLATE_ACTIVATED', r.template.id, templateAuditMeta(r.template, { mode: 'scheduled' }));
      return res.json({ ok: true, template: full(r.template, o.clock()), ...(await listPayload()) });
    } catch (err) {
      if (err instanceof TemplateRefused) return refused(res, err);
      return next(err);
    }
  });

  router.post('/templates/:id/archive', STAFF, async (req, res, next) => {
    try {
      if (req.body?.confirm !== true) return res.status(400).json({ error: 'confirm_required', message: 'Archiving needs confirm: true.' });
      const r = await archiveTemplate(req.params.id, { portal: o.portal(), now: o.clock() });
      if (r.from !== 'ARCHIVED') await audit(req, 'DIGEST_TEMPLATE_ARCHIVED', r.template.id, templateAuditMeta(r.template, { from: r.from }));
      return res.json({ ok: true, ...(await listPayload()) });
    } catch (err) {
      if (err instanceof TemplateRefused) return refused(res, err);
      return next(err);
    }
  });

  router.post('/templates/revert/:audience', STAFF, async (req, res, next) => {
    try {
      if (req.body?.confirm !== true) return res.status(400).json({ error: 'confirm_required', message: 'Reverting needs confirm: true.' });
      const audience = parseAudience(req.params.audience);
      if (!audience) return res.status(400).json({ error: 'bad_audience' });
      const r = await revertTemplate(audience, { portal: o.portal(), cfg: o.cfg(), now: o.clock() });
      await audit(
        req,
        'DIGEST_TEMPLATE_REVERTED',
        r.from.id,
        templateAuditMeta(r.from, { revertedFromName: r.from.name, restoredId: r.to?.id ?? null, restoredName: r.to?.name ?? BUILTIN_NAME }),
      );
      return res.json({ ok: true, ...(await listPayload()) });
    } catch (err) {
      if (err instanceof TemplateRefused) return refused(res, err);
      return next(err);
    }
  });

  function setPreviewHeaders(res: Response) {
    res.setHeader('Content-Security-Policy', o.previewCsp);
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
  }

  /**
   * Fills `html` with `?data=recent` (the latest frozen stories for the
   * audience, else the worst case) or `?data=worst`, with real ads when the
   * pool can fill the slots, else sample ads. 'check' mode: a template's bad
   * link shows instead of refusing (the checklist names it).
   */
  async function sendPreview(req: Request, res: Response, audience: DigestAudience, html: string) {
    setPreviewHeaders(res);
    const cfg = o.cfg();
    const now = o.clock();
    const fixture = worstCaseFixture(cfg);
    let items: FrozenItem[] = fixture.items;
    if (req.query.data !== 'worst') {
      const recent = await recentItems(o.portal(), audience);
      if (recent.length > 0) items = recent;
    }
    let ads: RenderAd[] = fixture.ads;
    try {
      const slots = slotsForMainCount(renderableMainCount(items));
      ads = pickAds({ slots, audience, items, at: now, pool: await loadAdPool(o.portal()) }).map((p) => toRenderAd(p, cfg.assetBaseUrl));
    } catch (err) {
      if (!(err instanceof AdSlotError)) throw err;
    }
    try {
      const r = renderDigest({
        items,
        audience,
        runDate: now,
        cfg: { ...cfg, postalAddress: cfg.postalAddress || 'Postal address (DIGEST_POSTAL_ADDRESS)' },
        ads,
        template: { html },
        mode: 'check',
        assetBaseUrl: cfg.assetBaseUrl,
      });
      return res.status(200).type('text/html; charset=utf-8').send(r.html);
    } catch (err) {
      if (err instanceof RenderError) return res.status(422).type('text/plain').send(`No preview: ${err.message}`);
      throw err;
    }
  }

  return router;
}

/** The latest frozen story list for `audience` in `portal` (any run that froze items), as the renderer takes it. */
async function recentItems(portal: string, audience: DigestAudience): Promise<FrozenItem[]> {
  const run = await prisma.digestRun.findFirst({
    where: { portal, items: { some: {} } },
    orderBy: { runDate: 'desc' },
    select: { id: true },
  });
  if (!run) return [];
  const rows = await prisma.digestItem.findMany({
    where: { runId: run.id, OR: [{ audience: null }, { audience }] },
    orderBy: { rank: 'asc' },
  });
  return rows.map((r) => ({
    rank: r.rank,
    section: r.section === 'ICYMI' ? 'ICYMI' : 'MAIN',
    articleKey: r.articleKey,
    campaignId: r.campaignId,
    title: r.title,
    url: r.url,
    authority: r.authority,
    category: r.category,
    excerpt: r.excerpt,
    capturedAt: r.capturedAt,
    readRate: r.readRate,
    imageUrl: r.imageUrl,
  }));
}
