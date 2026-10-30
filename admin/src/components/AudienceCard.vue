<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { apiErrorMessage, useApi } from '../composables/useApi';
import { useAuth } from '../composables/useAuth';
import ConfirmPush from './ConfirmPush.vue';

/**
 * Digests → Audience card (docs/CMS_AUDIENCE_SYNC_DESIGN.md §10.2): how the Premium / Free reader lists are doing
 * after the CMS sync. Everything comes from Postgres (`GET /api/digest/audience`); nothing here calls the CMS or
 * Mailercloud. An ADMIN sees the counts and, when the breaker has paused Mailercloud writes, can review them and
 * press Resume (confirm first, Cancel focused). A PUBLISHER sees the one-line status. Hidden when the sync is off.
 * The server writes every sentence; this card only lays them out.
 */

type Counts = {
  premiumCms: number | null;
  premiumOurs: number;
  premiumApplied: number;
  premiumMailercloud: number | null;
  former: number;
  noMarketing: number;
  pendingWrites: number;
};
type Card =
  | { enabled: false }
  | { enabled: true; ok: boolean; line: string }
  | {
      enabled: true;
      ok: boolean;
      line: string;
      writesLive: boolean;
      guardActive: boolean;
      counts: Counts;
      last: { webhookAt: string | null; incrementalAt: string | null; fullAt: string | null };
      errors24h: { writerRetryable: number; writerFatal: number; seqConflict: number; unknownStatus: number };
      guard: { ok: true } | { ok: false; check: string; plain: string };
      breaker: { open: boolean; reason: string | null; plain: string | null; openedAt: string | null; review: Record<string, number> };
    };

const api = useApi();
const { user } = useAuth();
const card = ref<Card | null>(null);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const confirming = ref(false);
const busy = ref(false);

const full = computed(() => (card.value && card.value.enabled && 'counts' in card.value ? card.value : null));
const isAdmin = computed(() => user.value?.role === 'ADMIN');

const REVIEW_LABEL: Record<string, string> = {
  rows: 'Readers in the load',
  premiumCms: 'Premium (CMS)',
  premiumOurs: 'Premium (ours)',
  premium: 'Premium',
  mailed: 'Mailed members',
  changed: 'Role changes in this run',
  limit: 'Limit',
  removals24h: 'Premium removals in 24 h',
  premiumNow: 'Premium now',
  previousRows: 'Readers in the previous load',
  erasures: 'Erasures today',
};
const reviewRows = computed(() =>
  Object.entries(full.value?.breaker.review ?? {})
    .filter(([k]) => k !== 'reason')
    .map(([k, v]) => ({ label: REVIEW_LABEL[k] ?? k.replace(/([A-Z])/g, ' $1').toLowerCase(), value: v })),
);

const num = (n: number | null): string => (n === null ? '—' : n.toLocaleString('en-IN'));
function when(iso: string | null): string {
  if (!iso) return 'never';
  return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' IST';
}
const errorTotal = computed(() => {
  const e = full.value?.errors24h;
  return e ? e.writerRetryable + e.writerFatal + e.seqConflict + e.unknownStatus : 0;
});
const errorWords = computed(() => {
  const e = full.value?.errors24h;
  if (!e) return '';
  const parts: string[] = [];
  if (e.writerRetryable) parts.push(`${e.writerRetryable} Mailercloud writes retrying`);
  if (e.writerFatal) parts.push(`${e.writerFatal} refused by Mailercloud`);
  if (e.seqConflict) parts.push(`${e.seqConflict} conflicting CMS updates today`);
  if (e.unknownStatus) parts.push(`${e.unknownStatus} unknown account statuses today`);
  return parts.join('; ');
});

async function load() {
  error.value = null;
  try {
    card.value = await api.get<Card>('/api/digest/audience');
  } catch (e) {
    error.value = apiErrorMessage(e);
  }
}

async function resume() {
  busy.value = true;
  error.value = null;
  try {
    await api.post('/api/digest/audience/resume', {});
    notice.value = 'Audience sync resumed. Mailercloud writes restart on the next run.';
    confirming.value = false;
    await load();
  } catch (e) {
    confirming.value = false;
    error.value = apiErrorMessage(e);
    await load();
  } finally {
    busy.value = false;
  }
}

onMounted(load);
defineExpose({ load });
</script>

<template>
  <section v-if="card && card.enabled" id="audience-card" class="card audience-card" aria-labelledby="audience-title">
    <div class="toolbar">
      <h2 id="audience-title" style="margin: 0">Audience</h2>
      <span class="status-pill" :class="card.ok ? 'active' : 'inactive'">{{ card.ok ? 'Verified' : 'Needs attention' }}</span>
    </div>
    <p class="aud-line">{{ card.line }}</p>

    <div v-if="error" class="banner err" role="alert">{{ error }}</div>
    <div v-if="notice" class="banner ok" role="status">{{ notice }}</div>

    <template v-if="full && isAdmin">
      <div v-if="full.breaker.open" class="banner warn aud-breaker" role="status">
        <p class="banner-lead">Mailercloud writes are paused for review.</p>
        <p class="banner-detail">{{ full.breaker.plain }}<span v-if="full.breaker.openedAt"> Paused {{ when(full.breaker.openedAt) }}.</span></p>
        <dl v-if="reviewRows.length" class="aud-review">
          <div v-for="r in reviewRows" :key="r.label">
            <dt>{{ r.label }}</dt>
            <dd>{{ r.value.toLocaleString('en-IN') }}</dd>
          </div>
        </dl>
        <button class="btn btn-primary" :disabled="busy" @click="confirming = true">Resume</button>
      </div>
      <p v-else-if="!full.guard.ok" class="muted aud-held">Premium digest held: {{ full.guard.plain }}.</p>

      <table class="stack aud-table">
        <thead>
          <tr>
            <th class="num">Premium · CMS</th>
            <th class="num">Premium · ours</th>
            <th class="num">Premium · Mailercloud</th>
            <th class="num">Former</th>
            <th class="num">No marketing</th>
            <th class="num">Pending writes</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td class="num" data-label="Premium · CMS">{{ num(full.counts.premiumCms) }}</td>
            <td class="num" data-label="Premium · ours">{{ num(full.counts.premiumOurs) }}</td>
            <td class="num" data-label="Premium · Mailercloud">{{ num(full.counts.premiumMailercloud) }}</td>
            <td class="num" data-label="Former">{{ num(full.counts.former) }}</td>
            <td class="num" data-label="No marketing">{{ num(full.counts.noMarketing) }}</td>
            <td class="num" data-label="Pending writes">{{ num(full.counts.pendingWrites) }}</td>
          </tr>
        </tbody>
      </table>

      <table class="stack aud-table">
        <thead>
          <tr>
            <th>Last webhook</th>
            <th>Last incremental pull</th>
            <th>Last full pull</th>
            <th>Mailercloud writes</th>
            <th>Send guard</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td data-label="Last webhook">{{ when(full.last.webhookAt) }}</td>
            <td data-label="Last incremental pull">{{ when(full.last.incrementalAt) }}</td>
            <td data-label="Last full pull">{{ when(full.last.fullAt) }}</td>
            <td data-label="Mailercloud writes">{{ full.writesLive ? 'Live' : 'Dry run' }}</td>
            <td data-label="Send guard">{{ full.guardActive ? 'On' : 'Off' }}</td>
          </tr>
        </tbody>
      </table>
      <p class="muted legend">
        Errors in the last 24 h: {{ errorTotal === 0 ? 'none' : errorWords }}. “—” means not known yet; the Mailercloud
        count is refreshed by the nightly check.
      </p>
    </template>
  </section>

  <ConfirmPush
    v-if="confirming && full"
    heading="Resume audience sync?"
    :title="full.breaker.plain ?? 'The audience sync is paused.'"
    detail="Mailercloud writes restart on the next run."
    confirm-label="Resume"
    busy-label="Resuming…"
    :busy="busy"
    @confirm="resume"
    @cancel="confirming = false"
  />
</template>

<style scoped>
.aud-line {
  margin: 8px 0 12px;
  font-size: 14px;
}
.aud-held {
  margin: 0 0 12px;
}
.aud-breaker {
  margin: 0 0 14px;
}
.aud-breaker .btn {
  margin-top: 10px;
}
.aud-review {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 22px;
  margin: 8px 0 0;
}
.aud-review div {
  min-width: 0;
}
.aud-review dt {
  color: var(--muted);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.aud-review dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
.aud-table {
  margin-top: 4px;
}
.aud-table + .aud-table {
  margin-top: 14px;
}
</style>
