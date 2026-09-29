import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Frontend unit tests (vitest + jsdom).
 *
 * The axios wrapper (src/lib/api) is always mocked in tests — no live backend,
 * no real network. See src/test/*.test.tsx.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@botflow/shared': path.resolve(dirname, '../shared/src/index.ts'),
      '@': path.resolve(dirname, 'src'),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
