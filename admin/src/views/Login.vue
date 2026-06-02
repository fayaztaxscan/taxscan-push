<script setup lang="ts">
import { ref } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useAuth } from '../composables/useAuth';

const password = ref('');
const error = ref<string | null>(null);
const submitting = ref(false);
const router = useRouter();
const route = useRoute();
const { login } = useAuth();

async function onSubmit() {
  error.value = null;
  submitting.value = true;
  try {
    await login(password.value);
    const next = (route.query.next as string) || '/dashboard';
    router.push(next);
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Login failed';
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
        <label for="pw">Password</label>
        <input
          id="pw"
          v-model="password"
          type="password"
          autocomplete="current-password"
          autofocus
          required
        />
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
