<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { apiErrorMessage, DISPATCH_TIMEOUT_MS, useApi, type RequestOptions } from '../composables/useApi';
import { useAuth } from '../composables/useAuth';
import ConfirmPush from './ConfirmPush.vue';

/**
 * Digests → Audience card (docs/CMS_AUDIENCE_SYNC_DESIGN.md §10.2): how the Premium / Free reader lists are doing
 * after the CMS sync. Everything comes from Postgres (`GET /api/digest/audience`); nothing here calls the CMS or
 * Mailercloud. An ADMIN sees the counts and, when the breaker has paused Mailercloud writes, can review them and
 * press Resume (confirm first, Cancel focused). A PUBLISHER sees the one-line status. Hidden when the sync is off.
 * The server writes every sentence; this card only lays them out.
 *
 * Digest notices (brief 2026-11-09-digest-notice-list), ADMIN only: one line of counts for the daily list the CMS pulls (paid readers whose
 * digest cannot reach them), a sentence when the CMS would not get it, and the one-time "Import Mailercloud statuses" (a CSV exported from
 * Mailercloud, posted raw; the reply is counts only, and no address is ever shown or kept here).
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
/** The reply of POST /api/digest/audience/import-statuses: counts only. */
type ImportCounts = {
  read: number;
  invalid: number;
  ignored: number;
  notInCms: number;
  matched: { UNSUBSCRIBE: number; HARD_BOUNCE: number; SPAM: number };
  created: number;
  upgraded: number;
  unchanged: number;
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
      refused?: { premium: number; former: number };
      /** The CMS digest-notice list: absent for a server without it. `asOf` is when the counts were built. */
      notices?: { enabled: boolean; ready: boolean; badAddress: number; unsubscribed: number; asOf: string };
      /** Present only when AUDIENCE_FREE_READERS is on (brief 2026-11-08-free-cms-readers). Counts only. */
      free?: { eligible: number; admitted: number; tagged: number; refused: number; waiting: number; admittedToday: number; cap: number; tagConfigured: boolean };
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
const retrying = ref(false);
const retryBusy = ref(false);
const busy = ref(false);
// Import Mailercloud statuses: the chosen file waits for the confirm; the result / error sit under the button (not in the top banner,
// which can be a screen away on a phone).
const fileInput = ref<HTMLInputElement | null>(null);
const pendingFile = ref<File | null>(null);
const importBusy = ref(false);
const importError = ref<string | null>(null);
const importResult = ref<string | null>(null);

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

const refusedPremium = computed(() => full.value?.refused?.premium ?? 0);
const refusedFormer = computed(() => full.value?.refused?.former ?? 0);
// FREE refusals count too: Retry refused retries every refused member (brief 2026-11-08-free-cms-readers).
const refusedFree = computed(() => full.value?.free?.refused ?? 0);
const refusedTotal = computed(() => refusedPremium.value + refusedFormer.value + refusedFree.value);
const refusedLine = (n: number, role: string): string => `${n.toLocaleString('en-IN')} ${role} ${n === 1 ? 'reader was' : 'readers were'} refused by Mailercloud`;

/** The one FREE line: eligible · admitted (today of cap) · tagged · refused · waiting, plus the two plain warnings. */
const freeLine = computed(() => {
  const f = full.value?.free;
  if (!f) return null;
  const n = (v: number) => v.toLocaleString('en-IN');
  const today = f.cap === 0 ? 'adding is paused: daily limit 0' : `${n(f.admittedToday)} today of ${n(f.cap)}`;
  return {
    counts: `Free readers: ${n(f.eligible)} eligible · ${n(f.admitted)} admitted (${today}) · ${n(f.tagged)} tagged · ${n(f.refused)} refused · ${n(f.waiting)} waiting to be added.`,
    warn: f.tagConfigured ? null : 'The Free tag isn’t set, so nothing is written to Mailercloud for free readers.',
  };
});

const num = (n: number | null): string => (n === null ? '—' : n.toLocaleString('en-IN'));
function when(iso: string | null): string {
  if (!iso) return 'never';
  return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' IST';
}

/** The one notices line, and the one sentence for a list the CMS would not get (switched off wins over not ready). */
const noticesLine = computed(() => {
  const x = full.value?.notices;
  if (!x) return null;
  return `Digest notices: ${num(x.badAddress)} bad address · ${num(x.unsubscribed)} unsubscribed (list as of ${when(x.asOf)})`;
});
const noticesNote = computed(() => {
  const x = full.value?.notices;
  if (!x) return null;
  if (!x.enabled) return 'The CMS cannot fetch this list yet: the door is switched off.';
  if (!x.ready) return 'The CMS gets a "not ready" answer: no complete full load in the last 48 hours, or the audience sync is paused.';
  return null;
});

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

async function retryRefused() {
  retryBusy.value = true;
  error.value = null;
  try {
    const r = await api.post<{ ok: boolean; count: number }>('/api/digest/audience/retry-refused', {});
    const n = r?.count ?? refusedTotal.value;
    notice.value = `Done — ${n.toLocaleString('en-IN')} ${n === 1 ? 'reader' : 'readers'} will be tried again on the next run. Mailercloud writes pause 07:10–08:00 IST.`;
    retrying.value = false;
    await load();
  } catch (e) {
    retrying.value = false;
    error.value = apiErrorMessage(e);
    await load();
  } finally {
    retryBusy.value = false;
  }
}

const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const IMPORT_TOO_BIG = 'That file is over 5 MB. Export only the paid readers, or split it.';
// A POST is never retried; with no reply the import may still have run (it is safe to repeat: nothing changes the second time).
const IMPORT_NO_REPLY = 'No reply from the server in time. Check the card in a moment before importing again.';
const IMPORT_REQUEST: RequestOptions = { timeoutMs: DISPATCH_TIMEOUT_MS, unknownMessage: IMPORT_NO_REPLY };

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return bytes < 10 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The result as one paragraph of plain words, built from the counts only. */
function importSentence(c: ImportCounts): string {
  const n = (v: number | undefined): string => (v ?? 0).toLocaleString('en-IN');
  const m = c.matched ?? { UNSUBSCRIBE: 0, HARD_BOUNCE: 0, SPAM: 0 };
  const inCms = (m.UNSUBSCRIBE ?? 0) + (m.HARD_BOUNCE ?? 0) + (m.SPAM ?? 0);
  return [
    `Read ${n(c.read)} ${c.read === 1 ? 'row' : 'rows'}.`,
    `${n(inCms)} ${inCms === 1 ? 'reader is' : 'readers are'} in the CMS: ${n(m.UNSUBSCRIBE)} unsubscribed, ${n(m.HARD_BOUNCE)} bounced, ${n(m.SPAM)} spam ${m.SPAM === 1 ? 'complaint' : 'complaints'}.`,
    `Added ${n(c.created)} new, updated ${n(c.upgraded)}, ${n(c.unchanged)} ${c.unchanged === 1 ? 'was' : 'were'} already on the list.`,
    `Not in the CMS: ${n(c.notInCms)}.`,
    `Other statuses ignored: ${n(c.ignored)}.`,
    `Unreadable addresses: ${n(c.invalid)}.`,
  ].join(' ');
}

/** A file was chosen: over 5 MB is refused here (no request); anything else waits for the confirm. */
function onPickFile(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = ''; // so the same file can be chosen again
  if (!file) return;
  importError.value = null;
  if (file.size > MAX_IMPORT_BYTES) {
    importError.value = IMPORT_TOO_BIG;
    return;
  }
  pendingFile.value = file;
}

function cancelImport() {
  if (!importBusy.value) pendingFile.value = null;
}

async function runImport() {
  const file = pendingFile.value;
  if (!file) return;
  importBusy.value = true;
  importError.value = null;
  importResult.value = null;
  try {
    // The browser labels a CSV by what else is installed (Excel makes it application/vnd.ms-excel): the server is told what it is.
    const csv = new File([file], file.name, { type: 'text/csv' });
    const r = await api.upload<{ ok: boolean; counts: ImportCounts }>('/api/digest/audience/import-statuses', csv, IMPORT_REQUEST);
    importResult.value = importSentence(r.counts);
    pendingFile.value = null;
    await load(); // the notice counts above now include what was just added
  } catch (e) {
    pendingFile.value = null;
    importError.value = apiErrorMessage(e);
  } finally {
    importBusy.value = false;
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

      <div v-if="refusedTotal > 0" class="aud-refused">
        <p v-if="refusedPremium > 0">{{ refusedLine(refusedPremium, 'Premium') }} and have no tag.</p>
        <p v-if="refusedFormer > 0">{{ refusedLine(refusedFormer, 'Former') }}.</p>
        <p v-if="refusedFree > 0">{{ refusedLine(refusedFree, 'Free') }}.</p>
        <button class="btn" :disabled="retryBusy" @click="retrying = true">Retry refused</button>
      </div>

      <p v-if="freeLine" class="aud-free">
        {{ freeLine.counts }}
        <span v-if="freeLine.warn" class="aud-free-warn">{{ freeLine.warn }}</span>
      </p>

      <div v-if="noticesLine" class="aud-notices">
        <p class="aud-notices-line">{{ noticesLine }}</p>
        <p v-if="noticesNote" class="muted aud-notices-note">{{ noticesNote }}</p>
        <div class="aud-import">
          <input ref="fileInput" type="file" accept=".csv,text/csv" hidden @change="onPickFile" />
          <button type="button" class="btn" :disabled="importBusy" @click="fileInput?.click()">
            {{ importBusy ? 'Importing…' : 'Import Mailercloud statuses' }}
          </button>
          <div v-if="importError" class="banner err" role="alert">{{ importError }}</div>
          <p v-if="importResult" class="aud-import-result" role="status">{{ importResult }}</p>
        </div>
      </div>

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

  <ConfirmPush
    v-if="retrying && full"
    heading="Retry refused readers?"
    :title="`Try these ${refusedTotal.toLocaleString('en-IN')} ${refusedTotal === 1 ? 'reader' : 'readers'} again?`"
    detail="They will be sent to Mailercloud again on the next run."
    confirm-label="Retry refused"
    busy-label="Retrying…"
    :busy="retryBusy"
    @confirm="retryRefused"
    @cancel="retrying = false"
  />

  <ConfirmPush
    v-if="pendingFile"
    heading="Import Mailercloud statuses?"
    :title="`${pendingFile.name} (${fileSize(pendingFile.size)})`"
    detail="This adds Mailercloud's unsubscribed and bounced readers to our list so the CMS can tell them. It never emails anyone."
    confirm-label="Import"
    busy-label="Importing…"
    :busy="importBusy"
    @confirm="runImport"
    @cancel="cancelImport"
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
.aud-refused {
  margin: 0 0 14px;
  font-size: 14px;
}
.aud-refused p {
  margin: 0 0 6px;
}
.aud-refused .btn {
  margin-top: 4px;
}
.aud-free {
  margin: 0 0 14px;
  font-size: 14px;
  font-variant-numeric: tabular-nums;
}
.aud-free-warn {
  display: block;
  margin-top: 4px;
  color: var(--warn);
  font-weight: 600;
}
.aud-notices {
  margin: 0 0 14px;
  font-size: 14px;
  font-variant-numeric: tabular-nums;
}
.aud-notices-line {
  margin: 0;
}
.aud-notices-note {
  margin: 4px 0 0;
}
.aud-import {
  margin: 10px 0 0;
}
.aud-import .banner {
  margin: 10px 0 0;
}
.aud-import-result {
  margin: 10px 0 0;
  line-height: 1.5;
  /* A paragraph, not a table row: kept to a readable line length on a wide screen. */
  max-width: 72ch;
}
@media (max-width: 720px) {
  /* 16px text, full width: a thumb target, and the same size the fields use so iOS never zooms. */
  .aud-import .btn {
    width: 100%;
    font-size: 16px;
  }
}
.aud-table {
  margin-top: 4px;
}
.aud-table + .aud-table {
  margin-top: 14px;
}
</style>
