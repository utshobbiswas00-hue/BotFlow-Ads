import { Router } from 'express';
import type { CreateApiKeyInput } from '../services/apiKey.service';
import { createApiKey, listApiKeys, revokeApiKey } from '../services/apiKey.service';
import { limiters } from '../middleware/rateLimit';
import { validate } from '../middleware/validate';
import { UnauthorizedError } from '../utils/errors';
import { createApiKeySchema } from '@botflow/shared';

/**
 * User-facing API-key management (the Mini App side of programmatic access).
 *
 * Mounted under `/api` like every other user router, so every route here runs
 * behind telegramAuth — a key can only ever be managed by the Telegram
 * session of its owner. The public, key-authenticated surface lives in
 * `publicApi.routes.ts`.
 */

export const apiKeyRouter = Router();

function requireUser(req: { user?: { id: string } }) {
  if (!req.user) throw new UnauthorizedError('Open the app from Telegram to continue.');
  return req.user;
}

/** GET /api/keys — the user's keys. Secret material is never included. */
apiKeyRouter.get('/keys', async (req, res, next) => {
  try {
    const user = requireUser(req);
    res.json({ ok: true, data: { keys: await listApiKeys(user.id) } });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/keys — issue a new key.
 *
 * 201 with the plaintext key in the body — the ONLY time it is ever returned.
 * The response carries a note so the UI can say "copy it now".
 */
apiKeyRouter.post(
  '/keys',
  limiters.auth,
  validate({ body: createApiKeySchema }),
  async (req, res, next) => {
    try {
      const user = requireUser(req);
      const { key, record } = await createApiKey(user.id, req.body as CreateApiKeyInput);
      res.status(201).json({
        ok: true,
        data: {
          key,
          apiKey: record,
          note: 'Store this key now — it is shown only once and cannot be read back.',
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

/** DELETE /api/keys/:id — revoke (idempotent, never deletes). */
apiKeyRouter.delete('/keys/:id', async (req, res, next) => {
  try {
    const user = requireUser(req);
    const record = await revokeApiKey(user.id, req.params.id as string);
    res.json({ ok: true, data: { revoked: true, apiKey: record } });
  } catch (err) {
    next(err);
  }
});
