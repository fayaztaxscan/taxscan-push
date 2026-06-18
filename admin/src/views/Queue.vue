<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useApi } from '../composables/useApi';
import PipelineStrip from '../components/PipelineStrip.vue';

type QueueItem = {
  id: string;
  title: string;
  body: string;
  url: string;
  authority: string | null;
  sendQueue: 'QUALIFIED' | 'FALLBACK';
  createdAt: string;
};

const api = useApi();
const items = ref<QueueItem[]>([]);
const loading = ref(false);
const busyId = ref<string | null>(null);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);

async function load() {
  loading.value = true;
  error.value = null;
  try {
    const data = await api.get<{ items: QueueItem[] }>('/api/queue');
    items.value = data.items;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

async function pushNow(item: QueueItem) {
  busyId.value = item.id;
  error.value = null;
  notice.value = null;
  try {
    const res = await api.post<{ sent?: number }>(`/api/queue/${item.id}/push`, {});
    items.value = items.value.filter((i) => i.id !== item.id);
    notice.value = `Pushed “${item.title.slice(0, 60)}” to ${res.sent ?? 0} subscribers.`;
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
    <h1 class="section-title">Send queue</h1>
    <PipelineStrip current="queue" />
    <p class="muted" style="margin-top: 0">
      Articles already approved to send, waiting their automatic slot (about one every 45 minutes),
      in the order they’ll go out — <strong>oldest published first</strong>. Unclassified articles
      sit in <strong>Review</strong> until you approve them. Use <strong>Push now</strong> to send
      one immediately instead of waiting its turn.
    </p>

    <div v-if="error" class="banner err">{{ error }}</div>
    <div v-if="notice" class="banner ok">{{ notice }}</div>

    <div class="card">
      <div class="toolbar">
        <div class="toolbar-title">Waiting ({{ items.length }})</div>
        <button class="btn" :disabled="loading" @click="load">
          {{ loading ? 'Loading…' : 'Refresh' }}
        </button>
      </div>

      <table>
        <thead>
          <tr>
            <th style="width: 40px">#</th>
            <th>Article</th>
            <th>Source</th>
            <th>Captured</th>
            <th style="text-align: right">Action</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(item, i) in items" :key="item.id">
            <td class="muted">{{ i + 1 }}</td>
            <td>
              <a :href="item.url" target="_blank" rel="noopener">{{ item.title }}</a>
              <div class="muted" style="font-size: 12px">{{ item.body }}</div>
            </td>
            <td style="white-space: nowrap">
              <span>{{ item.authority || '—' }}</span>
              <span
                v-if="item.sendQueue === 'FALLBACK'"
                class="role-badge"
                style="margin-left: 6px"
                title="Filler — only sends when nothing qualified is waiting"
                >filler</span
              >
            </td>
            <td class="muted" style="white-space: nowrap">
              {{ new Date(item.createdAt).toLocaleString() }}
            </td>
            <td style="text-align: right; white-space: nowrap">
              <button class="btn btn-primary" :disabled="busyId === item.id" @click="pushNow(item)">
                Push now
              </button>
            </td>
          </tr>
          <tr v-if="items.length === 0 && !loading">
            <td colspan="5" class="muted" style="text-align: center; padding: 24px">
              Nothing waiting — the queue is clear. 🎉
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </main>
</template>
