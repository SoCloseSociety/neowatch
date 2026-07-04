import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const API_TARGET = process.env.API_TARGET || 'http://localhost:8787';

// Stamp the service-worker cache name with a unique per-build id so each deploy
// gets a fresh cache and `activate` purges the previous generation (no stale shell,
// no unbounded cache growth). public/sw.js is copied verbatim, so patch dist after.
function swVersionStamp() {
  return {
    name: 'sw-version-stamp',
    closeBundle() {
      const swPath = fileURLToPath(new URL('./dist/sw.js', import.meta.url));
      if (!existsSync(swPath)) return;
      const stamp = Date.now().toString(36);
      writeFileSync(swPath, readFileSync(swPath, 'utf8').replace(/__SW_VERSION__/g, stamp));
    },
  };
}

export default defineConfig({
  plugins: [react(), swVersionStamp()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5273,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
    },
  },
  build: {
    target: 'es2020',
    sourcemap: false,
  },
});
