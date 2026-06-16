<script setup lang="ts">
import type { Band } from '../composables/thresholds';
import InfoTip from './InfoTip.vue';

defineProps<{
  label: string;
  value: string | number;
  hint?: string;
  band?: Band;
  bandTitle?: string;
  info?: string;
}>();
</script>

<template>
  <div class="metric">
    <div class="label">
      <span v-if="band" :class="['band-dot', band]" :title="bandTitle" />
      {{ label }}
      <InfoTip v-if="info" :heading="label" :text="info" />
    </div>
    <div class="value">{{ value }}</div>
    <div v-if="hint" class="hint">{{ hint }}</div>
  </div>
</template>
