import { Router } from 'express';
import { renderPrometheus } from '../../engine/output/prometheus';
import type { RateLimiterEngine } from '../../engine/rate-limiter';

/** GET /metrics — all tenants, Prometheus text format. */
export function prometheusRoutes(engine: RateLimiterEngine): Router {
  const router = Router();
  router.get('/metrics', (_req, res) => {
    res.type('text/plain; version=0.0.4').send(renderPrometheus(engine));
  });
  return router;
}
