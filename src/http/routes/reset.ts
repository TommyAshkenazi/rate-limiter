import { Router, type RequestHandler } from 'express';
import { UnknownTenantError, type RateLimiterEngine, type ResetSelector } from '../../engine/rate-limiter';
import { sendError } from '../responses/send-error';
import { validateResetBody } from '../validation/reset-body';

/** POST /v1/rate-limit/reset (admin) — clear buckets of a tenant / policy / key. */
export function resetRoutes(engine: RateLimiterEngine, adminOnly: RequestHandler): Router {
  const router = Router();

  router.post('/v1/rate-limit/reset', adminOnly, (req, res) => {
    const problem = validateResetBody(req.body);
    if (problem) return sendError(res, 400, 'INVALID_REQUEST', problem);
    try {
      const removed = engine.reset(req.body as ResetSelector);
      res.json({ tenantId: req.body.tenantId, removedBuckets: removed });
    } catch (err) {
      if (err instanceof UnknownTenantError) return sendError(res, 404, 'UNKNOWN_TENANT');
      throw err;
    }
  });

  return router;
}
