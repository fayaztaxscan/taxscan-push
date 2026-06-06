<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useApi } from '../composables/useApi';
import { useAuth } from '../composables/useAuth';
import type { ApiError } from '../composables/useApi';
import CampaignDetail from '../components/CampaignDetail.vue';

type AuditUser = { id: string; email: string; role: 'ADMIN' | 'PUBLISHER' };

type AuditItem = {
  id: string;
  userId: string | null;
  user: AuditUser | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  metadata: Record<string, unknown> | null;
  ipAddress: string | null;
  createdAt: string;
};

const ACTIONS = [
  'LOGIN_SUCCESS',
  'LOGIN_FAILED',
  'LOGOUT',
  'PASSWORD_CHANGED',
  'USER_CREATED',
  'USER_DEACTIVATED',
  'USER_REACTIVATED',
  'USER_ROLE_CHANGED',
  'USER_PASSWORD_RESET',
  'CAMPAIGN_DISPATCHED',
  'CAMPAIGN_DISPATCH_FAILED',
] as const;

const api = useApi();
const { user: meUser } = useAuth();

// Filters
const filterAction = ref<string>('');
const filterUserId = ref<string>('');
const filterSince = ref<string>('');
const filterUntil = ref<string>('');
const filterResourceId = ref<string>('');

// Data
const items = ref<AuditItem[]>([]);
const total = ref(0);
const limit = ref(50);
const offset = ref(0);
const loading = ref(false);
const listError = ref<string | null>(null);

// User picker for the dropdown
const users = ref<AuditUser[]>([]);

// Campaign detail modal
const detailCampaignId = ref<string | null>(null);

function apiErrorMessage(e: unknown): string {
  const err = e as ApiError | undefined;
  const body = err?.body as { message?: string; error?: string } | undefined;
  return body?.message ?? body?.error ?? err?.message ?? 'Request failed';
}

function fmtTimestamp(s: string): string {
  return new Date(s).toLocaleString();
}

function localToIso(local: string): string | null {
  // datetime-local inputs return values like "2026-06-06T12:34" (no TZ).
  // Treat them as local time and convert to ISO for the API.
  if (!local) return null;
  return new Date(local).toISOString();
}

function summarize(item: AuditItem): string {
  const m = (item.metadata ?? {}) as Record<string, unknown>;
  switch (item.action) {
    case 'LOGIN_SUCCESS':
      return item.user ? `${item.user.email} signed in` : `${m.email ?? 'unknown'} signed in`;
    case 'LOGIN_FAILED':
      return `Failed login attempt for ${m.email ?? 'unknown'} (${m.reason ?? '—'})`;
    case 'LOGOUT':
      return item.user ? `${item.user.email} signed out` : 'Signed out';
    case 'PASSWORD_CHANGED':
      return item.user ? `${item.user.email} changed their password` : 'Password changed';
    case 'USER_CREATED':
      return `Created ${m.email ?? '—'} as ${m.role ?? '—'}`;
    case 'USER_DEACTIVATED':
      return `Deactivated ${m.email ?? '—'}`;
    case 'USER_REACTIVATED':
      return `Reactivated ${m.email ?? '—'}`;
    case 'USER_ROLE_CHANGED': {
      const before = m.before as { role?: string } | undefined;
      const after = m.after as { role?: string } | undefined;
      return `Changed ${m.email ?? '—'} from ${before?.role ?? '?'} to ${after?.role ?? '?'}`;
    }
    case 'USER_PASSWORD_RESET':
      return `Reset password for ${m.email ?? '—'}`;
    case 'CAMPAIGN_DISPATCHED':
      return `Dispatched: sent ${m.sent ?? '?'}, failed ${m.failed ?? '?'}, capped ${m.capped ?? '?'}`;
    case 'CAMPAIGN_DISPATCH_FAILED':
      return `Dispatch failed — ${m.error ?? 'unknown error'}`;
    default:
      return JSON.stringify(item.metadata ?? {});
  }
}

async function loadUsers(): Promise<void> {
  try {
    const data = await api.get<{ items: AuditUser[] }>('/api/users/picker');
    users.value = data.items;
  } catch {
    // Picker is best-effort — if it fails the user filter just stays empty
    // and the rest of the page works.
    users.value = [];
  }
}

async function load(): Promise<void> {
  loading.value = true;
  listError.value = null;
  try {
    const qs = new URLSearchParams();
    qs.set('limit', String(limit.value));
    qs.set('offset', String(offset.value));
    if (filterAction.value) qs.set('action', filterAction.value);
    if (filterUserId.value) qs.set('userId', filterUserId.value);
    const since = localToIso(filterSince.value);
    const until = localToIso(filterUntil.value);
    if (since) qs.set('since', since);
    if (until) qs.set('until', until);
    const data = await api.get<{ items: AuditItem[]; total: number }>(
      `/api/audit?${qs.toString()}`,
    );
    // resourceId is client-side filtered because /api/audit doesn't expose
    // it as a server-side filter yet — small list (≤200/page) makes this
    // cheap, and the search-by-id usage is rare enough not to warrant
    // backend work right now.
    const rid = filterResourceId.value.trim();
    items.value = rid
      ? data.items.filter((i) => (i.resourceId ?? '').includes(rid))
      : data.items;
    total.value = data.total;
  } catch (e) {
    listError.value = apiErrorMessage(e);
  } finally {
    loading.value = false;
  }
}

const pageStart = computed(() => (total.value === 0 ? 0 : offset.value + 1));
const pageEnd = computed(() => Math.min(offset.value + limit.value, total.value));
const canPrev = computed(() => offset.value > 0);
const canNext = computed(() => offset.value + limit.value < total.value);

function nextPage(): void {
  offset.value += limit.value;
  load();
}
function prevPage(): void {
  offset.value = Math.max(0, offset.value - limit.value);
  load();
}

function applyFilters(): void {
  offset.value = 0;
  load();
}
function resetFilters(): void {
  filterAction.value = '';
  filterUserId.value = '';
  filterSince.value = '';
  filterUntil.value = '';
  filterResourceId.value = '';
  offset.value = 0;
  load();
}
function filterMine(): void {
  if (!meUser.value) return;
  filterUserId.value = meUser.value.id;
  offset.value = 0;
  load();
}

function openCampaign(id: string): void {
  detailCampaignId.value = id;
}
function closeCampaign(): void {
  detailCampaignId.value = null;
}

watch(filterAction, applyFilters);
watch(filterUserId, applyFilters);

onMounted(async () => {
  await loadUsers();
  await load();
});
</script>

<template>
  <main class="page">
    <div class="toolbar">
      <h1 class="section-title" style="margin: 0">Activity</h1>
      <button class="btn" :disabled="loading" @click="load">
        {{ loading ? 'Loading…' : 'Refresh' }}
      </button>
    </div>

    <div class="card filters-card">
      <div class="filter-row">
        <div class="filter-col">
          <label>Action</label>
          <select v-model="filterAction">
            <option value="">All actions</option>
            <option v-for="a in ACTIONS" :key="a" :value="a">{{ a }}</option>
          </select>
        </div>

        <div class="filter-col">
          <label>User</label>
          <select v-model="filterUserId">
            <option value="">Anyone</option>
            <option v-for="u in users" :key="u.id" :value="u.id">
              {{ u.email }} ({{ u.role }})
            </option>
          </select>
        </div>

        <div class="filter-col">
          <label>Since</label>
          <input v-model="filterSince" type="datetime-local" />
        </div>

        <div class="filter-col">
          <label>Until</label>
          <input v-model="filterUntil" type="datetime-local" />
        </div>

        <div class="filter-col grow">
          <label>Resource id contains</label>
          <input
            v-model="filterResourceId"
            type="text"
            placeholder="e.g. cmpu… (campaign / user id)"
            @keyup.enter="applyFilters"
          />
        </div>

        <div class="filter-col" style="align-self: flex-end; display: flex; gap: 6px">
          <button class="btn btn-mini" @click="filterMine">Only mine</button>
          <button class="btn btn-mini" @click="applyFilters">Apply</button>
          <button class="btn btn-mini" @click="resetFilters">Reset</button>
        </div>
      </div>
    </div>

    <div v-if="listError" class="banner err">{{ listError }}</div>

    <div class="card">
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Who</th>
            <th>Action</th>
            <th>Resource</th>
            <th>Summary</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="it in items" :key="it.id">
            <td class="muted" style="white-space: nowrap">{{ fmtTimestamp(it.createdAt) }}</td>
            <td>
              <template v-if="it.user">
                <span>{{ it.user.email }}</span>
                <span class="role-badge" :class="it.user.role.toLowerCase()" style="margin-left: 4px">
                  {{ it.user.role }}
                </span>
              </template>
              <span v-else class="muted" style="font-size: 12px">system / bearer</span>
            </td>
            <td><code style="font-size: 12px">{{ it.action }}</code></td>
            <td>
              <template v-if="it.resourceType === 'campaign' && it.resourceId">
                <button
                  type="button"
                  class="link-button"
                  :title="it.resourceId"
                  @click="openCampaign(it.resourceId)"
                >
                  campaign · {{ it.resourceId.slice(0, 10) }}…
                </button>
              </template>
              <template v-else-if="it.resourceType && it.resourceId">
                {{ it.resourceType }} · {{ it.resourceId.slice(0, 10) }}…
              </template>
              <span v-else class="muted">—</span>
            </td>
            <td>{{ summarize(it) }}</td>
          </tr>
          <tr v-if="items.length === 0 && !loading">
            <td colspan="5" class="muted" style="text-align: center; padding: 24px">
              No matching activity.
            </td>
          </tr>
        </tbody>
      </table>

      <div class="pagination">
        <span class="muted" style="font-size: 12px"
          >Showing {{ pageStart }}–{{ pageEnd }} of {{ total }}</span
        >
        <span class="spacer" />
        <button class="btn btn-mini" :disabled="!canPrev" @click="prevPage">Prev</button>
        <button class="btn btn-mini" :disabled="!canNext" @click="nextPage">Next</button>
      </div>
    </div>

    <CampaignDetail
      v-if="detailCampaignId"
      :campaign-id="detailCampaignId"
      @close="closeCampaign"
    />
  </main>
</template>
