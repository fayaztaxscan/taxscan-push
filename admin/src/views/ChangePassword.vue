<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuth, AuthError } from '../composables/useAuth';

const router = useRouter();
const { user, changePassword } = useAuth();

const currentPassword = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const error = ref<string | null>(null);
const submitting = ref(false);
const done = ref(false);

const isForced = computed(() => !!user.value?.passwordResetRequired);
const canSubmit = computed(
  () =>
    currentPassword.value.length > 0 &&
    newPassword.value.length > 0 &&
    newPassword.value === confirmPassword.value,
);

async function onSubmit() {
  error.value = null;
  if (newPassword.value !== confirmPassword.value) {
    error.value = 'New passwords do not match';
    return;
  }
  submitting.value = true;
  try {
    await changePassword(currentPassword.value, newPassword.value);
    done.value = true;
    // Auto-route into the dashboard after a brief success message so the
    // forced-flow doesn't leave the user staring at this page.
    setTimeout(() => router.push('/dashboard'), 800);
  } catch (e) {
    if (e instanceof AuthError) {
      error.value = e.message;
    } else {
      error.value = 'Password change failed. Please try again.';
    }
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <main class="page">
    <div class="card" style="max-width: 480px; margin: 60px auto">
      <h1 class="section-title">
        {{ isForced ? 'Change your temporary password' : 'Change password' }}
      </h1>
      <p v-if="isForced" class="muted">
        An admin reset your password and you need to choose a new one before continuing.
      </p>
      <p class="muted" style="font-size: 12px">
        At least 12 characters. Must include a lowercase letter, an uppercase letter,
        and a digit.
      </p>

      <form @submit.prevent="onSubmit">
        <div class="form-row">
          <label for="cur">Current password</label>
          <input
            id="cur"
            v-model="currentPassword"
            type="password"
            autocomplete="current-password"
            required
            autofocus
          />
        </div>
        <div class="form-row">
          <label for="new">New password</label>
          <input
            id="new"
            v-model="newPassword"
            type="password"
            autocomplete="new-password"
            required
          />
        </div>
        <div class="form-row">
          <label for="conf">Confirm new password</label>
          <input
            id="conf"
            v-model="confirmPassword"
            type="password"
            autocomplete="new-password"
            required
          />
        </div>

        <div v-if="error" class="banner err">{{ error }}</div>
        <div v-if="done" class="banner ok">
          Password changed. Redirecting…
        </div>

        <div class="form-row" style="display: flex; justify-content: flex-end">
          <button
            type="submit"
            class="btn btn-primary"
            :disabled="!canSubmit || submitting || done"
          >
            {{ submitting ? 'Updating…' : 'Update password' }}
          </button>
        </div>
      </form>
    </div>
  </main>
</template>
