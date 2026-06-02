<script setup lang="ts">
import { useRouter } from 'vue-router';
import { useAuth } from '../composables/useAuth';

const router = useRouter();
const { logout } = useAuth();

function onLogout() {
  logout();
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
    <button class="logout" @click="onLogout">Log out</button>
  </nav>
</template>
