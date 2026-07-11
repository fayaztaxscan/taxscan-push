<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
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
  /** Article reads (GA, all traffic); null = no data for this URL yet. */
  reads: number | null;
  /** Reads from sessions that arrived via our push notification. */
  pushReads: number | null;
};

const api = useApi();
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

function setSort(key: SortKey): void {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc';
  } else {
    sortKey.value = key;
    sortDir.value = 'desc';
  }
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

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const qs = new URLSearchParams({ limit: '100' });
    if (showOnlyMine.value && meUser.value) {
      qs.set('createdByUserId', meUser.value.id);
    }
    const data = await api.get<{ campaigns: Campaign[] }>(
      `/api/campaigns?${qs.toString()}`,
    );
    campaigns.value = data.campaigns;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
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
    </div>

    <div v-if="error" class="banner err">{{ error }}</div>

    <div class="card">
      <table>
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
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="c in sortedCampaigns"
            :key="c.id"
            class="row-clickable"
            @click="openDetail(c.id)"
          >
            <td class="muted" style="white-space: nowrap">{{ fmtDate(c.createdAt) }}</td>
            <td :class="c.sentAt ? '' : 'muted'" style="white-space: nowrap">
              {{ c.sentAt ? fmtDate(c.sentAt) : '—' }}
            </td>
            <td>{{ c.title }}</td>
            <td>
              <template v-if="c.createdBy">
                <span class="tag-manual">Manual</span>
                <span class="muted" style="font-size: 11px; margin-left: 4px">{{ c.createdBy.email }}</span>
              </template>
              <span v-else class="tag-auto">Automatic</span>
            </td>
            <td><span class="badge" :class="c.status">{{ c.status }}</span></td>
            <td>{{ c.sent }}</td>
            <td>{{ c.clicked }}</td>
            <td>
              <span :class="['band-pill', classify(c.ctr, THRESHOLDS.ctr)]" :title="bandTooltip('ctr')">
                {{ pct(c.ctr) }}
              </span>
            </td>
            <td :class="c.reads === null ? 'muted' : ''" :title="c.reads === null ? 'No read data for this URL yet' : ''">
              {{ fmtReads(c.reads) }}
            </td>
            <td :class="c.pushReads === null ? 'muted' : ''">{{ fmtReads(c.pushReads) }}</td>
            <td>{{ c.failed }}</td>
            <td>
              <span
                :class="['band-pill', classify(c.deliveryRate, THRESHOLDS.deliveryRate)]"
                :title="bandTooltip('deliveryRate')"
              >
                {{ pct(c.deliveryRate) }}
              </span>
            </td>
          </tr>
          <tr v-if="campaigns.length === 0 && !loading">
            <td colspan="12" class="muted" style="text-align: center; padding: 24px">
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
</style>
