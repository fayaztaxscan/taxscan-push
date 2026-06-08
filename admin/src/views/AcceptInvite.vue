<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useAuth, AuthError } from '../composables/useAuth';

const router = useRouter();
const route = useRoute();
const { fetchInvite, acceptInvite } = useAuth();

const token = computed(() => (route.query.token as string) || '');

const loading = ref(true);
const loadError = ref<string | null>(null);
const invite = ref<{ email: string; role: 'ADMIN' | 'PUBLISHER' } | null>(null);

const password = ref('');
const confirm = ref('');
const error = ref<string | null>(null);
const submitting = ref(false);

const canSubmit = computed(
  () => password.value.length > 0 && password.value === confirm.value && !submitting.value,
);

onMounted(async () => {
  if (!token.value) {
    loadError.value = 'This invitation link is missing its token.';
    loading.value = false;
    return;
  }
  try {
    invite.value = await fetchInvite(token.value);
  } catch (e) {
    loadError.value = e instanceof AuthError ? e.message : 'Could not load this invitation.';
  } finally {
    loading.value = false;
  }
});

async function onSubmit() {
  error.value = null;
  if (password.value !== confirm.value) {
    error.value = 'Passwords do not match';
    return;
  }
  submitting.value = true;
  try {
    await acceptInvite(token.value, password.value);
    router.push('/dashboard');
  } catch (e) {
    error.value = e instanceof AuthError ? e.message : 'Could not accept the invitation.';
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="login-shell">
    <div class="login-card">
      <h1>Accept your invitation</h1>

      <p v-if="loading" class="muted">Loading invitation…</p>

      <div v-else-if="loadError" class="banner err">{{ loadError }}</div>

      <form v-else @submit.prevent="onSubmit">
        <p class="muted">
          You're joining <strong>Taxscan Push</strong> as
          <strong>{{ invite?.role === 'ADMIN' ? 'an administrator' : 'a publisher' }}</strong
          ><span v-if="invite"> ({{ invite.email }})</span>. Choose a password to activate
          your account.
        </p>
        <p class="muted" style="font-size: 12px">
          At least 12 characters. Must include a lowercase letter, an uppercase letter, and a
          digit.
        </p>

        <div class="form-row">
          <label for="ai-pw">Password</label>
          <input
            id="ai-pw"
            v-model="password"
            type="password"
            autocomplete="new-password"
            required
            autofocus
          />
        </div>
        <div class="form-row">
          <label for="ai-conf">Confirm password</label>
          <input
            id="ai-conf"
            v-model="confirm"
            type="password"
            autocomplete="new-password"
            required
          />
        </div>

        <div v-if="error" class="banner err">{{ error }}</div>

        <div class="form-row" style="display: flex; justify-content: flex-end">
          <button type="submit" class="btn btn-primary" :disabled="!canSubmit">
            {{ submitting ? 'Activating…' : 'Activate account' }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>
