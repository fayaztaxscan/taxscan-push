<script setup lang="ts">
import { useRouter } from 'vue-router';
import { useAuth } from '../composables/useAuth';

const router = useRouter();
const { user, logout } = useAuth();

async function onLogout() {
  await logout();
  router.push({ name: 'login' });
}
</script>

<template>
  <nav class="nav">
    <span class="brand">Taxscan Push</span>
    <router-link to="/dashboard">Dashboard</router-link>
    <router-link to="/compose">Compose</router-link>
    <router-link to="/campaigns">Campaigns</router-link>
    <span class="spacer" />
    <span v-if="user" class="nav-user">
      <span class="nav-email">{{ user.email }}</span>
      <span class="role-badge" :class="user.role.toLowerCase()">{{ user.role }}</span>
    </span>
    <router-link to="/change-password" class="nav-secondary">Change password</router-link>
    <button class="logout" @click="onLogout">Log out</button>
  </nav>
</template>
