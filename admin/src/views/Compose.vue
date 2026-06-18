<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { apiErrorMessage, useApi } from '../composables/useApi';
import { useTestDevice } from '../composables/useTestDevice';

type DispatchResult = {
  campaignId: string;
  status: string;
  sent: number;
  capped: number;
  cooled: number;
  expiredPruned: number;
  failed: number;
  deferred?: { scheduledAt: string };
};

const api = useApi();
const testDevice = useTestDevice();
// Destructure so the refs auto-unwrap in the template (testDevice.x would stay a Ref).
const {
  supported: testSupported,
  permission: testPermission,
  ready: testReady,
  busy: testBusy,
  error: testError,
} = testDevice;

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
// Full-reach override: bypasses the daily cap + per-subscriber cooldown so the
// send reaches every eligible subscriber. Only valid for immediate sends, so it
// is mutually exclusive with scheduling (the "later" option is disabled while on).
const force = ref(false);
const scheduleMode = ref<'now' | 'later'>('now');
const scheduledAtLocal = ref('');

const submitting = ref(false);
const result = ref<DispatchResult | null>(null);
const errorBanner = ref<string | null>(null);
const testNotice = ref<string | null>(null);

const target = computed(() => {
  if (targetMode.value === 'all') return { type: 'all' as const };
  return { type: 'topics' as const, topics: selectedTopics.value };
});

// Enough to send the real campaign (audience + schedule must be valid too).
const canSend = computed(() => {
  if (!title.value || !body.value || !url.value) return false;
  if (targetMode.value === 'topics' && selectedTopics.value.length === 0) return false;
  if (scheduleMode.value === 'later' && !scheduledAtLocal.value) return false;
  return true;
});

// Enough to preview on this device (audience/schedule don't apply to a preview).
const canTest = computed(() => Boolean(title.value && body.value && url.value));

function clearStatus() {
  result.value = null;
  errorBanner.value = null;
  testNotice.value = null;
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
  if (force.value) payload.force = true;
  // force is immediate-only — never attach a schedule when it's on.
  if (!force.value) {
    if (overrides.scheduledAt) payload.scheduledAt = overrides.scheduledAt;
    else if (scheduleMode.value === 'later' && scheduledAtLocal.value) {
      payload.scheduledAt = new Date(scheduledAtLocal.value).toISOString();
    }
  }
  return payload;
}

async function send() {
  clearStatus();
  submitting.value = true;
  try {
    const res = await api.post<DispatchResult>('/api/send', buildPayload());
    result.value = res;
  } catch (e) {
    errorBanner.value = apiErrorMessage(e);
  } finally {
    submitting.value = false;
  }
}

async function enableTestDevice() {
  clearStatus();
  await testDevice.enable();
}

async function sendToMyDevice() {
  clearStatus();
  try {
    await testDevice.sendTest({
      title: title.value,
      body: body.value,
      url: url.value,
      icon: icon.value || undefined,
    });
    testNotice.value = 'Sent — check the notification on this device.';
  } catch {
    // testError is already set; surfaced in the panel below.
  }
}

onMounted(() => {
  void testDevice.refresh();
});
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
          <small class="muted" style="font-size: 11px">
            An article, a course (academy.taxscan.in) or a product (shop.taxscan.in) link.
          </small>
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
          <label style="display: inline-flex; gap: 6px; text-transform: none; letter-spacing: 0; margin-top: 6px;">
            <input v-model="force" type="checkbox" style="width: auto" /> Force send (ignore
            frequency limits — full reach)
          </label>
        </div>
        <div class="form-row">
          <label>Scheduling</label>
          <div class="radio-row">
            <label><input v-model="scheduleMode" type="radio" value="now" /> Send now</label>
            <label>
              <input v-model="scheduleMode" type="radio" value="later" :disabled="force" />
              Schedule for
            </label>
          </div>
          <p v-if="force" class="muted" style="margin: 6px 0 0; font-size: 12px">
            Force send is immediate only — scheduling is disabled.
          </p>
          <input
            v-if="scheduleMode === 'later' && !force"
            v-model="scheduledAtLocal"
            type="datetime-local"
            style="margin-top: 8px"
          />
        </div>
      </div>

      <div v-if="errorBanner" class="banner err">{{ errorBanner }}</div>
      <div v-if="result" class="banner ok">
        {{ result.status === 'SCHEDULED' ? 'Scheduled' : 'Dispatched' }} ·
        reached {{ result.sent }} subscriber(s) · campaignId={{ result.campaignId }}
      </div>

      <div class="form-row" style="display: flex; justify-content: flex-end">
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

    <!-- Preview on the editor's own device — never touches real subscribers. -->
    <div class="card">
      <div class="toolbar-title">Test on this device</div>
      <p class="muted" style="margin-top: 4px">
        Send the notification above to <strong>just this browser</strong> to see exactly how it
        looks. No one else receives it.
      </p>

      <template v-if="!testSupported">
        <p class="muted">This browser can’t show notifications, so on-device testing isn’t available here.</p>
      </template>

      <template v-else-if="!testReady">
        <button class="btn" :disabled="testBusy" @click="enableTestDevice">
          {{ testBusy ? 'Enabling…' : 'Enable test notifications on this device' }}
        </button>
        <p
          v-if="testPermission === 'denied'"
          class="muted"
          style="margin: 8px 0 0; font-size: 12px"
        >
          Notifications are blocked for this site. Allow them in your browser’s site settings, then
          reload this page.
        </p>
      </template>

      <template v-else>
        <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap">
          <span class="muted" style="font-size: 13px">✓ This device is set up for testing.</span>
          <button class="btn btn-primary" :disabled="!canTest || testBusy" @click="sendToMyDevice">
            {{ testBusy ? 'Sending…' : 'Send test to my device' }}
          </button>
          <span v-if="!canTest" class="muted" style="font-size: 12px">
            Fill in the title, body and link above first.
          </span>
        </div>
      </template>

      <div v-if="testError" class="banner err" style="margin-top: 10px">{{ testError }}</div>
      <div v-if="testNotice" class="banner ok" style="margin-top: 10px">{{ testNotice }}</div>
    </div>
  </main>
</template>
