<script setup lang="ts">
import { onMounted, ref } from 'vue';
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
};

const api = useApi();
const { user: meUser } = useAuth();

const campaigns = ref<Campaign[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const showOnlyMine = ref(false);

const detailCampaignId = ref<string | null>(null);

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

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString();
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
  <main class="page">
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
            <th>Captured</th>
            <th>Pushed</th>
            <th>Title</th>
            <th>Created by</th>
            <th>Status</th>
            <th>Sent</th>
            <th>Clicked</th>
            <th>CTR</th>
            <th>Failed</th>
            <th>Delivery</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="c in campaigns"
            :key="c.id"
            class="row-clickable"
            @click="openDetail(c.id)"
          >
            <td class="muted">{{ fmtDate(c.createdAt) }}</td>
            <td :class="c.sentAt ? '' : 'muted'">{{ c.sentAt ? fmtDate(c.sentAt) : '—' }}</td>
            <td>{{ c.title }}</td>
            <td>
              <template v-if="c.createdBy">
                <span style="font-size: 12px">{{ c.createdBy.email }}</span>
                <span
                  class="role-badge"
                  :class="c.createdBy.role.toLowerCase()"
                  style="margin-left: 4px"
                >
                  {{ c.createdBy.role }}
                </span>
              </template>
              <span v-else class="muted" style="font-size: 12px">via bearer / system</span>
            </td>
            <td><span class="badge" :class="c.status">{{ c.status }}</span></td>
            <td>{{ c.sent }}</td>
            <td>{{ c.clicked }}</td>
            <td>
              <span :class="['band-pill', classify(c.ctr, THRESHOLDS.ctr)]" :title="bandTooltip('ctr')">
                {{ pct(c.ctr) }}
              </span>
            </td>
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
            <td colspan="10" class="muted" style="text-align: center; padding: 24px">
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
