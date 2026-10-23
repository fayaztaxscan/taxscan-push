<script setup lang="ts">
import { onMounted } from 'vue';
import { useStaffPush } from '../composables/useStaffPush';

/**
 * "Notify me on this device" (digest task 14). One compact card: the current
 * state of THIS browser, and the one control that changes it. The browser's
 * permission prompt appears only after the button tap.
 */
const { state, busy, error, notice, warning, status, refresh, enable, disable, sendTest } = useStaffPush();

onMounted(refresh);
</script>

<template>
  <section class="card staff-push" aria-labelledby="staff-push-title">
    <div class="sp-row">
      <div class="sp-text">
        <h2 id="staff-push-title">Notifications on this device</h2>

        <template v-if="state === 'on'">
          <p class="sp-state"><span class="status-pill active">On for this device</span></p>
          <p class="muted sp-help">
            You get a notification when today's digest is ready to approve, and a reminder if it is still waiting an
            hour after the send time. The email still comes.
          </p>
        </template>

        <template v-else-if="state === 'off'">
          <p class="sp-state"><span class="status-pill inactive">Off</span></p>
          <p class="muted sp-help">
            Get a notification on this phone or computer when today's digest is ready to approve, and a reminder if
            nobody has approved it an hour after the send time. The email still comes.
          </p>
        </template>

        <template v-else-if="state === 'blocked'">
          <p class="sp-state"><span class="status-pill inactive">Blocked in browser settings</span></p>
          <p class="muted sp-help">
            To allow: open this site's settings (the icon left of the address bar) → Notifications → Allow, then reload
            this page.
          </p>
        </template>

        <template v-else-if="state === 'ios-home-screen'">
          <p class="sp-state"><span class="status-pill inactive">Add to Home Screen first</span></p>
          <p class="muted sp-help">
            On an iPhone or iPad, notifications work only from the Home Screen: in Safari tap Share → Add to Home
            Screen, open Taxscan Push from the Home Screen, sign in, and come back here (iOS 16.4 or later).
          </p>
        </template>

        <template v-else-if="state === 'unsupported'">
          <p class="sp-state"><span class="status-pill inactive">Not available</span></p>
          <p class="muted sp-help">This browser can't show notifications. The digest emails still come.</p>
        </template>

        <p v-else class="muted sp-help">Checking…</p>

        <p v-if="status && !status.sending && (state === 'on' || state === 'off')" class="muted sp-help">
          {{
            status.digestEnabled
              ? 'Digest notifications are switched off for now (DIGEST_STAFF_PUSH_ENABLED); nothing is sent until they are on.'
              : 'The digest is switched off, so nothing is sent yet. This device is ready for when it is on.'
          }}
        </p>
      </div>

      <div class="sp-actions">
        <button v-if="state === 'off'" class="btn btn-primary" :disabled="busy" @click="enable">
          {{ busy ? 'Setting up…' : 'Notify me on this device' }}
        </button>
        <template v-else-if="state === 'on'">
          <button class="btn" :disabled="busy" @click="sendTest">Send a test</button>
          <button class="btn" :disabled="busy" @click="disable">Stop notifications on this device</button>
        </template>
      </div>
    </div>
    <div v-if="error" class="banner err sp-msg" role="alert">{{ error }}</div>
    <template v-else>
      <div v-if="notice" class="banner ok sp-msg" role="status">{{ notice }}</div>
      <div v-if="warning" class="banner warn sp-msg" role="status">{{ warning }}</div>
    </template>
  </section>
</template>

<style scoped>
.sp-row {
  display: flex;
  gap: 16px;
  align-items: flex-start;
  justify-content: space-between;
}
.sp-text {
  min-width: 0;
  flex: 1 1 auto;
}
.sp-text h2 {
  margin: 0 0 8px;
}
.sp-state {
  margin: 0 0 6px;
}
.sp-help {
  margin: 0;
  font-size: 13px;
  max-width: 62ch;
}
.sp-help + .sp-help {
  margin-top: 6px;
}
.sp-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
  flex: 0 0 auto;
}
.sp-msg {
  margin: 12px 0 0;
}
@media (max-width: 720px) {
  .sp-row {
    flex-direction: column;
  }
  .sp-actions {
    justify-content: flex-start;
    width: 100%;
  }
  .sp-actions .btn {
    flex: 1 1 auto;
  }
}
</style>
