<script setup lang="ts">
import { computed } from 'vue';

/**
 * Inline micro-sparkline for a single grid row.
 *
 * Deliberately NOT the Dashboard's SparkLine: that one is a full-width hero
 * chart with a fixed navy fill and its own aria label. This draws at table-cell
 * size, takes its stroke from the caller (so Discover and Google News keep the
 * violet of their own grids), and is aria-labelled per row.
 *
 * Scaled to its OWN maximum, not a shared one: the question a row answers is
 * "which way is this heading", and a category with a tenth of the traffic would
 * otherwise flatline into a straight line and read as "no change".
 */
const props = defineProps<{
  values: number[];
  label: string;
  stroke?: string;
  width?: number;
  height?: number;
}>();

const w = computed(() => props.width ?? 72);
const h = computed(() => props.height ?? 20);
const stroke = computed(() => props.stroke ?? '#6d28d9');

const geometry = computed(() => {
  const vs = props.values;
  if (vs.length < 2) return null;
  const max = Math.max(...vs);
  const pad = 2;
  const usable = h.value - pad * 2;
  const step = w.value / (vs.length - 1);
  // A row that never moved is drawn flat along the baseline rather than
  // dividing by zero and springing to the top of the box.
  const y = (v: number) => (max <= 0 ? h.value - pad : h.value - pad - (v / max) * usable);
  const pts = vs.map((v, i) => [i * step, y(v)] as const);
  return {
    line: pts.map(([x, yy], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${yy.toFixed(1)}`).join(' '),
    last: pts[pts.length - 1],
  };
});
</script>

<template>
  <svg
    v-if="geometry"
    :viewBox="`0 0 ${w} ${h}`"
    :width="w"
    :height="h"
    class="trend"
    role="img"
    :aria-label="label"
  >
    <path :d="geometry.line" fill="none" :stroke="stroke" stroke-width="1.5" stroke-linejoin="round" />
    <!-- The newest point is dotted so the eye knows which end is now. -->
    <circle :cx="geometry.last[0]" :cy="geometry.last[1]" r="1.9" :fill="stroke" />
  </svg>
</template>

<style scoped>
.trend {
  display: block;
  overflow: visible;
}
</style>
