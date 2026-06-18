<script setup lang="ts">
// Shows the article flow (Captured → Review → Queue → Sent) with the current
// screen's stage highlighted, so the relationship between the Review and Queue
// screens is obvious at a glance. Each stage carries a one-line tooltip.
defineProps<{ current: 'captured' | 'review' | 'queue' | 'sent' }>();

const stages = [
  { key: 'captured', label: 'Captured', tip: 'New articles pulled from the RSS feeds.' },
  { key: 'review', label: 'Review', tip: "Unclassified articles waiting for an editor's decision." },
  {
    key: 'queue',
    label: 'Queue',
    tip: 'Approved articles waiting their ~45-min send slot, in send order.',
  },
  { key: 'sent', label: 'Sent', tip: 'Pushed to subscribers — see the Campaigns screen.' },
] as const;
</script>

<template>
  <nav class="pipeline" aria-label="Article flow">
    <template v-for="(s, i) in stages" :key="s.key">
      <span v-if="i > 0" class="pipeline-arrow" aria-hidden="true">→</span>
      <span class="pipeline-stage" :class="{ active: s.key === current }" :title="s.tip">
        {{ s.label }}
      </span>
    </template>
  </nav>
</template>

<style scoped>
.pipeline {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin: 4px 0 14px;
  font-size: 12px;
}
.pipeline-stage {
  padding: 3px 10px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--muted);
  background: var(--surface);
  white-space: nowrap;
  cursor: default;
}
.pipeline-stage.active {
  background: var(--primary);
  border-color: var(--primary);
  color: #fff;
  font-weight: 600;
}
.pipeline-arrow {
  color: var(--muted);
}
</style>
