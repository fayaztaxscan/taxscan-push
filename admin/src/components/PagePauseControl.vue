<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import ConfirmPush from './ConfirmPush.vue';
import { apiErrorMessage, useApi, type ApiError } from '../composables/useApi';
import { PAUSE_NOTE_MAX, socialPageName, type PageStatus, type SocialChannel } from '../composables/socialPages';

/**
 * Pause / Resume ONE social page (brief 2026-11-09-social-page-alerts-pause). ADMIN only: the screens render it under `v-if="isAdmin"`
 * (the server answers a PUBLISHER 403 either way). One button that flips with the page's state: "Pause this page" while it posts,
 * "Resume posting" while it is paused, and each opens a confirm (Cancel focused, like every push confirm). Pausing takes one optional
 * one-line note (200 characters at most) that the banner and the Activity log show.
 *
 * `page` is the LinkedIn page key; Facebook and Telegram have one page and leave it out. On success, and on a 409 (somebody else
 * already did it), the screen is told to reload with `done`; a failure stays in the dialog, in words, so it is seen where it was made.
 * Pausing a page that is also `stopped` is allowed: the stop keeps its own banner and Resume.
 */
const props = defineProps<{ channel: SocialChannel; page?: string | null; status: PageStatus | null | undefined }>();
const emit = defineEmits<{ done: [outcome: 'paused' | 'resumed' | 'refreshed'] }>();

const api = useApi();
const open = ref(false);
const busy = ref(false);
const note = ref('');
const failure = ref<string | null>(null);

const paused = computed(() => props.status?.status === 'paused');
const name = computed(() => socialPageName(props.channel, props.page ?? props.status?.page ?? 'taxscan'));
const noteLeft = computed(() => PAUSE_NOTE_MAX - note.value.length);

function ask(): void {
  note.value = '';
  failure.value = null;
  open.value = true;
}
function close(): void {
  if (busy.value) return;
  open.value = false;
}

// A failure in plain words, never the server's code (`internal_error`). A write that got no reply keeps useApi's own sentence: it says
// the change may still have gone through.
function failureText(e: unknown, resuming: boolean): string {
  const err = e as ApiError;
  const code = (err.body as { error?: string } | undefined)?.error;
  if (err.status === 403) return 'Only an administrator can pause or resume a page.';
  if (code === 'note_too_long') return `The note is too long: ${PAUSE_NOTE_MAX} characters at most.`;
  if (err.outcomeUnknown) return apiErrorMessage(e);
  if ((err.status ?? 0) >= 500 || code === 'internal_error') {
    return `Could not ${resuming ? 'resume' : 'pause'} the page: the server had a problem. Try again in a moment.`;
  }
  return apiErrorMessage(e);
}

async function confirm(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  failure.value = null;
  const wasPaused = paused.value;
  const body: { page?: string; note?: string } = {};
  if (props.page) body.page = props.page;
  if (!wasPaused && note.value.trim()) body.note = note.value.trim();
  try {
    await api.post(`/api/${props.channel}/${wasPaused ? 'page-resume' : 'page-pause'}`, body);
    open.value = false;
    emit('done', wasPaused ? 'resumed' : 'paused');
  } catch (e) {
    const err = e as ApiError;
    const code = (err.body as { error?: string } | undefined)?.error;
    // Already paused / already resumed (a colleague pressed first), or the page is no longer in use: nothing to do but show the truth.
    if (err.status === 409 || code === 'invalid_page') {
      open.value = false;
      emit('done', 'refreshed');
    } else {
      failure.value = failureText(e, wasPaused);
    }
  } finally {
    busy.value = false;
  }
}

function onEnter(e: KeyboardEvent): void {
  if (!e.isComposing) void confirm();
}

// Escape closes the dialog. ConfirmPush listens on its overlay, but after a failed press the focused button was disabled meanwhile, so
// focus is on the page behind and the overlay never hears the key: listen on the document while the dialog is open.
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') close();
}
watch(open, (isOpen) => {
  if (isOpen) document.addEventListener('keydown', onKey);
  else document.removeEventListener('keydown', onKey);
});
onBeforeUnmount(() => document.removeEventListener('keydown', onKey));
</script>

<template>
  <template v-if="status">
    <button
      type="button"
      class="btn"
      :class="{ 'btn-primary': paused }"
      data-testid="page-pause-btn"
      @click="ask"
    >
      {{ paused ? 'Resume posting' : 'Pause this page' }}
    </button>

    <ConfirmPush
      v-if="open"
      :busy="busy"
      :heading="paused ? `Resume posting to ${name}?` : `Pause ${name}?`"
      :detail="
        paused
          ? 'Posts start again from the next push. Nothing that was skipped is posted.'
          : 'Every push is skipped on this page, with no post, until you resume it. Skipped pushes are not posted later.'
      "
      :confirm-label="paused ? 'Resume posting' : 'Pause this page'"
      :busy-label="paused ? 'Resuming…' : 'Pausing…'"
      @confirm="confirm"
      @cancel="close"
    >
      <div v-if="!paused" class="pp-note" data-testid="page-pause-note">
        <label for="page-pause-note-input">Note (optional)</label>
        <input
          id="page-pause-note-input"
          v-model="note"
          type="text"
          :maxlength="PAUSE_NOTE_MAX"
          autocomplete="off"
          enterkeyhint="done"
          placeholder="Why, for whoever looks next"
          :disabled="busy"
          aria-describedby="page-pause-note-count"
          @keydown.enter.prevent="onEnter"
        />
        <span id="page-pause-note-count" class="pp-count" :class="{ near: noteLeft <= 20 }" data-testid="page-pause-count"
          >{{ note.length }} / {{ PAUSE_NOTE_MAX }}</span
        >
      </div>
      <p v-if="failure" class="banner err pp-fail" role="alert" data-testid="page-pause-error">{{ failure }}</p>
    </ConfirmPush>
  </template>
</template>

<style scoped>
.pp-note {
  margin-top: 14px;
}
.pp-count {
  display: block;
  margin-top: 4px;
  text-align: right;
  font-size: 12px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.pp-count.near {
  color: var(--warn);
  font-weight: 600;
}
.pp-fail {
  margin: 12px 0 0;
  overflow-wrap: anywhere;
}
@media (max-width: 720px) {
  /* A thumb-sized target, like the other buttons in a phone toolbar (the dialog's own buttons are ConfirmPush's). */
  [data-testid='page-pause-btn'] {
    min-height: 44px;
  }
}
</style>
