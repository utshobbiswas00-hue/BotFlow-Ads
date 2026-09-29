/**
 * Single source of truth for the test database URL.
 *
 * The integration tests exercise REAL money movement, so they run against a
 * real PostgreSQL database — never a mock and never SQLite. Point them
 * anywhere with `TEST_DATABASE_URL`; the default matches the docker-compose
 * Postgres in the repo root (`npm run infra:up`).
 *
 * The database itself is created and migrated automatically by globalSetup,
 * so `npm test` works on a clean machine with nothing but Postgres running.
 */

// `connection_limit` matters: the concurrency tests want several real
// transactions open at once. With Prisma's default pool they queue in Node
// instead of racing in Postgres, which would make a row-lock test pass for the
// wrong reason (and add a 10s pool timeout to the run).
const DEFAULT_TEST_DATABASE_URL =
  'postgresql://botflow:botflow_dev_pass@localhost:5432/botflow_ads_test?schema=public&connection_limit=10';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;

export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379';

/** Name of the database inside the URL (no leading slash). */
export function databaseNameOf(url: string): string {
  const parsed = new URL(url);
  const name = parsed.pathname.replace(/^\//, '');
  if (!name) throw new Error(`TEST_DATABASE_URL has no database name: ${url}`);
  return name;
}

/**
 * URL of the `postgres` maintenance database on the same server.
 * `CREATE DATABASE` cannot run against the database being created, so the
 * bootstrap connects here first.
 */
export function maintenanceUrlFor(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

export function describeTestDatabase(): string {
  const parsed = new URL(TEST_DATABASE_URL);
  return `${parsed.hostname}:${parsed.port || '5432'}/${databaseNameOf(TEST_DATABASE_URL)}`;
}
