// Target thresholds from the "What good looks like" README section.
// Each metric has a band: good (green) / warn (amber) / bad (red).
// `null` data (denominator = 0) is `neutral` (grey).

export type Band = 'good' | 'warn' | 'bad' | 'neutral';

type Threshold = { good: number; warn: number; inverse?: boolean };

export const THRESHOLDS: Record<
  'optInRate' | 'ctr' | 'unsubscribeRate' | 'deliveryRate',
  Threshold
> = {
  // Higher is better:
  optInRate: { good: 0.05, warn: 0.03 }, // ≥5% target
  ctr: { good: 0.06, warn: 0.04 }, // ≥4–6% target
  deliveryRate: { good: 0.95, warn: 0.9 }, // ≥95% target
  // Lower is better:
  unsubscribeRate: { good: 0.005, warn: 0.01, inverse: true }, // <0.5% target
};

export function classify(value: number | null | undefined, t: Threshold): Band {
  if (value === null || value === undefined || Number.isNaN(value)) return 'neutral';
  if (t.inverse) {
    if (value < t.good) return 'good';
    if (value < t.warn) return 'warn';
    return 'bad';
  }
  if (value >= t.good) return 'good';
  if (value >= t.warn) return 'warn';
  return 'bad';
}

export function pct(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return (value * 100).toFixed(digits) + '%';
}

export function bandTooltip(name: keyof typeof THRESHOLDS): string {
  const t = THRESHOLDS[name];
  if (t.inverse) {
    return `Target: < ${(t.good * 100).toFixed(1)}% · Warning: < ${(t.warn * 100).toFixed(1)}%`;
  }
  return `Target: ≥ ${(t.good * 100).toFixed(0)}% · Warning: ≥ ${(t.warn * 100).toFixed(0)}%`;
}
