<script setup lang="ts">
import { ref } from 'vue';

// The admin guide is authored as a standalone HTML document with its own
// styles, so we embed it in an iframe (style isolation) rather than inlining it
// into the SPA. There is ONE copy of the guide (the HTML): "Print / Save as PDF"
// prints the iframe's own window, so the browser's print dialog gets the guide
// only (no app menu) with its A4 / page-break rules, and "Save as PDF" is
// always current. The endpoint is auth-gated; the iframe request carries the
// session cookie same-origin.
const frame = ref<HTMLIFrameElement | null>(null);

function printGuide() {
  const w = frame.value?.contentWindow;
  if (!w) return;
  w.focus();
  w.print();
}
</script>

<template>
  <main class="page">
    <div class="toolbar">
      <h1 class="section-title" style="margin: 0">Admin guide</h1>
      <span class="spacer" style="flex: 1" />
      <button type="button" class="btn" @click="printGuide">Print / Save as PDF</button>
    </div>

    <div class="card guide-frame-card">
      <iframe
        ref="frame"
        src="/api/guide.html"
        title="Taxscan Push admin user guide"
        class="guide-frame"
      ></iframe>
    </div>
  </main>
</template>

<style scoped>
.guide-frame-card {
  padding: 0;
  overflow: hidden;
}
.guide-frame {
  display: block;
  width: 100%;
  height: calc(100vh - 200px);
  min-height: 480px;
  border: 0;
  background: #fff;
}
</style>
