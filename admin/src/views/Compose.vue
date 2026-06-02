<script setup lang="ts">
import { computed, ref } from 'vue';
import { useApi } from '../composables/useApi';
import { useAuth } from '../composables/useAuth';

type DispatchResult = {
  campaignId: string;
  status: string;
  sent: number;
  capped: number;
  expiredPruned: number;
  failed: number;
  deferred?: { scheduledAt: string };
};

const api = useApi();
const { testSegmentTopic } = useAuth();

const TOPICS = [
  { label: 'GST', slug: 'gst' },
  { label: 'Income Tax', slug: 'income-tax' },
  { label: 'Customs', slug: 'customs' },
  { label: 'Corporate', slug: 'corporate' },
];

const title = ref('');
const body = ref('');
const url = ref('https://www.taxscan.in/');
const icon = ref('');
const targetMode = ref<'all' | 'topics'>('all');
const selectedTopics = ref<string[]>([]);
const breaking = ref(false);
const scheduleMode = ref<'now' | 'later'>('now');
const scheduledAtLocal = ref('');

const submitting = ref(false);
const sendingTest = ref(false);
const result = ref<DispatchResult | null>(null);
const errorBanner = ref<string | null>(null);

const target = computed(() => {
  if (targetMode.value === 'all') return { type: 'all' as const };
  return { type: 'topics' as const, topics: selectedTopics.value };
});

const canSend = computed(() => {
  if (!title.value || !body.value || !url.value) return false;
  if (targetMode.value === 'topics' && selectedTopics.value.length === 0) return false;
  if (scheduleMode.value === 'later' && !scheduledAtLocal.value) return false;
  return true;
});

function clearStatus() {
  result.value = null;
  errorBanner.value = null;
}

function buildPayload(overrides: Partial<{ target: unknown; breaking: boolean; scheduledAt?: string }> = {}) {
  const payload: Record<string, unknown> = {
    portal: 'taxscan',
    title: title.value,
    body: body.value,
    url: url.value,
    target: overrides.target ?? target.value,
    breaking: overrides.breaking ?? breaking.value,
  };
  if (icon.value) payload.icon = icon.value;
  if (overrides.scheduledAt) payload.scheduledAt = overrides.scheduledAt;
  else if (scheduleMode.value === 'later' && scheduledAtLocal.value) {
    payload.scheduledAt = new Date(scheduledAtLocal.value).toISOString();
  }
  return payload;
}

async function sendTest() {
  clearStatus();
  sendingTest.value = true;
  try {
    const res = await api.post<DispatchResult>('/api/send', {
      portal: 'taxscan',
      title: title.value || 'Test push',
      body: body.value || 'Internal segment test',
      url: url.value || 'https://www.taxscan.in/',
      icon: icon.value || undefined,
      target: { type: 'topics', topics: [testSegmentTopic.value] },
      breaking: true,
    });
    result.value = res;
  } catch (e) {
    errorBanner.value = e instanceof Error ? e.message : String(e);
  } finally {
    sendingTest.value = false;
  }
}

async function send() {
  clearStatus();
  submitting.value = true;
  try {
    const res = await api.post<DispatchResult>('/api/send', buildPayload());
    result.value = res;
  } catch (e) {
    errorBanner.value = e instanceof Error ? e.message : String(e);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <main class="page">
    <h1 class="section-title">Compose &amp; send</h1>

    <div class="card">
      <div class="form-row">
        <label for="title">Title</label>
        <input id="title" v-model="title" type="text" placeholder="Article headline" />
      </div>

      <div class="form-row">
        <label for="body">Body</label>
        <textarea id="body" v-model="body" placeholder="One-line summary" />
      </div>

      <div class="row">
        <div class="form-row">
          <label for="url">Click URL</label>
          <input id="url" v-model="url" type="url" placeholder="https://www.taxscan.in/…" />
        </div>
        <div class="form-row">
          <label for="icon">Icon URL (optional)</label>
          <input id="icon" v-model="icon" type="url" placeholder="https://…" />
        </div>
      </div>

      <div class="form-row">
        <label>Target</label>
        <div class="radio-row">
          <label><input v-model="targetMode" type="radio" value="all" /> All subscribers</label>
          <label><input v-model="targetMode" type="radio" value="topics" /> By topic</label>
        </div>
        <div v-if="targetMode === 'topics'" class="checkbox-row" style="margin-top: 10px">
          <label v-for="t in TOPICS" :key="t.slug">
            <input v-model="selectedTopics" type="checkbox" :value="t.slug" />
            {{ t.label }}
          </label>
        </div>
      </div>

      <div class="row">
        <div class="form-row">
          <label>Flags</label>
          <label style="display: inline-flex; gap: 6px; text-transform: none; letter-spacing: 0;">
            <input v-model="breaking" type="checkbox" style="width: auto" /> Breaking (bypass quiet
            hours)
          </label>
        </div>
        <div class="form-row">
          <label>Scheduling</label>
          <div class="radio-row">
            <label><input v-model="scheduleMode" type="radio" value="now" /> Send now</label>
            <label><input v-model="scheduleMode" type="radio" value="later" /> Schedule for</label>
          </div>
          <input
            v-if="scheduleMode === 'later'"
            v-model="scheduledAtLocal"
            type="datetime-local"
            style="margin-top: 8px"
          />
        </div>
      </div>

      <div v-if="errorBanner" class="banner err">{{ errorBanner }}</div>
      <div v-if="result" class="banner ok">
        {{ result.status === 'SCHEDULED' ? 'Scheduled' : 'Dispatched' }} ·
        campaignId={{ result.campaignId }}
        <pre>{{ JSON.stringify(result, null, 2) }}</pre>
      </div>

      <div class="form-row" style="display: flex; gap: 10px; justify-content: flex-end">
        <button
          type="button"
          class="btn"
          :disabled="sendingTest"
          :title="`Targets topic: '${testSegmentTopic}'`"
          @click="sendTest"
        >
          {{ sendingTest ? 'Sending test…' : `Send test to '${testSegmentTopic}'` }}
        </button>
        <button
          type="button"
          class="btn btn-primary"
          :disabled="!canSend || submitting"
          @click="send"
        >
          {{ submitting ? 'Sending…' : scheduleMode === 'later' ? 'Schedule' : 'Send now' }}
        </button>
      </div>
    </div>
  </main>
</template>
