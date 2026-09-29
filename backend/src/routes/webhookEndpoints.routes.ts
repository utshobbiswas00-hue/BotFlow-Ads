import { Router } from 'express';
import { z } from 'zod';
import { limiters } from '../middleware/rateLimit';
import { validate } from '../middleware/validate';
import { UnauthorizedError } from '../utils/errors';
import {
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  listWebhookDeliveries,
  listWebhookEndpoints,
  testWebhookEndpoint,
  updateWebhookEndpoint,
} from '../services/webhook.service';

/**
 * Advertiser webhook endpoint management (the Mini App side).
 *
 * Mounted under `/api` behind the router-level `telegramAuth()` in
 * routes/index.ts, so an endpoint can only ever be managed by the Telegram
 * session of its owner. The delivery machinery lives in
 * `services/webhook.service.ts`; this file is only the HTTP surface.
 *
 * The signing secret is returned exactly once, from POST /webhooks. No endpoint
 * below can read it back — a secret that is re-readable eventually ends up in a
 * screenshot.
 */

export const webhookEndpointsRouter = Router();

function requireUser(req: { user?: { id: string } }) {
  if (!req.user) throw new UnauthorizedError('Open the app from Telegram to continue.');
  return req.user;
}

/** GET /api/webhooks — the caller's endpoints (never the secret). */
webhookEndpointsRouter.get('/webhooks', async (req, res, next) => {
  try {
    const user = requireUser(req);
    res.json({ ok: true, data: { endpoints: await listWebhookEndpoints(user.id) } });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/webhooks — create an endpoint.
 *
 * 201 with `secret` in the body — the only time it is ever returned. The
 * response carries a note so the UI can say "copy it now".
 */
webhookEndpointsRouter.post(
  '/webhooks',
  limiters.auth,
  async (req, res, next) => {
    try {
      const user = requireUser(req);
      const { endpoint, secret } = await createWebhookEndpoint(user.id, req.body);
      res.status(201).json({
        ok: true,
        data: {
          endpoint,
          secret,
          note: 'Store this signing secret now — it is shown only once and cannot be read back.',
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /api/webhooks/deliveries — the caller's recent delivery log.
 *
 * Declared BEFORE `/webhooks/:id` so the literal path is not captured as an id.
 */
webhookEndpointsRouter.get(
  '/webhooks/deliveries',
  validate({
    query: z.object({
      endpointId: z.string().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }),
  }),
  async (req, res, next) => {
    try {
      const user = requireUser(req);
      const { endpointId, limit } = req.query as unknown as { endpointId?: string; limit: number };
      const deliveries = await listWebhookDeliveries(user.id, { endpointId, limit });
      res.json({ ok: true, data: { deliveries } });
    } catch (err) {
      next(err);
    }
  },
);

/** PATCH /api/webhooks/:id — change url/events/description, enable or disable. */
webhookEndpointsRouter.patch('/webhooks/:id', async (req, res, next) => {
  try {
    const user = requireUser(req);
    const endpoint = await updateWebhookEndpoint(user.id, req.params.id as string, req.body);
    res.json({ ok: true, data: { endpoint } });
  } catch (err) {
    next(err);
  }
});

/** DELETE /api/webhooks/:id — remove the endpoint and its delivery history. */
webhookEndpointsRouter.delete('/webhooks/:id', async (req, res, next) => {
  try {
    const user = requireUser(req);
    res.json({ ok: true, data: await deleteWebhookEndpoint(user.id, req.params.id as string) });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/webhooks/:id/test — queue a `TEST` delivery.
 *
 * Exists so an integrator can prove reachability and signature validation
 * before real campaign events depend on the endpoint.
 */
webhookEndpointsRouter.post('/webhooks/:id/test', limiters.auth, async (req, res, next) => {
  try {
    const user = requireUser(req);
    res.json({ ok: true, data: await testWebhookEndpoint(user.id, req.params.id as string) });
  } catch (err) {
    next(err);
  }
});
