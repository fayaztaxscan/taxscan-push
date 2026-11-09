<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue';

/**
 * "Push now" confirmation. Push now sends an article to every subscriber the
 * moment it's tapped, and a delivered notification can't be recalled, so one
 * stray tap (easy on a phone while scrolling the queue) used to be enough.
 * Cancel holds focus, so Enter or a reflexive second tap doesn't send.
 *
 * Compose reuses it for "Send now" with its own wording (audience, no queue);
 * the defaults are the Queue / Review "Push now" text. `note` is an optional
 * extra line under the detail (Compose: "Not posted to: …"); empty = nothing shown.
 *
 * Page Pause / Resume (the social screens) reuses it with no article line (`title` left out) and a default slot for its one optional
 * field; nothing changes for a caller that passes a title and no slot.
 */
withDefaults(
  defineProps<{
    title?: string;
    busy?: boolean;
    heading?: string;
    detail?: string;
    note?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    busyLabel?: string;
  }>(),
  {
    busy: false,
    title: '',
    note: '',
    heading: 'Send to everyone now?',
    detail:
      "It goes to all subscribers straight away, skipping the queue. A sent notification can't be recalled.",
    confirmLabel: 'Push now',
    cancelLabel: 'Cancel',
    busyLabel: 'Sending…',
  },
);
const emit = defineEmits<{ confirm: []; cancel: [] }>();

const cancelBtn = ref<HTMLButtonElement | null>(null);
onMounted(async () => {
  await nextTick();
  cancelBtn.value?.focus();
});
</script>

<template>
  <Teleport to="body">
    <div class="modal-overlay" @click.self="emit('cancel')" @keydown.esc="emit('cancel')">
      <div class="modal-card" role="alertdialog" aria-modal="true" aria-labelledby="confirm-push-title" :aria-describedby="note ? 'confirm-push-desc confirm-push-note' : 'confirm-push-desc'">
        <h2 id="confirm-push-title">{{ heading }}</h2>
        <p v-if="title" class="confirm-push-article">{{ title }}</p>
        <p id="confirm-push-desc" class="muted">{{ detail }}</p>
        <p v-if="note" id="confirm-push-note" class="confirm-push-note">{{ note }}</p>
        <slot />
        <div class="modal-actions">
          <button ref="cancelBtn" type="button" class="btn" @click="emit('cancel')">{{ cancelLabel }}</button>
          <button type="button" class="btn btn-primary" :disabled="busy" @click="emit('confirm')">
            {{ busy ? busyLabel : confirmLabel }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.confirm-push-article {
  margin: 0 0 8px;
  font-weight: 600;
  line-height: 1.4;
  /* A file name (Import Mailercloud statuses) has no spaces to break at. */
  overflow-wrap: anywhere;
}
/* Full-strength, semibold text under the muted 12px detail: it changes what this send does, so it must not read as small print,
   but it stays smaller than the article headline above it. */
.confirm-push-note {
  margin: 8px 0 0;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
</style>
