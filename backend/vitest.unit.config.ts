import { defineConfig } from 'vitest/config';

/**
 * DB-FREE unit tests.
 *
 * The default backend config (vitest.config.ts) is for INTEGRATION tests: it has
 * a `globalSetup` that creates and migrates a real PostgreSQL database, and it
 * includes `tests/**\/*.test.ts`. Pure functions — like the entitlement merge —
 * must not pay that cost, so they live under `tests/unit/**` and run through this
 * separate, narrowly-scoped config instead of changing the integration one.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    fileParallelism: false,
    pool: 'forks',
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      // Satisfies config/env's schema. Nothing connects: the db modules are
      // mocked in the unit tests themselves.
      DATABASE_URL: 'postgresql://unit:unit@localhost:5432/unit_tests_not_used',
      REDIS_URL: 'redis://localhost:6379',
    },
  },
});
