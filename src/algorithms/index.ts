import type { RateLimitPolicy } from '../types';
import { LeakyBucket } from './leaky-bucket';
import { SlidingWindowCounter } from './sliding-window';
import { TokenBucket } from './token-bucket';
import type { RateLimitAlgorithm } from './types';

export * from './types';
export { LeakyBucket } from './leaky-bucket';
export { SlidingWindowCounter } from './sliding-window';
export { TokenBucket } from './token-bucket';

export class PolicyValidationError extends Error {}

function positive(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** Rate for bucket algorithms: explicit, or derived as capacity per window. */
function resolveRate(policy: RateLimitPolicy): number {
  if (positive(policy.refillRatePerSecond)) return policy.refillRatePerSecond;
  if (positive(policy.windowSizeSeconds)) return policy.capacity / policy.windowSizeSeconds;
  throw new PolicyValidationError(
    `policy ${policy.id}: ${policy.algorithm} needs refillRatePerSecond or windowSizeSeconds`,
  );
}

export function createAlgorithm(policy: RateLimitPolicy): RateLimitAlgorithm {
  if (!positive(policy.capacity)) {
    throw new PolicyValidationError(`policy ${policy.id}: capacity must be > 0`);
  }
  switch (policy.algorithm) {
    case 'token-bucket':
      return new TokenBucket(policy.capacity, resolveRate(policy));
    case 'leaky-bucket':
      return new LeakyBucket(policy.capacity, resolveRate(policy));
    case 'sliding-window':
      if (!positive(policy.windowSizeSeconds)) {
        throw new PolicyValidationError(`policy ${policy.id}: sliding-window needs windowSizeSeconds`);
      }
      return new SlidingWindowCounter(policy.capacity, policy.windowSizeSeconds);
    default:
      throw new PolicyValidationError(`policy ${policy.id}: unknown algorithm ${String(policy.algorithm)}`);
  }
}
