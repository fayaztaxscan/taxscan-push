<script setup lang="ts">
// The admin guide is authored as a standalone HTML document with its own
// styles, so we embed it in an iframe (style isolation) rather than inlining it
// into the SPA. The PDF stays available as a download. Both endpoints are
// auth-gated; the iframe/download requests carry the session cookie same-origin.
</script>

<template>
  <main class="page">
    <div class="toolbar">
      <h1 class="section-title" style="margin: 0">Admin guide</h1>
      <span class="spacer" style="flex: 1" />
      <a class="btn" href="/api/guide?download=1" download>Download PDF</a>
    </div>

    <div class="card guide-frame-card">
      <iframe
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
