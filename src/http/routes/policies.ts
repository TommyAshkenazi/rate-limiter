import { Router, type RequestHandler } from 'express';
import type { RateLimiterEngine } from '../../engine/rate-limiter';
import type { RateLimitPolicy } from '../../types';
import { sendError } from '../responses/send-error';
import { validatePoliciesBody } from '../validation/policies-body';

/**
 * GET /v1/tenants/{tenantId}/policies          — read a tenant's rules
 * PUT /v1/tenants/{tenantId}/policies (admin)  — replace them at runtime
 */
export function policyRoutes(engine: RateLimiterEngine, adminOnly: RequestHandler): Router {
  const router = Router();

  router.get('/v1/tenants/:tenantId/policies', (req, res) => {
    const tenantId = req.params.tenantId as string;
    const policies = engine.getTenantPolicies(tenantId);
    if (!policies) return sendError(res, 404, 'UNKNOWN_TENANT');
    res.json({ tenantId, policies });
  });

  router.put('/v1/tenants/:tenantId/policies', adminOnly, (req, res) => {
    const tenantId = req.params.tenantId as string;
    const problem = validatePoliciesBody(req.body);
    if (problem) return sendError(res, 400, 'INVALID_REQUEST', problem);
    try {
      engine.setTenantPolicies(tenantId, (req.body as { policies: RateLimitPolicy[] }).policies);
    } catch (err) {
      // Compilation is all-or-nothing: on any invalid policy the tenant keeps its old set.
      return sendError(res, 400, 'INVALID_POLICY', (err as Error).message);
    }
    res.json({ tenantId, policies: engine.getTenantPolicies(tenantId) });
  });

  return router;
}
