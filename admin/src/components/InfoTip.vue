<script setup lang="ts">
import { nextTick, ref } from 'vue';

defineProps<{ text: string; heading?: string }>();

const open = ref(false);
const btn = ref<HTMLButtonElement | null>(null);
const pos = ref<{ top: number; left: number }>({ top: 0, left: 0 });

// Popover is teleported to <body> with position:fixed so it can't be clipped by
// the card's `overflow-x: auto`. Position it under the icon, clamped to the viewport.
async function show() {
  open.value = true;
  await nextTick();
  const el = btn.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  const width = 260;
  const left = Math.max(8, Math.min(r.left + r.width / 2 - width / 2, window.innerWidth - width - 8));
  pos.value = { top: r.bottom + 8, left };
}
function hide() {
  open.value = false;
}
</script>

<template>
  <span class="infotip">
    <button
      ref="btn"
      type="button"
      class="infotip-btn"
      aria-label="What is this?"
      @mouseenter="show"
      @mouseleave="hide"
      @focus="show"
      @blur="hide"
      @keydown.esc="hide"
      @click="show"
    >
      i
    </button>
    <Teleport to="body">
      <span
        v-if="open"
        class="infotip-pop"
        role="tooltip"
        :style="{ top: pos.top + 'px', left: pos.left + 'px' }"
      >
        <strong v-if="heading" class="infotip-head">{{ heading }}</strong>
        {{ text }}
      </span>
    </Teleport>
  </span>
</template>

<style scoped>
.infotip {
  display: inline-flex;
  vertical-align: middle;
  margin-left: 6px;
}
.infotip-btn {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 1px solid #94a3b8;
  background: #fff;
  color: #475569;
  font: italic 700 11px/1 Georgia, 'Times New Roman', serif;
  cursor: help;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.infotip-btn:hover,
.infotip-btn:focus-visible {
  border-color: #0b2545;
  color: #0b2545;
  outline: none;
}
</style>

<!-- Unscoped: the popover is teleported to <body>, outside this component's scope. -->
<style>
.infotip-pop {
  position: fixed;
  z-index: 2147483000;
  width: 260px;
  max-width: 80vw;
  background: #0b2545;
  color: #fff;
  text-align: left;
  font-size: 12px;
  font-weight: 400;
  line-height: 1.45;
  letter-spacing: 0;
  text-transform: none;
  padding: 10px 12px;
  border-radius: 8px;
  box-shadow: 0 10px 28px rgba(11, 37, 69, 0.3);
}
.infotip-pop .infotip-head {
  display: block;
  margin-bottom: 4px;
  font-weight: 700;
}
</style>
