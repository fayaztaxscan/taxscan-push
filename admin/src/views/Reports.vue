<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { apiErrorMessage, useApi, type ApiError } from '../composables/useApi';
import { useAuth } from '../composables/useAuth';
import { toPng } from 'html-to-image';
import TrendLine from '../components/TrendLine.vue';

type Heatmap = {
  rows: { label: string; perDay: number[]; total: number }[];
  dates: string[];
  dayTotals: number[];
  grandTotal: number;
};
type Report = {
  period: 'weekly' | 'monthly' | 'custom';
  start: string;
  end: string;
  dates: string[];
  total: number;
  prevTotal: number;
  byCategory: Heatmap;
  byBench: Heatmap;
  quality: { qualified: number; fallback: number; review: number; uncategorized: number };
  gaps: { benchesWithNothing: string[] };
};

// The "Reads" report — pageview aggregates by bench/category over trailing
// windows, built daily on the server from Google Analytics (never at request
// time) and served from its cache. Shares the sheet + heat-table styling so
// Download/Copy image work unchanged.
type ReadsCell = { views: number; articles: number; share: number } | null;
type ReadsRow = { label: string; cells: ReadsCell[] };
type ReadsReport = {
  ready: boolean;
  message?: string;
  generatedAt?: string;
  windows?: { label: string; days: number; siteViews: number; articleViews: number; articlesRead: number }[];
  categories?: ReadsRow[];
  benches?: ReadsRow[];
};

// The "Surfaces" report — how much traffic Google Discover and Google News sent
// us, by category and bench, month by month (or over a custom range).
// UNIT WARNING: these are Google CLICKS and IMPRESSIONS, not pageviews. They are
// never comparable with (and must never be added to) the Reads figures above.
type SurfaceKey = 'DISCOVER' | 'GOOGLE_NEWS';
type SurfaceStat = { clicks: number; impressions: number; articles: number };
/** null = no pickup at all for this row in this column (NOT a synced zero). */
type SurfaceCell = SurfaceStat | null;
type SurfaceRow = { label: string; cells: SurfaceCell[] };
type SurfaceGrid = { surface: SurfaceKey; rows: SurfaceRow[] };
type TopSurfacedArticle = { pagePath: string; title: string; clicks: number; impressions: number };
/** A month, or one side of a custom range. `partial` = Google is still filling it. */
type SurfaceColumn = { key: string; label: string; from: string; to: string; partial: boolean };
type SurfacesReport = {
  ready: boolean;
  message?: string;
  generatedAt?: string;
  mode?: 'months' | 'range';
  columns?: SurfaceColumn[];
  totals?: Record<SurfaceKey, SurfaceStat>[];
  byCategory?: SurfaceGrid[];
  byBench?: SurfaceGrid[];
  topArticles?: Record<SurfaceKey, TopSurfacedArticle[]>;
  compare?: { current: number; base: number };
  topWindow?: { from: string; to: string; label: string };
  dataThrough?: string | null;
  dataFrom?: string | null;
};

const api = useApi();
const { user } = useAuth();
const isAdmin = computed(() => user.value?.role === 'ADMIN');
type Period = 'weekly' | 'monthly' | 'custom' | 'reads' | 'surfaces';
const period = ref<Period>('weekly');

// --- Custom date range (max 30 days, both ends inclusive) -------------------
const MAX_CUSTOM_DAYS = 30;
const customFrom = ref('');
const customTo = ref('');

/** Local calendar day as YYYY-MM-DD (editors are in IST; the server re-validates in IST). */
function dayKey(d: Date): string {
  return d.toLocaleDateString('en-CA');
}
const todayKey = dayKey(new Date());

const customDays = computed(() => {
  if (!customFrom.value || !customTo.value) return null;
  const ms = new Date(customTo.value).getTime() - new Date(customFrom.value).getTime();
  if (Number.isNaN(ms)) return null;
  return Math.round(ms / 86_400_000) + 1;
});
const customError = computed(() => {
  if (!customFrom.value || !customTo.value) return 'Pick both dates.';
  const days = customDays.value;
  if (days === null) return 'Pick valid dates.';
  if (days < 1) return '"From" must be on or before "To".';
  if (customTo.value > todayKey) return 'The range cannot extend into the future.';
  if (days > MAX_CUSTOM_DAYS) return `Max ${MAX_CUSTOM_DAYS} days — this range is ${days}.`;
  return null;
});

type Recipient = { id: string; email: string; active: boolean; createdAt: string };
const recipients = ref<Recipient[]>([]);
const newEmail = ref('');
const recBusy = ref(false);
const recError = ref<string | null>(null);

async function loadRecipients() {
  if (!isAdmin.value) return;
  try {
    const d = await api.get<{ items: Recipient[] }>('/api/report-recipients');
    recipients.value = d.items;
  } catch (e) {
    recError.value = apiErrorMessage(e);
  }
}
async function addRecipient() {
  const email = newEmail.value.trim();
  if (!email) return;
  recBusy.value = true;
  recError.value = null;
  try {
    await api.post('/api/report-recipients', { email });
    newEmail.value = '';
    await loadRecipients();
  } catch (e) {
    recError.value = apiErrorMessage(e);
  } finally {
    recBusy.value = false;
  }
}
async function removeRecipient(r: Recipient) {
  recBusy.value = true;
  recError.value = null;
  try {
    await api.del(`/api/report-recipients/${r.id}`);
    recipients.value = recipients.value.filter((x) => x.id !== r.id);
  } catch (e) {
    recError.value = apiErrorMessage(e);
  } finally {
    recBusy.value = false;
  }
}
const report = ref<Report | null>(null);
const readsReport = ref<ReadsReport | null>(null);
const surfacesReport = ref<SurfacesReport | null>(null);
// Set only when the server says the feature is switched off (404 {error:'disabled'}).
// Kept out of the red error banner: "off" is a state, not a failure.
const surfacesOff = ref<string | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const sheet = ref<HTMLElement | null>(null);

async function load() {
  if (period.value === 'custom' && customError.value) return;
  loading.value = true;
  error.value = null;
  notice.value = null;
  try {
    if (period.value === 'reads') {
      readsReport.value = await api.get<ReadsReport>('/api/reports/reads');
      return;
    }
    if (period.value === 'surfaces') {
      surfacesOff.value = null;
      try {
        const q =
          surfaceRangeOn.value && !surfaceRangeError.value
            ? `?from=${surfFrom.value}&to=${surfTo.value}`
            : '';
        surfacesReport.value = await api.get<SurfacesReport>(`/api/reports/surfaces${q}`);
      } catch (e) {
        // The server returns 404 {error:'disabled'} when the Search Console sync
        // is switched off. That is an expected state, so render it as a calm card
        // rather than letting it fall through to the red error banner.
        const err = e as ApiError;
        if (err?.status === 404 && (err.body as { error?: string } | undefined)?.error === 'disabled') {
          surfacesReport.value = null;
          surfacesOff.value = apiErrorMessage(e);
        } else {
          throw e;
        }
      }
      return;
    }
    const query =
      period.value === 'custom'
        ? `period=custom&from=${customFrom.value}&to=${customTo.value}`
        : `period=${period.value}`;
    report.value = await api.get<Report>(`/api/reports?${query}`);
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    loading.value = false;
  }
}
function setPeriod(p: Period) {
  if (period.value === p) return;
  period.value = p;
  if (p === 'custom' && (!customFrom.value || !customTo.value)) {
    // Sensible starting range: the last 7 days, ending today.
    customTo.value = todayKey;
    customFrom.value = dayKey(new Date(Date.now() - 6 * 86_400_000));
  }
  void load();
}

const trendPct = computed(() => {
  const r = report.value;
  if (!r || r.prevTotal === 0) return null;
  return Math.round(((r.total - r.prevTotal) / r.prevTotal) * 100);
});
const periodTitle = computed(() =>
  report.value?.period === 'weekly' ? 'Weekly' : report.value?.period === 'monthly' ? 'Monthly' : 'Custom',
);
// The unit the vs-previous trend compares against — for custom ranges the
// backend compares to the equally-long window immediately before it.
const prevNoun = computed(() => {
  const r = report.value;
  if (!r) return '';
  if (r.period === 'weekly') return 'week';
  if (r.period === 'monthly') return 'month';
  return `${r.dates.length} days`;
});
const catMax = computed(() => maxOf(report.value?.byCategory));
const benchMax = computed(() => maxOf(report.value?.byBench));
const topGaps = computed(() => (report.value?.gaps.benchesWithNothing ?? []).slice(0, 6));

function maxOf(h?: Heatmap): number {
  let m = 0;
  for (const row of h?.rows ?? []) for (const v of row.perDay) if (v > m) m = v;
  return m;
}
function shortDate(d: string): string {
  return d.slice(5); // MM-DD
}
function rangeLabel(r: Report): string {
  return `${r.start} → ${r.end}`;
}
function cellColor(n: number, max: number): string {
  if (n === 0) return '#fde2e1'; // soft red for zero
  const ratio = Math.min(1, n / Math.max(1, max));
  return `hsl(${Math.round(ratio * 120)}, 62%, 72%)`; // red → yellow → green
}

// --- Reads report helpers ----------------------------------------------------
// Blue sequential intensity (share of the window's article reads) — reads use
// magnitude, not the coverage report's red→green "gap" semantics. sqrt spreads
// the heavy tail; the mix is capped so dark text stays readable on every cell.
const readsMaxShare = computed(() => {
  const r = readsReport.value;
  let m = 0;
  for (const row of [...(r?.categories ?? []), ...(r?.benches ?? [])])
    for (const c of row.cells) if (c && c.share > m) m = c.share;
  return m;
});
function readsCellColor(share: number): string {
  const p = Math.sqrt(share / Math.max(readsMaxShare.value, 0.0001)) * 0.58;
  const mix = (w: number, b: number) => Math.round(w + (b - w) * p);
  return `rgb(${mix(255, 42)}, ${mix(255, 120)}, ${mix(255, 214)})`; // white → #2a78d6
}
function fmtViews(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}
function sharePct(share: number): string {
  return (share * 100).toFixed(1) + '%';
}
const readsAsOf = computed(() => {
  const g = readsReport.value?.generatedAt;
  return g ? new Date(g).toLocaleString() : '';
});

// --- Surfaces report helpers -------------------------------------------------
// `fmtViews` is a plain magnitude abbreviator; aliased here so the Surfaces
// markup never reads as if it were printing "views" (it prints Google clicks
// and impressions, which are a different unit entirely).
const fmtCount = fmtViews;

const SURFACE_KEYS: SurfaceKey[] = ['DISCOVER', 'GOOGLE_NEWS'];
const SURFACE_LABEL: Record<SurfaceKey, string> = {
  DISCOVER: 'Google Discover',
  GOOGLE_NEWS: 'Google News',
};
const EMPTY_STAT: SurfaceStat = { clicks: 0, impressions: 0, articles: 0 };

// --- Surfaces custom range ---------------------------------------------------
// Its own control rather than the coverage tab's "Custom" button: that one
// drives period=custom on a different report with a 30-day ceiling, while this
// range aggregates into a single column and may span a year.
const MAX_SURFACE_RANGE_DAYS = 400;
const surfaceRangeOn = ref(false);
const surfFrom = ref('');
const surfTo = ref('');
const surfaceRangeDays = computed(() => {
  if (!surfFrom.value || !surfTo.value) return null;
  const ms = new Date(surfTo.value).getTime() - new Date(surfFrom.value).getTime();
  if (Number.isNaN(ms)) return null;
  return Math.round(ms / 86_400_000) + 1;
});
const surfaceRangeError = computed(() => {
  if (!surfaceRangeOn.value) return null;
  if (!surfFrom.value || !surfTo.value) return 'Pick both dates.';
  const days = surfaceRangeDays.value;
  if (days === null) return 'Pick valid dates.';
  if (days < 1) return '"From" must be on or before "To".';
  if (surfFrom.value > todayKey) return 'The range cannot start in the future.';
  if (days > MAX_SURFACE_RANGE_DAYS) return `Max ${MAX_SURFACE_RANGE_DAYS} days — this range is ${days}.`;
  return null;
});
function openSurfaceRange() {
  surfaceRangeOn.value = true;
  if (!surfFrom.value || !surfTo.value) {
    // Opens on the last complete month — the span most likely to be asked for,
    // and one that is fully reported rather than still filling.
    const now = new Date();
    const firstOfThis = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastOfPrev = new Date(firstOfThis.getTime() - 86_400_000);
    surfTo.value = dayKey(lastOfPrev);
    surfFrom.value = dayKey(new Date(lastOfPrev.getFullYear(), lastOfPrev.getMonth(), 1));
  }
  void load();
}
function clearSurfaceRange() {
  surfaceRangeOn.value = false;
  void load();
}

const surfaceColumns = computed<SurfaceColumn[]>(() => surfacesReport.value?.columns ?? []);
const surfacesMode = computed(() => surfacesReport.value?.mode ?? 'months');

/**
 * Column headings. In months mode the year is redundant on every column, so it
 * shows only where it changes (the first column and each January) — the reader
 * gets the year without 18 repetitions of it.
 */
const columnHeads = computed(() =>
  surfaceColumns.value.map((c, i) => {
    if (surfacesMode.value !== 'months') return { top: c.label, sub: '', partial: c.partial };
    const [y, m] = c.from.split('-');
    const prevYear = i > 0 ? surfaceColumns.value[i - 1].from.slice(0, 4) : null;
    return {
      top: c.label.split(' ')[0],
      sub: prevYear === null || prevYear !== y || m === '01' ? y : '',
      partial: c.partial,
    };
  }),
);

/**
 * One self-contained section per surface: its per-column totals (also the
 * shading denominators), its two grids and its top-articles list. Built here so
 * the template never has to hunt through the per-surface grid arrays.
 */
const surfaceSections = computed(() => {
  const r = surfacesReport.value;
  if (!r?.ready) return [];
  return SURFACE_KEYS.map((key) => ({
    key,
    label: SURFACE_LABEL[key],
    totals: (r.totals ?? []).map((t) => t?.[key] ?? EMPTY_STAT),
    benches: r.byBench?.find((g) => g.surface === key)?.rows ?? [],
    categories: r.byCategory?.find((g) => g.surface === key)?.rows ?? [],
    top: r.topArticles?.[key] ?? [],
    // Bench above Category, matching the coverage and Reads tabs. Iterated in
    // the template so the two grids can never drift apart in markup.
    grids: [
      { key: 'bench', title: 'Courts / benches', unit: 'court or bench story', rows: r.byBench?.find((g) => g.surface === key)?.rows ?? [] },
      { key: 'category', title: 'Categories', unit: 'category', rows: r.byCategory?.find((g) => g.surface === key)?.rows ?? [] },
    ],
  }));
});

/**
 * Which two columns every Δ on this screen compares, as {current, base}.
 *
 * Taken from the payload, NOT re-derived here. The two modes order their columns
 * differently — months oldest-first ending on a still-filling month, a range
 * subject-first — and inferring "newest is last" inverts every delta in range
 * mode, reading as a rise when the truth is a fall. The server states the pair
 * and its tests pin it.
 */
const compareIdx = computed<{ current: number; base: number }>(
  () => surfacesReport.value?.compare ?? { current: -1, base: -1 },
);

function pctChange(now: number, before: number): number | null {
  if (before <= 0) return null;
  return Math.round(((now - before) / before) * 100);
}

/**
 * Below this many clicks in the earlier period, a percentage stops being
 * information: a row that went 9 → 2,800 reads as "▲ 30711%", which crowds out
 * every meaningful figure in the column while saying less than "+2.8k" does.
 * Small bases get the absolute movement instead.
 */
const MIN_BASE_FOR_PCT = 50;

/**
 * The answer before any grid: what each surface sent last complete month, which
 * way it moved, and how far it sits from its best month on screen. The peak line
 * exists because a single month's number reads as fine in isolation — the story
 * in this data is the slope, and it belongs where nobody has to scroll for it.
 */
const surfaceHeadline = computed(() => {
  const { current: i, base } = compareIdx.value;
  const cols = surfaceColumns.value;
  if (i < 0) return [];
  const hasBase = base >= 0 && base < cols.length;
  return surfaceSections.value.map((s) => {
    const clicks = s.totals[i]?.clicks ?? 0;
    let peakIdx = 0;
    s.totals.forEach((t, ti) => {
      if ((t?.clicks ?? 0) > (s.totals[peakIdx]?.clicks ?? 0)) peakIdx = ti;
    });
    // "Best month on screen" is a statement about a run of months. Across two
    // range columns the peak is just whichever side is larger, which the Δ
    // already says — so it is dropped rather than restated.
    const showPeak = surfacesMode.value === 'months' && peakIdx !== i;
    return {
      key: s.key,
      label: s.label,
      clicks,
      columnLabel: cols[i]?.label ?? '',
      delta: hasBase ? move(clicks, s.totals[base]?.clicks ?? 0) : null,
      prevLabel: hasBase ? (cols[base]?.label ?? '') : '',
      peak: s.totals[peakIdx]?.clicks ?? 0,
      peakLabel: cols[peakIdx]?.label ?? '',
      fromPeak: showPeak ? move(clicks, s.totals[peakIdx]?.clicks ?? 0) : null,
    };
  });
});

/** Row values for the inline trend line, nulls read as zero pickup. */
function rowValues(row: SurfaceRow): number[] {
  return row.cells.map((c) => c?.clicks ?? 0);
}
function rowTrendLabel(rowLabel: string, surfaceLabel: string): string {
  const cols = surfaceColumns.value;
  return `${rowLabel} — ${surfaceLabel} clicks from ${cols[0]?.label ?? ''} to ${
    cols[cols.length - 1]?.label ?? ''
  }`;
}
/** A period-on-period movement, ready to render. */
type Move = { pct: number | null; from: number; to: number };

function move(to: number, from: number): Move {
  return { pct: pctChange(to, from), from, to };
}
/** Row-level movement: the last complete column against the one before it. */
function rowDelta(row: SurfaceRow): Move | null {
  const { current, base } = compareIdx.value;
  if (current < 0 || base < 0 || base >= row.cells.length) return null;
  return move(row.cells[current]?.clicks ?? 0, row.cells[base]?.clicks ?? 0);
}
function deltaText(m: Move | null): string {
  if (m === null || (m.from === 0 && m.to === 0)) return '—';
  const dir = m.to >= m.from ? '▲' : '▼';
  if (m.from < MIN_BASE_FOR_PCT) {
    // Too small a base for a percentage to mean anything — state the movement.
    const diff = Math.abs(m.to - m.from);
    return diff === 0 ? 'flat' : `${dir} ${fmtCount(diff)}`;
  }
  if (m.pct === 0) return 'flat';
  return `${dir} ${Math.abs(m.pct ?? 0)}%`;
}
function deltaTitle(m: Move | null, fromLabel: string, toLabel: string): string {
  if (m === null) return '';
  const base =
    `${fromLabel}: ${m.from.toLocaleString()} clicks → ${toLabel}: ${m.to.toLocaleString()} clicks`;
  return m.from < MIN_BASE_FOR_PCT && m.from !== m.to
    ? `${base}. Shown as a count, not a percentage — ${m.from.toLocaleString()} is too small a base for a percentage to mean much.`
    : base;
}
function deltaClass(m: Move | null): string {
  if (m === null || m.to === m.from) return 'flat';
  return m.to > m.from ? 'up' : 'down';
}

/**
 * Share of the LATEST COMPLETE column's clicks across BOTH surfaces. Drives
 * which section opens by default: giving a surface worth a rounding error the
 * same screen space as the one carrying the traffic is what makes a report
 * tiring to read.
 */
function surfaceShareOfAll(key: SurfaceKey): number {
  const total = surfaceHeadline.value.reduce((n, h) => n + h.clicks, 0);
  if (total <= 0) return 0;
  return (surfaceHeadline.value.find((h) => h.key === key)?.clicks ?? 0) / total;
}

// Surfaces the reader has opened by hand. A minor surface stays collapsed until
// asked for — but the threshold is computed, not hardcoded, so if Google News
// ever grows into a real channel it expands on its own.
const MINOR_SURFACE_SHARE = 0.1;
const openedSurfaces = ref<SurfaceKey[]>([]);
function surfaceIsOpen(key: SurfaceKey): boolean {
  return surfaceShareOfAll(key) >= MINOR_SURFACE_SHARE || openedSurfaces.value.includes(key);
}
function toggleSurface(key: SurfaceKey): void {
  openedSurfaces.value = openedSurfaces.value.includes(key)
    ? openedSurfaces.value.filter((k) => k !== key)
    : [...openedSurfaces.value, key];
}

/** True when Google has reported no pickup at all for this surface, anywhere on screen. */
function surfaceHasNothing(s: { totals: SurfaceStat[]; benches: SurfaceRow[]; categories: SurfaceRow[] }): boolean {
  return (
    s.benches.length === 0 &&
    s.categories.length === 0 &&
    s.totals.every((t) => t.clicks === 0 && t.impressions === 0)
  );
}

/** A cell's share of everything that surface sent us in that column (clicks). */
function surfaceShare(clicks: number, columnClicks: number): number {
  return columnClicks > 0 ? clicks / columnClicks : 0;
}
// Violet intensity — deliberately NOT the Reads blue and NOT the coverage
// red→green, so a glance can never confuse Google clicks with reads or gaps.
//
// Shaded on each cell's share of ITS OWN column, not of the whole grid. With
// months as columns that distinction decides what the grid is for: absolute
// shading would just restate the traffic collapse in every row and wash out the
// recent months entirely, while share-of-column answers "what was Google picking
// up that month" — a mix question the totals row above already contextualises.
const surfacesMaxShare = computed(() => {
  let m = 0;
  for (const s of surfaceSections.value) {
    for (const row of [...s.benches, ...s.categories]) {
      row.cells.forEach((c, i) => {
        if (!c) return;
        const share = surfaceShare(c.clicks, s.totals[i]?.clicks ?? 0);
        if (share > m) m = share;
      });
    }
  }
  return m;
});
function surfaceCellColor(share: number): string {
  const p = Math.sqrt(share / Math.max(surfacesMaxShare.value, 0.0001)) * 0.55;
  const mix = (w: number, v: number) => Math.round(w + (v - w) * p);
  return `rgb(${mix(255, 109)}, ${mix(255, 40)}, ${mix(255, 217)})`; // white → #6d28d9
}
function ctrPct(clicks: number, impressions: number): string {
  return impressions > 0 ? ((clicks / impressions) * 100).toFixed(1) + '%' : '—';
}
/** Full-sentence native tooltip: spells out the unit so nobody reads it as reads. */
function surfaceCellTitle(
  surfaceLabel: string,
  rowLabel: string,
  columnLabel: string,
  c: SurfaceStat,
  columnClicks: number,
): string {
  return (
    `${rowLabel} — ${surfaceLabel}, ${columnLabel}: ` +
    `${c.clicks.toLocaleString()} clicks from ${c.impressions.toLocaleString()} impressions ` +
    `(click rate ${ctrPct(c.clicks, c.impressions)}) across ${c.articles.toLocaleString()} articles — ` +
    `${sharePct(surfaceShare(c.clicks, columnClicks))} of what ${surfaceLabel} sent that period. ` +
    `Google clicks, not reads.`
  );
}
const surfacesThrough = computed(() => surfacesReport.value?.dataThrough ?? null);
const surfacesFrom = computed(() => surfacesReport.value?.dataFrom ?? null);

/**
 * The earliest month on screen against the earliest data we hold. The sync only
 * fetches a rolling lookback, so without a backfill the grid is a couple of
 * columns wide — worth saying plainly rather than letting a short grid read as
 * "Google sent us nothing before March".
 */
const surfacesHistoryNote = computed(() => {
  const from = surfacesFrom.value;
  const cols = surfaceColumns.value;
  if (!from || cols.length === 0 || surfacesMode.value !== 'months') return null;
  // The first column is clipped by the data, not by choice, when history starts
  // mid-month — that is normal. Only flag genuinely thin history.
  return cols.length < 3 ? from : null;
});

/** Whether the currently-shown tab actually has a sheet to export. */
const sheetReady = computed(() => {
  if (period.value === 'reads') return !!readsReport.value?.ready;
  if (period.value === 'surfaces') return !!surfacesReport.value?.ready;
  return !!report.value;
});

async function renderPng(): Promise<string> {
  const node = sheet.value;
  if (!node) throw new Error('Report not ready.');
  // On narrow viewports the heat tables live inside horizontally-scrollable
  // wrappers (so they don't clip on screen). For the shared image we want the
  // FULL report, so temporarily neutralise that clipping and capture at the
  // sheet's full content width. On desktop nothing overflows, so scrollWidth ==
  // offsetWidth and the output is byte-for-byte what it was before.
  node.classList.add('exporting');
  try {
    const width = Math.ceil(node.scrollWidth);
    return await toPng(node, {
      backgroundColor: '#ffffff',
      pixelRatio: 2,
      width,
      style: { width: `${width}px` },
    });
  } finally {
    node.classList.remove('exporting');
  }
}
async function downloadImage() {
  error.value = null;
  notice.value = null;
  try {
    const a = document.createElement('a');
    a.href = await renderPng();
    a.download =
      period.value === 'reads'
        ? `taxscan-reads-report-${new Date().toLocaleDateString('en-CA')}.png`
        : period.value === 'surfaces'
          ? // Name it after the last day Google has actually reported, not "today" —
            // the newest 2–3 days are never in the data.
            `taxscan-google-surfaces-report-${surfacesThrough.value ?? new Date().toLocaleDateString('en-CA')}.png`
          : period.value === 'custom'
            ? `taxscan-report-${report.value?.start ?? ''}-to-${report.value?.end ?? ''}.png`
            : `taxscan-${period.value}-report-${report.value?.end ?? ''}.png`;
    a.click();
    notice.value = 'Image downloaded — attach it in WhatsApp.';
  } catch (e) {
    error.value = `Could not generate image: ${e instanceof Error ? e.message : String(e)}`;
  }
}
async function copyImage() {
  error.value = null;
  notice.value = null;
  try {
    const blob = await (await fetch(await renderPng())).blob();
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    notice.value = 'Image copied — paste it into WhatsApp.';
  } catch {
    error.value = 'Copy isn’t supported in this browser — use Download instead.';
  }
}

async function emailTest() {
  error.value = null;
  notice.value = null;
  try {
    const r = await api.post<{ to: string }>('/api/reports/test-email', { period: period.value });
    notice.value = `Test report emailed to ${r.to}. Check your inbox.`;
  } catch (e) {
    error.value = apiErrorMessage(e);
  }
}

// --- Standing warning: did the last SCHEDULED report email actually go out? --
// A failed send used to be invisible here — it existed only in the deploy logs,
// which is how two runs (31 Aug, 1 Sep 2026) failed unnoticed for a week. This
// stays up until a later scheduled run succeeds; there is nothing to dismiss,
// because the condition is not resolved by reading about it.
type EmailRun = {
  period: 'weekly' | 'monthly';
  ranAt: string;
  recipients: number;
  sent: number;
  failed: number;
  error: string | null;
};
const emailRun = ref<EmailRun | null>(null);

async function loadEmailStatus() {
  try {
    const d = await api.get<{ lastRun: EmailRun | null }>('/api/reports/email-status');
    emailRun.value = d.lastRun;
  } catch {
    // Silent: this is a secondary signal. Failing to fetch it must never make
    // the Reports screen look broken, and a false "email failed" would be
    // worse than showing nothing.
    emailRun.value = null;
  }
}

/** The provider's own words, trimmed of the wrapper our sender adds. */
const emailRunProviderMessage = computed(() => {
  const raw = emailRun.value?.error;
  if (!raw) return null;
  const m = raw.match(/"Error"\s*:\s*"([^"]+)"/);
  return m ? m[1] : raw;
});

const emailRunWarning = computed(() => {
  const r = emailRun.value;
  if (!r || r.failed === 0) return null;
  const when = new Date(r.ranAt).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  const none = r.sent === 0;
  return {
    headline: none
      ? `The ${r.period} report email did not reach anyone.`
      : `The ${r.period} report email reached only some recipients.`,
    detail: `Sent to ${r.sent} of ${r.recipients} on ${when}.`,
    provider: emailRunProviderMessage.value,
  };
});

onMounted(() => {
  void load();
  void loadRecipients();
  void loadEmailStatus();
});
</script>

<template>
  <main class="page page-wide">
    <div class="toolbar">
      <h1 class="section-title" style="margin: 0">Coverage report</h1>
      <div class="seg">
        <button :class="{ on: period === 'weekly' }" @click="setPeriod('weekly')">Weekly</button>
        <button :class="{ on: period === 'monthly' }" @click="setPeriod('monthly')">Monthly</button>
        <button :class="{ on: period === 'custom' }" @click="setPeriod('custom')">Custom</button>
        <button :class="{ on: period === 'reads' }" @click="setPeriod('reads')">Reads</button>
        <button :class="{ on: period === 'surfaces' }" @click="setPeriod('surfaces')">Surfaces</button>
      </div>
      <span class="spacer" style="flex: 1" />
      <button class="btn" :disabled="loading || !sheetReady" @click="downloadImage">Download image</button>
      <button class="btn" :disabled="loading || !sheetReady" @click="copyImage">Copy image</button>
      <button
        class="btn"
        :disabled="!report || loading || period === 'custom' || period === 'reads' || period === 'surfaces'"
        :title="
          period === 'custom' || period === 'reads' || period === 'surfaces'
            ? 'Test emails send the standing Weekly/Monthly report'
            : ''
        "
        @click="emailTest"
      >
        Email me a test
      </button>
      <button class="btn" :disabled="loading" @click="load">{{ loading ? 'Loading…' : 'Refresh' }}</button>
    </div>

    <!-- Custom range picker — any window of up to 30 days, both ends inclusive. -->
    <div v-if="period === 'custom'" class="custom-range">
      <label>From <input v-model="customFrom" type="date" :max="todayKey" /></label>
      <label>To <input v-model="customTo" type="date" :max="todayKey" /></label>
      <button class="btn btn-primary" :disabled="loading || !!customError" @click="load">Apply</button>
      <span v-if="customError" class="range-err">{{ customError }}</span>
      <span v-else class="muted">{{ customDays }} day{{ customDays === 1 ? '' : 's' }}</span>
    </div>

    <!-- Surfaces range picker. Its own control, not the Custom tab's: that one
         drives a different report with a 30-day ceiling. Sits outside the sheet,
         so the exported image carries the report and not the controls that made
         it. Placed here, above the v-if chain below, so it cannot break it. -->
    <div v-if="period === 'surfaces' && (surfacesReport?.ready || surfaceRangeOn)" class="custom-range">
      <template v-if="surfaceRangeOn">
        <label>From <input v-model="surfFrom" type="date" :max="todayKey" /></label>
        <label>To <input v-model="surfTo" type="date" :max="todayKey" /></label>
        <button class="btn btn-primary" :disabled="loading || !!surfaceRangeError" @click="load">Apply</button>
        <button class="btn" :disabled="loading" @click="clearSurfaceRange">Back to months</button>
        <span v-if="surfaceRangeError" class="range-err">{{ surfaceRangeError }}</span>
        <span v-else class="muted">
          {{ surfaceRangeDays }} day{{ surfaceRangeDays === 1 ? '' : 's' }}, compared with the
          {{ surfaceRangeDays }} before it
        </span>
      </template>
      <template v-else>
        <span class="muted">Every month we hold, side by side.</span>
        <button class="btn" :disabled="loading" @click="openSurfaceRange">Pick a date range</button>
      </template>
    </div>

    <!-- Standing condition, not a response to anything just clicked — hence
         its own colour rather than the red used for request errors below. -->
    <div v-if="emailRunWarning" class="banner warn" role="status">
      <p class="banner-lead">{{ emailRunWarning.headline }}</p>
      <p class="banner-detail">
        {{ emailRunWarning.detail }}
        <template v-if="emailRunWarning.provider">
          The email provider said: “{{ emailRunWarning.provider }}”
        </template>
      </p>
      <p class="banner-detail">
        Once the provider is working again, use “Email me a test” to check delivery. This notice
        clears itself when the next scheduled report sends.
      </p>
    </div>

    <div v-if="error" class="banner err">{{ error }}</div>
    <div v-if="notice" class="banner ok">{{ notice }}</div>

    <!-- Allow-list, not "!== reads": every panel below is an arm of ONE v-if
         chain (only one ref="sheet" may ever be mounted, see renderPng), so a
         new tab must be named here or it would render the coverage sheet. -->
    <div
      v-if="(period === 'weekly' || period === 'monthly' || period === 'custom') && report"
      ref="sheet"
      class="report-sheet"
    >
      <div class="report-head">
        <div class="report-title">Taxscan {{ periodTitle }} Coverage Report</div>
        <div class="report-range">{{ rangeLabel(report) }}</div>
      </div>

      <div class="insights">
        <div class="ins">
          <div class="ins-n">{{ report.total }}</div>
          <div class="ins-l">articles published</div>
        </div>
        <div class="ins">
          <div class="ins-n" :class="trendPct === null ? '' : trendPct >= 0 ? 'up' : 'down'">
            {{ trendPct === null ? '—' : (trendPct >= 0 ? '▲ ' : '▼ ') + Math.abs(trendPct) + '%' }}
          </div>
          <div class="ins-l">vs previous {{ prevNoun }} ({{ report.prevTotal }})</div>
        </div>
        <div class="ins">
          <div class="ins-n">{{ report.byCategory.rows.length }} / {{ report.byBench.rows.length }}</div>
          <div class="ins-l">categories / benches active</div>
        </div>
        <div class="ins">
          <div class="ins-n">{{ report.quality.qualified }}·{{ report.quality.fallback }}·{{ report.quality.review }}</div>
          <div class="ins-l">court rulings · tribunal filler · review</div>
        </div>
      </div>

      <div v-if="topGaps.length" class="gaps">
        <strong>No coverage in this {{ report.period === 'custom' ? 'period' : report.period === 'weekly' ? 'week' : 'month' }}:</strong>
        {{ topGaps.join(', ') }}<span v-if="report.gaps.benchesWithNothing.length > topGaps.length"> …</span>
      </div>

      <h3 class="heat-h">Courts / benches × dates</h3>
      <div class="heat-scroll">
        <table class="heat">
          <thead>
            <tr>
              <th class="heat-label">Bench</th>
              <th v-for="d in report.byBench.dates" :key="d">{{ shortDate(d) }}</th>
              <th class="heat-total">Total</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in report.byBench.rows" :key="row.label">
              <td class="heat-label">{{ row.label }}</td>
              <td v-for="(n, i) in row.perDay" :key="i" :style="{ background: cellColor(n, benchMax) }">{{ n }}</td>
              <td class="heat-total">{{ row.total }}</td>
            </tr>
            <tr class="heat-foot">
              <td class="heat-label">Total</td>
              <td v-for="(t, i) in report.byBench.dayTotals" :key="i">{{ t }}</td>
              <td class="heat-total">{{ report.byBench.grandTotal }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 class="heat-h">Categories × dates</h3>
      <div class="heat-scroll">
        <table class="heat">
          <thead>
            <tr>
              <th class="heat-label">Category</th>
              <th v-for="d in report.byCategory.dates" :key="d">{{ shortDate(d) }}</th>
              <th class="heat-total">Total</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in report.byCategory.rows" :key="row.label">
              <td class="heat-label">{{ row.label }}</td>
              <td v-for="(n, i) in row.perDay" :key="i" :style="{ background: cellColor(n, catMax) }">{{ n }}</td>
              <td class="heat-total">{{ row.total }}</td>
            </tr>
            <tr class="heat-foot">
              <td class="heat-label">Total</td>
              <td v-for="(t, i) in report.byCategory.dayTotals" :key="i">{{ t }}</td>
              <td class="heat-total">{{ report.byCategory.grandTotal }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="report-foot">Generated by Taxscan Push · {{ rangeLabel(report) }}</div>
    </div>

    <!-- Reads report: what actually gets read, by bench and category, over
         trailing windows. Data is built daily on the server from GA. -->
    <div v-else-if="period === 'reads' && readsReport?.ready" ref="sheet" class="report-sheet">
      <div class="report-head">
        <div class="report-title">Taxscan Reads Report</div>
        <div class="report-range">Article reads by bench &amp; category · data as of {{ readsAsOf }}</div>
      </div>

      <div class="insights">
        <div v-for="w in readsReport.windows" :key="w.label" class="ins">
          <div class="ins-n">{{ fmtViews(w.articleViews) }}</div>
          <div class="ins-l">reads · last {{ w.label }} · {{ w.articlesRead.toLocaleString() }} articles</div>
        </div>
      </div>

      <!-- Bench above Category, matching the Weekly/Monthly coverage tabs. -->
      <h3 class="heat-h">Courts / benches × window</h3>
      <div class="heat-scroll">
        <table class="heat reads">
          <thead>
            <tr>
              <th class="heat-label">Bench</th>
              <th v-for="w in readsReport.windows" :key="w.label">{{ w.label }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in readsReport.benches" :key="row.label">
              <td class="heat-label">{{ row.label }}</td>
              <td
                v-for="(c, i) in row.cells"
                :key="i"
                :style="c ? { background: readsCellColor(c.share) } : undefined"
                :title="c ? `${row.label} — last ${readsReport.windows?.[i]?.label}: ${c.views.toLocaleString()} reads (${sharePct(c.share)}) across ${c.articles.toLocaleString()} articles` : ''"
              >
                <template v-if="c">
                  <span class="rv">{{ fmtViews(c.views) }}</span>
                  <span class="rs">{{ sharePct(c.share) }}</span>
                </template>
                <span v-else class="muted">—</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 class="heat-h">Categories × window</h3>
      <div class="heat-scroll">
        <table class="heat reads">
          <thead>
            <tr>
              <th class="heat-label">Category</th>
              <th v-for="w in readsReport.windows" :key="w.label">{{ w.label }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in readsReport.categories" :key="row.label">
              <td class="heat-label">{{ row.label }}</td>
              <td
                v-for="(c, i) in row.cells"
                :key="i"
                :style="c ? { background: readsCellColor(c.share) } : undefined"
                :title="c ? `${row.label} — last ${readsReport.windows?.[i]?.label}: ${c.views.toLocaleString()} reads (${sharePct(c.share)}) across ${c.articles.toLocaleString()} articles` : ''"
              >
                <template v-if="c">
                  <span class="rv">{{ fmtViews(c.views) }}</span>
                  <span class="rs">{{ sharePct(c.share) }}</span>
                </template>
                <span v-else class="muted">—</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="report-foot">
        Reads = pageviews from all traffic (Google Analytics), classified from the headline with the
        coverage report's rules. Windows are trailing and cumulative — 1 month includes the week.
        Deeper blue = larger share of that window's reads.
      </div>
    </div>

    <div v-else-if="period === 'reads' && readsReport && !readsReport.ready" class="card">
      <p class="muted">{{ readsReport.message ?? 'The first reads report has not been built yet — check back shortly.' }}</p>
    </div>

    <!-- Surfaces report: what Google Discover / Google News picked up, by bench
         and category, month by month (or over a chosen range). Aggregated on the
         server from stored Search Console data — the request path never calls
         Google. -->
    <div v-else-if="period === 'surfaces' && surfacesReport?.ready" ref="sheet" class="report-sheet">
      <div class="report-head">
        <div class="report-title">Taxscan Google Surfaces Report</div>
        <div class="report-range">
          What Google Discover &amp; Google News picked up ·
          <template v-if="surfacesMode === 'range' && surfaceColumns.length">
            {{ surfaceColumns[0].label }} against the {{ surfaceColumns[1]?.label?.toLowerCase() }} ·
          </template>
          <template v-if="surfacesThrough">Google has reported up to {{ surfacesThrough }}</template>
          <template v-else>Google has not reported any complete day yet</template>
        </div>
      </div>

      <!-- The answer first: what each surface sent last complete month, which way
           it moved, and how far that sits from its best month on screen. A single
           month's number reads as fine in isolation; the slope is the story. -->
      <div class="surface-headline">
        <div v-for="h in surfaceHeadline" :key="h.key" class="sh-item">
          <span class="sh-n">{{ fmtCount(h.clicks) }}</span>
          <span class="sh-l">{{ h.label }} clicks · {{ h.columnLabel }}</span>
          <span class="sh-d">
            <span :class="['delta', deltaClass(h.delta)]">{{ deltaText(h.delta) }}</span>
            <span v-if="h.prevLabel" class="sh-sub">vs {{ h.prevLabel }}</span>
          </span>
          <span v-if="h.fromPeak !== null" class="sh-sub">
            Best month on screen: {{ h.peakLabel }} ({{ fmtCount(h.peak) }}) ·
            <span :class="['delta', deltaClass(h.fromPeak)]">{{ deltaText(h.fromPeak) }}</span>
            since
          </span>
        </div>
      </div>

      <!-- The two things that stop a reader misreading these numbers. Kept short
           and on the panel (so they survive into the exported image) rather than
           hidden in a tooltip. -->
      <div class="gaps">
        <p style="margin: 0 0 4px">
          <strong>These are Google clicks, not Reads.</strong>
          Someone tapped our headline in Discover or Google News. The Reads tab counts page views
          from every source — don’t add or compare the two.
        </p>
        <p v-if="surfaceColumns.some((c) => c.partial)" style="margin: 0">
          <strong>The newest column is still filling.</strong>
          Google reports 2–3 days late, so it is always short — the figures above compare the last
          complete period instead.
        </p>
        <p v-else style="margin: 0">
          <strong>Google reports 2–3 days late.</strong>
          A range ending in the last few days will be short through no fault of the coverage.
        </p>
        <p v-if="surfacesHistoryNote" style="margin: 4px 0 0">
          <strong>History starts {{ surfacesHistoryNote }}.</strong>
          Earlier months were never collected, so their absence here says nothing about what
          Google picked up then.
        </p>
      </div>

      <section v-for="s in surfaceSections" :key="s.key" class="surface-block">
        <div class="surface-h-row">
          <h3 class="surface-h">{{ s.label }}</h3>
          <!-- A surface carrying a rounding-error share stays folded away until
               asked for, so the one that matters isn't buried under a duplicate. -->
          <button
            v-if="!surfaceHasNothing(s) && surfaceShareOfAll(s.key) < MINOR_SURFACE_SHARE"
            class="btn"
            @click="toggleSurface(s.key)"
          >
            {{ surfaceIsOpen(s.key) ? 'Hide breakdown' : 'Show breakdown' }}
          </button>
        </div>

        <p v-if="surfaceHasNothing(s)" class="muted no-pickup">
          Google sent us nothing from {{ s.label }} in this period — no clicks and no impressions.
          Either our stories are not being picked up there, or Google has not reported them yet.
        </p>

        <p v-else-if="!surfaceIsOpen(s.key)" class="muted no-pickup">
          A small share of our Google traffic —
          {{ fmtCount(surfaceHeadline.find((h) => h.key === s.key)?.clicks ?? 0) }} clicks in
          {{ surfaceHeadline.find((h) => h.key === s.key)?.columnLabel }}. Show the breakdown if you
          want the detail.
        </p>

        <template v-else>
          <div v-for="g in s.grids" :key="g.key">
            <h3 class="heat-h">
              {{ g.title }} × {{ surfacesMode === 'months' ? 'month' : 'period' }}
            </h3>
            <p v-if="!g.rows.length" class="muted no-pickup">
              No {{ s.label }} pickup on any {{ g.unit }} in this period.
            </p>
            <div v-else class="heat-scroll">
              <table class="heat surfaces">
                <thead>
                  <tr>
                    <th class="heat-label">{{ g.key === 'bench' ? 'Bench' : 'Category' }}</th>
                    <!-- Shape before numbers: 18 columns across 30 rows is 540
                         figures, but 30 trajectories. The precise movement is the
                         Δ column at the far end, where the eye lands last. -->
                    <th v-if="surfacesMode === 'months' && surfaceColumns.length > 2" class="th-trend">
                      Trend
                    </th>
                    <th
                      v-for="(head, i) in columnHeads"
                      :key="i"
                      :class="{ 'th-partial': head.partial }"
                      :title="head.partial ? 'Still filling — Google reports 2–3 days late' : undefined"
                    >
                      {{ head.top }}<span v-if="head.partial" aria-hidden="true">·</span>
                      <span v-if="head.sub" class="th-year">{{ head.sub }}</span>
                    </th>
                    <th class="th-delta">Δ</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in g.rows" :key="row.label">
                    <td class="heat-label">{{ row.label }}</td>
                    <td v-if="surfacesMode === 'months' && surfaceColumns.length > 2" class="td-trend">
                      <TrendLine :values="rowValues(row)" :label="rowTrendLabel(row.label, s.label)" />
                    </td>
                    <td
                      v-for="(c, i) in row.cells"
                      :key="i"
                      :class="{ 'td-partial': surfaceColumns[i]?.partial }"
                      :style="c ? { backgroundColor: surfaceCellColor(surfaceShare(c.clicks, s.totals[i]?.clicks ?? 0)) } : undefined"
                      :title="
                        c
                          ? surfaceCellTitle(s.label, row.label, surfaceColumns[i]?.label ?? '', c, s.totals[i]?.clicks ?? 0)
                          : `${row.label} — no ${s.label} pickup in ${surfaceColumns[i]?.label ?? 'this period'}`
                      "
                    >
                      <!-- Clicks only. Impressions, click rate and share are all in
                           the cell's tooltip — two numbers in every cell of a 30-row
                           grid is 300 numbers to read past to find the pattern. -->
                      <span v-if="c" class="rv">{{ fmtCount(c.clicks) }}</span>
                      <span v-else class="muted">—</span>
                    </td>
                    <td
                      :class="['td-delta', deltaClass(rowDelta(row))]"
                      :title="
                        deltaTitle(
                          rowDelta(row),
                          surfaceColumns[compareIdx.base]?.label ?? '',
                          surfaceColumns[compareIdx.current]?.label ?? '',
                        )
                      "
                    >
                      {{ deltaText(rowDelta(row)) }}
                    </td>
                  </tr>
                </tbody>
                <tfoot>
                  <tr>
                    <td class="heat-label">All {{ s.label }} clicks</td>
                    <td v-if="surfacesMode === 'months' && surfaceColumns.length > 2" class="td-trend">
                      <TrendLine
                        :values="s.totals.map((t) => t.clicks)"
                        :label="`${s.label} total clicks over the period shown`"
                      />
                    </td>
                    <td v-for="(t, i) in s.totals" :key="i" :class="{ 'td-partial': surfaceColumns[i]?.partial }">
                      {{ fmtCount(t.clicks) }}
                    </td>
                    <td
                      :class="[
                        'td-delta',
                        deltaClass(
                          compareIdx.base >= 0
                            ? move(
                                s.totals[compareIdx.current]?.clicks ?? 0,
                                s.totals[compareIdx.base]?.clicks ?? 0,
                              )
                            : null,
                        ),
                      ]"
                    >
                      {{
                        deltaText(
                          compareIdx.base >= 0
                            ? move(
                                s.totals[compareIdx.current]?.clicks ?? 0,
                                s.totals[compareIdx.base]?.clicks ?? 0,
                              )
                            : null,
                        )
                      }}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          <h3 class="heat-h">Most picked-up articles · {{ surfacesReport?.topWindow?.label ?? '' }}</h3>
          <p v-if="!s.top.length" class="muted no-pickup">
            No single article drew a {{ s.label }} click in that period.
          </p>
          <div v-else class="heat-scroll">
            <table class="heat surfaces">
              <thead>
                <tr>
                  <th class="heat-label">#</th>
                  <th class="heat-label">Article</th>
                  <th>Clicks</th>
                  <th>Impressions</th>
                  <th>Click rate</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(a, i) in s.top" :key="a.pagePath">
                  <td class="heat-label rank">{{ i + 1 }}</td>
                  <td class="heat-label art-title">
                    <span class="rv">{{ a.title }}</span>
                    <span class="rs">{{ a.pagePath }}</span>
                  </td>
                  <td>{{ a.clicks.toLocaleString() }}</td>
                  <td class="dim">{{ a.impressions.toLocaleString() }}</td>
                  <td class="dim">{{ ctrPct(a.clicks, a.impressions) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </section>

      <div class="report-foot">
        Numbers are clicks from Google; hover a cell for impressions, click rate and share. “—” means
        no pickup at all, which is not the same as zero clicks. Deeper violet = a larger share of that
        surface’s clicks <em>within its own column</em>, so shading shows what Google favoured that
        month rather than restating the size of the month. Δ compares the last complete month with the
        one before it. Google credits whichever copy of a story it treats as the original, so a story
        published twice can appear as two near-identical rows.
        <span v-if="surfacesThrough">Data reported by Google up to {{ surfacesThrough }}.</span>
      </div>
    </div>

    <!-- (a) Feature switched off — a state, not an error. -->
    <div v-else-if="period === 'surfaces' && surfacesOff" class="card">
      <p style="margin: 0 0 6px"><strong>Google Discover &amp; News tracking is switched off.</strong></p>
      <p class="muted" style="margin: 0 0 6px">{{ surfacesOff }}</p>
      <p class="muted" style="margin: 0">
        Nothing is being collected at the moment, so there is nothing to show here. An admin can turn
        it on; Google then starts filling in the numbers over the following few days.
      </p>
    </div>

    <!-- (b) Switched on, but Google has not delivered a first day yet. -->
    <div v-else-if="period === 'surfaces' && surfacesReport && !surfacesReport.ready" class="card">
      <p style="margin: 0 0 6px"><strong>Nothing has come back from Google yet.</strong></p>
      <p class="muted" style="margin: 0 0 6px">
        {{ surfacesReport.message ?? 'Tracking is on, but no Discover or Google News data has been collected so far.' }}
      </p>
      <p class="muted" style="margin: 0">
        Google reports this data 2–3 days behind, so the first numbers usually appear a couple of days
        after tracking is turned on. Check back then — there is nothing to fix.
      </p>
    </div>

    <div v-else-if="!loading" class="card">
      <p class="muted">No report data yet.</p>
    </div>

    <!-- Email recipients — admin only. App users always get the report too. -->
    <div v-if="isAdmin" class="card" style="margin-top: 16px">
      <div class="toolbar-title">Email recipients</div>
      <p class="muted" style="margin-top: 4px">
        Everyone with a login already receives the weekly &amp; monthly report by email. Add extra
        internal members here — <strong>email only</strong> (no login, no push).
      </p>
      <div style="display: flex; gap: 8px; margin: 8px 0; max-width: 460px">
        <input
          v-model="newEmail"
          type="email"
          placeholder="name@company.com"
          style="flex: 1"
          @keyup.enter="addRecipient"
        />
        <button class="btn btn-primary" :disabled="recBusy || !newEmail" @click="addRecipient">Add</button>
      </div>
      <div v-if="recError" class="banner err">{{ recError }}</div>
      <table>
        <thead>
          <tr><th>Email</th><th>Added</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="r in recipients" :key="r.id">
            <td>{{ r.email }}</td>
            <td class="muted">{{ new Date(r.createdAt).toLocaleDateString() }}</td>
            <td style="text-align: right">
              <button class="btn" :disabled="recBusy" @click="removeRecipient(r)">Remove</button>
            </td>
          </tr>
          <tr v-if="recipients.length === 0">
            <td colspan="3" class="muted" style="text-align: center; padding: 16px">
              No extra recipients yet — only logged-in users get the report.
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </main>
</template>

<style scoped>
.seg {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}
.seg button {
  border: 0;
  background: var(--surface);
  padding: 6px 14px;
  font-size: 13px;
  cursor: pointer;
}
.seg button.on {
  background: var(--primary);
  color: #fff;
  font-weight: 600;
}
.custom-range {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin: 10px 0 4px;
  font-size: 13px;
}
.custom-range label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--muted);
}
.custom-range input[type='date'] {
  font-size: 13px;
}
.range-err {
  color: #dc2626;
  font-size: 12px;
}
.report-sheet {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 22px;
  margin-top: 4px;
}
.report-title {
  font-size: 18px;
  font-weight: 700;
}
.report-range {
  color: var(--muted);
  font-size: 13px;
  margin-top: 2px;
}
.insights {
  display: grid;
  /* Wrap to 2-up (and eventually 1-up) on narrow screens instead of clipping
     the 4th card off the edge. 4-across on desktop is unchanged. */
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
  margin: 16px 0;
}
.ins {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
}
.ins-n {
  font-size: 20px;
  font-weight: 700;
}
.ins-n.up {
  color: #16a34a;
}
.ins-n.down {
  color: #dc2626;
}
.ins-l {
  font-size: 11px;
  color: var(--muted);
  margin-top: 2px;
}
.gaps {
  font-size: 12px;
  background: #fff7ed;
  border: 1px solid #fed7aa;
  border-radius: 8px;
  padding: 8px 12px;
  margin-bottom: 14px;
}
.heat-h {
  margin: 18px 0 6px;
  font-size: 13px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--muted);
}
/* Heat tables can be wider than the viewport (esp. the monthly 30-day view),
   so each scrolls horizontally within its own wrapper rather than overflowing
   the document. During PNG export (.exporting) we drop the clip so the shared
   image captures the full table — see renderPng(). */
.heat-scroll {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}
.report-sheet.exporting .heat-scroll {
  overflow: visible;
}
table.heat {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
table.heat th,
table.heat td {
  border: 1px solid #fff;
  padding: 4px 6px;
  text-align: center;
  white-space: nowrap;
}
table.heat th {
  background: #1e293b;
  color: #fff;
  font-weight: 600;
}
table.heat td.heat-label,
table.heat th.heat-label {
  text-align: left;
  background: #f1f5f9;
  color: #0f172a;
  font-weight: 600;
}
table.heat th.heat-label {
  background: #1e293b;
  color: #fff;
}
table.heat td.heat-total,
table.heat th.heat-total {
  font-weight: 700;
  background: #e2e8f0;
}
table.heat th.heat-total {
  background: #1e293b;
}
.heat-foot td {
  font-weight: 700;
  background: #e2e8f0 !important;
}
.report-foot {
  margin-top: 14px;
  font-size: 11px;
  color: var(--muted);
  text-align: right;
}
/* Reads + Surfaces cells: headline value with a secondary line under it,
   right-aligned (magnitudes). Backgrounds are set inline — blue share-intensity
   by readsCellColor(), violet click-share by surfaceCellColor(). */
table.heat.reads td,
table.heat.surfaces td {
  text-align: right;
  padding: 5px 10px;
}
table.heat.reads td.heat-label,
table.heat.surfaces td.heat-label {
  text-align: left;
}
table.heat.reads .rv,
table.heat.surfaces .rv {
  display: block;
  font-weight: 600;
}
table.heat.reads .rs,
table.heat.surfaces .rs {
  display: block;
  font-size: 10px;
  color: #475569;
}
/* --- Surfaces report ------------------------------------------------------- */
/* The answer, before the evidence. Same tile vocabulary as .insights so it reads
   as part of the system, just given the top of the panel. */
.surface-headline {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin: 14px 0 4px;
}
.sh-item {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 14px;
  min-width: 160px;
}
.sh-n {
  display: block;
  font-size: 24px;
  font-weight: 700;
  line-height: 1.15;
}
.sh-l {
  display: block;
  font-size: 11px;
  color: var(--muted);
}
.sh-d {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-top: 6px;
}
.sh-sub {
  display: block;
  font-size: 11px;
  color: var(--muted);
  margin-top: 2px;
}
/* Direction is carried by the same green/red the dashboard tiles use, and only
   ever as text on a chip — the cell fills stay a single violet ramp, so nothing
   here can be mistaken for the coverage report's red = gap semantics. */
.delta {
  font-size: 12px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.delta.up {
  color: #16a34a;
}
.delta.down {
  color: #dc2626;
}
.delta.flat {
  color: var(--muted);
}
/* The signature column: shape before numbers. Narrow and unpadded so 18 month
   columns still fit before the table needs to scroll. */
th.th-trend,
td.td-trend {
  width: 76px;
  padding: 2px 4px;
  background: #fff;
}
td.td-trend {
  border-color: var(--border);
}
th.th-delta,
td.td-delta {
  font-size: 11px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  background: #f8fafc;
  border-color: var(--border);
}
td.td-delta.up {
  color: #16a34a;
}
td.td-delta.down {
  color: #dc2626;
}
td.td-delta.flat {
  color: var(--muted);
}
/* The current month is always short a few days. Hatching it says "incomplete"
   without dimming the number itself, which is real data. */
th.th-partial,
td.td-partial {
  background-image: repeating-linear-gradient(
    135deg,
    rgba(148, 163, 184, 0.22) 0 3px,
    transparent 3px 6px
  );
}
.th-year {
  display: block;
  font-size: 9px;
  font-weight: 400;
  opacity: 0.75;
}
table.heat.surfaces tfoot td {
  background: #e2e8f0;
  font-weight: 700;
}
table.heat.surfaces tfoot td.td-trend {
  background: #fff;
}
/* Heading and its show/hide control on one line. */
.surface-h-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.surface-block + .surface-block {
  margin-top: 26px;
  border-top: 1px solid var(--border);
  padding-top: 6px;
}
.surface-h {
  margin: 18px 0 0;
  font-size: 15px;
  font-weight: 700;
  color: #0f172a;
}
/* Distinct from an error: "no pickup here" is a finding, not a fault. */
.no-pickup {
  font-size: 12px;
  margin: 6px 0 2px;
}
table.heat.surfaces td.dim {
  color: #475569;
  font-weight: 400;
}
table.heat.surfaces td.rank {
  text-align: right;
  width: 1%;
  background: #f1f5f9;
}
/* Headlines are long: this is the one column allowed to wrap, overriding the
   shared `white-space: nowrap` so the table stays a sane width on phones. */
table.heat.surfaces td.art-title {
  white-space: normal;
  max-width: 460px;
  font-weight: 400;
}
table.heat.surfaces td.art-title .rv {
  font-weight: 600;
}
</style>
