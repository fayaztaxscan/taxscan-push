<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import ConfirmPush from '../components/ConfirmPush.vue';
import { useRoute } from 'vue-router';
import { useAuth } from '../composables/useAuth';
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
  page?: string;
  login: { since: string; status: number | null } | null;
  policy: { since: string; code: number | null; subcode: number | null; message: string | null } | null;
};
type CheckResult = { ok: true; name: string; message: string } | { ok: false; kind: string; status?: number | null; code?: number | null; message: string };
type Filter = 'all' | 'waiting' | 'posted' | 'failed' | 'skipped';

const api = useApi();
const { user: meUser } = useAuth();
const isAdmin = computed(() => meUser.value?.role === 'ADMIN');

// Dates are IST days (the server's day boundary). Today in IST = UTC + 5:30.
const IST_MS = 5.5 * 3600 * 1000;
function istDay(offsetDays: number): string {
  return new Date(Date.now() + IST_MS + offsetDays * 86_400_000).toISOString().slice(0, 10);
}
const maxDate = istDay(0);
const minDate = istDay(-14);

// ?date=YYYY-MM-DD (the Campaigns Channels marks link here); anything outside the 14-day window falls back to today.
const qDate = String(useRoute().query.date ?? '');
const date = ref<string>(/^\d{4}-\d{2}-\d{2}$/.test(qDate) && qDate >= minDate && qDate <= maxDate ? qDate : maxDate);
const filter = ref<Filter>('all');
const rows = ref<Row[]>([]);
const counts = ref<Counts>({ waiting: 0, posted: 0, failed: 0, skipped: 0, notPosted: 0, all: 0 });
const login = ref<ListResponse['login']>(null);
const policy = ref<ListResponse['policy']>(null);
const check = ref<CheckResult | null>(null);
const checking = ref(false);
const resuming = ref(false);
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
  return `Facebook rejected the access token${st} since ${when}. Posting is stopped until a new token is set in Railway or the app restarts.`;
});

function whenText(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}
const policyText = computed(() => {
  const p = policy.value;
  if (!p) return '';
  const code = p.code ? ` (code ${p.code}${p.subcode ? '/' + p.subcode : ''})` : '';
  const said = p.message ? ` Facebook said: “${p.message.replace(/[.\s]+$/, '')}”.` : '';
  return `Since ${whenText(p.since)}${code}.${said} Nothing is posted until an administrator presses Resume.`;
});

async function load(keepError = false): Promise<void> {
  loading.value = true;
  if (!keepError) error.value = null;
  try {
    const data = await api.get<ListResponse>(`/api/facebook/posts?date=${encodeURIComponent(date.value)}`);
    rows.value = data.rows;
    counts.value = data.counts;
    login.value = data.login;
    policy.value = data.policy ?? null;
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
    ? 'Check the Facebook page first — it may already be posted.'
    : 'It goes to the Taxscan Facebook page straight away. Check the page first if you are unsure.',
);

async function confirmRetry(): Promise<void> {
  const r = retrying.value;
  if (!r?.id) return;
  busyId.value = r.id;
  error.value = null;
  note.value = null;
  try {
    const res = await api.post<{ ok: boolean; status: 'POSTED' | 'FAILED' | 'PENDING' }>(
      `/api/facebook/posts/${encodeURIComponent(r.id)}/retry`,
      {},
      {
        ...PUSH_REQUEST,
        unknownMessage: 'No reply from the server — it may still be posting. Check the list in a minute.',
      },
    );
    if (res.status === 'FAILED') note.value = 'Facebook did not accept it — see the reason on the row.';
    else if (res.status === 'PENDING') note.value = 'Facebook is busy — it will be tried again shortly.';
    retrying.value = null;
    await load();
  } catch (e) {
    retrying.value = null;
    const status = (e as { status?: number })?.status;
    const reason = (e as { body?: { error?: string } })?.body?.error;
    if (status === 409) {
      error.value =
        reason === 'policy_stop'
          ? 'Posting is stopped because Facebook blocked a post. An administrator has to resume it first.'
          : reason === 'not_configured'
            ? 'The Facebook page is not set up yet (page id / token in Railway).'
            : 'This post changed in the meantime — the list has been refreshed.';
      await load(true);
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
    await api.post(`/api/facebook/posts/${encodeURIComponent(r.id)}/skip`, {});
    await load();
  } catch (e) {
    error.value = apiErrorMessage(e);
    await load(true);
  } finally {
    busyId.value = null;
  }
}

const KIND_TEXT: Record<string, string> = {
  transient: 'Could not reach Facebook',
  auth: 'Facebook rejected the access token',
  policy: 'Facebook blocked the request',
  rate: 'Facebook is rate limiting us',
  not_configured: 'The page is not set up',
  failed: 'Facebook refused the request',
  error: 'Connection failed',
};

async function checkConnection(): Promise<void> {
  checking.value = true;
  check.value = null;
  try {
    check.value = await api.post<CheckResult>('/api/facebook/check', {}, { ...PUSH_REQUEST, unknownMessage: 'No reply from the server — try Check connection again.' });
  } catch (e) {
    check.value = { ok: false, kind: 'error', message: apiErrorMessage(e) };
  } finally {
    checking.value = false;
  }
}

async function resume(): Promise<void> {
  resuming.value = true;
  error.value = null;
  note.value = null;
  try {
    await api.post('/api/facebook/resume', {});
    note.value = 'Posting resumed. The next waiting article goes out within a few minutes.';
  } catch (e) {
    const status = (e as { status?: number })?.status;
    if (status === 409) note.value = 'Posting was already resumed.';
    else error.value = apiErrorMessage(e);
  } finally {
    resuming.value = false;
    await load(true);
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

onMounted(() => load());
</script>

<template>
  <main class="page page-wide">
    <div class="toolbar">
      <h1 class="section-title" style="margin: 0">Facebook page</h1>
      <div class="fb-tools">
        <button v-if="isAdmin" class="btn" :disabled="checking" data-testid="fb-check" @click="checkConnection">
          {{ checking ? 'Checking…' : 'Check connection' }}
        </button>
        <button class="btn" :disabled="loading" @click="load()">{{ loading ? 'Loading…' : 'Refresh' }}</button>
      </div>
    </div>
    <p class="muted" style="font-size: 13px; margin: 4px 0 8px">
      Every article we push is posted to the Taxscan Facebook page automatically, a few minutes later. Nothing to do
      unless a post fails.
    </p>
    <ul class="fb-rules muted" data-testid="fb-rules">
      <li>One post at a time, at least 10 minutes apart, and no more than 30 a day. Busy days spill over, so a post can be late.</li>
      <li>If Facebook blocks a post, posting stops completely until an administrator presses Resume.</li>
    </ul>

    <div v-if="check" class="banner" :class="check.ok ? 'ok' : 'err'" role="status" data-testid="fb-check-result">
      <template v-if="check.ok">Connected to page: <strong>{{ check.name }}</strong></template>
      <template v-else>
        <strong>{{ KIND_TEXT[check.kind] ?? 'Connection failed' }}.</strong>
        {{ check.message }}{{ check.status ? ' (HTTP ' + check.status + (check.code ? ', code ' + check.code : '') + ')' : '' }}
      </template>
    </div>

    <div v-if="policy" class="banner err fb-policy" role="alert" data-testid="fb-policy">
      <div>
        <strong>Facebook blocked a post — check the page before resuming.</strong>
        <div>{{ policyText }}</div>
        <div v-if="!isAdmin" style="margin-top: 4px">Ask an administrator to resume posting once the page is fine.</div>
      </div>
      <button v-if="isAdmin" type="button" class="btn btn-primary" :disabled="resuming" @click="resume">
        {{ resuming ? 'Resuming…' : 'Resume posting' }}
      </button>
    </div>
    <div v-if="login" class="banner warn" role="alert">{{ loginText }}</div>

    <div class="fb-controls">
      <div class="fb-days">
        <button type="button" class="btn" :class="{ 'fb-on': isToday }" @click="setDate(maxDate)">Today</button>
        <button type="button" class="btn" :class="{ 'fb-on': isYesterday }" @click="setDate(istDay(-1))">Yesterday</button>
        <label class="fb-date">
          <span class="sr-only">Pick a date</span>
          <input type="date" :value="date" :min="minDate" :max="maxDate" aria-label="Pick a date" @change="onPick" />
        </label>
      </div>
      <div class="fb-chips" role="group" aria-label="Filter by status">
        <button
          v-for="c in CHIPS"
          :key="c.key"
          type="button"
          class="fb-chip"
          :class="{ 'fb-on': filter === c.key, 'fb-alert': c.key === 'failed' && counts.failed > 0 }"
          :aria-pressed="filter === c.key"
          @click="filter = c.key"
        >
          {{ c.label }} <span class="fb-count">{{ c.key === 'all' ? counts.all : counts[c.key] }}</span>
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
          <tr v-for="r in shown" :key="r.campaignId" :class="{ 'fb-quiet': r.status === 'NOT_POSTED' }">
            <td data-label="Pushed" style="white-space: nowrap">
              <strong>{{ r.pushedTime }}</strong>
            </td>
            <td class="cell-lead">{{ r.headline }}</td>
            <td class="cell-wide" data-label="Status">
              <span class="fb-status" :class="'s-' + r.status">{{ statusText(r) }}</span>
              <a
                v-if="r.status === 'POSTED' && r.postUrl"
                class="fb-view"
                :href="r.postUrl"
                target="_blank"
                rel="noopener"
                >View on Facebook</a
              >
              <div v-if="r.status === 'FAILED' && r.error" class="fb-reason">{{ r.error }}</div>
              <div v-else-if="r.status === 'RETRYING' && r.error" class="fb-reason muted">{{ r.error }}</div>
            </td>
            <td class="cell-actions fb-actions">
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
      heading="Post to Facebook now?"
      :detail="retryDetail"
      confirm-label="Post now"
      busy-label="Posting…"
      @confirm="confirmRetry"
      @cancel="retrying = null"
    />
  </main>
</template>

<style scoped>
.fb-tools {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.fb-rules {
  font-size: 13px;
  margin: 0 0 12px;
  padding-left: 18px;
}
.fb-policy {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px 16px;
  overflow-wrap: anywhere;
}
.fb-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px 16px;
  margin-bottom: 12px;
}
.fb-days {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.fb-date input {
  width: auto;
}
.fb-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.fb-chip {
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  border-radius: 999px;
  padding: 7px 14px;
  font-size: 13px;
  cursor: pointer;
}
.fb-chip.fb-alert:not(.fb-on) {
  border-color: #dc2626;
  color: #b91c1c;
  font-weight: 600;
}
.fb-chip.fb-on,
.btn.fb-on {
  background: var(--primary);
  border-color: var(--primary);
  color: #fff;
}
.fb-count {
  font-variant-numeric: tabular-nums;
  opacity: 0.8;
  margin-left: 2px;
}
.fb-status {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
}
.fb-status.s-POSTED {
  color: #16a34a;
}
.fb-status.s-FAILED {
  color: #dc2626;
}
.fb-status.s-SKIPPED,
.fb-status.s-RETRYING {
  color: var(--warn);
}
.fb-view {
  margin-left: 10px;
  font-size: 13px;
}
.fb-reason {
  font-size: 12px;
  margin-top: 2px;
  overflow-wrap: anywhere;
}
.fb-status + .fb-reason {
  color: #b91c1c;
}
tr.fb-quiet td {
  opacity: 0.6;
}
.fb-actions {
  white-space: nowrap;
}
.fb-actions .btn {
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
  .fb-policy .btn {
    width: 100%;
  }
  .toolbar .btn,
  .fb-days .btn,
  .fb-chip,
  .fb-date input,
  .fb-view {
    min-height: 44px;
  }
  .fb-view {
    display: inline-flex;
    align-items: center;
  }
  .fb-chips {
    width: 100%;
  }
  .fb-chip {
    flex: 1 1 auto;
  }
  .fb-actions .btn {
    margin-right: 0;
    min-height: 44px;
  }
}
</style>
