<script setup lang="ts">
import type { Band } from '../composables/thresholds';

defineProps<{
  label: string;
  value: string | number;
  hint?: string;
  band?: Band;
  bandTitle?: string;
}>();
</script>

<template>
  <div class="metric">
    <div class="label">
      <span v-if="band" :class="['band-dot', band]" :title="bandTitle" />
      {{ label }}
    </div>
    <div class="value">{{ value }}</div>
    <div v-if="hint" class="hint">{{ hint }}</div>
  </div>
</template>
