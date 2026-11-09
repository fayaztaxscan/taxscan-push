<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuth } from '../composables/useAuth';
import { useNavSections } from '../composables/useNavSections';
import NavDropdown from './NavDropdown.vue';
import SectionTabs from './SectionTabs.vue';

/**
 * The admin menu: a top row of sections (Dashboard · Push · Social · Email · Reports, Admin ▾, who you are, Account ▾) and,
 * under it, a tab row with the screens of the section you are in. On a phone (720px and below, the same cut-off as the
 * content rules in app.css) the top row is the brand and a ☰ button; ☰ opens ONE list (every section with its screens
 * beneath it, then Admin, then Account) and the tab row stays under the bar. The desktop row and the phone list are two
 * different trees, so only one of them is ever in the page.
 */
const router = useRouter();
const route = useRoute();
const { user, logout } = useAuth();
const { sections, activeSection } = useNavSections();

const isAdmin = computed(() => user.value?.role === 'ADMIN');

function inGroup(paths: string[]): boolean {
  return paths.some((p) => route.path === p || route.path.startsWith(p + '/'));
}
const adminActive = computed(() => inGroup(['/users', '/activity']));
const accountActive = computed(() => inGroup(['/guide', '/change-password']));

// ---- Phone or not ---------------------------------------------------------------------------------------------------
const PHONE_QUERY = '(max-width: 720px)';
const phoneQuery = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(PHONE_QUERY) : null;
const isPhone = ref(phoneQuery?.matches === true);

// ---- Open/closed state: the phone list, and at most one dropdown ---------------------------------------------------
const menuOpen = ref(false);
type Drop = 'admin' | 'account';
const openDrop = ref<Drop | null>(null);
const toggleButton = ref<HTMLButtonElement | null>(null);

function closeAll() {
  menuOpen.value = false;
  openDrop.value = null;
}
function toggleDrop(which: Drop) {
  openDrop.value = openDrop.value === which ? null : which;
}
// A dropdown asks to close itself (outside click, Escape, focus left). Only if it is still the open one: clicking the OTHER
// button in the same event must not undo the dropdown that click just opened.
function closeDrop(which: Drop) {
  if (openDrop.value === which) openDrop.value = null;
}

function onPhoneChange(e: MediaQueryListEvent) {
  isPhone.value = e.matches;
  closeAll();
}
// Escape closes the phone list and gives focus back to ☰ (the dropdowns do the same for themselves).
function onDocKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && menuOpen.value) {
    menuOpen.value = false;
    toggleButton.value?.focus();
  }
}
onMounted(() => {
  phoneQuery?.addEventListener('change', onPhoneChange);
  document.addEventListener('keydown', onDocKey);
});
onBeforeUnmount(() => {
  phoneQuery?.removeEventListener('change', onPhoneChange);
  document.removeEventListener('keydown', onDocKey);
});

// ANY route change closes everything, including the browser's Back button (a click handler alone misses it).
watch(() => route.fullPath, closeAll);

async function onLogout() {
  closeAll();
  await logout();
  router.push({ name: 'login' });
}
</script>

<template>
  <header class="nav-shell">
    <nav class="nav" aria-label="Main">
      <span class="brand">Taxscan Push</span>

      <!-- Laptops and tablets: sections on the left, who you are + menus on the right. -->
      <div v-if="!isPhone" class="nav-menu">
        <router-link to="/dashboard" class="nav-link" @click="closeAll">Dashboard</router-link>
        <router-link
          v-for="s in sections"
          :key="s.key"
          :to="s.target"
          class="nav-link nav-section"
          :class="{ active: s.active }"
          :data-group="s.key"
          @click="closeAll"
          >{{ s.label }}</router-link
        >
        <router-link to="/reports" class="nav-link" @click="closeAll">Reports</router-link>
        <span class="spacer" />
        <NavDropdown
          v-if="isAdmin"
          id="nav-admin-menu"
          label="Admin"
          group="admin"
          :active="adminActive"
          :open="openDrop === 'admin'"
          @toggle="toggleDrop('admin')"
          @close="closeDrop('admin')"
        >
          <router-link to="/users" @click="closeAll">Users</router-link>
          <router-link to="/activity" @click="closeAll">Activity</router-link>
        </NavDropdown>
        <span v-if="user" class="nav-user">
          <span class="nav-email" :title="user.email">{{ user.email }}</span>
          <span class="role-badge" :class="user.role.toLowerCase()">{{ user.role }}</span>
        </span>
        <NavDropdown
          id="nav-account-menu"
          label="Account"
          group="account"
          :active="accountActive"
          :open="openDrop === 'account'"
          @toggle="toggleDrop('account')"
          @close="closeDrop('account')"
        >
          <!-- Only where the top row has had to drop the email (narrow tablets); app.css hides this line above that. -->
          <span v-if="user" class="nav-panel-email">{{ user.email }}</span>
          <router-link to="/guide" @click="closeAll">Guide</router-link>
          <router-link to="/change-password" @click="closeAll">Change password</router-link>
          <button type="button" class="logout" @click="onLogout">Log out</button>
        </NavDropdown>
      </div>

      <!-- Phones: ☰ and one list. -->
      <template v-else>
        <button
          ref="toggleButton"
          class="nav-toggle"
          type="button"
          :aria-expanded="menuOpen"
          aria-controls="nav-menu"
          aria-label="Toggle navigation menu"
          @click="menuOpen = !menuOpen"
        >
          <span aria-hidden="true">{{ menuOpen ? '✕' : '☰' }}</span>
        </button>
        <div v-if="menuOpen" id="nav-menu" class="nav-menu nav-menu-phone">
          <router-link to="/dashboard" class="nav-link" @click="closeAll">Dashboard</router-link>
          <div v-for="s in sections" :key="s.key" class="nav-group" role="group" :aria-labelledby="`nav-h-${s.key}`">
            <span :id="`nav-h-${s.key}`" class="nav-label" :class="{ active: s.active }" :data-group="s.key">{{
              s.label
            }}</span>
            <div class="nav-group-links">
              <router-link v-for="t in s.tabs" :key="t.to" :to="t.to" @click="closeAll">{{ t.label }}</router-link>
            </div>
          </div>
          <router-link to="/reports" class="nav-link" @click="closeAll">Reports</router-link>
          <div v-if="isAdmin" class="nav-group" role="group" aria-labelledby="nav-h-admin">
            <span id="nav-h-admin" class="nav-label" :class="{ active: adminActive }" data-group="admin">Admin</span>
            <div class="nav-group-links">
              <router-link to="/users" @click="closeAll">Users</router-link>
              <router-link to="/activity" @click="closeAll">Activity</router-link>
            </div>
          </div>
          <div class="nav-group" role="group" aria-labelledby="nav-h-account">
            <span id="nav-h-account" class="nav-label" :class="{ active: accountActive }" data-group="account"
              >Account</span
            >
            <span v-if="user" class="nav-user">
              <span class="nav-email">{{ user.email }}</span>
              <span class="role-badge" :class="user.role.toLowerCase()">{{ user.role }}</span>
            </span>
            <div class="nav-group-links">
              <router-link to="/guide" @click="closeAll">Guide</router-link>
              <router-link to="/change-password" @click="closeAll">Change password</router-link>
              <button type="button" class="logout" @click="onLogout">Log out</button>
            </div>
          </div>
        </div>
      </template>
    </nav>

    <!-- While ☰ is open the list already holds these screens, so the row steps aside rather than repeat under it. -->
    <SectionTabs v-if="activeSection && !menuOpen" :label="activeSection.label" :tabs="activeSection.tabs" />
  </header>
</template>
