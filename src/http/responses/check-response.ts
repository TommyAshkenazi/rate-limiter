import type { EvaluationResult } from '../../types';

/** Body of a check response: the spec's RateLimitResult (+ policyId for debugging). */
export function toCheckResponseBody(result: EvaluationResult): Record<string, unknown> {
  const body: Record<string, unknown> = {
    allowed: result.allowed,
    limit: result.limit,
    remaining: result.remaining,
    resetAt: result.resetAt,
  };
  if (result.retryAfterSeconds !== undefined) body.retryAfterSeconds = result.retryAfterSeconds;
  if (result.reason) body.reason = result.reason;
  if (result.policyId) body.policyId = result.policyId;
  return body;
}
