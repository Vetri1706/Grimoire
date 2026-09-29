import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: loadEnv(mode, '.', 'GRIMOIRE_').GRIMOIRE_API_PROXY || 'http://127.0.0.1:8080', changeOrigin: true } },
  },
}));
