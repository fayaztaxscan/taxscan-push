import type { DigestAudience } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { AD_SLOTS, isAllowedDigestUrl, withUtm } from './renderer';
import type { FrozenItem } from './builder';
import { istDateOf, istInstant } from './retryPolicy';
import { adUtmContent, forbiddenForAudience } from './adRules';

/**
 * Digest house ads (docs/EMAIL_DIGEST_DESIGN.md §1 defects 11–16, §3, §4
 * `ads.ts`, §7 Ads, §9, §13 task 9).
 *
 * `pickAds()` is the ONE eligibility rule. For each slot an ad is eligible when
 * it is ACTIVE, inside its date window, meant for the audience, allows the
 * slot, links to an allowlisted host (an off-allowlist link is DROPPED here,
 * at render, whatever was accepted at save), has its image, and is not already
 * in this email. Order: topic match (lead stories' category), then priority,
 * then least recently placed. Nothing eligible → the slot's default ad (same
 * filters). No default either → `AdSlotError`, and the build fails closed
 * (`config_invalid` + alert). A slot is never left empty.
 *
 * HARD GUARD: `kind = SUBSCRIPTION` is never placed in a PREMIUM send, whatever
 * its `audience` field says (paid members were shown "Subscribe now — ₹2,599"
 * in the hand-made digest, defect #12). Enforced here, again by the renderer
 * when it draws the ad, and again by the runner at freeze — each fails closed.
 */

export const AD_KINDS = ['HOUSE', 'SUBSCRIPTION', 'RENEWAL'] as const;
export const AD_AUDIENCES = ['ALL', 'FREE_ONLY', 'PREMIUM_ONLY'] as const;
export const AD_STATUSES = ['ACTIVE', 'PAUSED', 'ARCHIVED'] as const;
export type AdKind = (typeof AD_KINDS)[number];
export type AdAudience = (typeof AD_AUDIENCES)[number];
export type AdStatus = (typeof AD_STATUSES)[number];

/** Every slot the template can render, in order. */
export const SLOT_NUMBERS: readonly number[] = AD_SLOTS.map((s) => s.slot);
/** How many MAIN stories set the topic an ad can match. */
export const LEAD_ITEMS_FOR_TOPIC = 3;

export { forbiddenForAudience, adUtmContent };

/** An ad as `pickAds` sees it (the DB row, its image metadata and its last placement). */
export type PoolAd = {
  id: string;
  name: string;
  kind: string;
  headline: string;
  altText: string;
  body: string | null;
  ctaText: string;
  linkUrl: string;
  audience: string;
  topic: string | null;
  slots: number[];
  priority: number;
  isSlotDefault: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
  status: string;
  imageId: string | null;
  image: { id: string; mime: string; width: number; height: number; size: number } | null;
  lastPlacedAt: Date | null;
};

export type Exclusion =
  | 'not_active'
  | 'not_started'
  | 'ended'
  | 'audience'
  | 'subscription_guard'
  | 'slot'
  | 'link_not_allowed'
  | 'image_missing';

/** Why `ad` cannot go in `slot` of the `audience` email at `at`, or null when it can. Pure. */
export function whyIneligible(ad: PoolAd, audience: DigestAudience, slot: number, at: Date): Exclusion | null {
  if (ad.status !== 'ACTIVE') return 'not_active';
  if (ad.startsAt && ad.startsAt.getTime() > at.getTime()) return 'not_started';
  if (ad.endsAt && ad.endsAt.getTime() <= at.getTime()) return 'ended';
  if (forbiddenForAudience(ad.kind, audience)) return 'subscription_guard';
  if (ad.audience === 'FREE_ONLY' && audience !== 'FREE') return 'audience';
  if (ad.audience === 'PREMIUM_ONLY' && audience !== 'PREMIUM') return 'audience';
  if (ad.audience !== 'ALL' && ad.audience !== 'FREE_ONLY' && ad.audience !== 'PREMIUM_ONLY') return 'audience';
  if (ad.slots.length > 0 && !ad.slots.includes(slot)) return 'slot';
  if (!isAllowedDigestUrl(ad.linkUrl)) return 'link_not_allowed';
  if (ad.imageId && !ad.image) return 'image_missing';
  return null;
}

export type Placement = { slot: number; ad: PoolAd; utmContent: string; viaDefault: boolean };

export type SlotResult = {
  slot: number;
  /** Non-default ads that pass every filter for this slot (before "already used"). */
  eligible: number;
  /** Default ads that pass every filter for this slot (before "already used"). */
  defaults: number;
  placement: Placement | null;
};

export class AdSlotError extends Error {
  readonly code = 'ad_slot_unfillable';
  constructor(readonly problems: string[]) {
    super(`ad slot unfillable: ${problems.join('; ')}`);
    this.name = 'AdSlotError';
  }
}

const AUDIENCE_WORD: Record<DigestAudience, string> = { FREE: 'Free', PREMIUM: 'Premium' };

function norm(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

/**
 * Assigns one ad per slot without failing; a slot that cannot be filled gets
 * `placement: null`. Slots with the fewest candidates are filled first, so an
 * ad allowed everywhere does not take the only ad a narrow slot could use.
 */
export function assignAds(input: { slots: readonly number[]; audience: DigestAudience; items: Pick<FrozenItem, 'section' | 'category'>[]; at: Date; pool: PoolAd[] }): SlotResult[] {
  const { audience, at, pool } = input;
  const leadTopics = new Set(
    input.items
      .filter((i) => i.section === 'MAIN')
      .slice(0, LEAD_ITEMS_FOR_TOPIC)
      .map((i) => norm(i.category))
      .filter(Boolean),
  );
  const order = (a: PoolAd, b: PoolAd): number => {
    const ta = a.topic && leadTopics.has(norm(a.topic)) ? 1 : 0;
    const tb = b.topic && leadTopics.has(norm(b.topic)) ? 1 : 0;
    if (ta !== tb) return tb - ta;
    if (a.priority !== b.priority) return b.priority - a.priority;
    const la = a.lastPlacedAt?.getTime() ?? -Infinity;
    const lb = b.lastPlacedAt?.getTime() ?? -Infinity;
    if (la !== lb) return la - lb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };

  const perSlot = [...new Set(input.slots)].map((slot) => {
    const ok = pool.filter((ad) => whyIneligible(ad, audience, slot, at) === null);
    return {
      slot,
      regular: ok.filter((a) => !a.isSlotDefault).sort(order),
      fallback: ok.filter((a) => a.isSlotDefault).sort(order),
    };
  });
  const fillOrder = [...perSlot].sort((a, b) => a.regular.length + a.fallback.length - (b.regular.length + b.fallback.length) || a.slot - b.slot);

  // Depth-first over the slots in fill order, each slot trying its regular ads
  // then its defaults in rank order. The first branch explored IS the greedy
  // pick, so when greedy fills every slot the result is unchanged; when greedy
  // would strand a slot although a complete assignment exists (e.g. slot 1
  // {A,B}, slot 2 {A,C}, slot 3 {B,C} with C > B > A), the search finds it, so
  // the build never fails closed on a pool that can fill every slot, and the
  // coverage check's verdict does not depend on topic/priority/rotation order.
  // Only when no complete assignment exists does it fall back to greedy, whose
  // partial result names the stranded slots. ≤ 3 slots: the search is tiny.
  const choice = (s: (typeof perSlot)[number], ad: PoolAd): Placement => ({
    slot: s.slot,
    ad,
    utmContent: adUtmContent(ad.id, s.slot),
    viaDefault: !s.regular.includes(ad),
  });
  const search = (k: number, used: Set<string>, acc: Placement[]): Placement[] | null => {
    if (k === fillOrder.length) return acc;
    const s = fillOrder[k];
    for (const ad of [...s.regular, ...s.fallback]) {
      if (used.has(ad.id)) continue;
      used.add(ad.id);
      const done = search(k + 1, used, [...acc, choice(s, ad)]);
      used.delete(ad.id);
      if (done) return done;
    }
    return null;
  };
  const placed = new Map<number, Placement>();
  const complete = search(0, new Set<string>(), []);
  if (complete) {
    for (const p of complete) placed.set(p.slot, p);
  } else {
    const used = new Set<string>();
    for (const s of fillOrder) {
      const regular = s.regular.find((a) => !used.has(a.id));
      const ad = regular ?? s.fallback.find((a) => !used.has(a.id));
      if (!ad) continue;
      used.add(ad.id);
      placed.set(s.slot, choice(s, ad));
    }
  }
  return perSlot
    .map((s) => ({ slot: s.slot, eligible: s.regular.length, defaults: s.fallback.length, placement: placed.get(s.slot) ?? null }))
    .sort((a, b) => a.slot - b.slot);
}

/** Plain words for an unfillable slot ("Slot 3 — Premium: no eligible ad and no default"). */
export function slotProblem(r: SlotResult, audience: DigestAudience): string | null {
  if (r.placement) return null;
  const head = `Slot ${r.slot} — ${AUDIENCE_WORD[audience]}`;
  if (r.eligible + r.defaults === 0) return `${head}: no eligible ad and no default`;
  return `${head}: its only ads are already used in other slots of the same email; add another ad or a default for this slot`;
}

/**
 * One ad per slot, or `AdSlotError` naming every slot that cannot be filled.
 * Pure. `slots` = the slots this email will actually render.
 */
export function pickAds(input: Parameters<typeof assignAds>[0]): Placement[] {
  const results = assignAds(input);
  const problems = results.map((r) => slotProblem(r, input.audience)).filter((p): p is string => p !== null);
  if (problems.length > 0) throw new AdSlotError(problems);
  const placements = results.map((r) => r.placement as Placement);
  assertPlacementsAllowed(input.audience, placements.map((p) => ({ slot: p.slot, kind: p.ad.kind, linkUrl: p.ad.linkUrl })));
  return placements;
}

/**
 * The guard as a check on finished placements (the renderer and the freeze
 * call it too): no SUBSCRIPTION ad for PREMIUM, every link allowlisted, no ad
 * twice. Throws AdSlotError (fail closed).
 */
export function assertPlacementsAllowed(audience: DigestAudience, placed: { slot: number; kind: string; linkUrl: string; adId?: string }[]): void {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const p of placed) {
    if (forbiddenForAudience(p.kind, audience)) problems.push(`Slot ${p.slot} — ${AUDIENCE_WORD[audience]}: a subscription ad can never go to Premium readers`);
    if (!isAllowedDigestUrl(p.linkUrl)) problems.push(`Slot ${p.slot} — ${AUDIENCE_WORD[audience]}: the ad links to a host that is not on ALLOWED_PUSH_HOSTS`);
    if (p.adId) {
      if (seen.has(p.adId)) problems.push(`Slot ${p.slot} — ${AUDIENCE_WORD[audience]}: the same ad is placed twice`);
      seen.add(p.adId);
    }
  }
  if (problems.length > 0) throw new AdSlotError(problems);
}

/* ------------------------------------------------------------------ */
/* DB                                                                  */
/* ------------------------------------------------------------------ */

/** The portal's ACTIVE ads with their image metadata and last placement (one query each). */
export async function loadAdPool(portal: string): Promise<PoolAd[]> {
  const ads = await prisma.digestAd.findMany({
    where: { portal, status: 'ACTIVE' },
    include: { image: { select: { id: true, mime: true, width: true, height: true, size: true } } },
  });
  if (ads.length === 0) return [];
  const last = await prisma.digestAdPlacement.groupBy({
    by: ['adId'],
    where: { adId: { in: ads.map((a) => a.id) } },
    _max: { createdAt: true },
  });
  const lastBy = new Map(last.map((l) => [l.adId, l._max.createdAt]));
  return ads.map((a) => ({ ...a, lastPlacedAt: lastBy.get(a.id) ?? null }));
}

/* ------------------------------------------------------------------ */
/* Coverage (the Ads screen's check; the same rule as the build)       */
/* ------------------------------------------------------------------ */

export type SlotCoverage = {
  slot: number;
  ok: boolean;
  eligible: number;
  defaults: number;
  /** The ad the next build would place here (with no stories to match topics against). */
  pick: { adId: string; name: string; viaDefault: boolean } | null;
  problem: string | null;
};
export type AdCoverage = {
  ok: boolean;
  /** The instant checked: the next build. */
  checkedFor: string;
  audiences: Record<DigestAudience, { ok: boolean; slots: SlotCoverage[] }>;
  problems: string[];
};

/** The next daily build instant after `now` (today's if it is still ahead). */
export function nextBuildAt(now: Date, buildAtHhmm: string): Date {
  const today = istInstant(istDateOf(now), buildAtHhmm);
  return today.getTime() > now.getTime() ? today : new Date(today.getTime() + 86_400_000);
}

/**
 * Would every slot be filled for both audiences at `at`? Runs the build's own
 * `assignAds` over ALL slots (a slot that renders only on a long digest still
 * needs an ad), with no stories, so topics only reorder and never decide.
 */
export function coverageOf(pool: PoolAd[], at: Date): AdCoverage {
  const audiences = {} as AdCoverage['audiences'];
  const problems: string[] = [];
  for (const audience of ['FREE', 'PREMIUM'] as DigestAudience[]) {
    const results = assignAds({ slots: SLOT_NUMBERS, audience, items: [], at, pool });
    const slots = results.map((r) => {
      const problem = slotProblem(r, audience);
      if (problem) problems.push(problem);
      return {
        slot: r.slot,
        ok: problem === null,
        eligible: r.eligible,
        defaults: r.defaults,
        pick: r.placement ? { adId: r.placement.ad.id, name: r.placement.ad.name, viaDefault: r.placement.viaDefault } : null,
        problem,
      };
    });
    audiences[audience] = { ok: slots.every((s) => s.ok), slots };
  }
  return { ok: problems.length === 0, checkedFor: at.toISOString(), audiences, problems };
}

export async function adCoverage(portal: string, at: Date): Promise<AdCoverage> {
  return coverageOf(await loadAdPool(portal), at);
}

/* ------------------------------------------------------------------ */
/* Save validation (the Ads screen and the API)                        */
/* ------------------------------------------------------------------ */

const text = (max: number, label: string) =>
  z
    .string({ error: `${label} is required` })
    .transform((s) => s.replace(/\s+/g, ' ').trim())
    .pipe(z.string().min(1, `${label} is required`).max(max, `${label} is at most ${max} characters`));
const optionalText = (max: number, label: string) =>
  z
    .string()
    .nullish()
    .transform((s) => (s ?? '').replace(/\s+/g, ' ').trim())
    .pipe(z.string().max(max, `${label} is at most ${max} characters`))
    .transform((s) => (s === '' ? null : s));
const when = (label: string) =>
  z
    .union([z.string(), z.null()])
    .optional()
    .transform((s, ctx) => {
      if (s === undefined || s === null || s.trim() === '') return null;
      const d = new Date(s);
      if (Number.isNaN(d.getTime())) {
        ctx.addIssue({ code: 'custom', message: `${label} is not a date` });
        return z.NEVER;
      }
      return d;
    });

export const AdInputSchema = z
  .object({
    name: text(80, 'Name'),
    kind: z.enum(AD_KINDS, { error: 'Kind must be House, Subscription or Renewal' }),
    headline: text(120, 'Headline'),
    altText: text(150, 'Alt text'),
    body: optionalText(300, 'Body'),
    ctaText: text(30, 'Button text'),
    linkUrl: z.string({ error: 'Link is required' }).trim().min(1, 'Link is required').max(500, 'Link is too long'),
    imageId: z
      .string()
      .regex(/^[a-f0-9]{64}$/, 'Unknown image')
      .nullish()
      .transform((v) => v ?? null),
    audience: z.enum(AD_AUDIENCES, { error: 'Audience must be All, Free only or Premium only' }),
    topic: optionalText(60, 'Topic'),
    slots: z
      .array(z.number().int(), { error: 'Slots must be a list of slot numbers' })
      .default([])
      .refine((a) => a.every((n) => SLOT_NUMBERS.includes(n)), { message: `Slots must be among ${SLOT_NUMBERS.join(', ')}` })
      .transform((a) => [...new Set(a)].sort((x, y) => x - y)),
    priority: z.number({ error: 'Priority must be a number' }).int('Priority must be a whole number').min(0, 'Priority is 0–100').max(100, 'Priority is 0–100').default(0),
    isSlotDefault: z.boolean({ error: 'Default for slot must be true or false' }).default(false),
    startsAt: when('Start'),
    endsAt: when('End'),
    status: z.enum(['ACTIVE', 'PAUSED'], { error: 'Status must be Active or Paused' }).default('ACTIVE'),
  })
  .superRefine((v, ctx) => {
    if (!isAllowedDigestUrl(v.linkUrl)) {
      ctx.addIssue({ code: 'custom', path: ['linkUrl'], message: 'The link must go to taxscan.in, academy.taxscan.in or shop.taxscan.in (ALLOWED_PUSH_HOSTS)' });
    } else if ([...new URL(v.linkUrl).searchParams.keys()].some((k) => k.toLowerCase().startsWith('utm_'))) {
      ctx.addIssue({ code: 'custom', path: ['linkUrl'], message: 'Remove the utm_ parameters from the link; the digest adds its own' });
    }
    if (v.kind === 'SUBSCRIPTION' && v.audience === 'PREMIUM_ONLY') {
      ctx.addIssue({ code: 'custom', path: ['audience'], message: 'A subscription ad can never go to Premium readers' });
    }
    if (v.startsAt && v.endsAt && v.endsAt.getTime() <= v.startsAt.getTime()) {
      ctx.addIssue({ code: 'custom', path: ['endsAt'], message: 'End must be after start' });
    }
  });
export type AdInput = z.infer<typeof AdInputSchema>;

/** The UTM an ad link will carry in slot N of today's Free digest (the Ads screen's preview). */
export function utmPreview(linkUrl: string, adId: string, slot: number, campaign: string): string | null {
  if (!isAllowedDigestUrl(linkUrl)) return null;
  return withUtm(linkUrl, { campaign, content: adUtmContent(adId, slot) });
}

/** The host only — what an audit row may hold (never a full URL). */
export function linkHost(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
