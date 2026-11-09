<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';

/**
 * A disclosure button with a panel under it (Admin ▾, Account ▾). The parent owns `open` so only one is open at a time and
 * a route change closes them all. The button opens it by click, Enter or Space; Escape closes it and puts focus back on the
 * button; a click outside, or Tab moving focus out of the panel, closes it. Tab reaches every item while it is open.
 */
const props = defineProps<{
  /** The panel's id: `aria-controls` points at it. */
  id: string;
  label: string;
  open: boolean;
  /** The current screen is inside this dropdown (Users/Activity under Admin). */
  active?: boolean;
  /** Menu group, e.g. `admin`: carried to the button as `data-group`. */
  group?: string;
}>();
const emit = defineEmits<{ (e: 'toggle'): void; (e: 'close'): void }>();

const root = ref<HTMLElement | null>(null);
const button = ref<HTMLButtonElement | null>(null);

function onDocClick(e: MouseEvent) {
  if (props.open && root.value && !root.value.contains(e.target as Node)) emit('close');
}
function onDocKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.open) {
    emit('close');
    button.value?.focus();
  }
}
// Focus moved to somewhere outside this dropdown (Tab past the last item, or shift+Tab back out). A null relatedTarget is a
// click on plain text or a window switch, which the other handlers cover, so it is ignored.
function onFocusOut(e: FocusEvent) {
  const next = e.relatedTarget as Node | null;
  if (props.open && next && root.value && !root.value.contains(next)) emit('close');
}

onMounted(() => {
  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onDocKey);
});
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick);
  document.removeEventListener('keydown', onDocKey);
});
</script>

<template>
  <div ref="root" class="nav-drop" @focusout="onFocusOut">
    <button
      ref="button"
      type="button"
      class="nav-drop-btn"
      :class="{ active }"
      :data-group="group"
      :aria-controls="id"
      :aria-expanded="open"
      @click="emit('toggle')"
    >
      {{ label }} <span class="nav-drop-caret" aria-hidden="true">▾</span>
    </button>
    <div :id="id" class="nav-drop-panel" :class="{ open }">
      <slot />
    </div>
  </div>
</template>
