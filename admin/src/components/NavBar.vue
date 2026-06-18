<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuth } from '../composables/useAuth';

const router = useRouter();
const { user, logout } = useAuth();

// Mobile menu toggle. On desktop the menu is always visible (CSS
// `display: contents`), so this only matters at narrow widths.
const menuOpen = ref(false);
function closeMenu() {
  menuOpen.value = false;
}

async function onLogout() {
  closeMenu();
  await logout();
  router.push({ name: 'login' });
}
</script>

<template>
  <nav class="nav">
    <span class="brand">Taxscan Push</span>
    <button
      class="nav-toggle"
      type="button"
      :aria-expanded="menuOpen"
      aria-label="Toggle navigation menu"
      @click="menuOpen = !menuOpen"
    >
      <span aria-hidden="true">{{ menuOpen ? '✕' : '☰' }}</span>
    </button>
    <div class="nav-menu" :class="{ open: menuOpen }">
      <router-link to="/dashboard" @click="closeMenu">Dashboard</router-link>
      <router-link to="/compose" @click="closeMenu">Compose</router-link>
      <router-link to="/review" @click="closeMenu">Review</router-link>
      <router-link to="/queue" @click="closeMenu">Queue</router-link>
      <router-link to="/campaigns" @click="closeMenu">Campaigns</router-link>
      <router-link to="/activity" @click="closeMenu">Activity</router-link>
      <router-link v-if="user?.role === 'ADMIN'" to="/users" @click="closeMenu"
        >Users</router-link
      >
      <span class="spacer" />
      <span v-if="user" class="nav-user">
        <span class="nav-email">{{ user.email }}</span>
        <span class="role-badge" :class="user.role.toLowerCase()">{{ user.role }}</span>
      </span>
      <a
        href="/api/guide"
        target="_blank"
        rel="noopener"
        class="nav-secondary"
        @click="closeMenu"
        >Guide</a
      >
      <router-link to="/change-password" class="nav-secondary" @click="closeMenu"
        >Change password</router-link
      >
      <button class="logout" @click="onLogout">Log out</button>
    </div>
  </nav>
</template>
