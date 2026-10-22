<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { PUSH_REQUEST, useApi, type ApiError } from '../composables/useApi';
import PipelineStrip from '../components/PipelineStrip.vue';
import ConfirmPush from '../components/ConfirmPush.vue';

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
// The item awaiting "Send to everyone now?" — Push now never fires on one tap.
const confirming = ref<ReviewItem | null>(null);
// Set when the server refused a Push now for quiet hours (see Queue.vue).
const quietHold = ref<ReviewItem | null>(null);
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

async function act(item: ReviewItem, action: 'approve' | 'reject' | 'push', label: string, breaking = false) {
  busyId.value = item.id;
  error.value = null;
  notice.value = null;
  try {
    const res = await api.post<{ sent?: number }>(
      `/api/review/${item.id}/${action}`,
      breaking ? { breaking: true } : {},
      action === 'push' ? PUSH_REQUEST : undefined,
    );
    drop(item.id);
    notice.value =
      action === 'push'
        ? `Pushed “${item.title.slice(0, 60)}” to ${res.sent ?? 0} subscribers.`
        : `${label}: “${item.title.slice(0, 60)}”.`;
  } catch (e) {
    const err = e as ApiError;
    const code = (err.body as { error?: string } | undefined)?.error;
    if (action === 'push' && err.status === 409 && code === 'quiet_hours') {
      quietHold.value = item; // nothing was sent or changed
    } else if (action === 'push' && err.status === 410 && code === 'dead_link') {
      drop(item.id);
      error.value = `Not sent — “${item.title.slice(0, 60)}” has been deleted from the site, so it was archived.`;
    } else {
      error.value = e instanceof Error ? e.message : String(e);
    }
  } finally {
    busyId.value = null;
  }
}

async function confirmBreaking() {
  const item = quietHold.value;
  if (!item) return;
  await act(item, 'push', 'Pushed', true);
  quietHold.value = null;
}

async function confirmPush() {
  const item = confirming.value;
  if (!item) return;
  await act(item, 'push', 'Pushed');
  confirming.value = null;
}

onMounted(load);
</script>

<template>
  <main class="page">
    <h1 class="section-title">Review queue</h1>
    <PipelineStrip current="review" />
    <p class="muted" style="margin-top: 0">
      Articles the system couldn’t auto-classify (no recognised court/authority), plus
      job/recruitment posts (which never auto-send) — they wait here for your decision.
      <strong>Approve</strong> moves it to the <strong>Queue</strong> to auto-send on the next
      slot, <strong>Push now</strong> sends it immediately to everyone, <strong>Reject</strong>
      drops it.
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

      <table class="stack">
        <thead>
          <tr>
            <th>Article</th>
            <th>Captured</th>
            <th style="text-align: right">Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in items" :key="item.id">
            <td class="cell-lead">
              <a :href="item.url" target="_blank" rel="noopener">{{ item.title }}</a>
              <div class="muted" style="font-size: 12px">{{ item.body }}</div>
            </td>
            <td class="muted cell-full" data-label="Captured" style="white-space: nowrap">
              {{ new Date(item.createdAt).toLocaleString() }}
            </td>
            <td class="cell-actions" style="text-align: right; white-space: nowrap">
              <button class="btn btn-primary" :disabled="busyId === item.id" @click="act(item, 'approve', 'Approved')">
                Approve
              </button>
              <button class="btn" :disabled="busyId === item.id" @click="confirming = item">
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
      detail="Readers are promised no alerts at night. Leave it here and approve it to send in the morning — or send it now as Breaking news."
      confirm-label="Send now as Breaking"
      cancel-label="Leave for morning"
      @confirm="confirmBreaking"
      @cancel="quietHold = null"
    />
  </main>
</template>
