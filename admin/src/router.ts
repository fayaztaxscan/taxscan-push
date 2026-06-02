import { createRouter, createWebHistory, type RouteLocationNormalized } from 'vue-router';
import { useAuth } from './composables/useAuth';
import Login from './views/Login.vue';
import Compose from './views/Compose.vue';
import Campaigns from './views/Campaigns.vue';
import Dashboard from './views/Dashboard.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', name: 'login', component: Login, meta: { public: true } },
    { path: '/', redirect: '/dashboard' },
    { path: '/dashboard', name: 'dashboard', component: Dashboard },
    { path: '/compose', name: 'compose', component: Compose },
    { path: '/campaigns', name: 'campaigns', component: Campaigns },
  ],
});

router.beforeEach((to: RouteLocationNormalized) => {
  const { isAuthed } = useAuth();
  if (to.meta.public) return true;
  if (!isAuthed.value) return { name: 'login', query: { next: to.fullPath } };
  return true;
});
