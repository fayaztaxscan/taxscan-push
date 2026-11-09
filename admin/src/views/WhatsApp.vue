<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { apiErrorMessage, useApi, type ApiError } from '../composables/useApi';
import WhatsAppNudgeCard from '../components/WhatsAppNudgeCard.vue';

type Status = 'TODO' | 'POSTED' | 'SKIPPED';
type Row = {
  campaignId: string;
  articleKey: string;
  pushedAt: string;
  pushedTime: string;
  pushedAgainAt: string | null;
  pushedAgainTime: string | null;
  headline: string;
  authority: string | null;
  category: string | null;
  status: Status;
  actedBy: { id: string; email: string } | null;
  actedAt: string | null;
  /** The exact WhatsApp post, built on the server. Copy and Share use it verbatim. */
  text: string;
  /** Only on rows of the every-push rule: one row per push, and what was pushed. Absent on older article rows. */
  rule?: 'push';
  kind?: 'article' | 'course' | 'product' | 'page';
  /** Present ONLY on a SKIPPED row whose sender unticked WhatsApp on Compose (no person acted): the single value 'compose_skip'. Never shown as a code. */
  skipReason?: string;
};
type QueueResponse = {
  date: string;
  rows: Row[];
  counts: { todo: number; posted: number; skipped: number; all: number };
};
type Filter = 'todo' | 'posted' | 'skipped' | 'all';

const api = useApi();

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
const filter = ref<Filter>('todo');
const rows = ref<Row[]>([]);
const counts = ref<QueueResponse['counts']>({ todo: 0, posted: 0, skipped: 0, all: 0 });
const loading = ref(false);
const error = ref<string | null>(null);
const busyId = ref<string | null>(null); // a row's articleKey: a repeat of one campaign is its own row
const copiedId = ref<string | null>(null);
const note = ref<string | null>(null);
let copiedTimer: ReturnType<typeof setTimeout> | null = null;

// Web Share exists on phones (and some desktops with a share sheet); the brief wants it only where present.
const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

const isToday = computed(() => date.value === maxDate);
const isYesterday = computed(() => date.value === istDay(-1));

// A push whose sender unticked WhatsApp on Compose: SKIPPED by the system, so no person is named and no button is offered.
const COMPOSE_SKIP = 'compose_skip';

const CHIPS: { key: Filter; label: string }[] = [
  { key: 'todo', label: 'To do' },
  { key: 'posted', label: 'Posted' },
  { key: 'skipped', label: 'Skipped' },
  { key: 'all', label: 'All' },
];

const shown = computed(() => {
  const want: Record<Filter, Status | null> = { todo: 'TODO', posted: 'POSTED', skipped: 'SKIPPED', all: null };
  const s = want[filter.value];
  return s ? rows.value.filter((r) => r.status === s) : rows.value;
});

const dayWord = computed(() =>
  isToday.value ? 'today' : isYesterday.value ? 'yesterday' : `on ${date.value}`,
);
const emptyText = computed(() => {
  if (counts.value.all === 0) {
    return isToday.value ? 'Nothing pushed yet today.' : `Nothing was pushed ${dayWord.value}.`;
  }
  if (filter.value === 'todo') return `All done — nothing left to post ${dayWord.value}.`;
  if (filter.value === 'posted') return `Nothing marked Posted ${dayWord.value}.`;
  return `Nothing skipped ${dayWord.value}.`;
});

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const data = await api.get<QueueResponse>(`/api/whatsapp/queue?date=${encodeURIComponent(date.value)}`);
    rows.value = data.rows;
    counts.value = data.counts;
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
    // Out of range or cleared: snap back to what is on screen.
    (e.target as HTMLInputElement).value = date.value;
    return;
  }
  setDate(v);
}

async function mark(r: Row, status: Status): Promise<void> {
  busyId.value = r.articleKey;
  error.value = null;
  try {
    // A row of the every-push rule is marked for that push alone, so its own key goes along; older rows send just the status.
    await api.post(
      `/api/whatsapp/queue/${encodeURIComponent(r.campaignId)}`,
      r.rule === 'push' ? { status, articleKey: r.articleKey } : { status },
    );
    // The server owns who/when and the counts; reload rather than guess.
    await load();
  } catch (e) {
    const err = e as ApiError;
    // The server refuses to change a push the sender unticked on Compose (409); say it in words, never show the code.
    if (err.status === 409 && (err.body as { error?: string } | undefined)?.error === COMPOSE_SKIP) {
      await load();
      error.value = 'That push was skipped in Compose, so it cannot be changed here. The list has been reloaded.';
      return;
    }
    const gone = err?.status === 404;
    error.value = gone ? 'That push is no longer on the list (its time may have changed). The list has been reloaded.' : apiErrorMessage(e);
    if (gone) await load();
  } finally {
    busyId.value = null;
  }
}

/** Clipboard write with a fallback for non-secure pages and old browsers. */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the textarea route
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.opacity = '0';
  ta.style.fontSize = '16px'; // no iOS zoom
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}

async function copy(r: Row): Promise<void> {
  note.value = null;
  const ok = await writeClipboard(r.text);
  if (!ok) {
    note.value = 'Could not copy automatically — press and hold the post text to copy it.';
    return;
  }
  copiedId.value = r.articleKey;
  if (copiedTimer) clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => {
    copiedId.value = null;
  }, 2000);
}

async function share(r: Row): Promise<void> {
  note.value = null;
  try {
    await navigator.share({ text: r.text });
  } catch (e) {
    // Closing the share sheet is an AbortError: not a problem.
    if ((e as Error)?.name !== 'AbortError') note.value = 'Sharing did not work — use Copy instead.';
  }
}

const composeSkipped = (r: Row): boolean => r.status === 'SKIPPED' && r.skipReason === COMPOSE_SKIP;
function actedLine(r: Row): string {
  if (composeSkipped(r)) return 'Skipped in Compose';
  if (r.status === 'TODO') return 'To do';
  const word = r.status === 'POSTED' ? 'Posted' : 'Skipped';
  const who = r.actedBy?.email ?? 'someone';
  const when = r.actedAt
    ? new Date(r.actedAt).toLocaleString(undefined, {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';
  return `${word} by ${who}${when ? ' · ' + when : ''}`;
}
const KIND_LABEL = { article: 'Article', course: 'Course', product: 'Shop', page: 'Page' } as const;
/** Shown only on rows of the every-push rule; older rows carry no label. */
function kindLabel(r: Row): string | null {
  return r.rule === 'push' && r.kind ? KIND_LABEL[r.kind] : null;
}
function section(r: Row): string {
  return [r.authority, r.category].filter(Boolean).join(' · ');
}

onMounted(load);
onBeforeUnmount(() => {
  if (copiedTimer) clearTimeout(copiedTimer);
});
</script>

<template>
  <main class="page page-wide">
    <div class="toolbar">
      <h1 class="section-title" style="margin: 0">WhatsApp channel</h1>
      <button class="btn" :disabled="loading" @click="load">{{ loading ? 'Loading…' : 'Refresh' }}</button>
    </div>
    <p class="muted wa-rule" style="font-size: 13px; margin: 4px 0 12px">
      Post in this order. Skip anything you don't want on the channel. Links carry WhatsApp tracking — don't edit them.
    </p>

    <WhatsAppNudgeCard />

    <div class="wa-controls">
      <div class="wa-days">
        <button type="button" class="btn" :class="{ 'wa-on': isToday }" @click="setDate(maxDate)">Today</button>
        <button type="button" class="btn" :class="{ 'wa-on': isYesterday }" @click="setDate(istDay(-1))">Yesterday</button>
        <label class="wa-date">
          <span class="sr-only">Pick a date</span>
          <input type="date" :value="date" :min="minDate" :max="maxDate" aria-label="Pick a date" @change="onPick" />
        </label>
      </div>
      <div class="wa-chips" role="group" aria-label="Filter by status">
        <button
          v-for="c in CHIPS"
          :key="c.key"
          type="button"
          class="wa-chip"
          :class="{ 'wa-on': filter === c.key }"
          :aria-pressed="filter === c.key"
          @click="filter = c.key"
        >
          {{ c.label }} <span class="wa-count">{{ counts[c.key] }}</span>
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
            <th>Post</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in shown" :key="r.articleKey" :class="{ 'wa-done': r.status !== 'TODO' }">
            <td data-label="Pushed" style="white-space: nowrap">
              <strong>{{ r.pushedTime }}</strong>
              <div v-if="r.pushedAgainTime" class="muted">pushed again {{ r.pushedAgainTime }}</div>
            </td>
            <td class="cell-lead">
              <span v-if="kindLabel(r)" class="wa-kind" :class="'k-' + r.kind">{{ kindLabel(r) }}</span>
              {{ r.headline }}
              <div v-if="section(r)" class="muted">{{ section(r) }}</div>
            </td>
            <td class="cell-full wa-post-cell" data-label="Post text">
              <pre class="wa-post">{{ r.text }}</pre>
            </td>
            <td class="cell-wide" data-label="Status">
              <span class="wa-status" :class="'s-' + r.status">{{ actedLine(r) }}</span>
            </td>
            <td class="cell-actions wa-actions">
              <!-- A push skipped in Compose is not posted by anyone: the row offers no button at all. -->
              <template v-if="!composeSkipped(r)">
                <button type="button" class="btn" :class="{ 'wa-copied': copiedId === r.articleKey }" @click="copy(r)">
                  {{ copiedId === r.articleKey ? 'Copied' : 'Copy' }}
                </button>
                <button v-if="canShare" type="button" class="btn" @click="share(r)">Share</button>
                <template v-if="r.status === 'TODO'">
                  <button
                    type="button"
                    class="btn btn-primary"
                    :disabled="busyId === r.articleKey"
                    @click="mark(r, 'POSTED')"
                  >
                    Posted
                  </button>
                  <button type="button" class="btn" :disabled="busyId === r.articleKey" @click="mark(r, 'SKIPPED')">
                    Skip
                  </button>
                </template>
                <button v-else type="button" class="btn" :disabled="busyId === r.articleKey" @click="mark(r, 'TODO')">
                  Back to To do
                </button>
              </template>
            </td>
          </tr>
          <tr v-if="shown.length === 0 && !loading && !error">
            <td colspan="5" class="muted" style="text-align: center; padding: 24px; font-size: 14px">
              {{ emptyText }}
            </td>
          </tr>
          <tr v-if="loading && rows.length === 0">
            <td colspan="5" class="muted" style="text-align: center; padding: 24px">Loading…</td>
          </tr>
        </tbody>
      </table>
    </div>
  </main>
</template>

<style scoped>
.wa-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px 16px;
  margin-bottom: 12px;
}
.wa-days {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.wa-date input {
  width: auto;
}
.wa-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.wa-chip {
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  border-radius: 999px;
  padding: 7px 14px;
  font-size: 13px;
  cursor: pointer;
}
.wa-chip.wa-on,
.btn.wa-on {
  background: var(--primary);
  border-color: var(--primary);
  color: #fff;
}
.wa-count {
  font-variant-numeric: tabular-nums;
  opacity: 0.8;
  margin-left: 2px;
}
.wa-post {
  margin: 0;
  padding: 8px 10px;
  background: #f8fafc;
  border: 1px solid var(--border);
  border-radius: 8px;
  font: inherit;
  font-size: 12px;
  line-height: 1.45;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.wa-post-cell {
  min-width: 260px;
  max-width: 440px;
}
.wa-kind {
  display: inline-block;
  margin-right: 6px;
  padding: 1px 8px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: #f1f5f9;
  color: var(--muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  vertical-align: 1px;
}
.wa-kind.k-course {
  background: #eff6ff;
  border-color: #bfdbfe;
  color: #1d4ed8;
}
.wa-kind.k-product {
  background: #fff7ed;
  border-color: #fed7aa;
  color: #9a3412;
}
.wa-kind.k-page {
  background: #e2e8f0;
  border-color: #cbd5e1;
  color: #334155;
}
.wa-status {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
}
.wa-status.s-POSTED {
  color: #16a34a;
}
.wa-status.s-SKIPPED {
  color: var(--warn);
}
.wa-actions {
  white-space: nowrap;
}
.wa-actions .btn {
  margin-right: 6px;
}
.btn.wa-copied {
  border-color: #16a34a;
  color: #166534;
}
tr.wa-done .wa-post {
  opacity: 0.6;
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
  .wa-days .btn,
  .wa-chip {
    min-height: 44px;
  }
  .wa-date input {
    min-height: 44px;
  }
  .wa-chips {
    width: 100%;
  }
  .wa-chip {
    flex: 1 1 auto;
  }
  .wa-post-cell {
    max-width: none;
  }
  .wa-actions .btn {
    margin-right: 0;
    min-height: 44px;
  }
}
</style>
