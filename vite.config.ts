import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// O servidor de ranking roda separado (npm run server). Em desenvolvimento,
// o Vite repassa /api para ele, assim o navegador usa sempre a mesma origem.
const apiTarget = process.env.EVORACE_API_PROXY ?? 'http://localhost:8787';

export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
  server: {
    port: 5173,
    proxy: { '/api': { target: apiTarget, changeOrigin: true } },
  },
  preview: {
    port: 4173,
    proxy: { '/api': { target: apiTarget, changeOrigin: true } },
  },
  build: { target: 'es2022', chunkSizeWarningLimit: 900 },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 60000,
  },
} as never);
