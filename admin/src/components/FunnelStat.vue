<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  label: string;
  value: number;
  base: number; // value to scale the bar against (e.g. the top-of-funnel count)
}>();

const pct = computed(() => {
  if (props.base <= 0) return 0;
  return Math.max(0, Math.min(1, props.value / props.base));
});
const pctLabel = computed(() => (pct.value * 100).toFixed(0) + '%');
</script>

<template>
  <div class="funnel-row">
    <span>{{ label }}</span>
    <div class="funnel-bar">
      <div class="funnel-bar-fill" :style="{ width: pct * 100 + '%' }" />
    </div>
    <span>{{ value.toLocaleString() }} · {{ pctLabel }}</span>
  </div>
</template>
