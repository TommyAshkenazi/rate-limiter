import type { RateLimitPolicy } from '../../types';
import type { ResolvedEngineOptions } from '../engine-options';
import { UnknownTenantError } from '../errors';
import { compilePolicy } from '../policies/compile-policy';
import type { CompiledPolicy } from '../policies/compiled-policy';
import { TenantRuntime } from './tenant-runtime';

/**
 * All known tenants. Handles configuration updates and auto-provisioning of
 * unknown tenants from the default template (capped, since tenantId comes from callers).
 */
export class TenantRegistry {
  private readonly tenants = new Map<string, TenantRuntime>();
  private dynamicTenants = 0;

  constructor(private readonly options: ResolvedEngineOptions) {
    // Validate the template eagerly so a bad config fails at boot, not on the first unknown tenant.
    options.defaultTenantPolicies?.forEach((p) => compilePolicy({ ...p, tenantId: '__template__' }, options));
  }

  has(tenantId: string): boolean {
    return this.tenants.has(tenantId);
  }

  all(): IterableIterator<TenantRuntime> {
    return this.tenants.values();
  }

  /** For admin/metrics calls: never auto-provisions. */
  getOrThrow(tenantId: string): TenantRuntime {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) throw new UnknownTenantError(tenantId);
    return tenant;
  }

  /** For evaluation: known tenant, or a new one from the template if allowed. */
  resolve(tenantId: string): TenantRuntime {
    const existing = this.tenants.get(tenantId);
    if (existing) return existing;

    const template = this.options.defaultTenantPolicies;
    if (!template || this.dynamicTenants >= this.options.maxDynamicTenants) throw new UnknownTenantError(tenantId);

    const runtime = new TenantRuntime(tenantId, true);
    runtime.policies = clientPoliciesFirst(template.map((p) => compilePolicy({ ...p, tenantId }, this.options)));
    this.tenants.set(tenantId, runtime);
    this.dynamicTenants++;
    return runtime;
  }

  /**
   * Atomically replace a tenant's policy set: everything is compiled first, so an invalid
   * policy leaves the old set untouched. Buckets survive when id + algorithm are unchanged.
   */
  setPolicies(tenantId: string, policies: RateLimitPolicy[]): void {
    const runtime = this.tenants.get(tenantId);
    const previous = new Map(runtime?.policies.map((c) => [c.policy.id, c]) ?? []);
    const ids = new Set<string>();

    const compiled = policies.map((p) => {
      if (ids.has(p.id)) throw new Error(`duplicate policy id ${p.id} for tenant ${tenantId}`);
      ids.add(p.id);
      const old = previous.get(p.id);
      const reuse = old && old.policy.algorithm === p.algorithm ? old.store : undefined;
      return compilePolicy({ ...p, tenantId }, this.options, reuse);
    });

    if (runtime) {
      runtime.policies = clientPoliciesFirst(compiled);
    } else {
      const created = new TenantRuntime(tenantId, false);
      created.policies = clientPoliciesFirst(compiled);
      this.tenants.set(tenantId, created);
    }
  }
}

/**
 * Client policies are checked before tenant pools. Order only affects which reason is
 * reported, since every policy is checked before anything is consumed.
 */
function clientPoliciesFirst(policies: CompiledPolicy[]): CompiledPolicy[] {
  return policies.sort((a, b) => (a.scope === b.scope ? 0 : a.scope === 'client' ? -1 : 1));
}
