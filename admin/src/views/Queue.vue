<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { PUSH_REQUEST, useApi, type ApiError } from '../composables/useApi';
import PipelineStrip from '../components/PipelineStrip.vue';
import ConfirmPush from '../components/ConfirmPush.vue';

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
// The item awaiting "Send to everyone now?" — Push now never fires on one tap.
const confirming = ref<QueueItem | null>(null);
// Set when the server refused a Push now for quiet hours: the second dialog
// offers the one deliberate way through — send it as Breaking.
const quietHold = ref<QueueItem | null>(null);
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

async function confirmPush() {
  const item = confirming.value;
  if (!item) return;
  await pushNow(item);
  confirming.value = null;
}

async function confirmBreaking() {
  const item = quietHold.value;
  if (!item) return;
  await pushNow(item, true);
  quietHold.value = null;
}

async function pushNow(item: QueueItem, breaking = false) {
  busyId.value = item.id;
  error.value = null;
  notice.value = null;
  try {
    const res = await api.post<{ sent?: number }>(
      `/api/queue/${item.id}/push`,
      breaking ? { breaking: true } : {},
      PUSH_REQUEST,
    );
    items.value = items.value.filter((i) => i.id !== item.id);
    notice.value = `Pushed “${item.title.slice(0, 60)}” to ${res.sent ?? 0} subscribers.`;
  } catch (e) {
    const err = e as ApiError;
    const code = (err.body as { error?: string } | undefined)?.error;
    if (err.status === 409 && code === 'quiet_hours') {
      quietHold.value = item; // nothing was sent or changed
    } else if (err.status === 410 && code === 'dead_link') {
      items.value = items.value.filter((i) => i.id !== item.id);
      error.value = `Not sent — “${item.title.slice(0, 60)}” has been deleted from the site, so it was archived.`;
    } else {
      error.value = e instanceof Error ? e.message : String(e);
    }
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

      <table class="stack">
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
            <td class="muted" data-label="Position">{{ i + 1 }}</td>
            <td class="cell-lead">
              <a :href="item.url" target="_blank" rel="noopener">{{ item.title }}</a>
              <div class="muted" style="font-size: 12px">{{ item.body }}</div>
            </td>
            <td class="cell-wide" data-label="Source" style="white-space: nowrap">
              <span>{{ item.authority || '—' }}</span>
              <span
                v-if="item.sendQueue === 'FALLBACK'"
                class="role-badge"
                style="margin-left: 6px"
                title="Filler — only sends when nothing qualified is waiting"
                >filler</span
              >
            </td>
            <td class="muted cell-full" data-label="Captured" style="white-space: nowrap">
              {{ new Date(item.createdAt).toLocaleString() }}
            </td>
            <td class="cell-actions cell-actions-end" style="text-align: right; white-space: nowrap">
              <button class="btn btn-primary" :disabled="busyId === item.id" @click="confirming = item">
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

    <ConfirmPush
      v-if="confirming"
      :title="confirming.title"
      :busy="busyId === confirming.id"
      @confirm="confirmPush"
      @cancel="confirming = null"
    />
    <ConfirmPush
      v-if="quietHold"
      :title="quietHold.title"
      :busy="busyId === quietHold.id"
      heading="It’s quiet hours (11 pm – 7 am)"
      detail="Readers are promised no alerts at night. Leave it and it goes out in its normal slot from 7 am — or send it now as Breaking news."
      confirm-label="Send now as Breaking"
      cancel-label="Leave for morning"
      @confirm="confirmBreaking"
      @cancel="quietHold = null"
    />
  </main>
</template>
