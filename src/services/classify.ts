/**
 * Editorial classifier for the RSS push pipeline (SEND_PACING_PLAN.md §2).
 *
 * Decides, from an article TITLE alone, whether a push is allowed. taxscan
 * titles name the issuing court/authority unambiguously (e.g.
 * "…: CESTAT [Read Order]", "Supreme Court …"), so a deterministic, priority-
 * ordered keyword match is reliable. CMS category tags are NOT used — they are
 * coarse WordPress sections ("Income Tax,Top Stories"), not the authority.
 *
 * Output queue:
 *   - QUALIFIED : allow-list authority → auto-eligible for sending.
 *   - FALLBACK  : ITAT/CESTAT/NCLAT/NCLT → sent ONLY as filler when nothing
 *                 qualified is pending (decision D2 / §5).
 *   - REVIEW    : no authority matched (mostly analytical/explainer articles)
 *                 → held for an editor to approve (§6).
 *
 * `tier` ranks QUALIFIED items for slot selection (lower = higher priority):
 *   1 Supreme Court, 2 High Court, 3 regulatory/announcement. FALLBACK/REVIEW
 *   get a high number so they never outrank qualified content.
 *
 * The lists are intentionally simple module constants for now; moving them to
 * env/config (so editors can tweak without a deploy) is a planned follow-up.
 */

export type SendQueue = 'QUALIFIED' | 'FALLBACK' | 'REVIEW';

export type Classification = {
  queue: SendQueue;
  /** Matched issuing authority, or null when nothing matched (REVIEW). */
  authority: string | null;
  /** Priority for slot selection among QUALIFIED items; lower = more important. */
  tier: number;
};

const REVIEW_TIER = 50;
const FALLBACK_TIER = 90;

type Rule = { authority: string; queue: SendQueue; tier: number; re: RegExp };

/**
 * Priority-ordered. The FIRST matching rule wins, so higher courts are listed
 * before the tribunals — a title naming both (e.g. "CESTAT … Jharkhand HC
 * Directs …") resolves to the operative higher authority (High Court → SEND).
 */
const RULES: Rule[] = [
  { authority: 'Supreme Court', queue: 'QUALIFIED', tier: 1, re: /\bsupreme court\b|\bSC\b/i },
  { authority: 'High Court', queue: 'QUALIFIED', tier: 2, re: /\bhigh court\b|\bHC\b/i },
  { authority: 'ICAI', queue: 'QUALIFIED', tier: 3, re: /\bICAI\b/i },
  { authority: 'CBDT', queue: 'QUALIFIED', tier: 3, re: /\bCBDT\b/i },
  { authority: 'CBIC', queue: 'QUALIFIED', tier: 3, re: /\bCBIC\b/i },
  { authority: 'DGFT', queue: 'QUALIFIED', tier: 3, re: /\bDGFT\b/i },
  { authority: 'IBBI', queue: 'QUALIFIED', tier: 3, re: /\bIBBI\b/i },
  { authority: 'GSTAT', queue: 'QUALIFIED', tier: 3, re: /\bGSTAT\b/i },
  {
    authority: 'PMLA',
    queue: 'QUALIFIED',
    tier: 3,
    re: /\bPMLA\b|prevention of money laundering/i,
  },
  {
    authority: 'ITAT',
    queue: 'FALLBACK',
    tier: FALLBACK_TIER,
    re: /\bITAT\b|income tax appellate tribunal/i,
  },
  { authority: 'CESTAT', queue: 'FALLBACK', tier: FALLBACK_TIER, re: /\bCESTAT\b/i },
  { authority: 'NCLAT', queue: 'FALLBACK', tier: FALLBACK_TIER, re: /\bNCLAT\b/i },
  { authority: 'NCLT', queue: 'FALLBACK', tier: FALLBACK_TIER, re: /\bNCLT\b/i },
];

export function classify(title: string): Classification {
  const t = (title ?? '').trim();
  for (const r of RULES) {
    if (r.re.test(t)) return { queue: r.queue, authority: r.authority, tier: r.tier };
  }
  return { queue: 'REVIEW', authority: null, tier: REVIEW_TIER };
}
