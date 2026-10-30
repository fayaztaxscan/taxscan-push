<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuth } from '../composables/useAuth';

const router = useRouter();
const route = useRoute();
const { user, logout } = useAuth();

// Mobile menu toggle. On desktop the menu is always visible (CSS
// `display: contents`), so this only matters at narrow widths.
const menuOpen = ref(false);
function closeMenu() {
  menuOpen.value = false;
  adminOpen.value = false;
}

// Channel groups. The active route's group label is emphasised.
const PUSH_PATHS = ['/compose', '/review', '/queue', '/campaigns'];
const EMAIL_PATHS = ['/digests', '/ads', '/templates'];
const ADMIN_PATHS = ['/users', '/activity'];
function inGroup(paths: string[]): boolean {
  return paths.some((p) => route.path === p || route.path.startsWith(p + '/'));
}
const pushActive = computed(() => inGroup(PUSH_PATHS));
const emailActive = computed(() => inGroup(EMAIL_PATHS));
const adminActive = computed(() => inGroup(ADMIN_PATHS));
const isAdmin = computed(() => user.value?.role === 'ADMIN');

// Admin disclosure (desktop). Closes on Escape (focus back to the button),
// outside click and route change.
const adminOpen = ref(false);
const adminRoot = ref<HTMLElement | null>(null);
const adminButton = ref<HTMLButtonElement | null>(null);
function onDocClick(e: MouseEvent) {
  if (adminOpen.value && adminRoot.value && !adminRoot.value.contains(e.target as Node)) {
    adminOpen.value = false;
  }
}
function onDocKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && adminOpen.value) {
    adminOpen.value = false;
    adminButton.value?.focus();
  }
}
onMounted(() => {
  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onDocKey);
});
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick);
  document.removeEventListener('keydown', onDocKey);
});
watch(
  () => route.fullPath,
  () => {
    adminOpen.value = false;
  },
);

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
      <router-link to="/dashboard" class="nav-first" @click="closeMenu">Dashboard</router-link>
      <span class="nav-label" :class="{ active: pushActive }" data-group="push">Push</span>
      <router-link to="/compose" @click="closeMenu">Compose</router-link>
      <router-link to="/review" @click="closeMenu">Review</router-link>
      <router-link to="/queue" @click="closeMenu">Queue</router-link>
      <router-link to="/campaigns" @click="closeMenu">Campaigns</router-link>
      <span class="nav-label" :class="{ active: emailActive }" data-group="email">Email</span>
      <router-link to="/digests" @click="closeMenu">Digests</router-link>
      <router-link to="/ads" @click="closeMenu">Ads</router-link>
      <router-link to="/templates" @click="closeMenu">Templates</router-link>
      <router-link to="/reports" class="nav-after-group" @click="closeMenu">Reports</router-link>
      <div v-if="isAdmin" ref="adminRoot" class="nav-admin">
        <span class="nav-label nav-admin-heading" :class="{ active: adminActive }" data-group="admin"
          >Admin</span
        >
        <button
          ref="adminButton"
          type="button"
          class="nav-admin-btn"
          :class="{ active: adminActive }"
          aria-controls="nav-admin-menu"
          :aria-expanded="adminOpen"
          @click="adminOpen = !adminOpen"
        >
          Admin <span aria-hidden="true">▾</span>
        </button>
        <div id="nav-admin-menu" class="nav-admin-panel" :class="{ open: adminOpen }">
          <router-link to="/users" @click="closeMenu">Users</router-link>
          <router-link to="/activity" @click="closeMenu">Activity</router-link>
        </div>
      </div>
      <span class="spacer" />
      <span v-if="user" class="nav-user">
        <span class="nav-email">{{ user.email }}</span>
        <span class="role-badge" :class="user.role.toLowerCase()">{{ user.role }}</span>
      </span>
      <router-link to="/guide" class="nav-secondary" @click="closeMenu">Guide</router-link>
      <router-link to="/change-password" class="nav-secondary" @click="closeMenu"
        >Change password</router-link
      >
      <button class="logout" @click="onLogout">Log out</button>
    </div>
  </nav>
</template>
