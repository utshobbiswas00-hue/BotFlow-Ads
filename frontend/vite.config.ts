import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));

// Alias @botflow/shared to the shared package SOURCE so the frontend can
// typecheck/build without a prior `npm run build -w @botflow/shared`.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@botflow/shared': path.resolve(dirname, '../shared/src/index.ts'),
      '@': path.resolve(dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    host: true,
  },
  preview: {
    port: 4173,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
});
