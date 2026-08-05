<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { apiErrorMessage, useApi, type ApiError } from '../composables/useApi';
import { useAuth } from '../composables/useAuth';
import { toPng } from 'html-to-image';

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
// us, by category and bench, over the same trailing windows the Reads tab uses.
// UNIT WARNING: these are Google CLICKS and IMPRESSIONS, not pageviews. They are
// never comparable with (and must never be added to) the Reads figures above.
type SurfaceKey = 'DISCOVER' | 'GOOGLE_NEWS';
type SurfaceStat = { clicks: number; impressions: number; articles: number };
/** null = no pickup at all for this row in this window (NOT a synced zero). */
type SurfaceCell = SurfaceStat | null;
type SurfaceRow = { label: string; cells: SurfaceCell[] };
type SurfaceGrid = { surface: SurfaceKey; rows: SurfaceRow[] };
type TopSurfacedArticle = { pagePath: string; title: string; clicks: number; impressions: number };
type SurfacesReport = {
  ready: boolean;
  message?: string;
  generatedAt?: string;
  windows?: { label: string; days: number; totals: Record<SurfaceKey, SurfaceStat> }[];
  byCategory?: SurfaceGrid[];
  byBench?: SurfaceGrid[];
  topArticles?: Record<SurfaceKey, TopSurfacedArticle[]>;
  dataThrough?: string | null;
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
        surfacesReport.value = await api.get<SurfacesReport>('/api/reports/surfaces');
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

/**
 * One self-contained section per surface: its window totals (also the shading
 * denominators), its two heat grids and its top-articles list. Built here so the
 * template never has to hunt through the per-surface grid arrays.
 */
const surfaceSections = computed(() => {
  const r = surfacesReport.value;
  if (!r?.ready) return [];
  return SURFACE_KEYS.map((key) => ({
    key,
    label: SURFACE_LABEL[key],
    windows: (r.windows ?? []).map((w) => ({
      label: w.label,
      days: w.days,
      ...(w.totals?.[key] ?? EMPTY_STAT),
    })),
    benches: r.byBench?.find((g) => g.surface === key)?.rows ?? [],
    categories: r.byCategory?.find((g) => g.surface === key)?.rows ?? [],
    top: r.topArticles?.[key] ?? [],
  }));
});
/** True when Google has reported no pickup at all for this surface, in any window. */
function surfaceHasNothing(s: { windows: SurfaceStat[]; benches: SurfaceRow[]; categories: SurfaceRow[] }): boolean {
  return (
    s.benches.length === 0 &&
    s.categories.length === 0 &&
    s.windows.every((w) => w.clicks === 0 && w.impressions === 0)
  );
}

/** A cell's share of everything that surface sent us in that window (clicks). */
function surfaceShare(clicks: number, windowClicks: number): number {
  return windowClicks > 0 ? clicks / windowClicks : 0;
}
// Violet intensity — deliberately NOT the Reads blue and NOT the coverage
// red→green, so a glance can never confuse Google clicks with reads or gaps.
const surfacesMaxShare = computed(() => {
  let m = 0;
  for (const s of surfaceSections.value) {
    for (const row of [...s.benches, ...s.categories]) {
      row.cells.forEach((c, i) => {
        if (!c) return;
        const share = surfaceShare(c.clicks, s.windows[i]?.clicks ?? 0);
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
  windowLabel: string,
  c: SurfaceStat,
  windowClicks: number,
): string {
  return (
    `${rowLabel} — ${surfaceLabel}, last ${windowLabel}: ` +
    `${c.clicks.toLocaleString()} clicks from ${c.impressions.toLocaleString()} impressions ` +
    `(click rate ${ctrPct(c.clicks, c.impressions)}) across ${c.articles.toLocaleString()} articles — ` +
    `${sharePct(surfaceShare(c.clicks, windowClicks))} of what ${surfaceLabel} sent in that window. ` +
    `Google clicks, not reads.`
  );
}
const surfacesThrough = computed(() => surfacesReport.value?.dataThrough ?? null);

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

onMounted(() => {
  void load();
  void loadRecipients();
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
         and category, over the same trailing windows the Reads tab uses.
         Aggregated on the server from stored Search Console data — the request
         path never calls Google. -->
    <div v-else-if="period === 'surfaces' && surfacesReport?.ready" ref="sheet" class="report-sheet">
      <div class="report-head">
        <div class="report-title">Taxscan Google Surfaces Report</div>
        <div class="report-range">
          What Google Discover &amp; Google News picked up ·
          <template v-if="surfacesThrough">Google has reported up to {{ surfacesThrough }}</template>
          <template v-else>Google has not reported any complete day yet</template>
        </div>
      </div>

      <!-- The two things an editor must know before reading a single number.
           Deliberately on the panel (and in the exported image), not in a tooltip. -->
      <div class="gaps">
        <p style="margin: 0 0 6px">
          <strong>These are Google clicks — they are not the “Reads” figures.</strong>
          A click here means someone tapped one of our headlines in the Google Discover feed or in
          Google News. The Reads tab counts page views from all traffic. Two different measures of two
          different things: never add them together and never compare one against the other.
          Impressions (the small grey number) are how often a headline was shown, tapped or not.
        </p>
        <p style="margin: 0">
          <strong>The last 2–3 days are always missing.</strong>
          Google reports this data a few days late, and for the newest days it sends nothing at all —
          not smaller numbers, none. So a quiet-looking recent stretch means Google has not reported
          yet, not that pickup collapsed. That is why everything here is a trailing window looking
          backwards, never a day-by-day chart.
        </p>
      </div>

      <section v-for="s in surfaceSections" :key="s.key" class="surface-block">
        <h3 class="surface-h">{{ s.label }}</h3>

        <p v-if="surfaceHasNothing(s)" class="muted no-pickup">
          Google sent us nothing from {{ s.label }} in any of these windows — no clicks and no
          impressions. Either our stories are not being picked up there, or Google has not reported
          them yet.
        </p>

        <template v-else>
          <div class="insights">
            <div v-for="w in s.windows" :key="w.label" class="ins">
              <div class="ins-n">{{ fmtCount(w.clicks) }}</div>
              <div class="ins-l">{{ s.label }} clicks · last {{ w.label }}</div>
              <div class="ins-l">
                {{ fmtCount(w.impressions) }} impressions · {{ w.articles.toLocaleString() }} articles
              </div>
            </div>
          </div>

          <!-- Bench above Category, matching the coverage and Reads tabs. -->
          <h3 class="heat-h">Courts / benches × window</h3>
          <p v-if="!s.benches.length" class="muted no-pickup">
            No {{ s.label }} pickup on any court or bench story in these windows.
          </p>
          <div v-else class="heat-scroll">
            <table class="heat surfaces">
              <thead>
                <tr>
                  <th class="heat-label">Bench</th>
                  <th v-for="w in s.windows" :key="w.label">{{ w.label }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in s.benches" :key="row.label">
                  <td class="heat-label">{{ row.label }}</td>
                  <td
                    v-for="(c, i) in row.cells"
                    :key="i"
                    :style="c ? { background: surfaceCellColor(surfaceShare(c.clicks, s.windows[i]?.clicks ?? 0)) } : undefined"
                    :title="
                      c
                        ? surfaceCellTitle(s.label, row.label, s.windows[i]?.label ?? '', c, s.windows[i]?.clicks ?? 0)
                        : `${row.label} — no ${s.label} pickup in the last ${s.windows[i]?.label ?? ''}`
                    "
                  >
                    <template v-if="c">
                      <span class="rv">{{ fmtCount(c.clicks) }}</span>
                      <span class="rs">{{ fmtCount(c.impressions) }} impr</span>
                    </template>
                    <span v-else class="muted">—</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <h3 class="heat-h">Categories × window</h3>
          <p v-if="!s.categories.length" class="muted no-pickup">
            No {{ s.label }} pickup in any category in these windows.
          </p>
          <div v-else class="heat-scroll">
            <table class="heat surfaces">
              <thead>
                <tr>
                  <th class="heat-label">Category</th>
                  <th v-for="w in s.windows" :key="w.label">{{ w.label }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in s.categories" :key="row.label">
                  <td class="heat-label">{{ row.label }}</td>
                  <td
                    v-for="(c, i) in row.cells"
                    :key="i"
                    :style="c ? { background: surfaceCellColor(surfaceShare(c.clicks, s.windows[i]?.clicks ?? 0)) } : undefined"
                    :title="
                      c
                        ? surfaceCellTitle(s.label, row.label, s.windows[i]?.label ?? '', c, s.windows[i]?.clicks ?? 0)
                        : `${row.label} — no ${s.label} pickup in the last ${s.windows[i]?.label ?? ''}`
                    "
                  >
                    <template v-if="c">
                      <span class="rv">{{ fmtCount(c.clicks) }}</span>
                      <span class="rs">{{ fmtCount(c.impressions) }} impr</span>
                    </template>
                    <span v-else class="muted">—</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <h3 class="heat-h">Most picked-up articles · last 1 month</h3>
          <p v-if="!s.top.length" class="muted no-pickup">
            No single article drew a {{ s.label }} click in the last month.
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
        Big number = clicks from Google; small grey number = impressions (times shown). “—” means no
        pickup at all in that window, which is not the same as zero clicks. Windows are trailing and
        cumulative — 1 month includes the week. Deeper violet = a larger share of that surface’s clicks
        in that window. Google credits whichever copy of a story it treats as the original, so a story
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
