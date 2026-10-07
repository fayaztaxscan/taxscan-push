<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue';

/**
 * "Push now" confirmation. Push now sends an article to every subscriber the
 * moment it's tapped, and a delivered notification can't be recalled, so one
 * stray tap (easy on a phone while scrolling the queue) used to be enough.
 * Cancel holds focus, so Enter or a reflexive second tap doesn't send.
 */
defineProps<{ title: string; busy?: boolean }>();
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
      <div class="modal-card" role="alertdialog" aria-modal="true" aria-labelledby="confirm-push-title" aria-describedby="confirm-push-desc">
        <h2 id="confirm-push-title">Send to everyone now?</h2>
        <p class="confirm-push-article">{{ title }}</p>
        <p id="confirm-push-desc" class="muted">
          It goes to all subscribers straight away, skipping the queue. A sent notification can't be
          recalled.
        </p>
        <div class="modal-actions">
          <button ref="cancelBtn" type="button" class="btn" @click="emit('cancel')">Cancel</button>
          <button type="button" class="btn btn-primary" :disabled="busy" @click="emit('confirm')">
            {{ busy ? 'Sending…' : 'Push now' }}
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
}
</style>
