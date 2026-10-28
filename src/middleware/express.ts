import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { buildRateLimitHeaders } from '../engine/output/headers';
import { ClientIpResolver } from '../extractors/client-ip-resolver';
import type { EvaluationResult, FailMode, Priority, RequestContext } from '../types';
import { withTimeout } from './with-timeout';

/** Anything that can decide: the in-process engine, or a client for the remote service. */
export interface RateLimiterBackend {
  evaluate(ctx: RequestContext): EvaluationResult | Promise<EvaluationResult>;
}

export interface ExpressRateLimitOptions {
  limiter: RateLimiterBackend;
  tenantId: string | ((req: Request) => string);
  /** Return the authenticated principal, if your auth middleware ran first. */
  userId?: (req: Request) => string | undefined;
  priority?: (req: Request) => Priority | undefined;
  cost?: (req: Request) => number;
  /** Decides the client IP from the socket + proxy headers. Default trusts no proxy. */
  ipResolver?: ClientIpResolver;
  /** What to do when the limiter throws or times out. Default 'open'. */
  failMode?: FailMode;
  /** Only meaningful for async (remote) backends. Default 50ms. */
  timeoutMs?: number;
  onError?: (err: unknown) => void;
}

/**
 * Plug-and-play Express middleware:
 *   app.use(expressRateLimit({ limiter: engine, tenantId: 'org-acme-prod' }))
 */
export function expressRateLimit(options: ExpressRateLimitOptions): RequestHandler {
  const ipResolver = options.ipResolver ?? new ClientIpResolver();
  const failMode = options.failMode ?? 'open';
  const timeoutMs = options.timeoutMs ?? 50;

  return async (req: Request, res: Response, next: NextFunction) => {
    let result: EvaluationResult;
    try {
      const ctx: RequestContext = {
        tenantId: typeof options.tenantId === 'function' ? options.tenantId(req) : options.tenantId,
        clientIp: ipResolver.resolve(req.socket.remoteAddress, req.headers),
        userId: options.userId?.(req),
        route: req.originalUrl || req.url,
        method: req.method,
        headers: req.headers,
        priority: options.priority?.(req),
        cost: options.cost?.(req),
      };
      result = await withTimeout(options.limiter.evaluate(ctx), timeoutMs);
    } catch (err) {
      options.onError?.(err);
      res.setHeader('X-RateLimit-Degraded', `fail-${failMode}`);
      if (failMode === 'open') return next();
      res.setHeader('Retry-After', '1');
      res.status(503).json({ error: 'RATE_LIMITER_UNAVAILABLE' });
      return;
    }

    res.set(buildRateLimitHeaders(result));
    if (result.allowed) return next();
    res.status(429).json({
      allowed: false,
      limit: result.limit,
      remaining: result.remaining,
      resetAt: result.resetAt,
      retryAfterSeconds: result.retryAfterSeconds,
      reason: result.reason,
    });
  };
}
