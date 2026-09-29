import type { NextFunction, Request, Response } from 'express';
import type { ZodTypeAny, z } from 'zod';
interface ValidateOptions {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

/**
 * Validates and COERCES request input with zod.
 *
 * The parsed result replaces `req.body` / `req.query` / `req.params` so
 * downstream handlers work with typed, sanitised data — unknown keys are
 * stripped, which is our first line of defence against mass-assignment.
 */
export function validate(schemas: ValidateOptions) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    req.validated ??= {};

    try {
      if (schemas.body) {
        const parsed = schemas.body.parse(req.body ?? {});
        req.body = parsed;
        req.validated.body = parsed;
      }

      if (schemas.query) {
        const parsed = schemas.query.parse(req.query ?? {});
        // Express 4 exposes req.query as a getter on some setups — assign defensively.
        Object.defineProperty(req, 'query', { value: parsed, writable: true, configurable: true });
        req.validated.query = parsed;
      }

      if (schemas.params) {
        const parsed = schemas.params.parse(req.params ?? {});
        req.params = parsed as Request['params'];
        req.validated.params = parsed;
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Typed accessor for a validated body. */
export function bodyOf<T extends ZodTypeAny>(req: Request, _schema: T): z.infer<T> {
  return req.body as z.infer<T>;
}
