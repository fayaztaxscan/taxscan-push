import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// In dev (`vite` on :5173), base stays `/` and the Vite dev server proxies
// /api → :3000. In prod (`vite build`), base is `/admin/` so the built
// index.html references assets at /admin/assets/... — matching where Express
// serves them via app.use('/admin', express.static(adminDist)).
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/admin/' : '/',
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
}));
