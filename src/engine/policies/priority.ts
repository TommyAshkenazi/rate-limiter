import type { PolicyScope, Priority, RateLimitPolicy } from '../../types';

/**
 * Default headroom ladder for tenant-wide pools: once the shared pool is >90% used,
 * background traffic is shed; above 95% standard traffic too; critical may use 100%.
 * This keeps the last slice of a tenant's capacity for critical requests even when
 * bulk jobs are hammering the same tenant.
 */
export const DEFAULT_TENANT_PRIORITY_WEIGHTS: Record<Priority, number> = {
  critical: 1,
  standard: 0.95,
  background: 0.9,
};

const NO_SHEDDING: Record<Priority, number> = { critical: 1, standard: 1, background: 1 };

/** Policy weights merged over the defaults for its scope; each must be in [0, 1]. */
export function resolvePriorityWeights(policy: RateLimitPolicy, scope: PolicyScope): Record<Priority, number> {
  const base = scope === 'tenant' ? DEFAULT_TENANT_PRIORITY_WEIGHTS : NO_SHEDDING;
  const merged = { ...base, ...(policy.priorityWeights ?? {}) };
  for (const p of Object.keys(merged) as Priority[]) {
    const w = merged[p];
    if (!Number.isFinite(w) || w < 0 || w > 1) throw new Error(`policy ${policy.id}: priority weight ${p} must be in [0,1]`);
  }
  return merged;
}

/** Units of `capacity` a request of this priority must leave untouched. */
export function reserveFor(capacity: number, weights: Record<Priority, number>, priority: Priority): number {
  return capacity * (1 - weights[priority]);
}
