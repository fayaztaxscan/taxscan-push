<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useAuth, AuthError } from '../composables/useAuth';

const email = ref('');
const password = ref('');
const error = ref<string | null>(null);
const submitting = ref(false);

const router = useRouter();
const route = useRoute();
const { login, user } = useAuth();

// Set by useApi when a 401 bounced the user here mid-session, so we explain
// why they're back at the login screen rather than showing nothing.
const sessionExpired = computed(() => route.query.reason === 'expired' && !error.value);

async function onSubmit() {
  error.value = null;
  submitting.value = true;
  try {
    await login(email.value, password.value);
    // First-login funnel — if the admin reset this user's password and
    // hasn't changed it yet, force the change before letting them roam.
    if (user.value?.passwordResetRequired) {
      router.push('/change-password');
      return;
    }
    const next = (route.query.next as string) || '/dashboard';
    router.push(next);
  } catch (e) {
    if (e instanceof AuthError) {
      error.value = e.message;
    } else {
      error.value = 'Sign in failed. Please try again.';
    }
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="login-shell">
    <form class="login-card" @submit.prevent="onSubmit">
      <h1>Taxscan Push admin</h1>
      <div class="form-row">
        <label for="email">Email</label>
        <input
          id="email"
          v-model="email"
          type="email"
          autocomplete="email"
          required
          autofocus
        />
      </div>
      <div class="form-row">
        <label for="pw">Password</label>
        <input
          id="pw"
          v-model="password"
          type="password"
          autocomplete="current-password"
          required
        />
      </div>
      <div v-if="sessionExpired" class="banner err">
        Your session expired — please sign in again.
      </div>
      <div v-if="error" class="banner err">{{ error }}</div>
      <div class="form-row" style="display: flex; justify-content: flex-end">
        <button type="submit" class="btn btn-primary" :disabled="submitting">
          {{ submitting ? 'Signing in…' : 'Sign in' }}
        </button>
      </div>
    </form>
  </div>
</template>
