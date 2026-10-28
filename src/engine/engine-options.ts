import type { Clock } from '../clock';
import type { RateLimitPolicy } from '../types';
import type { StoreFullBehaviour } from './storage/store-options';

/** A policy without a tenant, instantiated for tenants that were never configured. */
export type PolicyTemplate = Omit<RateLimitPolicy, 'tenantId'>;

/** Constructor options of RateLimiterEngine. Everything is optional. */
export interface EngineOptions {
  clock?: Clock;
  /** Per-policy cap on tracked keys when the policy doesn't set maxTrackedKeys. */
  defaultMaxTrackedKeys?: number;
  onStoreFull?: StoreFullBehaviour;
  /** Policies instantiated for tenants that were never configured. Omit to reject unknown tenants. */
  defaultTenantPolicies?: PolicyTemplate[];
  /** Upper bound on tenants auto-created from the template (tenantId is caller-controlled). */
  maxDynamicTenants?: number;
  sweepIntervalMs?: number;
  /** Max entries processed per store per sweep tick, so a sweep never stalls the event loop. */
  sweepBudget?: number;
}

/** EngineOptions with defaults filled in. */
export interface ResolvedEngineOptions {
  defaultMaxTrackedKeys: number;
  onStoreFull: StoreFullBehaviour;
  defaultTenantPolicies?: PolicyTemplate[];
  maxDynamicTenants: number;
  sweepIntervalMs: number;
  sweepBudget: number;
}

export function resolveEngineOptions(options: EngineOptions): ResolvedEngineOptions {
  return {
    defaultMaxTrackedKeys: options.defaultMaxTrackedKeys ?? 1_000_000,
    onStoreFull: options.onStoreFull ?? 'evict-lru',
    defaultTenantPolicies: options.defaultTenantPolicies,
    maxDynamicTenants: options.maxDynamicTenants ?? 1_000,
    sweepIntervalMs: options.sweepIntervalMs ?? 5_000,
    sweepBudget: options.sweepBudget ?? 50_000,
  };
}
