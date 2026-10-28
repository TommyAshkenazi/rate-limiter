import { epochSecondsAfter, type Clock } from '../../clock';
import type { EvaluationResult } from '../../types';
import type { TenantRuntime } from '../tenants/tenant-runtime';
import { classifyDenial } from './deny-reason';
import type { PendingCheck } from './pending-check';

/**
 * Phase 2, at least one policy denied: consume NOTHING anywhere, record the
 * isolation episode, and report the denying policy with the longest wait.
 */
export function rejectDenied(
  tenant: TenantRuntime,
  checks: PendingCheck[],
  now: number,
  cost: number,
  clock: Clock,
): EvaluationResult {
  let clientDenied: PendingCheck | undefined;
  let tenantDenied: PendingCheck | undefined;
  let waitMs = 0;

  for (const c of checks) {
    // A denied request still counts as "use" for LRU purposes. Otherwise a blocked key
    // ages to the head of the LRU and a flood of fresh keys evicts it — handing the
    // abuser a brand-new quota.
    if (c.stored) c.compiled.store.touch(c.state, now);
    if (c.decision.allowed) continue;

    // The client can only succeed once EVERY denying policy has room again.
    waitMs = Math.max(waitMs, c.decision.retryAfterMs);
    if (c.compiled.scope === 'client') {
      tenant.isolation.recordDenial(`${c.compiled.policy.id}|${c.key}`, now, c.decision.retryAfterMs);
      if (!clientDenied || c.decision.retryAfterMs > clientDenied.decision.retryAfterMs) clientDenied = c;
    } else if (!tenantDenied || c.decision.retryAfterMs > tenantDenied.decision.retryAfterMs) {
      tenantDenied = c;
    }
  }

  const reported = (clientDenied ?? tenantDenied)!;
  const retryAfterSeconds = Math.max(1, Math.ceil(waitMs / 1000));
  return {
    allowed: false,
    limit: reported.compiled.algorithm.capacity,
    remaining: reported.decision.remaining,
    resetAt: epochSecondsAfter(clock, waitMs),
    resetInSeconds: retryAfterSeconds,
    retryAfterSeconds,
    reason: classifyDenial(reported, clientDenied !== undefined, now, cost),
    policyId: reported.compiled.policy.id,
    windowSeconds: reported.compiled.algorithm.windowSeconds,
  };
}
