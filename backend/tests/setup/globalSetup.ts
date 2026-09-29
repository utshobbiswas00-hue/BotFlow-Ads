import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import {
  TEST_DATABASE_URL,
  databaseNameOf,
  describeTestDatabase,
  maintenanceUrlFor,
} from './testDatabase';

/**
 * Prepares the test database once per `npm test` run:
 *
 *   1. create the database if it does not exist yet
 *   2. apply every migration (`prisma migrate deploy`)
 *
 * Applying the real migrations — rather than `db push` — means the suite also
 * guards the migration history: if a migration is missing or does not match
 * schema.prisma, the tests fail before a single assertion runs.
 */
export default async function globalSetup(): Promise<void> {
  const dbName = databaseNameOf(TEST_DATABASE_URL);

  await ensureDatabaseExists(dbName);
  applyMigrations();

  // eslint-disable-next-line no-console
  console.log(`\n[test-db] ready at ${describeTestDatabase()}\n`);
}

async function ensureDatabaseExists(dbName: string): Promise<void> {
  const admin = new PrismaClient({
    datasources: { db: { url: maintenanceUrlFor(TEST_DATABASE_URL) } },
  });

  try {
    const rows = await admin.$queryRaw<Array<{ datname: string }>>`
      SELECT datname FROM pg_database WHERE datname = ${dbName}
    `;
    if (rows.length > 0) return;

    // Identifier cannot be parameterised — quote it instead of interpolating raw.
    await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
    // eslint-disable-next-line no-console
    console.log(`[test-db] created database "${dbName}"`);
  } catch (err) {
    throw new Error(
      `Could not reach PostgreSQL to prepare the test database (${describeTestDatabase()}).\n` +
        `Start it with "npm run infra:up" from the repo root, or set TEST_DATABASE_URL.\n` +
        `Original error: ${(err as Error).message}`,
    );
  } finally {
    await admin.$disconnect();
  }
}

function applyMigrations(): void {
  const backendDir = path.resolve(__dirname, '..', '..');
  const prismaBin = resolvePrismaBin(backendDir);

  execFileSync(prismaBin, ['migrate', 'deploy'], {
    cwd: backendDir,
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: 'pipe',
  });
}

function resolvePrismaBin(backendDir: string): string {
  const candidates = [
    path.resolve(backendDir, 'node_modules', '.bin', 'prisma'),
    path.resolve(backendDir, '..', 'node_modules', '.bin', 'prisma'),
  ];

  const found = candidates.find((c) => fs.existsSync(c));
  if (!found) {
    throw new Error(
      `prisma CLI not found. Looked in:\n  ${candidates.join('\n  ')}\nRun "npm install" first.`,
    );
  }
  return found;
}
