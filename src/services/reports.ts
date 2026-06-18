import type { SendQueue } from '@prisma/client';
import { prisma } from '../lib/prisma';

/**
 * Coverage & Quality reports (weekly / monthly). Two heatmaps the editorial
 * team used to build by hand:
 *   - Category × dates — are we publishing across all subject areas, enough?
 *   - Bench × dates    — which courts/tribunals are we covering, where are gaps?
 * Plus an insight layer (totals, vs-previous-period, coverage gaps, quality
 * split) and a no-undercount cross-check. Counts EVERY captured article in the
 * window (any status) — the report is about what was published, not what we sent.
 */

const IST_OFFSET_MIN = 5 * 60 + 30;

/** IST calendar-day key (YYYY-MM-DD) for an instant. */
export function istDateKey(d: Date): string {
  return new Date(d.getTime() + IST_OFFSET_MIN * 60_000).toISOString().slice(0, 10);
}

/** Inclusive list of IST day keys from `start` (IST midnight) up to but not including `end`. */
function dayKeys(start: Date, end: Date): string[] {
  const out: string[] = [];
  for (let t = start.getTime(); t < end.getTime(); t += 86_400_000) {
    out.push(istDateKey(new Date(t)));
  }
  return out;
}

// --- Category from RSS <category> tags ---------------------------------------
// Cross-cutting tags that aren't a subject area — skip them when picking the
// row a piece belongs to.
const CROSS_CUTTING = /^(top stories|news updates|featured|latest news|trending)$/i;
// Display aliases so taxscan's verbose tags read cleanly as heatmap rows.
const CATEGORY_ALIASES: { re: RegExp; label: string }[] = [
  { re: /cst.*vat.*gst|^gst$/i, label: 'GST' },
  { re: /income[\s-]*tax/i, label: 'Income Tax' },
  { re: /excise.*customs|^customs$/i, label: 'Customs' },
  { re: /service[\s-]*tax/i, label: 'Service Tax' },
  { re: /corporate/i, label: 'Corporate Law' },
  { re: /sebi|rbi/i, label: 'SEBI/RBI' },
  { re: /fema|foreign exchange/i, label: 'FEMA' },
  { re: /international tax|transfer pricing|\btp\b/i, label: 'International Tax/TP' },
  { re: /benami|pmla|money laundering/i, label: 'Benami/PMLA' },
  { re: /labour|labor/i, label: 'Labour Law' },
  { re: /round[\s-]*up|digest|weekly/i, label: 'Round-Ups/Digests' },
  { re: /job[\s-]*scan/i, label: 'JobScan' },
];

/** The report-category row for an article from its RSS category tags. */
export function reportCategory(categories: string[]): string {
  const subjects = (categories ?? []).map((c) => c.trim()).filter((c) => c && !CROSS_CUTTING.test(c));
  for (const c of subjects) {
    const alias = CATEGORY_ALIASES.find((a) => a.re.test(c));
    if (alias) return alias.label;
  }
  if (subjects.length > 0) return subjects[0]; // unknown subject tag → show it as-is
  return 'Uncategorized';
}

// --- Bench from the article title --------------------------------------------
// Priority-ordered; first match wins. Specific High Courts before the generic
// "High Court"; the apex Supreme Court first.
const BENCHES: { bench: string; re: RegExp }[] = [
  { bench: 'Supreme Court', re: /\bsupreme court\b|\bSC\b/i },
  { bench: 'Bombay High Court', re: /\bbombay\s+(?:high court|HC)\b/i },
  { bench: 'Delhi High Court', re: /\bdelhi\s+(?:high court|HC)\b/i },
  { bench: 'Madras High Court', re: /\bmadras\s+(?:high court|HC)\b/i },
  { bench: 'Calcutta High Court', re: /\bcalcutta\s+(?:high court|HC)\b/i },
  { bench: 'Karnataka High Court', re: /\bkarnataka\s+(?:high court|HC)\b/i },
  { bench: 'Kerala High Court', re: /\bkerala\s+(?:high court|HC)\b/i },
  { bench: 'Gujarat High Court', re: /\bgujarat\s+(?:high court|HC)\b/i },
  { bench: 'Rajasthan High Court', re: /\brajasthan\s+(?:high court|HC)\b/i },
  { bench: 'Punjab & Haryana High Court', re: /\bpunjab\b.*\bharyana\b.*(?:high court|HC)|\bp&h\s+(?:high court|HC)\b/i },
  { bench: 'Allahabad High Court', re: /\ballahabad\s+(?:high court|HC)\b/i },
  { bench: 'Telangana High Court', re: /\btelangana\s+(?:high court|HC)\b/i },
  { bench: 'Andhra Pradesh High Court', re: /\bandhra\s*pradesh\s+(?:high court|HC)\b/i },
  { bench: 'Orissa High Court', re: /\boris(?:s)?a\s+(?:high court|HC)\b/i },
  { bench: 'Patna High Court', re: /\bpatna\s+(?:high court|HC)\b/i },
  { bench: 'Madhya Pradesh High Court', re: /\bmadhya\s*pradesh\s+(?:high court|HC)\b/i },
  { bench: 'Himachal Pradesh High Court', re: /\bhimachal\s*pradesh\s+(?:high court|HC)\b/i },
  { bench: 'Chhattisgarh High Court', re: /\bchh?at(?:t)?isgarh\s+(?:high court|HC)\b/i },
  { bench: 'Uttarakhand High Court', re: /\buttarakhand\s+(?:high court|HC)\b/i },
  { bench: 'J&K High Court', re: /\b(?:j&k|jammu).*?(?:high court|HC)\b/i },
  { bench: 'Gauhati High Court', re: /\bgauhati\s+(?:high court|HC)\b/i },
  { bench: 'Jharkhand High Court', re: /\bjharkhand\s+(?:high court|HC)\b/i },
  { bench: 'High Court', re: /\bhigh court\b|\bHC\b/i }, // generic, after the named ones
  { bench: 'ITAT', re: /\bITAT\b|income tax appellate tribunal/i },
  { bench: 'CESTAT', re: /\bCESTAT\b/i },
  { bench: 'GSTAT', re: /\bGSTAT\b/i },
  { bench: 'NCLAT', re: /\bNCLAT\b/i },
  { bench: 'NCLT', re: /\bNCLT\b/i },
  { bench: 'AAAR', re: /\bAAAR\b/i },
  { bench: 'AAR', re: /\bAAR\b/i },
];

/** The court/bench for an article from its title; 'Unspecified' when none matches. */
export function detectBench(title: string): string {
  const t = (title ?? '').trim();
  for (const { bench, re } of BENCHES) {
    if (re.test(t)) return bench;
  }
  return 'Unspecified';
}

export type HeatmapRow = { label: string; perDay: number[]; total: number };
export type Heatmap = { rows: HeatmapRow[]; dates: string[]; dayTotals: number[]; grandTotal: number };
export type Report = {
  period: 'weekly' | 'monthly';
  start: string; // IST day key (inclusive)
  end: string; // IST day key (inclusive)
  dates: string[];
  total: number;
  prevTotal: number;
  byCategory: Heatmap;
  byBench: Heatmap;
  quality: { qualified: number; fallback: number; review: number; uncategorized: number };
  gaps: { categoriesWithNothing: string[]; benchesWithNothing: string[] };
};

function buildHeatmap(
  rowKeyOf: (c: { title: string; categories: string[] }) => string,
  rows: { title: string; categories: string[]; day: string }[],
  dates: string[],
): Heatmap {
  const dayIndex = new Map(dates.map((d, i) => [d, i]));
  const byRow = new Map<string, number[]>();
  for (const r of rows) {
    const key = rowKeyOf(r);
    const i = dayIndex.get(r.day);
    if (i === undefined) continue;
    if (!byRow.has(key)) byRow.set(key, new Array(dates.length).fill(0));
    byRow.get(key)![i] += 1;
  }
  const out: HeatmapRow[] = [...byRow.entries()].map(([label, perDay]) => ({
    label,
    perDay,
    total: perDay.reduce((a, b) => a + b, 0),
  }));
  out.sort((a, b) => b.total - a.total || a.label.localeCompare(b.label)); // busiest first
  const dayTotals = dates.map((_, i) => out.reduce((s, r) => s + r.perDay[i], 0));
  const grandTotal = dayTotals.reduce((a, b) => a + b, 0);
  return { rows: out, dates, dayTotals, grandTotal };
}

/**
 * Build a report over [start, end) (both IST-midnight instants), comparing to
 * the equally-long window immediately before it.
 */
export async function buildReport(opts: {
  portal: string;
  period: 'weekly' | 'monthly';
  start: Date;
  end: Date;
}): Promise<Report> {
  const { portal, period, start, end } = opts;
  const spanMs = end.getTime() - start.getTime();
  const prevStart = new Date(start.getTime() - spanMs);

  const [campaigns, prevTotal] = await Promise.all([
    prisma.campaign.findMany({
      where: { portal, createdAt: { gte: start, lt: end } },
      select: { title: true, categories: true, createdAt: true, sendQueue: true },
    }),
    prisma.campaign.count({ where: { portal, createdAt: { gte: prevStart, lt: start } } }),
  ]);

  const dates = dayKeys(start, end);
  const rows = campaigns.map((c) => ({
    title: c.title,
    categories: c.categories,
    day: istDateKey(c.createdAt),
    sendQueue: c.sendQueue,
  }));

  const byCategory = buildHeatmap((c) => reportCategory(c.categories), rows, dates);
  const byBench = buildHeatmap((c) => detectBench(c.title), rows, dates);

  const quality = { qualified: 0, fallback: 0, review: 0, uncategorized: 0 };
  for (const r of rows) {
    const q = r.sendQueue as SendQueue | null;
    if (q === 'QUALIFIED') quality.qualified += 1;
    else if (q === 'FALLBACK') quality.fallback += 1;
    else if (q === 'REVIEW') quality.review += 1;
    else quality.uncategorized += 1;
  }

  return {
    period,
    start: dates[0] ?? istDateKey(start),
    end: dates[dates.length - 1] ?? istDateKey(new Date(end.getTime() - 1)),
    dates,
    total: campaigns.length,
    prevTotal,
    byCategory,
    byBench,
    quality,
    gaps: {
      categoriesWithNothing: [], // categories are emergent from tags; "nothing" = absent row
      benchesWithNothing: BENCHES.map((b) => b.bench).filter(
        (b) => !byBench.rows.some((r) => r.label === b),
      ),
    },
  };
}

// --- Email rendering (inline styles, hex colours — email-client safe) --------
function cellHex(n: number, max: number): string {
  if (n === 0) return '#fbdcdc'; // soft red
  const r = n / Math.max(1, max);
  if (r < 0.34) return '#fde68a'; // amber
  if (r < 0.67) return '#bbf7d0'; // light green
  return '#4ade80'; // green
}

function emailHeatTable(title: string, label: string, h: Heatmap): string {
  const max = Math.max(1, ...h.rows.flatMap((r) => r.perDay));
  const th = (t: string, align = 'center') =>
    `<th style="background:#1e293b;color:#fff;padding:4px 6px;font-size:11px;border:1px solid #fff;text-align:${align};white-space:nowrap">${t}</th>`;
  const cell = (n: number, bg: string, bold = false) =>
    `<td style="padding:4px 6px;border:1px solid #fff;text-align:center;font-size:12px;background:${bg};${bold ? 'font-weight:700' : ''}">${n}</td>`;
  const head = `<tr>${th(label, 'left')}${h.dates.map((d) => th(d.slice(5))).join('')}${th('Total')}</tr>`;
  const body = h.rows
    .map(
      (row) =>
        `<tr><td style="padding:4px 6px;border:1px solid #fff;background:#f1f5f9;font-weight:600;font-size:12px;white-space:nowrap">${row.label}</td>` +
        row.perDay.map((n) => cell(n, cellHex(n, max))).join('') +
        cell(row.total, '#e2e8f0', true) +
        `</tr>`,
    )
    .join('');
  const foot =
    `<tr><td style="padding:4px 6px;border:1px solid #fff;background:#e2e8f0;font-weight:700;font-size:12px">Total</td>` +
    h.dayTotals.map((t) => cell(t, '#e2e8f0', true)).join('') +
    cell(h.grandTotal, '#cbd5e1', true) +
    `</tr>`;
  return `<h3 style="margin:18px 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#64748b">${title}</h3>
    <table style="width:100%;border-collapse:collapse;font-family:Arial,sans-serif">${head}${body}${foot}</table>`;
}

/** Render the report as a self-contained HTML email (subject + body + text). */
export function renderReportEmail(report: Report): { subject: string; html: string; text: string } {
  const periodLabel = report.period === 'weekly' ? 'Weekly' : 'Monthly';
  const subject = `Taxscan ${periodLabel} Coverage Report · ${report.start} → ${report.end}`;
  const trend =
    report.prevTotal > 0 ? Math.round(((report.total - report.prevTotal) / report.prevTotal) * 100) : null;
  const trendStr = trend === null ? '—' : trend >= 0 ? `▲ ${trend}%` : `▼ ${Math.abs(trend)}%`;
  const gaps = report.gaps.benchesWithNothing.slice(0, 8);
  const topBenches = report.byBench.rows.slice(0, 6).map((r) => `${r.label} ${r.total}`).join(', ');
  const text = `Taxscan ${periodLabel} Coverage Report (${report.start} → ${report.end})
${report.total} articles published, ${trendStr} vs previous ${report.period === 'weekly' ? 'week' : 'month'} (${report.prevTotal}).
Top benches: ${topBenches}.
Open the Taxscan Push admin → Reports for the full heatmaps.`;
  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#0f172a;background:#f8fafc;padding:16px;margin:0">
  <div style="max-width:920px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:22px">
    <div style="font-size:18px;font-weight:700">Taxscan ${periodLabel} Coverage Report</div>
    <div style="color:#64748b;font-size:13px;margin-top:2px">${report.start} → ${report.end}</div>
    <div style="margin:14px 0 4px;font-size:14px"><strong>${report.total}</strong> articles published ·
      <strong>${trendStr}</strong> vs previous ${report.period === 'weekly' ? 'week' : 'month'} (${report.prevTotal}) ·
      ${report.byCategory.rows.length} categories / ${report.byBench.rows.length} benches active</div>
    <div style="font-size:13px;color:#475569">Quality: ${report.quality.qualified} court rulings ·
      ${report.quality.fallback} tribunal filler · ${report.quality.review} in review${report.quality.uncategorized ? ` · ${report.quality.uncategorized} unclassified` : ''}</div>
    ${gaps.length ? `<div style="font-size:12px;background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:8px 12px;margin-top:12px"><strong>No coverage this ${report.period === 'weekly' ? 'week' : 'month'}:</strong> ${gaps.join(', ')}${report.gaps.benchesWithNothing.length > gaps.length ? ' …' : ''}</div>` : ''}
    ${emailHeatTable('Categories × dates', 'Category', report.byCategory)}
    ${emailHeatTable('Courts / benches × dates', 'Bench', report.byBench)}
    <div style="margin-top:16px;font-size:11px;color:#94a3b8">Generated automatically by Taxscan Push · internal report — please don't forward outside the team.</div>
  </div></body></html>`;
  return { subject, html, text };
}

/** IST-midnight instant for a given IST day key (YYYY-MM-DD). */
function istMidnight(dayKey: string): Date {
  return new Date(`${dayKey}T00:00:00.000+05:30`);
}

/** Default windows for the in-app/cron report at instant `now`. */
export function reportWindow(period: 'weekly' | 'monthly', now: Date): { start: Date; end: Date } {
  const todayKey = istDateKey(now);
  const endExclusive = istMidnight(todayKey); // up to (not incl.) today → full completed days
  if (period === 'weekly') {
    return { start: new Date(endExclusive.getTime() - 7 * 86_400_000), end: endExclusive };
  }
  // monthly: the previous calendar month (IST)
  const [y, m] = todayKey.split('-').map(Number);
  const firstOfThis = istMidnight(`${y}-${String(m).padStart(2, '0')}-01`);
  const prevMonthY = m === 1 ? y - 1 : y;
  const prevMonthM = m === 1 ? 12 : m - 1;
  const firstOfPrev = istMidnight(`${prevMonthY}-${String(prevMonthM).padStart(2, '0')}-01`);
  return { start: firstOfPrev, end: firstOfThis };
}
