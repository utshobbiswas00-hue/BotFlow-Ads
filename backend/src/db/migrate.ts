import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { logger } from '../config/logger';

/**
 * Apply pending Prisma migrations at process boot.
 *
 * Why this exists: the migrations used to run only through the
 * `start:api` / `start:worker` npm scripts. If the hosting dashboard's Start
 * Command is set to `node backend/dist/index.js` instead (which overrides
 * render.yaml), no migration ever runs and every query touching a new column
 * fails with SCHEMA_OUT_OF_DATE ("The app is being updated right now").
 *
 * Running the same idempotent `prisma migrate deploy` from inside the app makes
 * the schema correct no matter which command started the process. It takes a
 * Postgres advisory lock, so it is safe when the API and worker boot together,
 * and a no-op when the start script already applied everything.
 *
 * Set RUN_MIGRATIONS_ON_BOOT=false to turn it off.
 */
export function runMigrationsOnBoot(): void {
  if (process.env.RUN_MIGRATIONS_ON_BOOT === 'false' || process.env.NODE_ENV === 'test') {
    return;
  }

  let prismaCli: string;
  try {
    prismaCli = require.resolve('prisma/build/index.js');
  } catch {
    logger.error(
      'boot migrations skipped: the prisma CLI is not installed. Install with `npm ci --include=dev` ' +
        'or run `prisma migrate deploy` before starting.',
    );
    return;
  }

  // dist/db -> backend/prisma  (same relative layout under src/db when run with tsx)
  const schema = path.resolve(__dirname, '../../prisma/schema.prisma');

  logger.info('applying pending database migrations (prisma migrate deploy)');
  const result = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy', '--schema', schema], {
    encoding: 'utf8',
    env: process.env,
    timeout: 120_000,
  });

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (result.status === 0) {
    logger.info({ output: output.slice(-800) }, 'database migrations are up to date');
    return;
  }

  // Do not crash: the API can still serve routes that do not touch the missing
  // column. But say it loudly so the cause is obvious in the logs.
  logger.error(
    { status: result.status, output: output.slice(-2000) },
    'CRITICAL: prisma migrate deploy FAILED — the database schema is out of date',
  );
}
