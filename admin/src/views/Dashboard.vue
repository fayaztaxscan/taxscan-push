<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useApi } from '../composables/useApi';
import MetricCard from '../components/MetricCard.vue';
import FunnelStat from '../components/FunnelStat.vue';
import SparkLine from '../components/SparkLine.vue';
import InfoTip from '../components/InfoTip.vue';
import { THRESHOLDS, bandTooltip, classify, pct } from '../composables/thresholds';

// Plain-language explanations shown behind each card's ⓘ icon: what it means
// and what to expect from the numbers.
const INFO = {
  activeSubscribers:
    'How many people are signed up to get your notifications right now — your live audience. It grows as people opt in and dips when dead subscriptions are cleaned out. Expect steady growth; a sudden drop is usually a one-time cleanup, not lost readers.',
  totalSent:
    'Total individual notifications delivered since launch — sending one article to 1,000 people counts as 1,000. It only ever goes up. A faster climb means more articles going out and/or a bigger audience.',
  ctr:
    'Click-through rate: of all notifications sent, the share people actually clicked. The best gauge of how interesting and relevant your pushes are. Higher is better — aim for about 4–6%. Low means the content or who it is sent to needs work.',
  optInRate:
    'Of the people shown the “Allow notifications?” prompt, the share who said yes. Measures how convincing the prompt is. Aim for 5% or more. Low usually means the prompt shows at the wrong moment.',
  deliveryRate:
    'Of the notifications we tried to send, the share that actually reached the device. The rest bounce off dead or expired subscriptions. Aim for 95%+. A dip means many dead subscriptions and usually self-heals as they are pruned.',
  unsubscribeRate:
    'The share of subscribers who opted out or whose subscription died. Lower is better — keep it under 0.5%. A spike is a fatigue warning: too many notifications, or content people do not want.',
  sources:
    'Where your subscribers came from. “Soft prompt” = clicked Allow on your site. “Recaptured” = returning visitors who had already allowed notifications and were re-registered automatically. “SW endpoint rotation” = a technical re-registration of an existing subscriber (not a new person). “Bulk import” = added from a file.',
  growth:
    'New subscribers added each day over the last 30 days — your growth trend at a glance. A rising or steady line is healthy; a flat line near zero means sign-ups have stalled.',
  funnel:
    'The journey from prompt to subscriber: how many saw the “Allow?” prompt, how many accepted, and how many ended up subscribed. A big drop between two steps shows where you are losing people.',
  campaigns:
    'Your most recent notifications and how each did — who it reached, how many clicked, and the click rate (CTR). Use it to spot which headlines land best.',
};

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
  recapture: 'Recaptured (returning opt-ins)',
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
          :info="INFO.activeSubscribers"
        />
        <MetricCard
          label="Total sent"
          :value="metrics.totals.sent.toLocaleString()"
          :info="INFO.totalSent"
        />
        <MetricCard
          label="Overall CTR"
          :value="pct(overallCtrValue)"
          :hint="metrics.totals.clicked.toLocaleString() + ' clicks'"
          :band="classify(overallCtrValue, THRESHOLDS.ctr)"
          :band-title="bandTooltip('ctr')"
          :info="INFO.ctr"
        />
        <MetricCard
          label="Opt-in rate"
          :value="pct(metrics.optInRate)"
          :hint="metrics.funnel.promptAccepted.toLocaleString() + ' / ' + metrics.funnel.promptShown.toLocaleString() + ' prompts'"
          :band="classify(metrics.optInRate, THRESHOLDS.optInRate)"
          :band-title="bandTooltip('optInRate')"
          :info="INFO.optInRate"
        />
        <MetricCard
          label="Delivery rate"
          :value="pct(metrics.deliveryRate)"
          :hint="metrics.totals.failed.toLocaleString() + ' failed'"
          :band="classify(metrics.deliveryRate, THRESHOLDS.deliveryRate)"
          :band-title="bandTooltip('deliveryRate')"
          :info="INFO.deliveryRate"
        />
        <MetricCard
          label="Unsubscribe rate"
          :value="pct(metrics.unsubscribeRate)"
          :hint="metrics.totals.expired.toLocaleString() + ' expired'"
          :band="classify(metrics.unsubscribeRate, THRESHOLDS.unsubscribeRate)"
          :band-title="bandTooltip('unsubscribeRate')"
          :info="INFO.unsubscribeRate"
        />
      </div>
      <div class="thresholds-legend">
        Coloured dots reflect target thresholds — green = on target, amber = warning, red = below
        target. See README → "What good looks like".
      </div>

      <div class="card" style="margin-top: 16px">
        <h2>Subscriber sources <InfoTip heading="Subscriber sources" :text="INFO.sources" /></h2>
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
          <strong>Recaptured</strong> is the main growth source and should climb steadily — these
          are returning visitors who had already allowed notifications and re-register
          automatically. <strong>Soft prompt</strong> tracks new opt-ins from the on-site prompt.
        </div>
      </div>

      <div class="card">
        <h2>30-day subscriber growth <InfoTip heading="30-day subscriber growth" :text="INFO.growth" /></h2>
        <SparkLine :points="sparkPoints" />
        <div class="muted" style="margin-top: 6px">
          {{ sparkPoints.reduce((s, p) => s + p.value, 0).toLocaleString() }} new subscribers in the
          last 30 days
        </div>
      </div>

      <div class="card">
        <h2>Opt-in funnel <InfoTip heading="Opt-in funnel" :text="INFO.funnel" /></h2>
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
        <h2>Recent campaigns <InfoTip heading="Recent campaigns" :text="INFO.campaigns" /></h2>
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
