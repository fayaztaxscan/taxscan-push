<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { apiErrorMessage, DISPATCH_TIMEOUT_MS, PUSH_REQUEST, useApi } from '../composables/useApi';
import type { ApiError, RequestOptions } from '../composables/useApi';
import { useAuth } from '../composables/useAuth';
import { useTestDevice } from '../composables/useTestDevice';
import ConfirmPush from '../components/ConfirmPush.vue';

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
const { user } = useAuth();
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

// Optional picture for the LinkedIn + Facebook posts (SOCIAL_PICTURE_ENABLED). Off = no field and nothing sent.
// The server checks the rules and answers a plain sentence on refusal; Remove only drops the id (nothing is deleted).
type SocialPicture = { id: string; url: string; width: number; height: number; size: number; deduped: boolean };
const pictureOn = computed(() => user.value?.features?.socialPicture === true);
const picture = ref<SocialPicture | null>(null);
const pictureUploading = ref(false);
const pictureError = ref<string | null>(null);

// A 2 MB picture on a phone connection can outlast the shared 15 s, so the upload gets the push budget (90 s).
// A POST is never retried by useApi. With no reply in time the server may still store it, and the same file
// always gives the same stored picture, so choosing it again is safe and is how the preview comes back.
const PICTURE_MAYBE_UPLOADING =
  'The picture may still be uploading. In a moment, choose the same file again to see its preview.';
const PICTURE_UPLOAD: RequestOptions = { timeoutMs: DISPATCH_TIMEOUT_MS, unknownMessage: PICTURE_MAYBE_UPLOADING };

/** Same-origin path of the stored picture, so the preview and download work from any admin host. */
const pictureSrc = computed(() => {
  if (!picture.value) return null;
  try {
    return new URL(picture.value.url, window.location.origin).pathname;
  } catch {
    return null;
  }
});

async function onPictureFile(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  pictureUploading.value = true;
  pictureError.value = null;
  try {
    picture.value = await api.upload<SocialPicture>('/api/social-picture', file, PICTURE_UPLOAD);
  } catch (e) {
    picture.value = null;
    pictureError.value = (e as { outcomeUnknown?: boolean })?.outcomeUnknown
      ? PICTURE_MAYBE_UPLOADING
      : apiErrorMessage(e);
  } finally {
    pictureUploading.value = false;
  }
}

function removePicture() {
  picture.value = null;
  pictureError.value = null;
}

// The social pages this push can leave out (GET /api/social/pages). The server's list is drawn as it comes: no page name lives here, so a
// page switched on later just appears. `socialOff` holds the UNTICKED keys (empty = every page ticked = no `socialSkip` sent), so a page that
// joins the list starts ticked. It is not remembered: it starts empty on every visit and goes back to empty after each accepted send.
type SocialPage = { key: string; label: string };
const socialPages = ref<SocialPage[]>([]);
const socialOff = ref<string[]>([]);

/**
 * Reads the active pages. On the first read a failure leaves the group hidden, quietly (the send is then exactly today's send). On a
 * re-read after a refused send (`keepOnError`) a failure leaves the list as it was, so the sender's unticked pages are never lost
 * unseen: the same refusal simply comes back and nothing is sent.
 */
async function loadSocialPages(keepOnError = false) {
  try {
    const data = await api.get<{ pages?: SocialPage[] }>('/api/social/pages');
    const list = Array.isArray(data?.pages)
      ? data.pages.filter((p) => p && typeof p.key === 'string' && typeof p.label === 'string')
      : [];
    const known = new Set(list.map((p) => p.key));
    socialPages.value = list;
    socialOff.value = socialOff.value.filter((k) => known.has(k));
  } catch {
    if (!keepOnError) {
      socialPages.value = [];
      socialOff.value = [];
    }
  }
}

function setSocialTicked(key: string, ticked: boolean) {
  const rest = socialOff.value.filter((k) => k !== key);
  socialOff.value = ticked ? rest : [...rest, key];
}

/** The unticked pages, in the server's order: what goes in `socialSkip` and in the confirm's "Not posted to" line. Only pages on screen count. */
const skippedPages = computed(() => socialPages.value.filter((p) => socialOff.value.includes(p.key)));
const socialNote = computed(() =>
  skippedPages.value.length ? `Not posted to: ${skippedPages.value.map((p) => p.label).join(', ')}` : '',
);

const submitting = ref(false);
const confirming = ref(false);
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

// One-time id for this composed message. The server refuses a second send
// carrying the same id, so a retry after "no reply in time" — or a double
// click — can't push the same notification to every subscriber twice. It is
// kept across retries and replaced only when the message itself changes.
const requestId = ref<string | null>(null);

function newRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

// Set while a successful send clears its picture, so that clearing alone doesn't mint a new id:
// pressing Send again on the unchanged text must still meet the server's duplicate_send refusal.
let keepRequestIdOnce = false;

watch(
  [title, body, url, icon, targetMode, selectedTopics, breaking, force, scheduleMode, scheduledAtLocal, picture],
  () => {
    if (keepRequestIdOnce) {
      keepRequestIdOnce = false;
      return;
    }
    requestId.value = null;
  },
  { deep: true },
);

// Who the confirm dialog names. Topic sends also reach "All news" subscribers.
const TOPIC_LABEL = new Map(TOPICS.map((t) => [t.slug, t.label]));
const confirmHeading = computed(() =>
  targetMode.value === 'all'
    ? 'Send to everyone now?'
    : `Send to ${selectedTopics.value.map((s) => TOPIC_LABEL.get(s) ?? s).join(', ')} subscribers now?`,
);
const confirmDetail = computed(() => {
  const who =
    targetMode.value === 'all'
      ? 'It goes to all subscribers straight away.'
      : 'It goes out straight away — subscribers who chose “All news” get it too.';
  const night = breaking.value ? ' Breaking: it is sent even during quiet hours (11 pm – 7 am).' : '';
  return `${who}${night} A sent notification can't be recalled.`;
});

// "Send now" asks first; a scheduled send sends nothing yet, so it doesn't.
function onSendClick() {
  if (scheduleMode.value === 'later' && !force.value) {
    void send();
    return;
  }
  confirming.value = true;
}

async function confirmSend() {
  await send();
  confirming.value = false;
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
  if (requestId.value) payload.clientRequestId = requestId.value;
  if (pictureOn.value && picture.value) payload.socialImageId = picture.value.id;
  // Only when something is unticked: all ticked sends no field at all (today's request, byte for byte). Not part of the one-time id's
  // watch above on purpose: the id names the push to subscribers, which unticking a page does not change.
  if (skippedPages.value.length) payload.socialSkip = skippedPages.value.map((p) => p.key);
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
  if (!requestId.value) requestId.value = newRequestId();
  try {
    const res = await api.post<DispatchResult>('/api/send', buildPayload(), PUSH_REQUEST);
    result.value = res;
    // The picture belongs to the push just accepted; left attached it would silently ride on the next push's
    // LinkedIn and Facebook posts. Every other field stays. A refusal or no reply lands in catch and keeps it.
    if (picture.value) {
      keepRequestIdOnce = true;
      removePicture();
    }
    // Same for the unticked pages: they were for that push only, so the next one starts with every page ticked. Not watched, so the
    // one-time id is untouched and pressing Send again on the unchanged text still meets the server's duplicate_send refusal.
    socialOff.value = [];
  } catch (e) {
    errorBanner.value = apiErrorMessage(e);
    // An unticked page that is no longer in use: the server refused and sent nothing. Its message is shown as it came; re-read the list
    // so the group matches what is really on. Nothing is reset, so the send stays "not done" and the same one-time id is kept.
    const err = e as ApiError;
    if (err.status === 400 && (err.body as { error?: string } | undefined)?.error === 'unknown_social_page') {
      await loadSocialPages(true);
    }
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
  void loadSocialPages();
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

      <div v-if="pictureOn" class="form-row">
        <label for="social-picture">Picture for LinkedIn and Facebook (optional)</label>
        <div class="pic-row">
          <div class="pic-box" :class="{ has: pictureSrc }">
            <img v-if="pictureSrc" :src="pictureSrc" alt="Picture for the LinkedIn and Facebook posts" />
            <span v-else class="muted">No picture</span>
          </div>
          <div class="pic-side">
            <p class="pic-rule">
              JPEG or PNG, at most 2&nbsp;MB, at least 1080&nbsp;px wide. Square (1:1) to wide (1.91:1); portrait no taller
              than 4:5. Best: 1080&nbsp;×&nbsp;1080 (square) or 1200&nbsp;×&nbsp;627 (wide).
            </p>
            <p class="muted pic-note">Used only on the LinkedIn and Facebook posts, not in the notification itself.</p>
            <p class="muted pic-note">Clears after a successful send, so attach it again for the next push if needed.</p>
            <input
              v-if="!picture"
              id="social-picture"
              type="file"
              accept="image/jpeg,image/png"
              :disabled="pictureUploading || submitting"
              @change="onPictureFile"
            />
            <p v-if="pictureUploading" class="muted pic-note">Uploading…</p>
            <template v-if="picture && pictureSrc">
              <p class="pic-info">
                {{ picture.width }} × {{ picture.height }} px, {{ Math.ceil(picture.size / 1024) }} KB
              </p>
              <div class="pic-actions">
                <a class="btn btn-mini" :href="pictureSrc" download>Download</a>
                <button type="button" class="btn btn-mini" :disabled="submitting" @click="removePicture">Remove</button>
              </div>
            </template>
            <p v-if="pictureError" class="pic-err" role="alert">{{ pictureError }}</p>
          </div>
        </div>
      </div>

      <!-- One tick per active social page, drawn from the server's list. Unticked = that page gets nothing for THIS push. Hidden when the list is empty or unreadable. -->
      <div v-if="socialPages.length" class="form-row" role="group" aria-labelledby="social-post-to" data-testid="post-to">
        <label id="social-post-to">Post to</label>
        <div class="checkbox-row post-to">
          <label v-for="p in socialPages" :key="p.key" :class="{ off: socialOff.includes(p.key) }">
            <input
              type="checkbox"
              :checked="!socialOff.includes(p.key)"
              :data-key="p.key"
              @change="setSocialTicked(p.key, ($event.target as HTMLInputElement).checked)"
            />
            {{ p.label }}
          </label>
        </div>
        <p class="muted pic-note post-to-note">Untick a page to leave it out for this push only.</p>
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
          :disabled="!canSend || submitting || pictureUploading"
          @click="onSendClick"
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

    <ConfirmPush
      v-if="confirming"
      :title="title"
      :busy="submitting"
      :heading="confirmHeading"
      :detail="confirmDetail"
      :note="socialNote"
      confirm-label="Send now"
      @confirm="confirmSend"
      @cancel="confirming = false"
    />
  </main>
</template>

<style scoped>
/* Same look as the Ads screen's picture fields: dashed box until a picture is in, rule text at full strength. */
.pic-row {
  display: flex;
  gap: 14px;
  align-items: flex-start;
}
.pic-box {
  flex: 0 0 140px;
  height: 140px;
  border: 1px dashed var(--border);
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f8fafc;
  overflow: hidden;
}
.pic-box.has {
  border-style: solid;
  background: #fff;
}
.pic-box img {
  max-width: 100%;
  max-height: 100%;
  display: block;
}
.pic-side {
  flex: 1;
  min-width: 0;
}
.pic-rule {
  margin: 0 0 4px;
  font-size: 13px;
  color: var(--text);
}
.pic-note {
  margin: 0 0 8px;
  font-size: 12px;
}
.pic-info {
  margin: 0 0 8px;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.pic-actions .btn {
  text-decoration: none;
}
.pic-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.pic-err {
  margin: 8px 0 0;
  font-size: 13px;
  color: var(--danger);
  font-weight: 600;
}
/* "Post to": the topic pills' look, plus one signal for the new meaning: an unticked page is dashed and quiet, like the empty picture box. */
.post-to-note {
  margin: 6px 0 0;
}
.post-to label.off {
  background: transparent;
  border-style: dashed;
  color: var(--muted);
}
.post-to label:focus-within {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}
@media (max-width: 720px) {
  .pic-row {
    flex-direction: column;
  }
  .pic-box {
    flex-basis: auto;
    width: 100%;
    max-width: 320px;
    height: 200px;
  }
  /* An empty box is just a placeholder; on a phone it would push the rules a screen down. */
  .pic-box:not(.has) {
    display: none;
  }
  /* One page per line, text at 16px (no iOS zoom), a tick box and a row you can hit with a thumb. */
  .post-to {
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
  }
  .post-to label {
    font-size: 16px;
    min-height: 44px;
    gap: 12px;
    padding: 8px 14px;
    border-radius: 10px;
  }
  .post-to input {
    flex: none;
    width: 20px;
    height: 20px;
    margin: 0;
    padding: 0;
  }
  .pic-actions .btn {
    min-height: 44px;
    flex: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
}
</style>
