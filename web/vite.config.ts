import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  resolve: { alias: { '@api': fileURLToPath(new URL('../src', import.meta.url)) } },
  build: { outDir: 'dist', emptyOutDir: true },
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:3000' } },
  preview: { port: 4173, proxy: { '/api': 'http://127.0.0.1:3000' } },
});
