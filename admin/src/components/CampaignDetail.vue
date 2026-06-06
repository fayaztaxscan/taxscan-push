<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useApi } from '../composables/useApi';
import type { ApiError } from '../composables/useApi';

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
  scheduledAt: string | null;
  createdByUserId: string | null;
  createdBy: CampaignCreator;
};

type AuditItem = {
  id: string;
  userId: string | null;
  user: { id: string; email: string; role: 'ADMIN' | 'PUBLISHER' } | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

const props = defineProps<{ campaignId: string }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const api = useApi();

const loading = ref(false);
const error = ref<string | null>(null);
const campaign = ref<Campaign | null>(null);
const audit = ref<AuditItem[]>([]);

function apiErrorMessage(e: unknown): string {
  const err = e as ApiError | undefined;
  const body = err?.body as { message?: string; error?: string } | undefined;
  return body?.message ?? body?.error ?? err?.message ?? 'Request failed';
}

function fmtDate(s: string | null): string {
  return s ? new Date(s).toLocaleString() : '—';
}

function fmtPct(n: number | null): string {
  if (n === null || Number.isNaN(n)) return '—';
  return (n * 100).toFixed(1) + '%';
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    // /api/campaigns?limit=200 is the simplest way to look up a single
    // campaign by id without a dedicated /api/campaigns/:id route.
    // The backend already supports filtering by createdByUserId; for
    // single-id lookup we just paginate and filter client-side.
    const [campaignsRes, auditRes] = await Promise.all([
      api.get<{ campaigns: Campaign[] }>('/api/campaigns?limit=200'),
      api.get<{ items: AuditItem[]; total: number }>(
        `/api/audit?limit=50&offset=0`,
      ),
    ]);
    const match = campaignsRes.campaigns.find((c) => c.id === props.campaignId);
    if (!match) {
      error.value = 'Campaign not found in the most recent 200.';
      return;
    }
    campaign.value = match;
    audit.value = auditRes.items.filter(
      (a) => a.resourceType === 'campaign' && a.resourceId === props.campaignId,
    );
  } catch (e) {
    error.value = apiErrorMessage(e);
  } finally {
    loading.value = false;
  }
}

const summary = computed(() => {
  if (!campaign.value) return null;
  const c = campaign.value;
  return [
    { label: 'Status', value: c.status },
    { label: 'Sent', value: c.sent.toLocaleString() },
    { label: 'Clicked', value: c.clicked.toLocaleString() },
    { label: 'Failed', value: c.failed.toLocaleString() },
    { label: 'CTR', value: fmtPct(c.ctr) },
    { label: 'Delivery rate', value: fmtPct(c.deliveryRate) },
  ];
});

onMounted(load);
</script>

<template>
  <Teleport to="body">
    <div class="modal-overlay" @click.self="emit('close')">
      <div class="modal-card modal-wide" role="dialog" aria-labelledby="campaign-detail-title">
        <button
          type="button"
          class="modal-close"
          aria-label="Close"
          @click="emit('close')"
        >
          ×
        </button>

        <template v-if="loading">
          <p class="muted">Loading…</p>
        </template>

        <template v-else-if="error">
          <div class="banner err">{{ error }}</div>
          <div class="modal-actions">
            <button class="btn" @click="emit('close')">Close</button>
          </div>
        </template>

        <template v-else-if="campaign">
          <h2 id="campaign-detail-title">{{ campaign.title }}</h2>
          <p class="muted" style="font-size: 12px; margin: 0 0 12px">
            Campaign id <code>{{ campaign.id }}</code> · created
            {{ fmtDate(campaign.createdAt) }}
          </p>

          <div class="metrics-grid">
            <div v-for="s in summary" :key="s.label" class="metric-tile">
              <div class="metric-label">{{ s.label }}</div>
              <div class="metric-value">{{ s.value }}</div>
            </div>
          </div>

          <div class="form-row" style="margin-top: 16px">
            <span class="muted" style="font-size: 12px">Created by</span>
            <div>
              <template v-if="campaign.createdBy">
                {{ campaign.createdBy.email }}
                <span class="role-badge" :class="campaign.createdBy.role.toLowerCase()">
                  {{ campaign.createdBy.role }}
                </span>
              </template>
              <span v-else class="muted">via bearer / system</span>
            </div>
          </div>

          <h3 style="margin: 16px 0 8px; font-size: 14px">Audit log for this campaign</h3>
          <div class="audit-list">
            <div v-if="audit.length === 0" class="muted" style="font-size: 12px">
              No audit rows yet for this campaign.
            </div>
            <div v-for="a in audit" :key="a.id" class="audit-row">
              <div class="audit-row-head">
                <code style="font-size: 11px">{{ a.action }}</code>
                <span class="muted" style="font-size: 11px">{{ fmtDate(a.createdAt) }}</span>
              </div>
              <div class="audit-row-actor muted" style="font-size: 12px">
                {{ a.user ? a.user.email : 'system / bearer' }}
              </div>
              <pre class="audit-meta">{{ JSON.stringify(a.metadata, null, 2) }}</pre>
            </div>
          </div>

          <div class="modal-actions">
            <button class="btn" @click="emit('close')">Close</button>
          </div>
        </template>
      </div>
    </div>
  </Teleport>
</template>
