<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useApi } from '../composables/useApi';
import { useAuth } from '../composables/useAuth';
import { THRESHOLDS, bandTooltip, classify, pct } from '../composables/thresholds';
import CampaignDetail from '../components/CampaignDetail.vue';

type CampaignCreator = {
  id: string;
  email: string;
  role: 'ADMIN' | 'PUBLISHER';
} | null;

type Campaign = {
  id: string;
  title: string;
  status: string;
  sent: number;
  clicked: number;
  failed: number;
  ctr: number | null;
  deliveryRate: number | null;
  createdAt: string;
  sentAt: string | null;
  scheduledAt: string | null;
  createdByUserId: string | null;
  createdBy: CampaignCreator;
  /** Article reads (all traffic: the CMS from its cut-over date, GA4 before; see the note under the title); null = no data for this URL yet. */
  reads: number | null;
  /** Reads from sessions that arrived via our push notification. */
  pushReads: number | null;
  /** Present only while WhatsApp or LinkedIn is switched on; null per channel = not applicable to this row. */
  channels?: {
    whatsapp: 'TODO' | 'POSTED' | 'SKIPPED' | null;
    linkedin: 'PENDING' | 'POSTED' | 'FAILED' | 'SKIPPED' | null;
    /** Absent while Facebook posting is switched off. */
    facebook?: 'PENDING' | 'POSTED' | 'FAILED' | 'SKIPPED' | null;
  };
  channelDetails?: {
    /** `skipReason: 'compose_skip'` = the sender unticked this channel on Compose for this push (its mark is SKIPPED). */
    whatsapp?: { by: string | null; at: string; skipReason?: string };
    linkedin?: { error: string | null; at: string; postUrl: string | null; skipReason?: string };
    facebook?: { error: string | null; at: string | null; postUrl: string | null; skipReason?: string };
  };
  /** IST day (YYYY-MM-DD) of the push: which day to open on the channel screen. */
  channelDay?: string | null;
  /** The Compose picture for LinkedIn + Facebook; present only when the campaign has one and the setting is on. */
  pictureUrl?: string;
};

const api = useApi();
const router = useRouter();
const { user: meUser } = useAuth();

const campaigns = ref<Campaign[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const showOnlyMine = ref(false);

const detailCampaignId = ref<string | null>(null);

// Click a column header to sort by it; click again to flip direction. Default
// is Pushed (most recent sends first) so recent activity leads. Captured gives
// the as-listed/queue order. Nulls (e.g. a draft with no push time or CTR)
// always sort to the bottom regardless of direction.
type SortKey =
  | 'createdAt'
  | 'sentAt'
  | 'status'
  | 'sent'
  | 'clicked'
  | 'ctr'
  | 'reads'
  | 'pushReads'
  | 'failed'
  | 'deliveryRate';
const sortKey = ref<SortKey>('sentAt');
const sortDir = ref<'asc' | 'desc'>('desc');

/** Same-origin path of a stored picture, so `download` works (browsers ignore it across origins). */
function pictureHref(u: string): string {
  try {
    return new URL(u, window.location.origin).pathname;
  } catch {
    return u;
  }
}

function setSort(key: SortKey): void {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc';
  } else {
    sortKey.value = key;
    sortDir.value = 'desc';
  }
}
// Phones get a picker instead: a stacked table has no headers to tap.
const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'sentAt', label: 'Pushed' },
  { key: 'createdAt', label: 'Captured' },
  { key: 'status', label: 'Status' },
  { key: 'sent', label: 'Sent' },
  { key: 'clicked', label: 'Clicked' },
  { key: 'ctr', label: 'CTR' },
  { key: 'reads', label: 'Reads' },
  { key: 'pushReads', label: 'via Push' },
  { key: 'failed', label: 'Failed' },
  { key: 'deliveryRate', label: 'Delivery' },
];
function flipSortDir(): void {
  sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc';
}
function sortInd(key: SortKey): string {
  if (sortKey.value !== key) return '';
  return sortDir.value === 'desc' ? ' ▼' : ' ▲';
}
function sortVal(c: Campaign, key: SortKey): number | string | null {
  switch (key) {
    case 'createdAt':
      return Date.parse(c.createdAt);
    case 'sentAt':
      return c.sentAt ? Date.parse(c.sentAt) : null;
    case 'status':
      return c.status;
    case 'sent':
      return c.sent;
    case 'clicked':
      return c.clicked;
    case 'failed':
      return c.failed;
    case 'ctr':
      return c.ctr;
    case 'reads':
      return c.reads;
    case 'pushReads':
      return c.pushReads;
    case 'deliveryRate':
      return c.deliveryRate;
  }
}
const sortedCampaigns = computed(() => {
  const key = sortKey.value;
  const dir = sortDir.value === 'asc' ? 1 : -1;
  return [...campaigns.value].sort((a, b) => {
    const va = sortVal(a, key);
    const vb = sortVal(b, key);
    if (va === null && vb === null) return 0;
    if (va === null) return 1; // nulls last, regardless of direction
    if (vb === null) return -1;
    if (va < vb) return -1 * dir;
    if (va > vb) return 1 * dir;
    return Date.parse(b.createdAt) - Date.parse(a.createdAt); // stable tiebreak
  });
});

/** The source note under the title (the screen's muted style). GA4's caveat is the default; the server sends the CMS wording. */
const GA_READS_NOTE = 'Reads: GA4 (≈1 in 10 readers since 29 Sep)';
const readsNote = ref<string>(GA_READS_NOTE);

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const qs = new URLSearchParams({ limit: '100' });
    if (showOnlyMine.value && meUser.value) {
      qs.set('createdByUserId', meUser.value.id);
    }
    const data = await api.get<{ campaigns: Campaign[]; readsSource?: { mode: string; note: string } }>(
      `/api/campaigns?${qs.toString()}`,
    );
    campaigns.value = data.campaigns;
    // The server states the source only with READS_SOURCE=cms; otherwise the numbers are GA4's, with its caveat.
    readsNote.value = data.readsSource?.note ?? GA_READS_NOTE;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

// ---- Channels column (WhatsApp / LinkedIn / Facebook marks) ----
// Shown only when the server sent `channels` on at least one row, i.e. a switch is on.
const showChannels = computed(() => campaigns.value.some((c) => c.channels !== undefined));
const colCount = computed(() => (showChannels.value ? 13 : 12));

type Mark = { key: 'whatsapp' | 'linkedin' | 'facebook'; short: string; label: string; state: string };

function fmtTime(iso: string | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
/** "anagha@taxscan.in" -> "anagha": the name part of the email. */
function namePart(email: string | null | undefined): string {
  return email ? email.split('@')[0] : '';
}
/** True when the sender unticked this channel on Compose for the push: the mark stays the usual SKIPPED one, only its tooltip says why. */
const composeSkipped = (d: { skipReason?: string } | undefined): boolean => d?.skipReason === 'compose_skip';
function marksFor(c: Campaign): Mark[] {
  const out: Mark[] = [];
  const ch = c.channels;
  if (!ch) return out;
  const d = c.channelDetails;
  if (ch.whatsapp) {
    const s = ch.whatsapp;
    const at = fmtTime(d?.whatsapp?.at);
    const who = namePart(d?.whatsapp?.by);
    out.push({
      key: 'whatsapp',
      state: s,
      short: s === 'POSTED' ? 'WA ✓' : s === 'SKIPPED' ? 'WA –' : 'WA …',
      label:
        s === 'POSTED'
          ? `WhatsApp: posted${who ? ' by ' + who : ''}${at ? ' at ' + at : ''}`
          : s === 'SKIPPED'
            ? composeSkipped(d?.whatsapp)
              ? 'WhatsApp: skipped in Compose'
              : 'WhatsApp: skipped'
            : 'WhatsApp: waiting to be posted',
    });
  }
  if (ch.linkedin) {
    const s = ch.linkedin;
    const at = fmtTime(d?.linkedin?.at);
    const err = d?.linkedin?.error;
    out.push({
      key: 'linkedin',
      state: s,
      short: s === 'POSTED' ? 'in ✓' : s === 'FAILED' ? 'in ✕' : s === 'SKIPPED' ? 'in –' : 'in …',
      label:
        s === 'POSTED'
          ? `LinkedIn: posted${at ? ' at ' + at : ''}`
          : s === 'FAILED'
            ? `LinkedIn: failed${err ? ' — ' + err : ''}`
            : s === 'SKIPPED'
              ? composeSkipped(d?.linkedin)
                ? 'LinkedIn: skipped in Compose'
                : 'LinkedIn: skipped'
              : 'LinkedIn: waiting',
    });
  }
  if (ch.facebook) {
    const s = ch.facebook;
    const at = fmtTime(d?.facebook?.at ?? undefined);
    const err = d?.facebook?.error;
    out.push({
      key: 'facebook',
      state: s,
      short: s === 'POSTED' ? 'fb ✓' : s === 'FAILED' ? 'fb ✕' : s === 'SKIPPED' ? 'fb –' : 'fb …',
      label:
        s === 'POSTED'
          ? `Facebook: posted${at ? ' at ' + at : ''}`
          : s === 'FAILED'
            ? `Facebook: failed${err ? ' — ' + err : ''}`
            : s === 'SKIPPED'
              ? composeSkipped(d?.facebook)
                ? 'Facebook: skipped in Compose'
                : 'Facebook: skipped'
              : 'Facebook: waiting',
    });
  }
  return out;
}
function openChannel(c: Campaign, m: Mark): void {
  const query = c.channelDay ? { date: c.channelDay } : undefined;
  void router.push({ path: '/' + m.key, query });
}

function fmtReads(n: number | null): string {
  if (n === null) return '—';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

function fmtDate(iso: string): string {
  // Compact (no seconds, short month, no year) so the date columns stay on one
  // line and don't crowd out the metric columns.
  return new Date(iso).toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function openDetail(id: string): void {
  detailCampaignId.value = id;
}
function closeDetail(): void {
  detailCampaignId.value = null;
}

function toggleMine(): void {
  load();
}

onMounted(load);
</script>

<template>
  <main class="page page-wide">
    <div class="toolbar">
      <h1 class="section-title" style="margin: 0">Campaigns</h1>
      <label style="display: inline-flex; align-items: center; gap: 6px; font-size: 13px">
        <input
          v-model="showOnlyMine"
          type="checkbox"
          style="width: auto"
          @change="toggleMine"
        />
        Show only mine
      </label>
      <button class="btn" :disabled="loading" @click="load">
        {{ loading ? 'Loading…' : 'Refresh' }}
      </button>
      <div class="sort-sm only-sm">
        <label for="campaign-sort" class="sort-sm-label">Sort by</label>
        <select id="campaign-sort" v-model="sortKey">
          <option v-for="o in SORT_OPTIONS" :key="o.key" :value="o.key">{{ o.label }}</option>
        </select>
        <button
          type="button"
          class="btn"
          :aria-label="sortDir === 'desc' ? 'Highest or newest first — tap to reverse' : 'Lowest or oldest first — tap to reverse'"
          @click="flipSortDir"
        >
          {{ sortDir === 'desc' ? '▼' : '▲' }}
        </button>
      </div>
    </div>

    <p class="muted reads-note" style="font-size: 12px; margin: 4px 0 10px">{{ readsNote }}</p>
    <div v-if="error" class="banner err">{{ error }}</div>

    <div class="card">
      <table class="stack">
        <thead>
          <tr>
            <th class="th-sort" title="Sort by capture time" @click="setSort('createdAt')">
              Captured<span class="sort-ind">{{ sortInd('createdAt') }}</span>
            </th>
            <th class="th-sort" title="Sort by push time" @click="setSort('sentAt')">
              Pushed<span class="sort-ind">{{ sortInd('sentAt') }}</span>
            </th>
            <th>Title</th>
            <th>Source</th>
            <th class="th-sort" @click="setSort('status')">
              Status<span class="sort-ind">{{ sortInd('status') }}</span>
            </th>
            <th class="th-sort" @click="setSort('sent')">
              Sent<span class="sort-ind">{{ sortInd('sent') }}</span>
            </th>
            <th class="th-sort" @click="setSort('clicked')">
              Clicked<span class="sort-ind">{{ sortInd('clicked') }}</span>
            </th>
            <th class="th-sort" @click="setSort('ctr')">
              CTR<span class="sort-ind">{{ sortInd('ctr') }}</span>
            </th>
            <th
              class="th-sort"
              title="Article pageviews from all traffic (Google Analytics), summed over the tracked days"
              @click="setSort('reads')"
            >
              Reads<span class="sort-ind">{{ sortInd('reads') }}</span>
            </th>
            <th
              class="th-sort"
              title="Reads from sessions that arrived via our push notification"
              @click="setSort('pushReads')"
            >
              via Push<span class="sort-ind">{{ sortInd('pushReads') }}</span>
            </th>
            <th class="th-sort" @click="setSort('failed')">
              Failed<span class="sort-ind">{{ sortInd('failed') }}</span>
            </th>
            <th class="th-sort" @click="setSort('deliveryRate')">
              Delivery<span class="sort-ind">{{ sortInd('deliveryRate') }}</span>
            </th>
            <th v-if="showChannels" title="Whether the article was also posted to WhatsApp, LinkedIn and Facebook. Click a mark to open that screen.">
              Channels
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="c in sortedCampaigns"
            :key="c.id"
            class="row-clickable"
            @click="openDetail(c.id)"
          >
            <td class="muted" data-label="Captured" style="white-space: nowrap">{{ fmtDate(c.createdAt) }}</td>
            <td :class="c.sentAt ? '' : 'muted'" data-label="Pushed" style="white-space: nowrap">
              {{ c.sentAt ? fmtDate(c.sentAt) : '—' }}
            </td>
            <td class="cell-lead">
              {{ c.title }}
              <a
                v-if="c.pictureUrl"
                class="pic-link"
                :href="pictureHref(c.pictureUrl)"
                download
                title="The picture used on the LinkedIn and Facebook posts"
                @click.stop
              >Download picture</a>
            </td>
            <td data-label="Source">
              <template v-if="c.createdBy">
                <span class="tag-manual">Manual</span>
                <span class="muted" style="font-size: 11px; margin-left: 4px">{{ c.createdBy.email }}</span>
              </template>
              <span v-else class="tag-auto">Automatic</span>
            </td>
            <td data-label="Status"><span class="badge" :class="c.status">{{ c.status }}</span></td>
            <td data-label="Sent">{{ c.sent }}</td>
            <td data-label="Clicked">{{ c.clicked }}</td>
            <td data-label="CTR">
              <span :class="['band-pill', classify(c.ctr, THRESHOLDS.ctr)]" :title="bandTooltip('ctr')">
                {{ pct(c.ctr) }}
              </span>
            </td>
            <td :class="c.reads === null ? 'muted' : ''" data-label="Reads" :title="c.reads === null ? 'No read data for this URL yet' : ''">
              {{ fmtReads(c.reads) }}
            </td>
            <td
              :class="c.pushReads === null ? 'muted' : ''"
              data-label="via Push"
              :title="c.pushReads === null && c.reads !== null ? 'Not recorded for these days (the CMS records the source from 15 Oct)' : ''"
            >
              {{ fmtReads(c.pushReads) }}
            </td>
            <td data-label="Failed">{{ c.failed }}</td>
            <td data-label="Delivery">
              <span
                :class="['band-pill', classify(c.deliveryRate, THRESHOLDS.deliveryRate)]"
                :title="bandTooltip('deliveryRate')"
              >
                {{ pct(c.deliveryRate) }}
              </span>
            </td>
            <td v-if="showChannels" class="cell-full cell-channels" :class="{ 'cell-hide-sm': marksFor(c).length === 0 }" data-label="Channels">
              <span class="ch-marks">
                <button
                  v-for="m in marksFor(c)"
                  :key="m.key"
                  type="button"
                  class="ch-mark"
                  :class="['ch-' + m.key, 'st-' + m.state]"
                  :title="m.label"
                  :aria-label="m.label"
                  @click.stop="openChannel(c, m)"
                >
                  {{ m.short }}
                </button>
              </span>
            </td>
          </tr>
          <tr v-if="campaigns.length === 0 && !loading">
            <td :colspan="colCount" class="muted" style="text-align: center; padding: 24px">
              {{ showOnlyMine ? "You haven't sent any campaigns yet." : 'No campaigns yet.' }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <CampaignDetail
      v-if="detailCampaignId"
      :campaign-id="detailCampaignId"
      @close="closeDetail"
    />
  </main>
</template>

<style scoped>
.th-sort {
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}
.th-sort:hover {
  text-decoration: underline;
}
.sort-ind {
  font-size: 11px;
  opacity: 0.75;
}
.tag-manual {
  background: #dcfce7;
  color: #166534;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
}
.tag-auto {
  background: #eef2f7;
  color: #64748b;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
}
.pic-link {
  display: block;
  width: fit-content;
  margin-top: 2px;
  font-size: 12px;
  font-weight: 500;
  color: var(--primary);
}
.ch-marks {
  display: inline-flex;
  flex-wrap: nowrap;
  gap: 6px;
  white-space: nowrap;
}
.ch-mark {
  font: inherit;
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--muted);
  cursor: pointer;
}
.ch-mark:hover {
  border-color: var(--primary);
}
.ch-mark.st-POSTED {
  color: #166534;
  background: #dcfce7;
  border-color: #bbf7d0;
}
.ch-mark.st-FAILED {
  color: #b91c1c;
  background: #fee2e2;
  border-color: #fecaca;
}
@media (max-width: 720px) {
  .pic-link {
    padding: 10px 0;
    font-size: 13px;
  }
  .ch-mark {
    min-height: 44px;
    min-width: 56px;
    font-size: 13px;
  }
  .sort-sm {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
  }
  .sort-sm-label {
    margin: 0;
    white-space: nowrap;
  }
  .sort-sm select {
    flex: 1;
  }
  .sort-sm .btn {
    min-width: 44px;
  }
}
</style>
