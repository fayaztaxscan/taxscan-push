<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  points: { date: string; value: number }[];
  height?: number;
}>();

const w = 720;
const h = computed(() => props.height ?? 80);

const pathInfo = computed(() => {
  const points = props.points;
  if (points.length === 0) return { line: '', area: '', max: 0 };
  const max = Math.max(1, ...points.map((p) => p.value));
  const step = points.length > 1 ? w / (points.length - 1) : 0;
  const ys = points.map((p) => h.value - 6 - (p.value / max) * (h.value - 12));
  const coords = points.map((_, i) => [i * step, ys[i]] as [number, number]);
  const line = coords.map(([x, y], i) => (i === 0 ? `M${x},${y}` : `L${x},${y}`)).join(' ');
  const area =
    line +
    ` L${coords[coords.length - 1][0]},${h.value} L0,${h.value} Z`;
  return { line, area, max };
});
</script>

<template>
  <svg
    :viewBox="`0 0 ${w} ${h}`"
    preserveAspectRatio="none"
    style="width: 100%; display: block"
    role="img"
    aria-label="30-day subscriber growth"
  >
    <path :d="pathInfo.area" fill="#0b2545" fill-opacity="0.08" />
    <path :d="pathInfo.line" fill="none" stroke="#0b2545" stroke-width="2" />
  </svg>
</template>
