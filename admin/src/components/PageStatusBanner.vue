<script setup lang="ts">
import { computed } from 'vue';
import { bannerKind, type BannerKind, type PageStatus } from '../composables/socialPages';

/**
 * The standing banner on a social screen when its page is PAUSED, HELD or FAILING (brief 2026-11-09-social-page-alerts-pause).
 * The headline is the server's own sentence (`pageStatus.message`: who paused it and when, until when LinkedIn holds it, what failed);
 * this adds one plain helper line for the kind. A `stopped` page is NOT drawn here: the login / policy / channel stop keeps the
 * banner and Resume the screen already has.
 *
 * Three kinds, one colour language: navy = a person chose it (paused), amber = it clears by itself (held), red = it needs a person
 * (failing). Each has a heavier left edge, like the stop banners, so it reads as a standing condition and not as the answer to a click.
 */
const props = defineProps<{ status: PageStatus | null | undefined; isAdmin: boolean }>();

const kind = computed<BannerKind | null>(() => bannerKind(props.status));

const HELP: Record<BannerKind, string> = {
  held: 'Nothing is broken: the page posts again by itself. Pushes in between are skipped and not posted later.',
  failing: 'Check the failed rows below: Retry or Skip them. An administrator can Pause the page.',
  paused:
    'Every push is skipped on this page, with no post, until an administrator resumes it. Skipped pushes are not posted later.',
};
</script>

<template>
  <div
    v-if="kind && status"
    class="banner ps"
    :class="['ps-' + kind, { warn: kind === 'held', err: kind === 'failing' }]"
    :role="kind === 'failing' ? 'alert' : 'status'"
    :data-testid="'page-status-' + kind"
  >
    <p class="banner-lead" data-testid="page-status-message">{{ status.message }}</p>
    <p class="banner-detail" data-testid="page-status-help">{{ HELP[kind] }}</p>
    <p v-if="kind === 'paused' && !isAdmin" class="banner-detail" data-testid="page-status-ask">
      Ask an administrator to resume it.
    </p>
  </div>
</template>

<style scoped>
/* Two classes each, so the heavier left edge beats the global .banner.warn / .banner.err border shorthand whatever the load order. */
.ps {
  /* A typed note can hold a long unbroken word. */
  overflow-wrap: anywhere;
}
.ps.ps-paused {
  background: #f1f5f9;
  border: 1px solid var(--border);
  border-left: 4px solid var(--primary);
  color: var(--text);
}
.ps.ps-held {
  border-left: 4px solid var(--warn);
}
.ps.ps-failing {
  border-left: 4px solid #dc2626;
}
</style>
