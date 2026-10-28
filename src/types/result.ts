/** Why a request was rejected. */
export type DenyReason = 'TENANT_QUOTA_EXCEEDED' | 'CLIENT_KEY_EXCEEDED' | 'NOISY_NEIGHBOR_THROTTLED';

/** The decision for one request (the spec's RateLimitResult). */
export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number; // Unix timestamp in seconds
  retryAfterSeconds?: number;
  reason?: DenyReason;
}

/** extension: what the engine returns internally — the spec result plus diagnostics. */
export interface EvaluationResult extends RateLimitResult {
  /** The policy whose numbers are reported in the headers. Undefined when no policy matched. */
  policyId?: string;
  /** Window (seconds) of the reported policy, used for the RateLimit-Policy header. */
  windowSeconds?: number;
  /** Delta-seconds until `resetAt`, computed from the same milliseconds (no double rounding). */
  resetInSeconds?: number;
}
