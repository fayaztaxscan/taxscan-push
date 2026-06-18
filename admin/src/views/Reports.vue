<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { apiErrorMessage, useApi } from '../composables/useApi';
import { toPng } from 'html-to-image';

type Heatmap = {
  rows: { label: string; perDay: number[]; total: number }[];
  dates: string[];
  dayTotals: number[];
  grandTotal: number;
};
type Report = {
  period: 'weekly' | 'monthly';
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
const period = ref<'weekly' | 'monthly'>('weekly');
const report = ref<Report | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const sheet = ref<HTMLElement | null>(null);

async function load() {
  loading.value = true;
  error.value = null;
  notice.value = null;
  try {
    report.value = await api.get<Report>(`/api/reports?period=${period.value}`);
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    loading.value = false;
  }
}
function setPeriod(p: 'weekly' | 'monthly') {
  if (period.value === p) return;
  period.value = p;
  void load();
}

const trendPct = computed(() => {
  const r = report.value;
  if (!r || r.prevTotal === 0) return null;
  return Math.round(((r.total - r.prevTotal) / r.prevTotal) * 100);
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
  if (!sheet.value) throw new Error('Report not ready.');
  return toPng(sheet.value, { backgroundColor: '#ffffff', pixelRatio: 2 });
}
async function downloadImage() {
  error.value = null;
  notice.value = null;
  try {
    const a = document.createElement('a');
    a.href = await renderPng();
    a.download = `taxscan-${period.value}-report-${report.value?.end ?? ''}.png`;
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

onMounted(load);
</script>

<template>
  <main class="page page-wide">
    <div class="toolbar">
      <h1 class="section-title" style="margin: 0">Coverage report</h1>
      <div class="seg">
        <button :class="{ on: period === 'weekly' }" @click="setPeriod('weekly')">Weekly</button>
        <button :class="{ on: period === 'monthly' }" @click="setPeriod('monthly')">Monthly</button>
      </div>
      <span class="spacer" style="flex: 1" />
      <button class="btn" :disabled="!report || loading" @click="downloadImage">Download image</button>
      <button class="btn" :disabled="!report || loading" @click="copyImage">Copy image</button>
      <button class="btn" :disabled="loading" @click="load">{{ loading ? 'Loading…' : 'Refresh' }}</button>
    </div>

    <div v-if="error" class="banner err">{{ error }}</div>
    <div v-if="notice" class="banner ok">{{ notice }}</div>

    <div v-if="report" ref="sheet" class="report-sheet">
      <div class="report-head">
        <div class="report-title">
          Taxscan {{ report.period === 'weekly' ? 'Weekly' : 'Monthly' }} Coverage Report
        </div>
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
          <div class="ins-l">vs previous {{ report.period === 'weekly' ? 'week' : 'month' }} ({{ report.prevTotal }})</div>
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
        <strong>No coverage this {{ report.period === 'weekly' ? 'week' : 'month' }}:</strong>
        {{ topGaps.join(', ') }}<span v-if="report.gaps.benchesWithNothing.length > topGaps.length"> …</span>
      </div>

      <h3 class="heat-h">Categories × dates</h3>
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

      <h3 class="heat-h">Courts / benches × dates</h3>
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

      <div class="report-foot">Generated by Taxscan Push · {{ rangeLabel(report) }}</div>
    </div>

    <div v-else-if="!loading" class="card">
      <p class="muted">No report data yet.</p>
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
  grid-template-columns: repeat(4, 1fr);
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
