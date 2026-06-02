<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useApi } from '../composables/useApi';
import MetricCard from '../components/MetricCard.vue';
import FunnelStat from '../components/FunnelStat.vue';
import SparkLine from '../components/SparkLine.vue';
import { THRESHOLDS, bandTooltip, classify, pct } from '../composables/thresholds';

type Metrics = {
  activeSubscribers: number;
  growth: { date: string; newSubscribers: number }[];
  funnel: { promptShown: number; promptAccepted: number; subscribed: number };
  unsubscribeRate: number | null;
  optInRate: number | null;
  deliveryRate: number | null;
  totals: { sent: number; clicked: number; expired: number; failed: number };
  subscribersBySource: {
    'soft-prompt': number;
    recapture: number;
    pushsubscriptionchange: number;
    import: number;
  };
  campaigns: {
    id: string;
    title: string;
    status: string;
    sent: number;
    clicked: number;
    failed: number;
    ctr: number | null;
    deliveryRate: number | null;
    createdAt: string;
  }[];
};

const SOURCE_LABELS: Record<string, string> = {
  'soft-prompt': 'Soft prompt (organic opt-in)',
  recapture: 'Recaptured (iZooto migration)',
  pushsubscriptionchange: 'SW endpoint rotation',
  import: 'Bulk import',
};

const api = useApi();
const metrics = ref<Metrics | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

async function load() {
  loading.value = true;
  error.value = null;
  try {
    metrics.value = await api.get<Metrics>('/api/metrics');
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

const sparkPoints = computed(() =>
  (metrics.value?.growth ?? []).map((p) => ({ date: p.date, value: p.newSubscribers })),
);

const overallCtrValue = computed(() => {
  const t = metrics.value?.totals;
  if (!t || t.sent === 0) return null;
  return t.clicked / t.sent;
});

const sourceEntries = computed(() => {
  const src = metrics.value?.subscribersBySource;
  if (!src) return [] as { key: string; label: string; count: number }[];
  return (Object.keys(src) as (keyof typeof src)[]).map((key) => ({
    key,
    label: SOURCE_LABELS[key] || key,
    count: src[key],
  }));
});

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

onMounted(load);
</script>

<template>
  <main class="page">
    <div class="toolbar">
      <h1 class="section-title" style="margin: 0">Dashboard</h1>
      <button class="btn" :disabled="loading" @click="load">
        {{ loading ? 'Loading…' : 'Refresh' }}
      </button>
    </div>

    <div v-if="error" class="banner err">{{ error }}</div>

    <template v-if="metrics">
      <div class="metric-grid">
        <MetricCard
          label="Active subscribers"
          :value="metrics.activeSubscribers.toLocaleString()"
        />
        <MetricCard label="Total sent" :value="metrics.totals.sent.toLocaleString()" />
        <MetricCard
          label="Overall CTR"
          :value="pct(overallCtrValue)"
          :hint="metrics.totals.clicked.toLocaleString() + ' clicks'"
          :band="classify(overallCtrValue, THRESHOLDS.ctr)"
          :band-title="bandTooltip('ctr')"
        />
        <MetricCard
          label="Opt-in rate"
          :value="pct(metrics.optInRate)"
          :hint="metrics.funnel.promptAccepted.toLocaleString() + ' / ' + metrics.funnel.promptShown.toLocaleString() + ' prompts'"
          :band="classify(metrics.optInRate, THRESHOLDS.optInRate)"
          :band-title="bandTooltip('optInRate')"
        />
        <MetricCard
          label="Delivery rate"
          :value="pct(metrics.deliveryRate)"
          :hint="metrics.totals.failed.toLocaleString() + ' failed'"
          :band="classify(metrics.deliveryRate, THRESHOLDS.deliveryRate)"
          :band-title="bandTooltip('deliveryRate')"
        />
        <MetricCard
          label="Unsubscribe rate"
          :value="pct(metrics.unsubscribeRate)"
          :hint="metrics.totals.expired.toLocaleString() + ' expired'"
          :band="classify(metrics.unsubscribeRate, THRESHOLDS.unsubscribeRate)"
          :band-title="bandTooltip('unsubscribeRate')"
        />
      </div>
      <div class="thresholds-legend">
        Coloured dots reflect target thresholds — green = on target, amber = warning, red = below
        target. See README → "What good looks like".
      </div>

      <div class="card" style="margin-top: 16px">
        <h2>Subscriber sources</h2>
        <table>
          <thead>
            <tr><th>Source</th><th>Subscribers</th></tr>
          </thead>
          <tbody>
            <tr v-for="entry in sourceEntries" :key="entry.key">
              <td>{{ entry.label }}</td>
              <td>{{ entry.count.toLocaleString() }}</td>
            </tr>
          </tbody>
        </table>
        <div class="muted" style="margin-top: 6px">
          Watch <strong>Recaptured</strong> grow during iZooto cutover. Once comfortable, flip
          <code>SEND_MODE=live</code> and <code>CUTOVER_MODE=true</code> together.
        </div>
      </div>

      <div class="card">
        <h2>30-day subscriber growth</h2>
        <SparkLine :points="sparkPoints" />
        <div class="muted" style="margin-top: 6px">
          {{ sparkPoints.reduce((s, p) => s + p.value, 0).toLocaleString() }} new subscribers in the
          last 30 days
        </div>
      </div>

      <div class="card">
        <h2>Opt-in funnel</h2>
        <div class="funnel">
          <FunnelStat
            label="Prompt shown"
            :value="metrics.funnel.promptShown"
            :base="Math.max(metrics.funnel.promptShown, 1)"
          />
          <FunnelStat
            label="Prompt accepted"
            :value="metrics.funnel.promptAccepted"
            :base="Math.max(metrics.funnel.promptShown, 1)"
          />
          <FunnelStat
            label="Subscribed"
            :value="metrics.funnel.subscribed"
            :base="Math.max(metrics.funnel.promptShown, 1)"
          />
        </div>
      </div>

      <div class="card">
        <h2>Recent campaigns</h2>
        <table>
          <thead>
            <tr>
              <th>Created</th>
              <th>Title</th>
              <th>Status</th>
              <th>Sent</th>
              <th>Clicked</th>
              <th>CTR</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in metrics.campaigns.slice(0, 5)" :key="c.id">
              <td class="muted">{{ fmtDate(c.createdAt) }}</td>
              <td>{{ c.title }}</td>
              <td><span class="badge" :class="c.status">{{ c.status }}</span></td>
              <td>{{ c.sent }}</td>
              <td>{{ c.clicked }}</td>
              <td>
                <span :class="['band-pill', classify(c.ctr, THRESHOLDS.ctr)]" :title="bandTooltip('ctr')">
                  {{ pct(c.ctr) }}
                </span>
              </td>
            </tr>
            <tr v-if="metrics.campaigns.length === 0">
              <td colspan="6" class="muted" style="text-align: center; padding: 24px">
                No campaigns yet.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </main>
</template>
