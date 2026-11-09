<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';

/**
 * The tab row under the top bar: the screens of the section you are in. Same joined-box look as the Weekly / Monthly switch on
 * Reports (white segments, the current one filled navy). The row is its own scroll box, so on a phone a long row (Social with
 * four channels) swipes sideways inside it and never widens the page; the current tab is kept in view.
 */
const props = defineProps<{ label: string; tabs: Array<{ to: string; label: string }> }>();

const route = useRoute();
const strip = ref<HTMLElement | null>(null);

// Scroll the strip (not the page) just far enough that the current tab is fully visible.
function revealCurrent() {
  const box = strip.value;
  const cur = box?.querySelector<HTMLElement>('[aria-current="page"]');
  if (!box || !cur) return;
  const gutter = 16;
  const left = cur.offsetLeft;
  const right = left + cur.offsetWidth;
  if (left < box.scrollLeft + gutter) box.scrollLeft = Math.max(0, left - gutter);
  else if (right > box.scrollLeft + box.clientWidth - gutter) box.scrollLeft = right - box.clientWidth + gutter;
}
onMounted(() => nextTick(revealCurrent));
watch(
  () => [route.path, props.tabs.length],
  () => nextTick(revealCurrent),
);
</script>

<template>
  <nav ref="strip" class="nav-tabs" :aria-label="`${label} screens`">
    <div class="nav-tabs-track">
      <router-link v-for="t in tabs" :key="t.to" :to="t.to" :data-label="t.label">{{ t.label }}</router-link>
    </div>
  </nav>
</template>
