<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import ConfirmPush from '../components/ConfirmPush.vue';
import { apiErrorMessage, PUSH_REQUEST, useApi } from '../composables/useApi';

type Status = 'WAITING' | 'RETRYING' | 'POSTED' | 'FAILED' | 'SKIPPED' | 'NOT_POSTED';
type Row = {
  id: string | null;
  campaignId: string;
  pushedAt: string;
  pushedTime: string;
  headline: string;
  status: Status;
  error: string | null;
  attempts: number;
  nextAttemptTime: string | null;
  postedAt: string | null;
  postUrl: string | null;
  unknownOutcome: boolean;
};
type Counts = { waiting: number; posted: number; failed: number; skipped: number; notPosted: number; all: number };
type ListResponse = {
  date: string;
  rows: Row[];
  counts: Counts;
  login: { since: string; status: number | null } | null;
};
type Filter = 'all' | 'waiting' | 'posted' | 'failed' | 'skipped';

const api = useApi();

// Dates are IST days (the server's day boundary). Today in IST = UTC + 5:30.
const IST_MS = 5.5 * 3600 * 1000;
function istDay(offsetDays: number): string {
  return new Date(Date.now() + IST_MS + offsetDays * 86_400_000).toISOString().slice(0, 10);
}
const maxDate = istDay(0);
const minDate = istDay(-14);

const date = ref<string>(maxDate);
const filter = ref<Filter>('all');
const rows = ref<Row[]>([]);
const counts = ref<Counts>({ waiting: 0, posted: 0, failed: 0, skipped: 0, notPosted: 0, all: 0 });
const login = ref<ListResponse['login']>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const note = ref<string | null>(null);
const busyId = ref<string | null>(null);
const retrying = ref<Row | null>(null);

const isToday = computed(() => date.value === maxDate);
const isYesterday = computed(() => date.value === istDay(-1));

const CHIPS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'waiting', label: 'Waiting' },
  { key: 'posted', label: 'Posted' },
  { key: 'failed', label: 'Failed' },
  { key: 'skipped', label: 'Skipped' },
];

const shown = computed(() => {
  switch (filter.value) {
    case 'waiting':
      return rows.value.filter((r) => r.status === 'WAITING' || r.status === 'RETRYING');
    case 'posted':
      return rows.value.filter((r) => r.status === 'POSTED');
    case 'failed':
      return rows.value.filter((r) => r.status === 'FAILED');
    case 'skipped':
      return rows.value.filter((r) => r.status === 'SKIPPED');
    default:
      return rows.value;
  }
});

const dayWord = computed(() => (isToday.value ? 'today' : isYesterday.value ? 'yesterday' : `on ${date.value}`));
const emptyText = computed(() => {
  if (counts.value.all === 0) {
    return isToday.value ? 'Nothing pushed yet today.' : `Nothing was pushed ${dayWord.value}.`;
  }
  const word: Record<Exclude<Filter, 'all'>, string> = {
    waiting: 'waiting to be posted',
    posted: 'posted',
    failed: 'failed',
    skipped: 'skipped',
  };
  return `Nothing ${word[filter.value as Exclude<Filter, 'all'>]} ${dayWord.value}.`;
});

const loginText = computed(() => {
  if (!login.value) return '';
  const when = new Date(login.value.since).toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  const st = login.value.status ? ` (${login.value.status})` : '';
  return `LinkedIn rejected the access token${st} since ${when}. Posting is stopped until a new token is set in Railway or the app restarts.`;
});

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const data = await api.get<ListResponse>(`/api/linkedin/posts?date=${encodeURIComponent(date.value)}`);
    rows.value = data.rows;
    counts.value = data.counts;
    login.value = data.login;
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    loading.value = false;
  }
}

function setDate(d: string): void {
  if (!d || d < minDate || d > maxDate) return;
  date.value = d;
  void load();
}
function onPick(e: Event): void {
  const v = (e.target as HTMLInputElement).value;
  if (!v || v < minDate || v > maxDate) {
    (e.target as HTMLInputElement).value = date.value; // snap back to what is on screen
    return;
  }
  setDate(v);
}

const retryDetail = computed(() =>
  retrying.value?.unknownOutcome
    ? 'Check the LinkedIn page first — it may already be posted.'
    : 'It goes to the Taxscan LinkedIn page straight away.',
);

async function confirmRetry(): Promise<void> {
  const r = retrying.value;
  if (!r?.id) return;
  busyId.value = r.id;
  error.value = null;
  note.value = null;
  try {
    const res = await api.post<{ ok: boolean; status: 'POSTED' | 'FAILED' | 'PENDING' }>(
      `/api/linkedin/posts/${encodeURIComponent(r.id)}/retry`,
      {},
      {
        ...PUSH_REQUEST,
        unknownMessage: 'No reply from the server — it may still be posting. Check the list in a minute.',
      },
    );
    if (res.status === 'FAILED') note.value = 'LinkedIn did not accept it — see the reason on the row.';
    else if (res.status === 'PENDING') note.value = 'LinkedIn is busy — it will be tried again shortly.';
    retrying.value = null;
    await load();
  } catch (e) {
    retrying.value = null;
    const status = (e as { status?: number })?.status;
    if (status === 409) {
      error.value = 'This post changed in the meantime — the list has been refreshed.';
      await load();
    } else {
      error.value = apiErrorMessage(e);
    }
  } finally {
    busyId.value = null;
  }
}

async function skip(r: Row): Promise<void> {
  if (!r.id) return;
  busyId.value = r.id;
  error.value = null;
  note.value = null;
  try {
    await api.post(`/api/linkedin/posts/${encodeURIComponent(r.id)}/skip`, {});
    await load();
  } catch (e) {
    error.value = apiErrorMessage(e);
    await load();
  } finally {
    busyId.value = null;
  }
}

const STATUS_LABEL: Record<Status, string> = {
  WAITING: 'Waiting',
  RETRYING: 'Waiting',
  POSTED: 'Posted',
  FAILED: 'Failed',
  SKIPPED: 'Skipped',
  NOT_POSTED: 'Not posted',
};
function statusText(r: Row): string {
  if (r.status === 'RETRYING') return r.nextAttemptTime ? `Waiting — retry ${r.nextAttemptTime}` : 'Waiting — retry';
  return STATUS_LABEL[r.status];
}

onMounted(load);
</script>

<template>
  <main class="page page-wide">
    <div class="toolbar">
      <h1 class="section-title" style="margin: 0">LinkedIn page</h1>
      <button class="btn" :disabled="loading" @click="load">{{ loading ? 'Loading…' : 'Refresh' }}</button>
    </div>
    <p class="muted" style="font-size: 13px; margin: 4px 0 12px">
      Every article we push is posted to the Taxscan LinkedIn page automatically, a few minutes later. Nothing to do
      unless a post fails.
    </p>

    <div v-if="login" class="banner warn" role="alert">{{ loginText }}</div>

    <div class="li-controls">
      <div class="li-days">
        <button type="button" class="btn" :class="{ 'li-on': isToday }" @click="setDate(maxDate)">Today</button>
        <button type="button" class="btn" :class="{ 'li-on': isYesterday }" @click="setDate(istDay(-1))">Yesterday</button>
        <label class="li-date">
          <span class="sr-only">Pick a date</span>
          <input type="date" :value="date" :min="minDate" :max="maxDate" aria-label="Pick a date" @change="onPick" />
        </label>
      </div>
      <div class="li-chips" role="group" aria-label="Filter by status">
        <button
          v-for="c in CHIPS"
          :key="c.key"
          type="button"
          class="li-chip"
          :class="{ 'li-on': filter === c.key, 'li-alert': c.key === 'failed' && counts.failed > 0 }"
          :aria-pressed="filter === c.key"
          @click="filter = c.key"
        >
          {{ c.label }} <span class="li-count">{{ c.key === 'all' ? counts.all : counts[c.key] }}</span>
        </button>
      </div>
    </div>

    <div v-if="error" class="banner err">{{ error }}</div>
    <div v-if="note" class="banner warn">{{ note }}</div>

    <div class="card">
      <table class="stack">
        <thead>
          <tr>
            <th>Pushed (IST)</th>
            <th>Headline</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in shown" :key="r.campaignId" :class="{ 'li-quiet': r.status === 'NOT_POSTED' }">
            <td data-label="Pushed" style="white-space: nowrap">
              <strong>{{ r.pushedTime }}</strong>
            </td>
            <td class="cell-lead">{{ r.headline }}</td>
            <td class="cell-wide" data-label="Status">
              <span class="li-status" :class="'s-' + r.status">{{ statusText(r) }}</span>
              <a
                v-if="r.status === 'POSTED' && r.postUrl"
                class="li-view"
                :href="r.postUrl"
                target="_blank"
                rel="noopener"
                >View on LinkedIn</a
              >
              <div v-if="r.status === 'FAILED' && r.error" class="li-reason">{{ r.error }}</div>
              <div v-else-if="r.status === 'RETRYING' && r.error" class="li-reason muted">{{ r.error }}</div>
            </td>
            <td class="cell-actions li-actions">
              <template v-if="r.id && (r.status === 'FAILED' || r.status === 'RETRYING')">
                <button
                  v-if="r.status === 'FAILED'"
                  type="button"
                  class="btn btn-primary"
                  :disabled="busyId === r.id"
                  @click="retrying = r"
                >
                  Retry
                </button>
                <button type="button" class="btn" :disabled="busyId === r.id" @click="skip(r)">Skip</button>
              </template>
            </td>
          </tr>
          <tr v-if="shown.length === 0 && !loading && !error">
            <td colspan="4" class="muted" style="text-align: center; padding: 24px; font-size: 14px">{{ emptyText }}</td>
          </tr>
          <tr v-if="loading && rows.length === 0">
            <td colspan="4" class="muted" style="text-align: center; padding: 24px">Loading…</td>
          </tr>
        </tbody>
      </table>
    </div>

    <ConfirmPush
      v-if="retrying"
      :title="retrying.headline"
      :busy="busyId === retrying.id"
      heading="Post to LinkedIn now?"
      :detail="retryDetail"
      confirm-label="Post now"
      busy-label="Posting…"
      @confirm="confirmRetry"
      @cancel="retrying = null"
    />
  </main>
</template>

<style scoped>
.li-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px 16px;
  margin-bottom: 12px;
}
.li-days {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.li-date input {
  width: auto;
}
.li-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.li-chip {
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  border-radius: 999px;
  padding: 7px 14px;
  font-size: 13px;
  cursor: pointer;
}
.li-chip.li-alert:not(.li-on) {
  border-color: #dc2626;
  color: #b91c1c;
  font-weight: 600;
}
.li-chip.li-on,
.btn.li-on {
  background: var(--primary);
  border-color: var(--primary);
  color: #fff;
}
.li-count {
  font-variant-numeric: tabular-nums;
  opacity: 0.8;
  margin-left: 2px;
}
.li-status {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
}
.li-status.s-POSTED {
  color: #16a34a;
}
.li-status.s-FAILED {
  color: #dc2626;
}
.li-status.s-SKIPPED,
.li-status.s-RETRYING {
  color: var(--warn);
}
.li-view {
  margin-left: 10px;
  font-size: 13px;
}
.li-reason {
  font-size: 12px;
  margin-top: 2px;
  overflow-wrap: anywhere;
}
.li-status + .li-reason {
  color: #b91c1c;
}
tr.li-quiet td {
  opacity: 0.6;
}
.li-actions {
  white-space: nowrap;
}
.li-actions .btn {
  margin-right: 6px;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
@media (max-width: 720px) {
  .toolbar .btn,
  .li-days .btn,
  .li-chip,
  .li-date input,
  .li-view {
    min-height: 44px;
  }
  .li-view {
    display: inline-flex;
    align-items: center;
  }
  .li-chips {
    width: 100%;
  }
  .li-chip {
    flex: 1 1 auto;
  }
  .li-actions .btn {
    margin-right: 0;
    min-height: 44px;
  }
}
</style>
