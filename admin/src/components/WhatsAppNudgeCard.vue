<script setup lang="ts">
import { onMounted } from 'vue';
import { useStaffPush } from '../composables/useStaffPush';

/**
 * "Notify me on this device when articles are waiting" — the WhatsApp screen's opt-in for the staff nudge.
 * Same staff worker, permission handling and states as the Digests card; the device signs up for kind 'whatsapp'.
 * Shown ONLY when the server says the nudge is running (status.whatsappNudge); otherwise nothing renders.
 */
const { state, busy, error, notice, warning, status, refresh, enable, disable, sendTest } = useStaffPush('whatsapp');

onMounted(refresh);
</script>

<template>
  <section v-if="status?.whatsappNudge === true" class="card wa-nudge" aria-labelledby="wa-nudge-title">
    <div class="wn-row">
      <div class="wn-text">
        <h2 id="wa-nudge-title">Notify me on this device when articles are waiting</h2>

        <template v-if="state === 'on'">
          <p class="wn-state"><span class="status-pill active">On for this device</span></p>
        </template>
        <template v-else-if="state === 'off'">
          <p class="wn-state"><span class="status-pill inactive">Off</span></p>
        </template>
        <template v-else-if="state === 'blocked'">
          <p class="wn-state"><span class="status-pill inactive">Blocked in browser settings</span></p>
          <p class="muted wn-help">
            To allow: open this site's settings (the icon left of the address bar) → Notifications → Allow, then reload
            this page.
          </p>
        </template>
        <template v-else-if="state === 'ios-home-screen'">
          <p class="wn-state"><span class="status-pill inactive">Add to Home Screen first</span></p>
          <p class="muted wn-help">
            On an iPhone or iPad, notifications work only from the Home Screen: in Safari tap Share → Add to Home
            Screen, open Taxscan Push from the Home Screen, sign in, and come back here (iOS 16.4 or later).
          </p>
        </template>
        <template v-else-if="state === 'unsupported'">
          <p class="wn-state"><span class="status-pill inactive">Not available</span></p>
          <p class="muted wn-help">This browser can't show notifications.</p>
        </template>
        <p v-else class="muted wn-help">Checking…</p>

        <p v-if="state === 'on' || state === 'off'" class="muted wn-help">
          One notification when new articles are waiting, at most every 10 minutes, never between 11 pm and 7 am.
        </p>
      </div>

      <div class="wn-actions">
        <button v-if="state === 'off'" class="btn btn-primary" :disabled="busy" @click="enable">
          {{ busy ? 'Setting up…' : 'Notify me on this device' }}
        </button>
        <template v-else-if="state === 'on'">
          <button class="btn" :disabled="busy" @click="sendTest">Send a test</button>
          <button class="btn" :disabled="busy" @click="disable">Turn off</button>
        </template>
      </div>
    </div>
    <div v-if="error" class="banner err wn-msg" role="alert">{{ error }}</div>
    <template v-else>
      <div v-if="notice" class="banner ok wn-msg" role="status">{{ notice }}</div>
      <div v-if="warning" class="banner warn wn-msg" role="status">{{ warning }}</div>
    </template>
  </section>
</template>

<style scoped>
.wa-nudge {
  margin-bottom: 14px;
}
.wn-row {
  display: flex;
  gap: 16px;
  align-items: flex-start;
  justify-content: space-between;
}
.wn-text {
  min-width: 0;
  flex: 1 1 auto;
}
.wn-text h2 {
  margin: 0 0 8px;
  font-size: 15px;
}
.wn-state {
  margin: 0 0 6px;
}
.wn-help {
  margin: 0;
  font-size: 13px;
  max-width: 62ch;
}
.wn-help + .wn-help {
  margin-top: 6px;
}
.wn-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
  flex: 0 0 auto;
}
.wn-msg {
  margin: 12px 0 0;
}
@media (max-width: 720px) {
  .wn-row {
    flex-direction: column;
  }
  .wn-actions {
    justify-content: flex-start;
    width: 100%;
  }
  .wn-actions .btn {
    flex: 1 1 auto;
    min-height: 44px;
  }
}
</style>
