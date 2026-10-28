import type { EvaluationResult } from '../../types';

export interface HeaderOptions {
  /** Legacy de-facto headers with an epoch Reset (what the task spec shows). Default true. */
  legacy?: boolean;
  /** IETF draft-ietf-httpapi-ratelimit-headers style: RateLimit-* with delta-seconds Reset + RateLimit-Policy. Default true. */
  standard?: boolean;
  nowMs?: number;
}

/**
 * Header values are always integers in *seconds*:
 * - X-RateLimit-Reset is an epoch timestamp (as in the spec),
 * - RateLimit-Reset and Retry-After are delta-seconds (RFC 9110 §10.2.3), rounded UP
 *   so a client that obeys them never retries a few ms too early and gets another 429.
 */
export function buildRateLimitHeaders(result: EvaluationResult, options: HeaderOptions = {}): Record<string, string> {
  const headers: Record<string, string> = {};
  if (result.policyId !== undefined) {
    // Prefer the engine's own delta; recompute only for results that crossed the wire.
    const deltaReset =
      result.resetInSeconds ?? Math.max(0, result.resetAt - Math.ceil((options.nowMs ?? Date.now()) / 1000));
    if (options.legacy !== false) {
      headers['X-RateLimit-Limit'] = String(result.limit);
      headers['X-RateLimit-Remaining'] = String(result.remaining);
      headers['X-RateLimit-Reset'] = String(result.resetAt);
    }
    if (options.standard !== false) {
      headers['RateLimit-Limit'] = String(result.limit);
      headers['RateLimit-Remaining'] = String(result.remaining);
      headers['RateLimit-Reset'] = String(deltaReset);
      headers['RateLimit-Policy'] = `${result.limit};w=${result.windowSeconds ?? 1}`;
    }
  }
  if (!result.allowed && result.retryAfterSeconds !== undefined) {
    headers['Retry-After'] = String(result.retryAfterSeconds);
  }
  return headers;
}
