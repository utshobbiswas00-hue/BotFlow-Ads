import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';

/**
 * DB-FREE unit tests for the 5xx-only persistence added to the central error
 * handler (spec §84).
 *
 * The point of these tests is the LINE: a server fault is persisted, a client
 * mistake is not. Prisma is mocked — nothing connects — and the same fake
 * request/response pair is reused so the response behaviour can be asserted
 * alongside the log call.
 */
vi.mock('../../../db/prisma', () => ({
  prisma: {
    errorLog: { create: vi.fn(), count: vi.fn(), findMany: vi.fn() },
  },
  transaction: vi.fn(),
}));

import { prisma } from '../../../db/prisma';
import { errorHandler } from '../../../middleware/errorHandler';
import { AppError, InternalError, NotFoundError, ValidationError } from '../../../utils/errors';

const create = vi.mocked(prisma.errorLog.create);

function makeRes() {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res as unknown as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
}

function makeReq(path = '/api/thing'): Request {
  return {
    path,
    method: 'GET',
    baseUrl: '/api',
    route: { path: '/thing' },
    ctx: { requestId: 'req-1', ip: '1.2.3.4', userAgent: 'test', startedAt: 0 },
    user: { id: 'user-1' },
  } as unknown as Request;
}

const next = vi.fn() as unknown as NextFunction;

function known(code: string, meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError('db boom', {
    code,
    clientVersion: '5.22.0',
    meta,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  create.mockResolvedValue({} as never);
});

describe('errorHandler — persists 5xx / unhandled, never 4xx', () => {
  it('persists a 5xx AppError with its code and the route context', async () => {
    const res = makeRes();
    await errorHandler(new InternalError('the payment provider is down'), makeReq('/api/pay'), res, next);

    expect(create).toHaveBeenCalledTimes(1);
    const data = create.mock.calls[0][0].data as Record<string, unknown>;
    expect(data).toMatchObject({
      level: 'ERROR',
      source: 'HTTP',
      code: 'INTERNAL_ERROR',
      message: 'the payment provider is down',
      context: 'GET /api/thing',
      requestId: 'req-1',
      userId: 'user-1',
    });
    // Response is untouched: still a 500 envelope.
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('does NOT persist a 4xx app-error rejection (a 400 is not an incident)', async () => {
    const res422 = makeRes();
    await errorHandler(new ValidationError('bad input'), makeReq(), res422, next);
    expect(res422.status).toHaveBeenCalledWith(422);

    const res400 = makeRes();
    await errorHandler(new AppError('nope', 400), makeReq(), res400, next);
    expect(res400.status).toHaveBeenCalledWith(400);

    expect(create).not.toHaveBeenCalled();
  });

  it('does NOT persist a thrown ZodError (422)', async () => {
    const res = makeRes();
    await errorHandler(new ZodError([]), makeReq(), res, next);

    expect(create).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(422);
  });

  it('does NOT persist a Prisma 404 (P2025) but DOES persist a Prisma 5xx (P2021)', async () => {
    const notFoundRes = makeRes();
    await errorHandler(known('P2025'), makeReq(), notFoundRes, next);
    expect(create).not.toHaveBeenCalled();
    expect(notFoundRes.status).toHaveBeenCalledWith(404);

    const schemaRes = makeRes();
    await errorHandler(known('P2021'), makeReq(), schemaRes, next);
    expect(create).toHaveBeenCalledTimes(1);
    expect((create.mock.calls[0][0].data as Record<string, unknown>).source).toBe('DATABASE');
    expect((create.mock.calls[0][0].data as Record<string, unknown>).code).toBe('P2021');
    expect(schemaRes.status).toHaveBeenCalledWith(503);
  });

  it('persists an unhandled plain Error as HTTP/500 with the class name as code', async () => {
    const res = makeRes();
    await errorHandler(new Error('totally unexpected'), makeReq(), res, next);

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].data as Record<string, unknown>).toMatchObject({
      source: 'HTTP',
      code: 'Error',
      message: 'totally unexpected',
    });
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('does not throw out of the handler when the log write itself fails', async () => {
    create.mockRejectedValue(new Error('log db down'));

    const res = makeRes();
    await expect(
      errorHandler(new NotFoundError('x'), makeReq(), res, next),
    ).resolves.toBeUndefined();
    // 404 → no write even attempted; use a 500 to exercise the failing write.
    const res500 = makeRes();
    await expect(
      errorHandler(new InternalError('boom'), makeReq(), res500, next),
    ).resolves.toBeUndefined();
    expect(res500.status).toHaveBeenCalledWith(500);
  });
});
