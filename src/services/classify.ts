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
 *   - REVIEW    : no authority matched (mostly analytical/explainer articles),
 *                 OR a job/recruitment post (see JOB_RE) — held for an editor
 *                 to decide (§6). Job posts never auto-send, even when the title
 *                 also names an authority (e.g. "ICAI Recruitment").
 *
 * `tier` ranks QUALIFIED items for slot selection (lower = higher priority):
 *   1 Supreme Court, 2 priority High Court (Bombay), 3 any other High Court,
 *   4 regulatory/announcement. FALLBACK/REVIEW get a high number so they never
 *   outrank qualified content.
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

/**
 * Priority high courts: their rulings jump ahead of all other High Courts in
 * the send queue (ranked just below the Supreme Court). Editor-tunable — add an
 * entry to prioritise another bench, e.g.
 *   { authority: 'Delhi High Court', re: /\bdelhi\s+(?:high court|HC)\b/i }.
 */
const PRIORITY_HIGH_COURTS: { authority: string; re: RegExp }[] = [
  { authority: 'Bombay High Court', re: /\bbombay\s+(?:high court|HC)\b/i },
];
const PRIORITY_AUTHORITIES = new Set(PRIORITY_HIGH_COURTS.map((c) => c.authority));

type Rule = { authority: string; queue: SendQueue; tier: number; re: RegExp };

/**
 * Priority-ordered. The FIRST matching rule wins, so the apex authority in a
 * mixed title operates: Supreme Court → priority High Court (Bombay) → any
 * other High Court → regulatory → tribunals. A title naming both a tribunal and
 * a court (e.g. "CESTAT … Jharkhand HC Directs …") resolves to the court.
 */
const RULES: Rule[] = [
  { authority: 'Supreme Court', queue: 'QUALIFIED', tier: 1, re: /\bsupreme court\b|\bSC\b/i },
  ...PRIORITY_HIGH_COURTS.map(
    (c): Rule => ({ authority: c.authority, queue: 'QUALIFIED', tier: 2, re: c.re }),
  ),
  { authority: 'High Court', queue: 'QUALIFIED', tier: 3, re: /\bhigh court\b|\bHC\b/i },
  { authority: 'ICAI', queue: 'QUALIFIED', tier: 4, re: /\bICAI\b/i },
  { authority: 'CBDT', queue: 'QUALIFIED', tier: 4, re: /\bCBDT\b/i },
  { authority: 'CBIC', queue: 'QUALIFIED', tier: 4, re: /\bCBIC\b/i },
  { authority: 'DGFT', queue: 'QUALIFIED', tier: 4, re: /\bDGFT\b/i },
  { authority: 'IBBI', queue: 'QUALIFIED', tier: 4, re: /\bIBBI\b/i },
  { authority: 'GSTAT', queue: 'QUALIFIED', tier: 4, re: /\bGSTAT\b/i },
  {
    authority: 'PMLA',
    queue: 'QUALIFIED',
    tier: 4,
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

/**
 * Job / recruitment posts (taxscan's job-scan content). Matched on strong
 * job-posting signals only — NOT bare "job" (avoids "Job Work under GST", a GST
 * concept). Checked before the authority rules so a recruitment post that also
 * names an authority still goes to an editor rather than auto-sending.
 */
const JOB_RE =
  /\bvacanc(?:y|ies)\b|\bhiring\b|\brecruitment\b|\bwalk[- ]in\b|\binternship\b|\bjob opening/i;

export function classify(title: string): Classification {
  const t = (title ?? '').trim();
  if (JOB_RE.test(t)) return { queue: 'REVIEW', authority: null, tier: REVIEW_TIER };
  for (const r of RULES) {
    if (r.re.test(t)) return { queue: r.queue, authority: r.authority, tier: r.tier };
  }
  return { queue: 'REVIEW', authority: null, tier: REVIEW_TIER };
}

/**
 * Slot-selection priority for a QUALIFIED item, derived from its stored
 * `authority` (lower = more important): Supreme Court → priority High Court
 * (Bombay) → any other High Court → everything else (other allow-list
 * authorities AND editor-approved analytical items, which carry a null
 * authority — decision D5: they rank in the regulatory tier).
 */
export function authorityTier(authority: string | null): number {
  if (authority === 'Supreme Court') return 1;
  if (authority && PRIORITY_AUTHORITIES.has(authority)) return 2;
  if (authority === 'High Court') return 3;
  return 4;
}
