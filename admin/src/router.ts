import { createRouter, createWebHistory, type RouteLocationNormalized } from 'vue-router';
import { useAuth } from './composables/useAuth';
import Login from './views/Login.vue';
import Compose from './views/Compose.vue';
import Campaigns from './views/Campaigns.vue';
import Dashboard from './views/Dashboard.vue';
import ChangePassword from './views/ChangePassword.vue';

// Vite injects BASE_URL to match vite.config.ts → `/` in dev, `/admin/`
// in prod build. Vue Router's base then matches the public path so links
// and navigation work transparently in both modes.
export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/login', name: 'login', component: Login, meta: { public: true } },
    {
      path: '/change-password',
      name: 'change-password',
      component: ChangePassword,
    },
    { path: '/', redirect: '/dashboard' },
    { path: '/dashboard', name: 'dashboard', component: Dashboard },
    { path: '/compose', name: 'compose', component: Compose },
    { path: '/campaigns', name: 'campaigns', component: Campaigns },
  ],
});

router.beforeEach(async (to: RouteLocationNormalized) => {
  const { user, isAuthed, ready, checkSession } = useAuth();

  // First navigation after page load / hard refresh — wait for the
  // server to validate the cookie before deciding where to send the user.
  if (!ready.value) {
    await checkSession();
  }

  if (to.meta.public) {
    // Already logged in? Bounce away from /login.
    if (isAuthed.value && to.name === 'login') {
      // If the temp-password reset flag is still set, take them to the
      // forced-change route; otherwise to the dashboard.
      return user.value?.passwordResetRequired
        ? { name: 'change-password' }
        : { name: 'dashboard' };
    }
    return true;
  }

  if (!isAuthed.value) {
    return { name: 'login', query: { next: to.fullPath } };
  }

  // Forced password change gate. Anyone whose row has
  // passwordResetRequired=true (set by /api/users/:id/reset-password)
  // is funnelled to /change-password and cannot navigate elsewhere
  // until they change it. The /change-password route is reachable so
  // they can complete the flow.
  if (user.value?.passwordResetRequired && to.name !== 'change-password') {
    return { name: 'change-password' };
  }

  return true;
});
