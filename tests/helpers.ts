import { ManualClock } from '../src/clock';
import { RateLimiterEngine, type EngineOptions } from '../src/engine/rate-limiter';
import type { RateLimitPolicy, RequestContext } from '../src/types';

export type PolicyInput = Omit<RateLimitPolicy, 'tenantId' | 'name'> & { name?: string };

export function policy(p: PolicyInput): RateLimitPolicy {
  return { name: p.id, tenantId: '', ...p };
}

/** A tenant-wide pool large enough to never interfere unless a test wants it to. */
export const bigTenantPool = policy({
  id: 'tenant-pool',
  algorithm: 'token-bucket',
  capacity: 1_000_000,
  refillRatePerSecond: 1_000_000,
  keyStrategy: { dimensions: [] },
});

export function setup(
  tenants: Record<string, PolicyInput[]>,
  options: Omit<EngineOptions, 'clock'> = {},
): { engine: RateLimiterEngine; clock: ManualClock } {
  const clock = new ManualClock();
  const engine = new RateLimiterEngine({ ...options, clock });
  for (const [tenantId, policies] of Object.entries(tenants)) {
    engine.setTenantPolicies(tenantId, policies.map(policy));
  }
  return { engine, clock };
}

export function req(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    tenantId: 't1',
    clientIp: '203.0.113.10',
    route: '/api/items',
    method: 'GET',
    headers: {},
    ...overrides,
  };
}

export function times<T>(n: number, fn: (i: number) => T): T[] {
  return Array.from({ length: n }, (_, i) => fn(i));
}
