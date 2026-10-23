<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';

/**
 * An email shown at a chosen screen width inside a SANDBOXED iframe (no
 * scripts, no same-origin), scaled down to fit its box. The html always comes
 * from an API route that sends a sandbox CSP (`PREVIEW_CSP`) — never from the
 * SPA's own origin context. Shared by Digests (the frozen email) and Templates.
 */
const props = withDefaults(defineProps<{ src: string | null; widthPx: number; title: string; height?: number }>(), { height: 1100 });

const host = ref<HTMLElement | null>(null);
const hostWidth = ref(0);
let ro: ResizeObserver | null = null;
const scale = computed(() => (hostWidth.value > 0 ? Math.min(1, hostWidth.value / props.widthPx) : 1));
watch(host, (el) => {
  ro?.disconnect();
  if (el) {
    ro = new ResizeObserver(([entry]) => (hostWidth.value = entry.contentRect.width));
    ro.observe(el);
  }
});
onBeforeUnmount(() => ro?.disconnect());
defineExpose({ scale });
</script>

<template>
  <div ref="host" class="frame-host" :style="{ height: `${Math.round(height * scale)}px` }">
    <iframe
      v-if="src"
      :key="src"
      :src="src"
      sandbox=""
      referrerpolicy="no-referrer"
      :title="title"
      class="frame"
      :style="{ width: `${widthPx}px`, height: `${height}px`, transform: `scale(${scale})` }"
    />
    <div v-else class="frame-empty muted"><slot /></div>
  </div>
</template>

<style scoped>
.frame-host {
  position: relative;
  width: 100%;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #eef2f7;
}
.frame {
  display: block;
  border: 0;
  background: #fff;
  transform-origin: top left;
}
.frame-empty {
  padding: 24px;
  text-align: center;
}
</style>
