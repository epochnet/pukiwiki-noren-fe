import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@syntax': fileURLToPath(new URL('../../packages/syntax/src/index.ts', import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: { '/api': process.env.BFF_URL ?? 'http://127.0.0.1:18181' },
  },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 1500 },
});
