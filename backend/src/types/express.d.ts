import type { AuthAdmin, AuthUser, RequestContext } from './auth';

declare global {
  namespace Express {
    interface Request {
      /** Set by telegramAuth middleware. */
      user?: AuthUser;
      /** Set by adminAuth middleware (only for admin routes). */
      admin?: AuthAdmin;
      /** Set by requestId middleware. */
      ctx: RequestContext;
      /** Raw Telegram initData string for this request, if any. */
      initData?: string;
      /** Validated + parsed body/query, set by the validate middleware. */
      validated?: {
        body?: unknown;
        query?: unknown;
        params?: unknown;
      };
    }
  }
}

export {};
