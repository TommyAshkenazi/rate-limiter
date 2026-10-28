import type { RateLimitAlgorithm } from '../../algorithms';
import type { KeySpec } from '../../extractors/key-builder';
import type { RouteMatcher } from '../../extractors/route';
import type { PolicyScope, Priority, RateLimitPolicy } from '../../types';
import type { BucketStore } from '../storage/bucket-store';

/**
 * A policy with everything precomputed that the hot path would otherwise redo per
 * request: the algorithm instance, its bucket store, the key spec, method/route matchers
 * and resolved priority weights.
 */
export interface CompiledPolicy {
  readonly policy: RateLimitPolicy;
  readonly scope: PolicyScope;
  readonly algorithm: RateLimitAlgorithm;
  readonly store: BucketStore;
  readonly keySpec: KeySpec;
  /** null = any method */
  readonly methods: ReadonlySet<string> | null;
  /** null = any route */
  readonly routes: readonly RouteMatcher[] | null;
  readonly weights: Record<Priority, number>;
}
