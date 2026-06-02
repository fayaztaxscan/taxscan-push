<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useApi } from '../composables/useApi';

type Campaign = {
  id: string;
  title: string;
  status: string;
  sent: number;
  clicked: number;
  ctr: number | null;
  createdAt: string;
  scheduledAt: string | null;
};

const api = useApi();
const campaigns = ref<Campaign[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);

async function load() {
  loading.value = true;
  error.value = null;
  try {
    const data = await api.get<{ campaigns: Campaign[] }>('/api/campaigns?limit=100');
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
function fmtCtr(c: Campaign): string {
  if (c.ctr === null || c.sent === 0) return '—';
  return (c.ctr * 100).toFixed(1) + '%';
}

onMounted(load);
</script>

<template>
  <main class="page">
    <div class="toolbar">
      <h1 class="section-title" style="margin: 0">Campaigns</h1>
      <button class="btn" :disabled="loading" @click="load">
        {{ loading ? 'Loading…' : 'Refresh' }}
      </button>
    </div>

    <div v-if="error" class="banner err">{{ error }}</div>

    <div class="card">
      <table>
        <thead>
          <tr>
            <th>Created</th>
            <th>Title</th>
            <th>Status</th>
            <th>Sent</th>
            <th>Clicked</th>
            <th>CTR</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in campaigns" :key="c.id">
            <td class="muted">{{ fmtDate(c.createdAt) }}</td>
            <td>{{ c.title }}</td>
            <td><span class="badge" :class="c.status">{{ c.status }}</span></td>
            <td>{{ c.sent }}</td>
            <td>{{ c.clicked }}</td>
            <td>{{ fmtCtr(c) }}</td>
          </tr>
          <tr v-if="campaigns.length === 0 && !loading">
            <td colspan="6" class="muted" style="text-align: center; padding: 24px">
              No campaigns yet.
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </main>
</template>
