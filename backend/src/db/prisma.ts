import { Prisma, PrismaClient } from '@prisma/client';
import { logger } from '../config/logger';
import { isProd } from '../config/env';

/**
 * Single PrismaClient for the whole process.
 * In dev, hot-reload (tsx watch) would otherwise open a new pool on every
 * file save and exhaust Postgres connections — so we cache on globalThis.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: isProd
      ? [{ emit: 'event', level: 'error' }]
      : [
          { emit: 'event', level: 'error' },
          { emit: 'event', level: 'warn' },
        ],
  });

prisma.$on('error' as never, (e: unknown) => {
  logger.error({ err: e }, 'prisma error');
});

if (!isProd) globalForPrisma.prisma = prisma;

/**
 * Run a callback inside a serializable transaction.
 * Used for every money movement so balances can never drift.
 */
export function transaction<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: { timeout?: number; maxWait?: number; retries?: number },
): Promise<T> {
  const timeout = options?.timeout ?? 15_000;
  const maxWait = options?.maxWait ?? 10_000;
  const retries = options?.retries ?? 0;

  let attempt = 0;

  const run = async (): Promise<T> => {
    try {
      return await prisma.$transaction(fn, { timeout, maxWait });
    } catch (err) {
      // P2034 = write conflict / deadlock → safe to retry
      const isWriteConflict =
        err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034';
      if (isWriteConflict && attempt < retries) {
        attempt += 1;
        await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
        return run();
      }
      throw err;
    }
  };

  return run();
}

/**
 * Atomically increment/decrement wallet balances with a raw UPDATE.
 * Using SQL arithmetic (rather than read-modify-write) prevents lost updates
 * when two requests touch the same wallet at the same moment.
 */
export async function incrementWallet(
  tx: Prisma.TransactionClient,
  userId: string,
  deltas: {
    available?: number;
    reserved?: number;
    pending?: number;
    totalDeposited?: number;
    totalSpent?: number;
    totalEarned?: number;
    totalWithdrawn?: number;
    totalRefunded?: number;
  },
): Promise<void> {
  const set: Prisma.Sql[] = [];
  const add = (col: string, val?: number) => {
    if (val === undefined || val === 0) return;
    set.push(Prisma.sql`"${Prisma.raw(col)}" = "${Prisma.raw(col)}" + ${val}`);
  };

  add('available_cents', deltas.available);
  add('reserved_cents', deltas.reserved);
  add('pending_cents', deltas.pending);
  add('total_deposited_cents', deltas.totalDeposited);
  add('total_spent_cents', deltas.totalSpent);
  add('total_earned_cents', deltas.totalEarned);
  add('total_withdrawn_cents', deltas.totalWithdrawn);
  add('total_refunded_cents', deltas.totalRefunded);

  if (set.length === 0) return;

  await tx.$executeRaw`
    UPDATE wallets
    SET ${Prisma.join(set, ', ')}, "version" = "version" + 1, "updated_at" = NOW()
    WHERE "user_id" = ${userId}
  `;
}

/** Read a wallet row with a row-level lock for the duration of the tx. */
export async function lockWallet(tx: Prisma.TransactionClient, userId: string) {
  const rows = await tx.$queryRaw<
    Array<{
      id: string;
      available_cents: number;
      reserved_cents: number;
      pending_cents: number;
      currency: string;
    }>
  >`
    SELECT id, available_cents, reserved_cents, pending_cents, currency
    FROM wallets WHERE user_id = ${userId} FOR UPDATE
  `;
  return rows[0] ?? null;
}

export { Prisma };
export type { PrismaClient };
