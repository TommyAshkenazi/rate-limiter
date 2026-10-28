import { epochSecondsAfter, type Clock } from '../../clock';
import type { EvaluationResult } from '../../types';
import type { PendingCheck } from './pending-check';

/**
 * Phase 2, all policies allowed: consume from every one of them, store new buckets,
 * and report the most restrictive policy (lowest remaining, then latest reset).
 */
export function commitAllowed(checks: PendingCheck[], now: number, cost: number, clock: Clock): EvaluationResult {
  let reported: PendingCheck | undefined;
  for (const c of checks) {
    c.compiled.algorithm.consume(c.state, now, cost);
    if (c.isNew) c.compiled.store.insert(c.key, c.state, now);
    else c.compiled.store.touch(c.state, now);
    if (!reported || isTighter(c, reported)) reported = c;
  }

  if (!reported) {
    // No policy applies to this request: unlimited, no headers.
    return { allowed: true, limit: 0, remaining: 0, resetAt: epochSecondsAfter(clock, 0) };
  }
  return {
    allowed: true,
    limit: reported.compiled.algorithm.capacity,
    remaining: reported.decision.remaining,
    resetAt: epochSecondsAfter(clock, reported.decision.resetInMs),
    resetInSeconds: Math.ceil(reported.decision.resetInMs / 1000),
    policyId: reported.compiled.policy.id,
    windowSeconds: reported.compiled.algorithm.windowSeconds,
  };
}

function isTighter(a: PendingCheck, b: PendingCheck): boolean {
  if (a.decision.remaining !== b.decision.remaining) return a.decision.remaining < b.decision.remaining;
  return a.decision.resetInMs > b.decision.resetInMs;
}
