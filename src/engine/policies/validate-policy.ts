import { PolicyValidationError } from '../../algorithms';
import type { KeyDimension, RateLimitPolicy } from '../../types';

const DIMENSIONS: ReadonlySet<KeyDimension> = new Set(['ip', 'userId', 'route', 'header']);

/**
 * Structural checks on a policy's key strategy. Algorithm parameters (capacity,
 * rates, windows) are checked by createAlgorithm(). Throws PolicyValidationError.
 */
export function validatePolicy(policy: RateLimitPolicy): void {
  if (!policy || typeof policy.id !== 'string' || !policy.id) throw new PolicyValidationError('policy.id is required');

  const dims = policy.keyStrategy?.dimensions;
  if (!Array.isArray(dims)) throw new PolicyValidationError(`policy ${policy.id}: keyStrategy.dimensions must be an array`);
  for (const d of dims) {
    if (!DIMENSIONS.has(d)) throw new PolicyValidationError(`policy ${policy.id}: unknown dimension ${String(d)}`);
  }
  if (dims.includes('header') && !policy.keyStrategy.headerName) {
    throw new PolicyValidationError(`policy ${policy.id}: header dimension needs keyStrategy.headerName`);
  }

  const v6 = policy.keyStrategy.ipv6SubnetMask;
  if (v6 !== undefined && (!Number.isInteger(v6) || v6 < 0 || v6 > 128)) {
    throw new PolicyValidationError(`policy ${policy.id}: ipv6SubnetMask must be 0..128`);
  }
  const v4 = policy.keyStrategy.ipv4SubnetMask;
  if (v4 !== undefined && (!Number.isInteger(v4) || v4 < 0 || v4 > 32)) {
    throw new PolicyValidationError(`policy ${policy.id}: ipv4SubnetMask must be 0..32`);
  }
}
