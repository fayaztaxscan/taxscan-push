<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import { DISPATCH_TIMEOUT_MS, apiErrorMessage, useApi, type ApiError } from '../composables/useApi';
import ConfirmPush from '../components/ConfirmPush.vue';
import EmailPreviewFrame from '../components/EmailPreviewFrame.vue';
import {
  AUDIENCES,
  AUDIENCE_LABEL,
  MAILERCLOUD_CAMPAIGN_URL,
  approvalLabel,
  count,
  dateLabel,
  kb,
  readLabel,
  runStateLabel,
  sendStateBadge,
  sendStateLabel,
  timeIst,
  type Audience,
  type RunState,
  type SendState,
  PREVIEW_WIDTHS,
  type PreviewWidth,
} from '../composables/digestView';

/**
 * Digests (docs/EMAIL_DIGEST_DESIGN.md §7): today's automatic email digest —
 * its state, approve / hold / Send now / Retry now, the frozen email as the
 * reader will get it, the stories and why they ranked, and the last 14 days.
 *
 * The server decides which buttons exist (`actions`); this screen never
 * infers a gate. Send now and Retry now go through ConfirmPush.
 */

type ScreenAction = { show: boolean; enabled: boolean; reason: string | null };
type Status = {
  enabled: boolean;
  config: { sendLive: boolean; approvalRequired: boolean; sendAt: string; buildAt: string | null; cutoff: string };
  today: null | {
    runId: string;
    builtAt: string | null;
    /** Task 13: the last Mailercloud health check (06:15 / 07:15, hourly while it is rejected). */
    health?: { ok: boolean | null; checkedAt: string | null; error: string | null };
  };
  attention: { code: string; headline: string; action: string } | null;
};
type Variant = {
  audience: Audience;
  state: SendState;
  subject: string;
  preheader: string;
  htmlBytes: number;
  hasPreview: boolean;
  /** Frozen without content: its ad slots could not be filled yet. */
  contentPending?: boolean;
  mcCampaignId: string | null;
  sendAfter: string;
  scheduledAt: string | null;
  sentConfirmedAt: string | null;
  nextAttemptAt: string | null;
  attempts: number;
  lastError: string | null;
  reached: number | null;
  /** Per variant (2026-10-23): a variant built after the approval needs its own. */
  approval?: 'not_needed' | 'waiting' | 'approved';
  ownApproval?: boolean;
  approvedBy?: string | null;
  approvedAt?: string | null;
  /** The custom template failed at send time; this copy uses the built-in template. */
  templateFallback?: { fromId: string; reason: string | null } | null;
  /** Task 13: Mailercloud already had this draft (e.g. after a restore); a person checks it and approves. */
  adoptedDraft?: boolean;
};
type Item = {
  rank: number;
  section: 'MAIN' | 'ICYMI';
  title: string;
  url: string;
  authority: string | null;
  tier: number;
  category: string;
  readRate: number | null;
  readBasis: 'reads' | 'new' | 'none';
};
type Detail = {
  runId: string;
  runDate: string;
  isToday: boolean;
  state: RunState;
  build: string;
  skipText: string | null;
  candidateCount: number;
  approval: string;
  approvedBy: string | null;
  approvedAt: string | null;
  readsLine: string | null;
  variants: Variant[];
  items: Record<Audience, Item[]>;
  actions: {
    approve: ScreenAction;
    hold: ScreenAction;
    sendNow: ScreenAction;
    retry: ScreenAction;
    testSend: Record<Audience, ScreenAction>;
  };
  audienceEstimate: Record<Audience, number | null>;
  timeline: { at: string; text: string; by: string | null }[];
};
type HistoryRow = {
  runId: string;
  runDate: string;
  state: RunState;
  items: Record<Audience, number>;
  variants: {
    audience: Audience;
    state: SendState;
    mcCampaignId: string | null;
    delivered: number | null;
    clicks: number | null;
    unsubscribes: number | null;
    bounces: number | null;
    complaints: number | null;
  }[];
};

const api = useApi();
const status = ref<Status | null>(null);
const detail = ref<Detail | null>(null);
const history = ref<HistoryRow[]>([]);
const selectedRunId = ref<string | null>(null);
const loading = ref(false);
const busy = ref<string | null>(null);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const confirming = ref<'send_now' | 'retry' | null>(null);

const audience = ref<Audience>('FREE');
const WIDTHS = PREVIEW_WIDTHS;
const width = ref<PreviewWidth>(WIDTHS[0]);

const sendLive = computed(() => status.value?.config.sendLive ?? false);
const variant = computed(() => detail.value?.variants.find((v) => v.audience === audience.value) ?? null);
const items = computed(() => detail.value?.items[audience.value] ?? []);
const previewSrc = computed(() =>
  detail.value && variant.value?.hasPreview
    ? `/api/digest/runs/${detail.value.runId}/preview/${audience.value.toLowerCase()}`
    : null,
);
const viewingPast = computed(() => !!detail.value && !detail.value.isToday);

async function loadDetail(runId: string | null) {
  selectedRunId.value = runId;
  if (!runId) {
    detail.value = null;
    return;
  }
  detail.value = await api.get<Detail>(`/api/digest/runs/${runId}`);
}

async function load() {
  loading.value = true;
  error.value = null;
  try {
    status.value = await api.get<Status>('/api/digest/status');
    if (!status.value.enabled) return;
    const [h] = await Promise.all([
      api.get<{ runs: HistoryRow[] }>('/api/digest/runs?days=14'),
      loadDetail(selectedRunId.value ?? status.value.today?.runId ?? null),
    ]);
    history.value = h.runs;
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    loading.value = false;
  }
}

function viewRun(runId: string) {
  error.value = null;
  void loadDetail(runId)
    .then(() => nextTick(() => document.getElementById('digest-today')?.scrollIntoView({ behavior: 'smooth' })))
    .catch((e) => (error.value = apiErrorMessage(e)));
}

function backToToday() {
  void loadDetail(status.value?.today?.runId ?? null).catch((e) => (error.value = apiErrorMessage(e)));
}

async function act(kind: 'approve' | 'hold') {
  if (!detail.value) return;
  busy.value = kind;
  error.value = null;
  notice.value = null;
  try {
    // Approve names the variants this screen shows as built and waiting: one built after the
    // run was approved is covered only by an approval given while it was on screen.
    const audiences = detail.value.variants.filter((v) => v.hasPreview && v.approval === 'waiting').map((v) => v.audience);
    await api.post(`/api/digest/runs/${detail.value.runId}/${kind}`, kind === 'approve' ? { audiences } : {});
    notice.value = kind === 'approve' ? 'Approved.' : 'Held. It will not send until someone approves it.';
    await load();
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    busy.value = null;
  }
}

const DOOR_UNKNOWN =
  'No reply from the server in time — the digest may still be sending. Refresh this page before trying again.';

async function confirmDoor() {
  const kind = confirming.value;
  if (!kind || !detail.value) return;
  busy.value = kind;
  error.value = null;
  notice.value = null;
  try {
    const res = await api.post<{ result: { state: RunState | null; steps: string[] } }>(
      `/api/digest/runs/${detail.value.runId}/${kind === 'send_now' ? 'send-now' : 'retry'}`,
      { confirm: true },
      { timeoutMs: DISPATCH_TIMEOUT_MS, unknownMessage: DOOR_UNKNOWN },
    );
    const st = res.result.state;
    notice.value =
      st === 'scheduled' || st === 'sent'
        ? 'Handed to Mailercloud. It is sending now.'
        : !sendLive.value && kind === 'retry'
          ? `Retried in preview mode: the Mailercloud draft is made, nothing is sent. Today's digest is now: ${st ? runStateLabel(st).toLowerCase() : 'unchanged'}.`
          : `Not sent yet. Today's digest is now: ${st ? runStateLabel(st).toLowerCase() : 'unchanged'}.`;
  } catch (e) {
    const err = e as ApiError;
    error.value = err.outcomeUnknown ? DOOR_UNKNOWN : apiErrorMessage(e);
  } finally {
    busy.value = null;
    confirming.value = null;
    await load();
  }
}

async function testSend() {
  if (!detail.value) return;
  const a = audience.value;
  busy.value = `test-${a}`;
  error.value = null;
  notice.value = null;
  try {
    await api.post(`/api/digest/runs/${detail.value.runId}/test-send/${a.toLowerCase()}`, {}, {
      timeoutMs: 45_000,
      unknownMessage: 'No reply in time — the test may still arrive. Check your inbox before sending another.',
    });
    notice.value = `Test of the ${AUDIENCE_LABEL[a]} digest sent to your address. Nothing was scheduled.`;
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    busy.value = null;
  }
}

/** "Free: ~10,066 readers; Premium: ~2,700 readers" when Mailercloud has reported list sizes before. */
const confirmTitle = computed(() => {
  const present = AUDIENCES.filter((a) => detail.value?.variants.some((v) => v.audience === a));
  const est = detail.value?.audienceEstimate;
  if (!present.some((a) => est?.[a])) return `${present.map((a) => AUDIENCE_LABEL[a]).join(' and ')}, to their full lists`;
  return present.map((a) => `${AUDIENCE_LABEL[a]}: ${est?.[a] ? `~${est[a]!.toLocaleString()} readers` : 'full list'}`).join('; ');
});

/** One plain line per variant about what happens next. */
function variantNote(v: Variant): string | null {
  if (v.adoptedDraft && v.approval === 'waiting' && (v.state === 'PENDING' || v.state === 'CREATED')) {
    return 'Mailercloud already had this draft (it may be from before a database restore). Check it in Mailercloud, then approve — or delete it there and a fresh one is made.';
  }
  if (v.ownApproval && v.approval === 'waiting' && v.hasPreview && (v.state === 'PENDING' || v.state === 'CREATED')) {
    return 'Waiting for approval: built after today’s approval, so it needs its own.';
  }
  if (v.templateFallback && (v.state === 'PENDING' || v.state === 'CREATED' || v.state === 'SCHEDULED')) {
    return `Uses the built-in template: its own template failed${v.templateFallback.reason ? ` (${v.templateFallback.reason})` : ''}.`;
  }
  if (v.lastError && (v.state === 'FAILED' || v.state === 'PENDING' || v.state === 'CREATED')) {
    const next = v.nextAttemptAt ? ` Next try at ${timeIst(v.nextAttemptAt)} IST.` : '';
    return `${v.lastError}.${next}`;
  }
  if (v.state === 'CREATED' && sendLive.value) return `Planned for ${timeIst(v.sendAfter)} IST.`;
  if (v.state === 'SCHEDULED' && v.scheduledAt) return `Handed to Mailercloud at ${timeIst(v.scheduledAt)} IST.`;
  if (v.state === 'SENT' && v.sentConfirmedAt) return `Confirmed sent at ${timeIst(v.sentConfirmedAt)} IST.`;
  return null;
}

const disabledReasons = computed(() => {
  const a = detail.value?.actions;
  if (!a) return [];
  return [...new Set([a.sendNow, a.retry].filter((x) => x.show && !x.enabled && x.reason).map((x) => x.reason as string))];
});
const anyButton = computed(() => {
  const a = detail.value?.actions;
  return !!a && (a.approve.show || a.hold.show || a.sendNow.show || a.retry.show);
});

// --- Preview frame: render at the chosen width, scaled down to fit (EmailPreviewFrame) ---
const frame = ref<InstanceType<typeof EmailPreviewFrame> | null>(null);
const scale = computed(() => frame.value?.scale ?? 1);

function variantFor(row: HistoryRow, a: Audience) {
  return row.variants.find((v) => v.audience === a) ?? null;
}
function pair(row: HistoryRow, pick: (v: HistoryRow['variants'][number]) => number | null): string {
  return AUDIENCES.map((a) => {
    const v = variantFor(row, a);
    return v ? count(pick(v)) : '—';
  }).join(' / ');
}

onMounted(load);
</script>

<template>
  <main class="page page-wide">
    <div class="toolbar">
      <h1 class="section-title" style="margin: 0">Email digest</h1>
      <button class="btn" :disabled="loading" @click="load">{{ loading ? 'Loading…' : 'Refresh' }}</button>
    </div>

    <div v-if="status?.enabled && status.attention" class="banner warn" role="status">
      <p class="banner-lead">{{ status.attention.headline }}</p>
      <p class="banner-detail">{{ status.attention.action }}</p>
    </div>
    <div v-if="error" class="banner err" role="alert">{{ error }}</div>
    <div v-if="notice" class="banner ok" role="status">{{ notice }}</div>

    <!-- Off: a calm explainer, nothing to press. -->
    <div v-if="status && !status.enabled" class="card">
      <p class="lead-line">The automatic email digest is switched off.</p>
      <p class="muted">
        When it is on, the morning's digest is built here at {{ status.config.buildAt ?? '06:30' }} IST from
        the stories already approved for push, ready to preview and approve before it goes out at
        {{ status.config.sendAt }} IST. It is switched on with DIGEST_ENABLED in Railway.
      </p>
    </div>

    <template v-else-if="status">
      <!-- Today (or the day picked in the history) -->
      <section id="digest-today" class="card">
        <div class="toolbar">
          <h2 style="margin: 0">{{ viewingPast && detail ? dateLabel(detail.runDate) : 'Today' }}</h2>
          <button v-if="viewingPast && status.today" class="btn btn-mini" @click="backToToday">Back to today</button>
        </div>

        <template v-if="!detail || (detail.build === 'BUILDING' && detail.variants.length === 0 && !viewingPast && !status.today?.builtAt)">
          <p class="lead-line">No digest has been built today yet.</p>
          <p class="muted">
            The next build is at {{ status.config.buildAt ?? '06:30' }} IST; it goes out at
            {{ status.config.sendAt }} IST{{ status.config.approvalRequired ? ' once approved' : '' }}.
          </p>
        </template>

        <template v-else>
          <p class="lead-line">
            {{ runStateLabel(detail.state) }}<span v-if="detail.skipText"> — {{ detail.skipText }}</span>
          </p>
          <div class="variant-rows">
            <div v-for="v in detail.variants" :key="v.audience" class="variant-row">
              <span class="variant-name">{{ AUDIENCE_LABEL[v.audience] }}</span>
              <span class="badge" :class="sendStateBadge(v.state)">{{ sendStateLabel(v.state, sendLive) }}</span>
              <span v-if="variantNote(v)" class="muted variant-note">{{ variantNote(v) }}</span>
            </div>
          </div>
          <p class="facts">
            <span>{{ approvalLabel(detail.approval, detail.approvedBy, detail.approvedAt) }}.</span>
            <span v-if="detail.readsLine">{{ detail.readsLine }}</span>
            <span v-if="!sendLive">Preview only: nothing is sent to readers while DIGEST_SEND_LIVE is off.</span>
            <span v-if="!viewingPast && status.today?.health?.checkedAt">
              Mailercloud check at {{ timeIst(status.today.health.checkedAt) }} IST:
              {{ status.today.health.ok ? 'answering' : 'failing' }}.
            </span>
          </p>

          <div v-if="anyButton" class="action-row">
            <button
              v-if="detail.actions.approve.show"
              class="btn btn-primary"
              :disabled="!!busy || !detail.actions.approve.enabled"
              @click="act('approve')"
            >
              {{ busy === 'approve' ? 'Approving…' : 'Approve' }}
            </button>
            <button v-if="detail.actions.hold.show" class="btn" :disabled="!!busy" @click="act('hold')">
              {{ busy === 'hold' ? 'Holding…' : 'Hold' }}
            </button>
            <button
              v-if="detail.actions.sendNow.show"
              class="btn"
              :disabled="!!busy || !detail.actions.sendNow.enabled"
              :title="detail.actions.sendNow.reason ?? undefined"
              @click="confirming = 'send_now'"
            >
              Send now
            </button>
            <button
              v-if="detail.actions.retry.show"
              class="btn"
              :disabled="!!busy || !detail.actions.retry.enabled"
              :title="detail.actions.retry.reason ?? undefined"
              @click="confirming = 'retry'"
            >
              Retry now
            </button>
          </div>
          <p v-for="r in disabledReasons" :key="r" class="muted reason">{{ r }}</p>

          <details v-if="detail.timeline.length" class="timeline">
            <summary>What happened ({{ detail.timeline.length }})</summary>
            <ol>
              <li v-for="(t, i) in detail.timeline" :key="i">
                <span class="t-time">{{ timeIst(t.at) }}</span>
                <span>{{ t.text }}<span v-if="t.by" class="muted"> by {{ t.by }}</span></span>
              </li>
            </ol>
          </details>
        </template>
      </section>

      <!-- Preview: the frozen email, as the inbox and the reader see it -->
      <section v-if="detail && detail.variants.length" class="card">
        <div class="toolbar preview-bar">
          <h2 style="margin: 0">Preview</h2>
          <div class="seg" role="group" aria-label="Version">
            <button
              v-for="a in AUDIENCES"
              :key="a"
              :class="{ on: audience === a }"
              :aria-pressed="audience === a"
              @click="audience = a"
            >
              {{ AUDIENCE_LABEL[a] }}
            </button>
          </div>
          <div class="seg" role="group" aria-label="Screen width">
            <button
              v-for="w in WIDTHS"
              :key="w.key"
              :class="{ on: width.key === w.key }"
              :aria-pressed="width.key === w.key"
              @click="width = w"
            >
              {{ w.label }} <span class="seg-px">{{ w.px }}</span>
            </button>
          </div>
        </div>

        <template v-if="variant">
          <!-- The inbox row: what a reader decides on before opening. -->
          <div class="inbox-row" aria-label="How it appears in the inbox">
            <span class="inbox-from">Taxscan</span>
            <span class="inbox-text">
              <span class="inbox-subject">{{ variant.subject }}</span>
              <span class="inbox-pre">{{ variant.preheader }}</span>
            </span>
          </div>
          <p class="muted size-line">
            {{ kb(variant.htmlBytes) }}, shown at {{ width.px }} px<span v-if="scale < 1"> (scaled to fit)</span>.
          </p>

          <EmailPreviewFrame ref="frame" :src="previewSrc" :width-px="width.px" :title="`${AUDIENCE_LABEL[audience]} digest preview`">
            <template v-if="variant?.contentPending">
              Not built yet: an ad slot could not be filled. Fix it on the Ads screen, then press Retry now.
            </template>
            <template v-else>No longer stored: a digest email is kept for 30 days. Its stories, ads and counts are kept.</template>
          </EmailPreviewFrame>

          <div class="test-row">
            <button
              class="btn"
              :disabled="!!busy || !detail.actions.testSend[audience].enabled"
              @click="testSend"
            >
              {{ busy === `test-${audience}` ? 'Sending test…' : `Test send ${AUDIENCE_LABEL[audience]} to me` }}
            </button>
            <span v-if="detail.actions.testSend[audience].reason" class="muted">
              {{ detail.actions.testSend[audience].reason }}
            </span>
          </div>
        </template>
      </section>

      <!-- The frozen story order and why -->
      <section v-if="detail && items.length" class="card">
        <div class="toolbar">
          <h2 style="margin: 0">Stories in the {{ AUDIENCE_LABEL[audience] }} digest ({{ items.length }})</h2>
        </div>
        <table class="stack">
          <thead>
            <tr>
              <th style="width: 36px">#</th>
              <th>Story</th>
              <th>Court / authority</th>
              <th>Section</th>
              <th style="text-align: right">Read rate</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="it in items" :key="`${it.section}-${it.rank}`">
              <td class="muted num" data-label="Rank">{{ it.rank }}</td>
              <td class="cell-lead">
                <a :href="it.url" target="_blank" rel="noopener">{{ it.title }}</a>
                <div class="muted">{{ it.category }}</div>
              </td>
              <td data-label="Court / authority">
                {{ it.authority || '—' }} <span class="muted">tier {{ it.tier }}</span>
              </td>
              <td data-label="Section">
                <span v-if="it.section === 'ICYMI'" class="role-badge" title="Carried over from an earlier digest">ICYMI</span>
                <span v-else>Main</span>
              </td>
              <td class="num" data-label="Read rate" style="text-align: right">
                {{ readLabel(it.readBasis, it.readRate) }}
              </td>
            </tr>
          </tbody>
        </table>
        <p class="muted legend">
          Order: Supreme Court and priority courts first (tier 1–4), then within a tier by organic reads per
          hour. A story too new to judge sorts in the middle of its tier (“new — neutral”).
        </p>
      </section>

      <!-- Last 14 days -->
      <section class="card">
        <div class="toolbar">
          <h2 style="margin: 0">Last 14 days</h2>
        </div>
        <table class="stack">
          <thead>
            <tr>
              <th>Date</th>
              <th>Free</th>
              <th>Premium</th>
              <th class="num">Stories</th>
              <th class="num">Delivered <span class="th-sub">Free / Premium</span></th>
              <th class="num">Clicks</th>
              <th class="num">Unsubscribes</th>
              <th class="num">Bounces</th>
              <th class="num">Complaints</th>
              <th>Mailercloud</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in history" :key="row.runId" :class="{ picked: row.runId === selectedRunId }">
              <td class="cell-lead">
                <button class="link-button" @click="viewRun(row.runId)">{{ dateLabel(row.runDate) }}</button>
              </td>
              <td v-for="a in AUDIENCES" :key="a" :data-label="AUDIENCE_LABEL[a]">
                <span v-if="variantFor(row, a)" class="badge" :class="sendStateBadge(variantFor(row, a)!.state)">
                  {{ sendStateLabel(variantFor(row, a)!.state, sendLive) }}
                </span>
                <span v-else class="muted">{{ runStateLabel(row.state) }}</span>
              </td>
              <td class="num" data-label="Stories">{{ row.items.FREE }}</td>
              <td class="num" data-label="Delivered">{{ pair(row, (v) => v.delivered) }}</td>
              <td class="num" data-label="Clicks">{{ pair(row, (v) => v.clicks) }}</td>
              <td class="num" data-label="Unsubscribes">{{ pair(row, (v) => v.unsubscribes) }}</td>
              <td class="num" data-label="Bounces">{{ pair(row, (v) => v.bounces) }}</td>
              <td class="num" data-label="Complaints">{{ pair(row, (v) => v.complaints) }}</td>
              <td class="cell-full" data-label="Mailercloud">
                <template v-for="a in AUDIENCES" :key="a">
                  <a
                    v-if="variantFor(row, a)?.mcCampaignId"
                    class="mc-link"
                    :href="MAILERCLOUD_CAMPAIGN_URL(variantFor(row, a)!.mcCampaignId!)"
                    target="_blank"
                    rel="noopener"
                    >View {{ AUDIENCE_LABEL[a] }}</a
                  >
                </template>
              </td>
            </tr>
            <tr v-if="history.length === 0 && !loading">
              <td colspan="10" class="muted" style="text-align: center; padding: 24px">
                No digests in the last 14 days.
              </td>
            </tr>
          </tbody>
        </table>
        <p class="muted legend">
          Figures read Free / Premium. “—” means no data: unsubscribes, hard bounces and spam complaints come
          from the Mailercloud webhook, and are shown only for digests sent while it was receiving.
        </p>
      </section>
    </template>

    <ConfirmPush
      v-if="confirming === 'send_now' && detail"
      heading="Send today's digest to everyone now?"
      :title="confirmTitle"
      detail="Both versions go to their lists straight away instead of at the planned time. A sent email can't be recalled."
      confirm-label="Send now"
      :busy="busy === 'send_now'"
      @confirm="confirmDoor"
      @cancel="confirming = null"
    />
    <ConfirmPush
      v-if="confirming === 'retry' && detail"
      heading="Retry today's digest now?"
      :title="confirmTitle"
      :detail="
        sendLive
          ? 'Tries again straight away with the same frozen email instead of waiting for the next automatic try. It never creates a second campaign.'
          : 'Preview mode: tries again straight away up to the Mailercloud draft, with the same frozen email. Nothing is sent while DIGEST_SEND_LIVE is off, and it never creates a second campaign.'
      "
      confirm-label="Retry now"
      :busy="busy === 'retry'"
      @confirm="confirmDoor"
      @cancel="confirming = null"
    />
  </main>
</template>

<style scoped>
.lead-line {
  margin: 0 0 8px;
  font-size: 16px;
  font-weight: 600;
}
.variant-rows {
  display: grid;
  gap: 6px;
  margin: 4px 0 10px;
}
.variant-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 10px;
  font-size: 13px;
}
.variant-name {
  min-width: 64px;
  font-weight: 600;
}
.variant-row .badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
}
.variant-note {
  overflow-wrap: anywhere;
}
.facts {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--muted);
}
.action-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.reason {
  margin: 6px 0 0;
}
.timeline {
  margin-top: 14px;
  font-size: 13px;
}
.timeline summary {
  cursor: pointer;
  color: var(--muted);
}
.timeline ol {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: grid;
  gap: 4px;
}
.timeline li {
  display: flex;
  gap: 10px;
}
.t-time {
  font-variant-numeric: tabular-nums;
  color: var(--muted);
  min-width: 44px;
}

/* Preview */
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
.seg-px {
  font-variant-numeric: tabular-nums;
  opacity: 0.7;
}
.preview-bar {
  justify-content: flex-start;
}
.preview-bar h2 {
  margin-right: auto !important;
}
/* The one new element: the message as the inbox lists it, before anyone opens it. */
.inbox-row {
  display: flex;
  gap: 14px;
  align-items: baseline;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-left: 3px solid var(--primary);
  border-radius: 8px;
  background: #fbfcfe;
  font-size: 14px;
  min-width: 0;
}
.inbox-from {
  font-weight: 700;
  flex: 0 0 auto;
}
.inbox-text {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.inbox-subject {
  font-weight: 600;
}
.inbox-pre {
  color: var(--muted);
  margin-left: 8px;
}
.size-line {
  margin: 6px 0 10px;
}
.test-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  margin-top: 12px;
}

/* Tables */
.num {
  font-variant-numeric: tabular-nums;
}
th.num,
td.num {
  text-align: right;
}
.th-sub {
  display: block;
  text-transform: none;
  letter-spacing: 0;
  font-weight: 400;
}
tr.picked td {
  background: #f1f5f9;
}
.mc-link {
  margin-right: 12px;
  white-space: nowrap;
}
.legend {
  margin: 10px 0 0;
}

@media (max-width: 720px) {
  .preview-bar .seg {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: 1fr;
    width: 100%;
  }
  .seg button {
    padding: 10px 4px;
    min-height: 40px;
  }
  .action-row .btn {
    flex: 1 1 calc(50% - 4px);
  }
  /* The inbox row wraps on a phone, like a mail app's two-line list item. */
  .inbox-row {
    flex-direction: column;
    gap: 2px;
  }
  .inbox-text {
    white-space: normal;
  }
  .inbox-pre {
    display: block;
    margin-left: 0;
  }
  table.stack td.num {
    text-align: left !important;
  }
  .test-row .btn {
    width: 100%;
  }
}
</style>
