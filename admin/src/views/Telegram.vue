<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import ConfirmPush from '../components/ConfirmPush.vue';
import { useRoute } from 'vue-router';
import { useAuth } from '../composables/useAuth';
import { apiErrorMessage, PUSH_REQUEST, useApi } from '../composables/useApi';
import { looksLikeCode, telegramErrorText } from '../composables/telegramErrors';

type Status = 'WAITING' | 'RETRYING' | 'POSTED' | 'FAILED' | 'SKIPPED' | 'NOT_POSTED';
type Row = {
  id: string | null;
  campaignId: string;
  pushedAt: string;
  pushedTime: string;
  headline: string;
  status: Status;
  /** A short fixed code (never Telegram's own text); shown as plain words with the code kept in brackets. */
  error: string | null;
  attempts: number;
  nextAttemptTime: string | null;
  postedAt: string | null;
  postUrl: string | null;
  /** The call may have gone out before the worker lost the answer: check the channel before retrying. */
  unknownOutcome: boolean;
  /** Present ONLY on a SKIPPED row whose sender unticked this channel on Compose: the single value 'compose_skip'. Never shown as a code. */
  skipReason?: string;
};
type Counts = { waiting: number; posted: number; failed: number; skipped: number; notPosted: number; all: number };
type Stop = { since: string; status: number | null; error: string };
type ListResponse = {
  date: string;
  page?: string;
  /** The channel's public name, e.g. "@taxscan_in" (never the bot token). */
  channel: string | null;
  rows: Row[];
  counts: Counts;
  /** Set while Telegram has refused the channel (bot removed, not an admin, token revoked): nothing posts until an ADMIN presses Resume. */
  stop: Stop | null;
  /** The moment the channel started posting EVERY push (an ISO time). Nothing pushed before it is ever posted. */
  everyPushFrom: string | null;
  maxDaysBack?: number;
};
type CheckResult =
  | { ok: true; name: string; message: string }
  | { ok: false; kind: string; status?: number | null; message: string };
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
const maxBack = ref(14); // the server's `maxDaysBack` replaces this on the first reply
const minDate = computed(() => istDay(-maxBack.value));

// ?date=YYYY-MM-DD (the Campaigns Channels marks link here); anything outside the window falls back to today.
const qDate = String(useRoute().query.date ?? '');
const date = ref<string>(/^\d{4}-\d{2}-\d{2}$/.test(qDate) && qDate >= istDay(-14) && qDate <= maxDate ? qDate : maxDate);
const filter = ref<Filter>('all');
const rows = ref<Row[]>([]);
const counts = ref<Counts>({ waiting: 0, posted: 0, failed: 0, skipped: 0, notPosted: 0, all: 0 });
const channel = ref<string | null>(null);
const stop = ref<Stop | null>(null);
const everyPushFrom = ref<string | null>(null);
const check = ref<CheckResult | null>(null);
const checking = ref(false);
const resuming = ref(false);
const confirmingResume = ref(false);
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

/** "9 Nov, 14:05 IST" (or with the year): the IST clock the "Pushed (IST)" column uses. Empty when the server's time is unreadable. */
function istText(iso: string | null | undefined, withYear: boolean): string {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  const when = d.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    ...(withYear ? { year: 'numeric' as const } : {}),
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'Asia/Kolkata',
  });
  return `${when} IST`;
}
const sinceText = computed(() => istText(everyPushFrom.value, true));
const stopSince = computed(() => istText(stop.value?.since, false));
/** The public link to the channel (a `@name` has one; a numeric -100… id does not). */
const channelUrl = computed(() => (channel.value && /^@[A-Za-z0-9_]+$/.test(channel.value) ? `https://t.me/${channel.value.slice(1)}` : null));
const stopWhat = computed(() => (stop.value ? telegramErrorText(stop.value.error, stop.value.status) : ''));

async function load(keepError = false): Promise<void> {
  loading.value = true;
  if (!keepError) error.value = null;
  try {
    const data = await api.get<ListResponse>(`/api/telegram/posts?date=${encodeURIComponent(date.value)}`);
    rows.value = data.rows;
    counts.value = data.counts;
    channel.value = data.channel ?? null;
    stop.value = data.stop ?? null;
    everyPushFrom.value = data.everyPushFrom ?? null;
    if (typeof data.maxDaysBack === 'number' && data.maxDaysBack > 0) maxBack.value = data.maxDaysBack;
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    loading.value = false;
  }
}

function setDate(d: string): void {
  if (!d || d < minDate.value || d > maxDate) return;
  date.value = d;
  void load();
}
function onPick(e: Event): void {
  const v = (e.target as HTMLInputElement).value;
  if (!v || v < minDate.value || v > maxDate) {
    (e.target as HTMLInputElement).value = date.value; // snap back to what is on screen
    return;
  }
  setDate(v);
}

const retryDetail = computed(() =>
  retrying.value?.unknownOutcome
    ? 'Check the Telegram channel first — it may already be posted.'
    : 'It goes to the Taxscan Telegram channel straight away. Check the channel first if you are unsure.',
);

async function confirmRetry(): Promise<void> {
  const r = retrying.value;
  if (!r?.id) return;
  busyId.value = r.id;
  error.value = null;
  note.value = null;
  try {
    const res = await api.post<{ ok: boolean; status: 'POSTED' | 'FAILED' | 'PENDING' }>(
      `/api/telegram/posts/${encodeURIComponent(r.id)}/retry`,
      {},
      {
        ...PUSH_REQUEST,
        unknownMessage: 'No reply from the server — it may still be posting. Check the list in a minute.',
      },
    );
    if (res.status === 'FAILED') note.value = 'Telegram did not accept it — see the reason on the row.';
    else if (res.status === 'PENDING') note.value = 'Telegram is busy — it will be tried again shortly.';
    retrying.value = null;
    await load();
  } catch (e) {
    retrying.value = null;
    const status = (e as { status?: number })?.status;
    const reason = (e as { body?: { error?: string } })?.body?.error;
    if (status === 409) {
      error.value =
        reason === 'stopped'
          ? 'Posting is stopped because Telegram refused the channel. An administrator has to resume it first.'
          : reason === 'not_configured'
            ? 'The Telegram channel is not set up yet (bot token / channel in Railway).'
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
    await api.post(`/api/telegram/posts/${encodeURIComponent(r.id)}/skip`, {});
    await load();
  } catch (e) {
    error.value = apiErrorMessage(e);
    await load(true);
  } finally {
    busyId.value = null;
  }
}

/** The check's failure line: the words and the code, or the server's sentence as it is (not set up / no reply). */
function checkDetail(c: Extract<CheckResult, { ok: false }>): string {
  return looksLikeCode(c.message) ? telegramErrorText(c.message, c.status) : c.message;
}

async function checkConnection(): Promise<void> {
  checking.value = true;
  check.value = null;
  try {
    check.value = await api.post<CheckResult>('/api/telegram/check', {}, { ...PUSH_REQUEST, unknownMessage: 'No reply from the server — try Check connection again.' });
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
    await api.post('/api/telegram/resume', {});
    note.value = 'Posting resumed. The pushes that waited go out a few a minute, oldest first.';
  } catch (e) {
    const status = (e as { status?: number })?.status;
    if (status === 409) note.value = 'Posting was already resumed.';
    else error.value = apiErrorMessage(e);
  } finally {
    resuming.value = false;
    confirmingResume.value = false;
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
// A push whose sender unticked this channel on Compose: SKIPPED, counted under Skipped, and (like every SKIPPED row) no buttons.
const COMPOSE_SKIP = 'compose_skip';
const COMPOSE_SKIP_TEXT = 'Skipped in Compose';
function statusText(r: Row): string {
  if (r.status === 'SKIPPED' && r.skipReason === COMPOSE_SKIP) return COMPOSE_SKIP_TEXT;
  // While the channel is stopped a waiting row is NOT on a retry timer: it posts once an administrator resumes.
  if (r.status === 'RETRYING' && stop.value) return 'Waiting — posts after Resume';
  if (r.status === 'RETRYING') return r.nextAttemptTime ? `Waiting — retry ${r.nextAttemptTime}` : 'Waiting — retry';
  return STATUS_LABEL[r.status];
}
/** The reason line under a row's status. A waiting row's reason is left out during a stop: the banner already says it once. */
function reasonOf(r: Row): string {
  if (!r.error) return '';
  if (r.status === 'FAILED') return telegramErrorText(r.error);
  if (r.status === 'RETRYING' && !stop.value) return telegramErrorText(r.error);
  return '';
}

onMounted(() => load());
</script>

<template>
  <main class="page page-wide">
    <div class="toolbar">
      <h1 class="section-title" style="margin: 0">Telegram channel</h1>
      <div class="tg-tools">
        <button v-if="isAdmin" class="btn" :disabled="checking" data-testid="tg-check" @click="checkConnection">
          {{ checking ? 'Checking…' : 'Check connection' }}
        </button>
        <button class="btn" :disabled="loading" @click="load()">{{ loading ? 'Loading…' : 'Refresh' }}</button>
      </div>
    </div>

    <!-- Where posts go, and from when. The channel's name is public. -->
    <p v-if="channel" class="tg-where" data-testid="tg-where">
      <span class="tg-to"
        >Posting to
        <a v-if="channelUrl" :href="channelUrl" target="_blank" rel="noopener"
          ><strong>{{ channel }}</strong></a
        ><strong v-else>{{ channel }}</strong></span
      >
      <span v-if="sinceText" class="tg-dot" aria-hidden="true">·</span>
      <span v-if="sinceText" class="tg-from" data-testid="tg-since">every push from {{ sinceText }}</span>
    </p>

    <!-- The one standing alarm: posting is stopped for the whole channel until an ADMIN presses Resume. -->
    <div v-if="stop" class="banner err tg-stop" role="alert" data-testid="tg-stop">
      <div class="tg-stop-text">
        <p class="banner-lead">Telegram refused the channel, so posting is stopped.</p>
        <p class="banner-detail">
          The bot was removed, is no longer an admin with the Post messages right, or its token was revoked. Nothing is posted until
          an administrator presses Resume. Pushes made meanwhile are kept and post after Resume.
        </p>
        <p class="banner-detail" data-testid="tg-stop-since">
          Stopped since {{ stopSince || 'an unknown time' }}. Telegram said: {{ stopWhat }}.
        </p>
        <p v-if="!isAdmin" class="banner-detail" data-testid="tg-stop-ask">Ask an administrator to fix the bot, then Resume.</p>
      </div>
      <button
        v-if="isAdmin"
        type="button"
        class="btn btn-primary"
        data-testid="tg-resume"
        :disabled="resuming"
        @click="confirmingResume = true"
      >
        Resume
      </button>
    </div>

    <p class="muted tg-intro" data-testid="tg-intro">
      Every push we send is posted to the Taxscan Telegram channel automatically, a minute or two later: articles, courses, shop
      products and site pages. A push that is sent again is posted again and gets its own row. Nothing to do unless a post fails.
    </p>
    <ul class="tg-rules muted" data-testid="tg-rules">
      <li>If Telegram is busy or cannot be reached, a post is tried again after 1, 5 and 15 minutes, then it shows Failed.</li>
      <li>
        If Telegram refuses the channel itself (bot removed, no longer an admin, token revoked), posting stops for every push until
        an administrator presses Resume.
      </li>
    </ul>

    <div v-if="check" class="banner" :class="check.ok ? 'ok' : 'err'" role="status" data-testid="tg-check-result">
      <template v-if="check.ok">Connected to channel: <strong>{{ check.name }}</strong></template>
      <template v-else>
        <strong>Connection check failed.</strong>
        {{ checkDetail(check) }}
      </template>
    </div>

    <div class="tg-controls">
      <div class="tg-days">
        <button type="button" class="btn" :class="{ 'tg-on': isToday }" @click="setDate(maxDate)">Today</button>
        <button type="button" class="btn" :class="{ 'tg-on': isYesterday }" @click="setDate(istDay(-1))">Yesterday</button>
        <label class="tg-date">
          <span class="sr-only">Pick a date</span>
          <input type="date" :value="date" :min="minDate" :max="maxDate" aria-label="Pick a date" @change="onPick" />
        </label>
      </div>
      <div class="tg-chips" role="group" aria-label="Filter by status">
        <button
          v-for="c in CHIPS"
          :key="c.key"
          type="button"
          class="tg-chip"
          :class="{ 'tg-on': filter === c.key, 'tg-alert': c.key === 'failed' && counts.failed > 0 }"
          :aria-pressed="filter === c.key"
          @click="filter = c.key"
        >
          {{ c.label }} <span class="tg-count">{{ c.key === 'all' ? counts.all : counts[c.key] }}</span>
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
          <tr v-for="r in shown" :key="r.campaignId" :class="{ 'tg-quiet': r.status === 'NOT_POSTED' }">
            <td data-label="Pushed" style="white-space: nowrap">
              <strong>{{ r.pushedTime }}</strong>
            </td>
            <td class="cell-lead">{{ r.headline }}</td>
            <td class="cell-wide" data-label="Status">
              <span class="tg-status" :class="'s-' + r.status">{{ statusText(r) }}</span>
              <a
                v-if="r.status === 'POSTED' && r.postUrl"
                class="tg-view"
                :href="r.postUrl"
                target="_blank"
                rel="noopener"
                >View on Telegram</a
              >
              <div v-if="reasonOf(r)" class="tg-reason" :class="{ 'muted': r.status !== 'FAILED' }">
                {{ reasonOf(r) }}
                <!-- Retry could post twice: let staff look at the channel first. -->
                <a v-if="r.unknownOutcome && channelUrl" class="tg-view" :href="channelUrl" target="_blank" rel="noopener"
                  >Open channel</a
                >
              </div>
            </td>
            <td class="cell-actions tg-actions">
              <template v-if="r.id && (r.status === 'FAILED' || r.status === 'RETRYING')">
                <!-- Nothing can be posted while the channel is stopped, so Retry is not offered; Skip still is. -->
                <button
                  v-if="r.status === 'FAILED' && !stop"
                  type="button"
                  class="btn"
                  :class="{ 'btn-primary': !r.unknownOutcome }"
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
      heading="Post to Telegram now?"
      :detail="retryDetail"
      confirm-label="Post now"
      busy-label="Posting…"
      @confirm="confirmRetry"
      @cancel="retrying = null"
    />
    <ConfirmPush
      v-if="confirmingResume"
      :title="channel ?? 'Telegram channel'"
      :busy="resuming"
      heading="Resume posting to Telegram?"
      detail="Check first that the bot is back in the channel as an admin with the Post messages right. The pushes that waited then go out a few a minute, oldest first."
      confirm-label="Resume posting"
      busy-label="Resuming…"
      @confirm="resume"
      @cancel="confirmingResume = false"
    />
  </main>
</template>

<style scoped>
.tg-tools {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
/* Where posts go: one quiet line under the title. The destination is bold, the go-live time is the muted second half. */
.tg-where {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 8px;
  margin: 4px 0 8px;
  font-size: 14px;
}
.tg-from,
.tg-dot {
  color: var(--muted);
}
.tg-intro {
  font-size: 13px;
  margin: 0 0 8px;
  text-wrap: pretty;
}
.tg-rules {
  font-size: 13px;
  margin: 0 0 12px;
  padding-left: 18px;
}
/* The stop is a standing condition (not the answer to a click): the red banner gets a heavier left edge, text left, Resume right. */
.banner.tg-stop {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px 16px;
  border-left: 4px solid #dc2626;
  overflow-wrap: anywhere;
}
.tg-stop-text {
  flex: 1 1 320px;
  min-width: 0;
}
.tg-stop-text p + p {
  margin-top: 4px;
}
.tg-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px 16px;
  margin-bottom: 12px;
}
.tg-days {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.tg-date input {
  width: auto;
}
.tg-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.tg-chip {
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  border-radius: 999px;
  padding: 7px 14px;
  font-size: 13px;
  cursor: pointer;
}
.tg-chip.tg-alert:not(.tg-on) {
  border-color: #dc2626;
  color: #b91c1c;
  font-weight: 600;
}
.tg-chip.tg-on,
.btn.tg-on {
  background: var(--primary);
  border-color: var(--primary);
  color: #fff;
}
.tg-count {
  font-variant-numeric: tabular-nums;
  opacity: 0.8;
  margin-left: 2px;
}
.tg-status {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
}
.tg-status.s-POSTED {
  color: #16a34a;
}
.tg-status.s-FAILED {
  color: #dc2626;
}
.tg-status.s-SKIPPED,
.tg-status.s-RETRYING {
  color: var(--warn);
}
.tg-view {
  margin-left: 10px;
  font-size: 13px;
}
.tg-reason {
  font-size: 12px;
  margin-top: 2px;
  overflow-wrap: anywhere;
}
/* "Open channel" under an unknown-outcome reason: its own line, flush with the reason text above it. */
.tg-reason .tg-view {
  display: block;
  width: fit-content;
  margin: 4px 0 0;
}
.tg-status + .tg-reason {
  color: #b91c1c;
}
.tg-status + .tg-reason.muted {
  color: var(--muted);
}
tr.tg-quiet td {
  opacity: 0.6;
}
.tg-actions {
  white-space: nowrap;
}
.tg-actions .btn {
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
  .tg-stop .btn {
    width: 100%;
  }
  /* Phone: the two halves of the "where" line stack, so the go-live time never wraps mid-phrase next to a dot. */
  .tg-from {
    flex-basis: 100%;
  }
  .tg-dot {
    display: none;
  }
  .toolbar .btn,
  .tg-days .btn,
  .tg-chip,
  .tg-date input,
  .tg-view {
    min-height: 44px;
  }
  .tg-view {
    display: inline-flex;
    align-items: center;
  }
  .tg-reason .tg-view {
    display: flex;
  }
  .tg-chips {
    width: 100%;
  }
  .tg-chip {
    flex: 1 1 auto;
  }
  .tg-actions .btn {
    margin-right: 0;
    min-height: 44px;
  }
}
</style>
