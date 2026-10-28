import type { EvaluationResult, RequestContext } from '../types';
import type { RateLimiterBackend } from './express';

/**
 * Calls a remote rate limiter service (this project's HTTP API) so many app
 * instances can share one limiter. Throws on network errors / timeouts / 5xx,
 * letting the middleware apply its fail-open or fail-closed policy.
 */
export class RemoteRateLimiterClient implements RateLimiterBackend {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 50,
  ) {}

  async evaluate(ctx: RequestContext): Promise<EvaluationResult> {
    const response = await fetch(`${this.baseUrl}/v1/rate-limit/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ctx),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (response.status !== 200 && response.status !== 429) {
      throw new Error(`rate limiter responded ${response.status}`);
    }
    const body = (await response.json()) as EvaluationResult;
    const window = /;w=(\d+)/.exec(response.headers.get('ratelimit-policy') ?? '');
    if (window) body.windowSeconds = Number(window[1]);
    return body;
  }
}
