import { clientIpKey } from '../../extractors/client-ip-key';
import type { CompiledPolicy } from '../policies/compiled-policy';
import type { TenantRuntime } from '../tenants/tenant-runtime';

export interface ResetSelector {
  tenantId: string;
  policyId?: string;
  /** Only delete buckets whose key contains all of these values. Omit to reset everything selected. */
  dimensions?: { ip?: string; userId?: string; route?: string };
}

/** Admin reset. Returns the number of buckets removed. O(keys) — never on the hot path. */
export function resetBuckets(tenant: TenantRuntime, selector: ResetSelector): number {
  const dims = selector.dimensions;
  const hasFilter = Boolean(dims && (dims.ip || dims.userId || dims.route));
  let removed = 0;

  for (const compiled of tenant.policies) {
    if (selector.policyId && compiled.policy.id !== selector.policyId) continue;
    if (!hasFilter) {
      removed += compiled.store.clear();
      continue;
    }
    // A policy that doesn't key on a requested dimension has nothing to reset for it.
    const required = requiredSegments(compiled, dims!);
    removed += compiled.store.deleteWhere((key) => {
      const segments = key.split('|');
      return required.every((r) => segments.includes(r));
    });
  }

  if (!hasFilter && !selector.policyId) tenant.isolation.clear();
  return removed;
}

/** The "name=value" key segments a bucket must contain to match the selector. */
function requiredSegments(compiled: CompiledPolicy, dims: NonNullable<ResetSelector['dimensions']>): string[] {
  const required: string[] = [];
  // The admin passes a raw IP; mask it the same way this policy does.
  if (dims.ip) required.push(`ip=${clientIpKey(dims.ip, compiled.keySpec.ipv6SubnetMask, compiled.keySpec.ipv4SubnetMask)}`);
  if (dims.userId) required.push(`user=${dims.userId}`);
  if (dims.route) required.push(`route=${dims.route}`);
  return required;
}
