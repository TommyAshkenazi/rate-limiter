import type { DenyReason, TenantMetrics } from '../../types';
import type { TenantRuntime } from '../tenants/tenant-runtime';

/** Body of GET /v1/tenants/{tenantId}/metrics. */
export function computeTenantMetrics(tenant: TenantRuntime): TenantMetrics {
  let keys = 0;
  let bytes = tenant.isolation.estimatedBytes();
  for (const c of tenant.policies) {
    keys += c.store.size;
    bytes += c.store.estimatedBytes();
  }
  return {
    tenantId: tenant.tenantId,
    activeTrackedKeys: keys,
    totalEvaluations: tenant.counters.total,
    allowedCount: tenant.counters.allowed,
    blockedCount: tenant.counters.blocked,
    noisyNeighborsIsolated: tenant.isolation.isolatedTotal,
    currentMemoryEstimatedBytes: bytes,
  };
}

/** Raw numbers per tenant and policy, for the Prometheus exporter. */
export interface TenantSnapshot {
  tenantId: string;
  metrics: TenantMetrics;
  blockedByReason: Record<DenyReason, number>;
  policies: { id: string; keys: number; evictedExpired: number; evictedCapacity: number; rejectedNew: number }[];
}

export function snapshotTenant(tenant: TenantRuntime): TenantSnapshot {
  return {
    tenantId: tenant.tenantId,
    metrics: computeTenantMetrics(tenant),
    blockedByReason: { ...tenant.counters.blockedByReason },
    policies: tenant.policies.map((c) => ({
      id: c.policy.id,
      keys: c.store.size,
      evictedExpired: c.store.evictedExpired,
      evictedCapacity: c.store.evictedCapacity,
      rejectedNew: c.store.rejectedNew,
    })),
  };
}
