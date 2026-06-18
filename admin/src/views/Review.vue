<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useApi } from '../composables/useApi';
import PipelineStrip from '../components/PipelineStrip.vue';

type ReviewItem = {
  id: string;
  title: string;
  body: string;
  url: string;
  authority: string | null;
  createdAt: string;
};

const api = useApi();
const items = ref<ReviewItem[]>([]);
const loading = ref(false);
const busyId = ref<string | null>(null);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);

async function load() {
  loading.value = true;
  error.value = null;
  try {
    const data = await api.get<{ items: ReviewItem[] }>('/api/review');
    items.value = data.items;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

function drop(id: string) {
  items.value = items.value.filter((i) => i.id !== id);
}

async function act(item: ReviewItem, action: 'approve' | 'reject' | 'push', label: string) {
  busyId.value = item.id;
  error.value = null;
  notice.value = null;
  try {
    const res = await api.post<{ sent?: number }>(`/api/review/${item.id}/${action}`, {});
    drop(item.id);
    notice.value =
      action === 'push'
        ? `Pushed “${item.title.slice(0, 60)}” to ${res.sent ?? 0} subscribers.`
        : `${label}: “${item.title.slice(0, 60)}”.`;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busyId.value = null;
  }
}

onMounted(load);
</script>

<template>
  <main class="page">
    <h1 class="section-title">Review queue</h1>
    <PipelineStrip current="review" />
    <p class="muted" style="margin-top: 0">
      Articles the system couldn’t auto-classify (no recognised court/authority) — they wait
      here for your decision. <strong>Approve</strong> moves it to the <strong>Queue</strong> to
      auto-send on the next slot, <strong>Push now</strong> sends it immediately to everyone,
      <strong>Reject</strong> drops it.
    </p>

    <div v-if="error" class="banner err">{{ error }}</div>
    <div v-if="notice" class="banner ok">{{ notice }}</div>

    <div class="card">
      <div class="toolbar">
        <div class="toolbar-title">Pending ({{ items.length }})</div>
        <button class="btn" :disabled="loading" @click="load">
          {{ loading ? 'Loading…' : 'Refresh' }}
        </button>
      </div>

      <table>
        <thead>
          <tr>
            <th>Article</th>
            <th>Captured</th>
            <th style="text-align: right">Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in items" :key="item.id">
            <td>
              <a :href="item.url" target="_blank" rel="noopener">{{ item.title }}</a>
              <div class="muted" style="font-size: 12px">{{ item.body }}</div>
            </td>
            <td class="muted" style="white-space: nowrap">
              {{ new Date(item.createdAt).toLocaleString() }}
            </td>
            <td style="text-align: right; white-space: nowrap">
              <button class="btn btn-primary" :disabled="busyId === item.id" @click="act(item, 'approve', 'Approved')">
                Approve
              </button>
              <button class="btn" :disabled="busyId === item.id" @click="act(item, 'push', 'Pushed')">
                Push now
              </button>
              <button class="btn" :disabled="busyId === item.id" @click="act(item, 'reject', 'Rejected')">
                Reject
              </button>
            </td>
          </tr>
          <tr v-if="items.length === 0 && !loading">
            <td colspan="3" class="muted" style="text-align: center; padding: 24px">
              Nothing pending review. 🎉
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </main>
</template>
