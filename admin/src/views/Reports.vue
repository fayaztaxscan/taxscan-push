<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { apiErrorMessage, useApi } from '../composables/useApi';
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

const api = useApi();
const { user } = useAuth();
const isAdmin = computed(() => user.value?.role === 'ADMIN');
const period = ref<'weekly' | 'monthly' | 'custom'>('weekly');

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
function setPeriod(p: 'weekly' | 'monthly' | 'custom') {
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
      period.value === 'custom'
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
      </div>
      <span class="spacer" style="flex: 1" />
      <button class="btn" :disabled="!report || loading" @click="downloadImage">Download image</button>
      <button class="btn" :disabled="!report || loading" @click="copyImage">Copy image</button>
      <button
        class="btn"
        :disabled="!report || loading || period === 'custom'"
        :title="period === 'custom' ? 'Test emails send the standing Weekly/Monthly report' : ''"
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

    <div v-if="report" ref="sheet" class="report-sheet">
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
</style>
