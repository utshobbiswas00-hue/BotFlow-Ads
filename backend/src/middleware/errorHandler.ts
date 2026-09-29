import type { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { isAppError } from '../utils/errors';
import { ERROR_CODES } from '../config/constants';
import { logger } from '../config/logger';
import { isProd } from '../config/env';

export interface ErrorBody {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

/** 404 fallback for unmatched routes. */
export function notFoundHandler(req: Request, res: Response): void {
  const body: ErrorBody = {
    ok: false,
    error: {
      code: ERROR_CODES.NOT_FOUND,
      message: `Route not found: ${req.method} ${req.path}`,
      requestId: req.ctx?.requestId,
    },
  };
  res.status(404).json(body);
}

/**
 * Central error translator.
 * Every failure leaves this function as a predictable JSON envelope so the
 * Mini App never has to guess at a response shape.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const requestId = req.ctx?.requestId;

  // ---- Known operational errors -------------------------------------
  if (isAppError(err)) {
    const status = err.statusCode;
    if (status >= 500) {
      logger.error({ err, requestId, path: req.path }, 'operational error (5xx)');
    } else {
      logger.warn({ code: err.code, message: err.message, requestId, path: req.path }, 'request rejected');
    }
    const body: ErrorBody = {
      ok: false,
      error: { code: err.code, message: err.message, details: err.details, requestId },
    };
    res.status(status).json(body);
    return;
  }

  // ---- Validation ---------------------------------------------------
  if (err instanceof ZodError) {
    const body: ErrorBody = {
      ok: false,
      error: {
        code: ERROR_CODES.VALIDATION_ERROR,
        message: 'Validation failed',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        requestId,
      },
    };
    res.status(422).json(body);
    return;
  }

  // ---- Prisma -------------------------------------------------------
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const mapped = mapPrismaError(err);
    logger.warn({ prismaCode: err.code, requestId, path: req.path }, 'prisma error');
    res.status(mapped.status).json({
      ok: false,
      error: { code: mapped.code, message: mapped.message, details: isProd ? undefined : err.meta, requestId },
    });
    return;
  }

  if (err instanceof Prisma.PrismaClientValidationError) {
    res.status(400).json({
      ok: false,
      error: { code: ERROR_CODES.VALIDATION_ERROR, message: 'Invalid data supplied', requestId },
    });
    return;
  }

  // ---- Payload / framework errors -----------------------------------
  const anyErr = err as { type?: string; status?: number; message?: string };

  if (anyErr?.type === 'entity.too.large') {
    res.status(413).json({
      ok: false,
      error: { code: ERROR_CODES.VALIDATION_ERROR, message: 'Request payload too large', requestId },
    });
    return;
  }

  if (anyErr?.type === 'entity.parse.failed') {
    res.status(400).json({
      ok: false,
      error: { code: ERROR_CODES.VALIDATION_ERROR, message: 'Malformed JSON body', requestId },
    });
    return;
  }

  // ---- Unknown ------------------------------------------------------
  logger.error({ err, requestId, path: req.path, method: req.method }, 'unhandled error');

  res.status(500).json({
    ok: false,
    error: {
      code: ERROR_CODES.INTERNAL_ERROR,
      message: isProd ? 'Something went wrong on our side' : (anyErr?.message ?? 'Internal error'),
      ...(isProd ? {} : { details: (err as Error)?.stack }),
      requestId,
    },
  });
}

/** Exported for tests: this mapping is the difference between an operator
 *  seeing "Database error" and knowing to run the migrations. */
export function mapPrismaError(err: Prisma.PrismaClientKnownRequestError): {
  status: number;
  code: string;
  message: string;
} {
  switch (err.code) {
    case 'P2002': {
      const target = (err.meta?.target as string[] | undefined)?.join(', ') ?? 'field';
      return { status: 409, code: ERROR_CODES.CONFLICT, message: `A record with this ${target} already exists` };
    }
    case 'P2003':
      return { status: 400, code: ERROR_CODES.VALIDATION_ERROR, message: 'Related record does not exist' };
    case 'P2025':
      return { status: 404, code: ERROR_CODES.NOT_FOUND, message: 'Record not found' };
    case 'P2034':
      return { status: 409, code: ERROR_CODES.CONFLICT, message: 'Write conflict, please retry' };
    // P2021 missing table / P2022 missing column. In practice this is always a
    // deploy that shipped code ahead of its migrations, which is a deploy
    // problem rather than a bad request — 503 says "try again shortly" and the
    // message names the fix instead of reading as a generic "Database error".
    // The prisma code itself is logged by the caller.
    case 'P2021':
    case 'P2022':
      // The caller logs the Prisma code and the raw message, which is where an
      // operator should read "run prisma migrate deploy". What travels back to
      // the client is read by whoever is holding the phone, and their only
      // useful move is to try again — so say that, and nothing about tooling.
      return {
        status: 503,
        code: ERROR_CODES.SCHEMA_OUT_OF_DATE,
        message: 'The app is being updated right now. Please try again in a minute.',
      };
    default:
      return { status: 500, code: ERROR_CODES.INTERNAL_ERROR, message: 'Database error' };
  }
}
