import type { DenyReason } from '../../types';
import type { PendingCheck } from './pending-check';

/**
 * Why was the request rejected?
 * - a client policy denied            -> CLIENT_KEY_EXCEEDED (the client's own quota; blamed first)
 * - a tenant pool denied, but would
 *   have allowed without the priority
 *   reserve                           -> NOISY_NEIGHBOR_THROTTLED (shed to protect higher priorities)
 * - a tenant pool is simply empty      -> TENANT_QUOTA_EXCEEDED
 */
export function classifyDenial(reported: PendingCheck, clientDenied: boolean, now: number, cost: number): DenyReason {
  if (clientDenied) return 'CLIENT_KEY_EXCEEDED';
  const fitsWithoutReserve =
    reported.reserve > 0 && reported.compiled.algorithm.check(reported.state, now, cost, 0).allowed;
  return fitsWithoutReserve ? 'NOISY_NEIGHBOR_THROTTLED' : 'TENANT_QUOTA_EXCEEDED';
}
