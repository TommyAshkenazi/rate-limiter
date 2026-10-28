import type { AlgorithmDecision } from '../../algorithms/types';
import { ExtractionContext } from '../../extractors/extraction-context';
import { buildKey } from '../../extractors/key-builder';
import { normalizeRoute } from '../../extractors/route';
import type { Priority, RequestContext } from '../../types';
import type { CompiledPolicy } from '../policies/compiled-policy';
import { matchPolicy } from '../policies/policy-match';
import { reserveFor } from '../policies/priority';
import type { TenantRuntime } from '../tenants/tenant-runtime';
import type { PendingCheck } from './pending-check';

/** Returned when a store is full and in reject-new mode. */
const STORE_FULL_DECISION: AlgorithmDecision = { allowed: false, remaining: 0, retryAfterMs: 1000, resetInMs: 1000 };

export interface CheckPhaseResult {
  checks: PendingCheck[];
  anyDenied: boolean;
}

/**
 * Phase 1: check every policy that applies to the request. NOTHING is consumed
 * and NO new bucket is stored here — that happens in phase 2, only if all allow.
 */
export function checkAllPolicies(tenant: TenantRuntime, ctx: RequestContext, now: number, cost: number): CheckPhaseResult {
  const priority: Priority = ctx.priority ?? 'standard';
  const method = (ctx.method || 'GET').toUpperCase();
  const route = normalizeRoute(ctx.route || '/');
  const extraction = new ExtractionContext(ctx, route, method);

  const checks: PendingCheck[] = [];
  let anyDenied = false;
  for (const compiled of tenant.policies) {
    const routeKey = matchPolicy(compiled, method, route);
    if (routeKey === undefined) continue;
    const key = buildKey(compiled.keySpec, extraction, routeKey);
    if (key === undefined) continue;

    const check = checkOne(compiled, key, now, cost, reserveFor(compiled.algorithm.capacity, compiled.weights, priority));
    if (!check.decision.allowed) anyDenied = true;
    checks.push(check);
  }
  return { checks, anyDenied };
}

function checkOne(compiled: CompiledPolicy, key: string, now: number, cost: number, reserve: number): PendingCheck {
  const existing = compiled.store.get(key);
  if (existing) {
    const decision = compiled.algorithm.check(existing, now, cost, reserve);
    return { compiled, key, state: existing, isNew: false, stored: true, decision, reserve };
  }

  // Unknown key: work on a fresh state that is NOT inserted yet, so a request
  // denied by another policy costs us no memory.
  const state = compiled.algorithm.createState(now);
  if (compiled.store.canAdmit(now)) {
    const decision = compiled.algorithm.check(state, now, cost, reserve);
    return { compiled, key, state, isNew: true, stored: false, decision, reserve };
  }
  compiled.store.rejectedNew++;
  return { compiled, key, state, isNew: false, stored: false, decision: STORE_FULL_DECISION, reserve };
}
