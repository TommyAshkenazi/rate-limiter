import { Router } from 'express';

/** GET /healthz — liveness probe for Docker / Kubernetes. */
export function healthRoutes(): Router {
  const router = Router();
  router.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });
  return router;
}
