import { Router, type Response } from 'express';
import type { Clock } from '../../clock';
import { buildRateLimitHeaders } from '../../engine/output/headers';
import { UnknownTenantError, type RateLimiterEngine } from '../../engine/rate-limiter';
import { parseIp } from '../../extractors/ip-parse';
import type { EvaluationResult, FailMode, RequestContext } from '../../types';
import type { Logger } from '../logger';
import { toCheckResponseBody } from '../responses/check-response';
import { sendError } from '../responses/send-error';
import { validateCheckBody } from '../validation/check-body';

export interface CheckRouteDeps {
  engine: RateLimiterEngine;
  failMode: FailMode;
  clock: Clock;
  logger: Logger;
}

/** POST /v1/rate-limit/check — evaluate and consume. 200 when allowed, 429 when not. */
export function checkRoutes({ engine, failMode, clock, logger }: CheckRouteDeps): Router {
  const router = Router();

  router.post('/v1/rate-limit/check', (req, res) => {
    const problem = validateCheckBody(req.body);
    if (problem) return sendError(res, 400, 'INVALID_REQUEST', problem);
    const ctx = req.body as RequestContext;
    if (!parseIp(ctx.clientIp)) return sendError(res, 400, 'INVALID_CLIENT_IP');
    ctx.headers ??= {};

    let result: EvaluationResult;
    try {
      result = engine.evaluate(ctx);
    } catch (err) {
      if (err instanceof UnknownTenantError) return sendError(res, 404, 'UNKNOWN_TENANT');
      logger.error('rate limit evaluation failed', err);
      return respondDegraded(res, failMode);
    }

    res.set(buildRateLimitHeaders(result, { nowMs: clock.wallMs() }));
    res.status(result.allowed ? 200 : 429).json(toCheckResponseBody(result));
  });

  return router;
}

/** The limiter itself failed: FAIL_MODE decides whether callers see "allowed" or 503. */
function respondDegraded(res: Response, failMode: FailMode): void {
  res.setHeader('X-RateLimit-Degraded', `fail-${failMode}`);
  if (failMode === 'open') {
    res.status(200).json({ allowed: true, degraded: true });
  } else {
    res.status(503).set('Retry-After', '1').json({ allowed: false, degraded: true });
  }
}
