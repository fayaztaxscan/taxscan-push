<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useApi } from '../composables/useApi';

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
// testSegmentTopic comes back on the /api/admin/subscribers response.
// We default to 'test' until the first fetch lands so the UI doesn't
// render an empty placeholder on first paint.
const testSegmentTopic = ref<string>('test');

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

type AdminSubscriber = {
  id: string;
  endpoint: string;
  topics: string[];
  userAgent: string | null;
  createdAt: string;
  portal: string;
};

const submitting = ref(false);
const sendingTest = ref(false);
const result = ref<DispatchResult | null>(null);
const errorBanner = ref<string | null>(null);
const testHint = ref<string | null>(null);
const subscribers = ref<AdminSubscriber[]>([]);
const loadingSubs = ref(false);
const enrollingId = ref<string | null>(null);

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
  testHint.value = null;
}

async function loadSubscribers() {
  loadingSubs.value = true;
  try {
    const data = await api.get<{ subscribers: AdminSubscriber[]; testSegmentTopic: string }>(
      '/api/admin/subscribers?limit=10',
    );
    subscribers.value = data.subscribers;
    if (data.testSegmentTopic) testSegmentTopic.value = data.testSegmentTopic;
  } catch (e) {
    errorBanner.value = e instanceof Error ? e.message : String(e);
  } finally {
    loadingSubs.value = false;
  }
}

async function addToTestSegment(s: AdminSubscriber) {
  enrollingId.value = s.id;
  try {
    const data = await api.post<{ subscriber: { id: string; topics: string[] } }>(
      `/api/admin/subscribers/${s.id}/test-segment`,
      {},
    );
    // Patch local state so the button updates without a refetch.
    const idx = subscribers.value.findIndex((x) => x.id === s.id);
    if (idx >= 0) subscribers.value[idx].topics = data.subscriber.topics;
  } catch (e) {
    errorBanner.value = e instanceof Error ? e.message : String(e);
  } finally {
    enrollingId.value = null;
  }
}

function inTestSegment(s: AdminSubscriber): boolean {
  return s.topics.includes(testSegmentTopic.value);
}

function endpointTail(endpoint: string): string {
  return endpoint.length > 40 ? '…' + endpoint.slice(-40) : endpoint;
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
    if (res.sent === 0) {
      testHint.value =
        `No subscriber has the '${testSegmentTopic.value}' topic yet, so nothing was delivered. ` +
        `Use the "Test segment" panel below to enrol your browser, then try again.`;
      // Refresh the subscriber list so the panel is ready when the user scrolls.
      void loadSubscribers();
    }
  } catch (e) {
    errorBanner.value = e instanceof Error ? e.message : String(e);
  } finally {
    sendingTest.value = false;
  }
}

onMounted(() => {
  void loadSubscribers();
});

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
      <div v-if="testHint" class="banner err">{{ testHint }}</div>
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

    <div class="card">
      <div class="toolbar">
        <div class="toolbar-title">Test segment</div>
        <button class="btn" :disabled="loadingSubs" @click="loadSubscribers">
          {{ loadingSubs ? 'Loading…' : 'Refresh' }}
        </button>
      </div>
      <p class="muted" style="margin-top: 0">
        The "Send test" button targets <code>topics: ['{{ testSegmentTopic }}']</code>.
        Add at least one subscriber below to that topic so test sends land somewhere.
      </p>
      <table>
        <thead>
          <tr>
            <th>Created</th>
            <th>Endpoint</th>
            <th>Topics</th>
            <th>UA</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in subscribers" :key="s.id">
            <td class="muted">{{ new Date(s.createdAt).toLocaleString() }}</td>
            <td><code style="font-size: 11px">{{ endpointTail(s.endpoint) }}</code></td>
            <td>{{ s.topics.join(', ') || '—' }}</td>
            <td class="muted">{{ s.userAgent || '—' }}</td>
            <td>
              <button
                class="btn"
                :disabled="inTestSegment(s) || enrollingId === s.id"
                @click="addToTestSegment(s)"
              >
                {{
                  inTestSegment(s)
                    ? 'In test segment'
                    : enrollingId === s.id
                    ? 'Adding…'
                    : `Add '${testSegmentTopic}'`
                }}
              </button>
            </td>
          </tr>
          <tr v-if="subscribers.length === 0 && !loadingSubs">
            <td colspan="5" class="muted" style="text-align: center; padding: 24px">
              No active subscribers yet. Open the demo page and accept the prompt to create one.
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </main>
</template>
