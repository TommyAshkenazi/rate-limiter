import { Router } from 'express';
import type { RateLimiterEngine } from '../../engine/rate-limiter';
import { sendError } from '../responses/send-error';

/** GET /v1/tenants/{tenantId}/metrics — counters and memory estimate for one tenant. */
export function tenantMetricsRoutes(engine: RateLimiterEngine): Router {
  const router = Router();
  router.get('/v1/tenants/:tenantId/metrics', (req, res) => {
    const tenantId = req.params.tenantId as string;
    if (!engine.hasTenant(tenantId)) return sendError(res, 404, 'UNKNOWN_TENANT');
    res.json(engine.getTenantMetrics(tenantId));
  });
  return router;
}
