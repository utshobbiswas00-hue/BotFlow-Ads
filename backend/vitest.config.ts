import { defineConfig } from 'vitest/config';
import { TEST_DATABASE_URL, TEST_REDIS_URL } from './tests/setup/testDatabase';

/**
 * Backend test configuration.
 *
 * These are INTEGRATION tests: they drive the real services against a real
 * PostgreSQL database, because the guarantees under test (row-level locking,
 * unique ledger references, transaction rollback) do not exist in a mock.
 *
 * Requirements: a running PostgreSQL. Everything else — creating the test
 * database and applying migrations — is done by tests/setup/globalSetup.ts.
 *   `npm run infra:up`  (repo root, docker compose)
 *   `npm test`
 *
 * Test files run one at a time in a single process: they share one database,
 * and each file truncates before it starts. Parallel files would delete each
 * other's fixtures.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Integration files under tests/, plus the co-located DB-backed service
    // tests under src/**/__tests__ that need the real database (for example
    // src/services/__tests__/aiAssistant.service.test.ts). Those are excluded
    // from the DB-free unit config, so they run here exactly once.
    include: ['tests/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
    globalSetup: ['./tests/setup/globalSetup.ts'],
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: process.env.LOG_LEVEL ?? 'silent',
      // The suite must never be able to touch the development database.
      DATABASE_URL: TEST_DATABASE_URL,
      REDIS_URL: TEST_REDIS_URL,
      TZ: 'Asia/Dhaka',
      JWT_SECRET: 'test_jwt_secret',
      ENCRYPTION_KEY: '0'.repeat(64),
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_WEBHOOK_SECRET: '',
    },
  },
});
