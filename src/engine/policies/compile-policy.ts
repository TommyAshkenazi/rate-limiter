import { createAlgorithm } from '../../algorithms';
import { compileRoutePattern } from '../../extractors/route';
import type { PolicyScope, RateLimitPolicy } from '../../types';
import { BucketStore } from '../storage/bucket-store';
import type { StoreFullBehaviour } from '../storage/store-options';
import type { CompiledPolicy } from './compiled-policy';
import { resolvePriorityWeights } from './priority';
import { validatePolicy } from './validate-policy';

export interface CompileOptions {
  defaultMaxTrackedKeys: number;
  onStoreFull: StoreFullBehaviour;
}

/**
 * Turn a policy from config into a CompiledPolicy. Throws on invalid input.
 * Pass `existing` to keep the buckets of a policy that is being updated in place.
 */
export function compilePolicy(policy: RateLimitPolicy, options: CompileOptions, existing?: BucketStore): CompiledPolicy {
  validatePolicy(policy);
  const algorithm = createAlgorithm(policy);
  const scope: PolicyScope = policy.scope ?? (policy.keyStrategy.dimensions.length === 0 ? 'tenant' : 'client');

  const storeOptions = {
    maxKeys: policy.maxTrackedKeys ?? options.defaultMaxTrackedKeys,
    ttlMs: algorithm.idleTtlMs,
    stateBytes: algorithm.stateBytes,
    onFull: options.onStoreFull,
  };
  let store = existing;
  if (store) store.reconfigure(storeOptions);
  else store = new BucketStore(storeOptions);

  return {
    policy,
    scope,
    algorithm,
    store,
    keySpec: {
      dimensions: policy.keyStrategy.dimensions,
      headerName: policy.keyStrategy.headerName,
      ipv6SubnetMask: policy.keyStrategy.ipv6SubnetMask ?? 64,
      ipv4SubnetMask: policy.keyStrategy.ipv4SubnetMask ?? 32,
    },
    methods: policy.match?.methods?.length ? new Set(policy.match.methods.map((m) => m.toUpperCase())) : null,
    routes: policy.match?.routes?.length ? policy.match.routes.map(compileRoutePattern) : null,
    weights: resolvePriorityWeights(policy, scope),
  };
}
