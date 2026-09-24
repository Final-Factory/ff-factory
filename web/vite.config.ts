import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const backend = process.env.FF_SANDBOXES_BACKEND ?? 'http://localhost:8790';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    // The wire contract lives in ../shared; allow Vite to serve it if it ever gains runtime constants.
    fs: { allow: ['..'] },
    proxy: {
      '/api': { target: backend, changeOrigin: true },
      '/ws': { target: backend, ws: true, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
