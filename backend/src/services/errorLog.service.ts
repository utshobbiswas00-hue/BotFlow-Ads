import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { logger } from '../config/logger';
import { isAppError } from '../utils/errors';
import { buildPaginated, type PaginatedResult, type Pagination } from '../utils/pagination';

/**
 * Persisted server-error records (spec §84).
 *
 * `recordError` is called from the CENTRAL error handler, so:
 *  - it MUST NOT throw. Failing to write the log must never replace the real
 *    error with a logging error, so every failure is swallowed after a log line.
 *  - it MUST NOT accept anything that could leak a secret. The input type has no
 *    field for headers, cookies, a request body or a raw query string, and the
 *    row is built field-by-field rather than by spreading the input — so even a
 *    caller that passes an untyped object carrying `headers` / `body` / `cookies`
 *    properties stores none of them. The one request-derived value kept, `context`,
 *    is sanitised below: everything from the first `?` is dropped, because query
 *    strings routinely carry reset tokens, API keys and email addresses.
 *
 * This is a persisted log of SERVER errors only. Read-side callers must not treat
 * it as a full request log — the api-logs view (spec §27) says the same thing.
 */

export const MAX_ERROR_MESSAGE_CHARS = 2000;
export const MAX_ERROR_CONTEXT_CHARS = 300;

/** The exact row shape `GET /api/admin/errors` returns (mirrors `ErrorLogRow`). */
export interface ErrorLogRow {
  id: string;
  level: string;
  source: string;
  code: string | null;
  message: string;
  context: string | null;
  requestId: string | null;
  userId: string | null;
  createdAt: Date;
}

/** Filter for the persisted-error list. */
export interface ErrorLogFilter {
  source?: string;
  level?: string;
  /** Inclusive lower bound on `createdAt`. */
  from?: Date;
  /** Exclusive upper bound on `createdAt`. */
  to?: Date;
}

/**
 * What a caller may hand `recordError`. Deliberately narrow: no `req`, no
 * headers, no cookies, no body, no query.
 */
export interface RecordErrorInput {
  /** ERROR (default) | WARN. */
  level?: string;
  /** HTTP | WORKER | TELEGRAM | PAYMENT | DATABASE | WEBHOOK. */
  source: string;
  /** AppError.code, the Prisma code, or the error class name. */
  code?: string | null;
  message: string;
  /** HTTP method + route pattern, or the job name. Query strings are stripped. */
  context?: string | null;
  requestId?: string | null;
  userId?: string | null;
}

/** Length-cap a value, preserving null. */
export function truncateErrorValue(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  return String(value).slice(0, max);
}

/**
 * Keep only the path part of a `context` value and cap its length. The `?` cut is
 * the important half: a route pattern never contains a query string, so anything
 * after the first `?` is caller-supplied data that must not be persisted.
 */
export function sanitizeErrorContext(context: string | null | undefined): string | null {
  if (context === null || context === undefined) return null;
  const withoutQuery = String(context).split('?')[0];
  return withoutQuery.slice(0, MAX_ERROR_CONTEXT_CHARS);
}

/**
 * Classify an error into an `ErrorLog.source` value. Prisma faults are DATABASE;
 * everything else this handler sees (AppError, ZodError, a plain Error) is HTTP.
 * Exported so the api-logs view can reuse the same rule instead of re-inventing it.
 */
export function classifyErrorSource(err: unknown): string {
  if (
    err instanceof Prisma.PrismaClientKnownRequestError ||
    err instanceof Prisma.PrismaClientValidationError ||
    err instanceof Prisma.PrismaClientInitializationError
  ) {
    return 'DATABASE';
  }
  return 'HTTP';
}

/** The greppable code for an error: AppError.code, the Prisma code, else the class name. */
export function classifyErrorCode(err: unknown): string | null {
  if (isAppError(err)) return err.code;
  if (err instanceof Prisma.PrismaClientKnownRequestError) return err.code;
  if (err instanceof Error && err.constructor?.name) return err.constructor.name;
  return null;
}

/**
 * Persist one error row. Never throws — see the file header for why. Returns
 * `true` when the row was written, `false` when the write failed, purely so tests
 * (and curious callers) can tell the two apart without a rejection.
 */
export async function recordError(input: RecordErrorInput): Promise<boolean> {
  try {
    await prisma.errorLog.create({
      // Built field-by-field on purpose — never `...input`. A caller cannot get
      // headers/cookies/body/query into the row by accident because there is no
      // code path that copies unknown keys across.
      data: {
        level: input.level ?? 'ERROR',
        source: input.source,
        code: truncateErrorValue(input.code ?? null, MAX_ERROR_CONTEXT_CHARS),
        message: String(input.message ?? '').slice(0, MAX_ERROR_MESSAGE_CHARS),
        context: sanitizeErrorContext(input.context),
        requestId: input.requestId ?? null,
        userId: input.userId ?? null,
      },
    });
    return true;
  } catch (err) {
    // Swallow: the real error is already on its way to the client. A broken log
    // must not become a second failure.
    logger.error(
      { err, source: input.source, code: input.code ?? null },
      'failed to persist error log (continuing)',
    );
    return false;
  }
}

/** Newest-first persisted errors, with optional source / level / date filters. */
export async function listErrorLogs(
  filter: ErrorLogFilter,
  p: Pagination,
): Promise<PaginatedResult<ErrorLogRow>> {
  const where: Prisma.ErrorLogWhereInput = {
    ...(filter.source ? { source: filter.source } : {}),
    ...(filter.level ? { level: filter.level } : {}),
    ...(filter.from || filter.to
      ? {
          createdAt: {
            ...(filter.from ? { gte: filter.from } : {}),
            ...(filter.to ? { lt: filter.to } : {}),
          },
        }
      : {}),
  };

  const [total, rows] = await Promise.all([
    prisma.errorLog.count({ where }),
    prisma.errorLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: p.skip,
      take: p.take,
      select: {
        id: true,
        level: true,
        source: true,
        code: true,
        message: true,
        context: true,
        requestId: true,
        userId: true,
        createdAt: true,
      },
    }),
  ]);

  return buildPaginated(rows as ErrorLogRow[], total, p);
}
