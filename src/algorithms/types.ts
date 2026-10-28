import type { AlgorithmName } from '../types';

/**
 * Store bookkeeping lives on the state itself, so the store needs no wrapper object per entry.
 * Both fields are maintained by the BucketStore, never by algorithms.
 */
export interface BucketState {
  /** Monotonic ms of the last request that touched this key (allowed or denied). */
  lastSeenAt: number;
  /** Touched since it was (re)placed at the tail of the store's Map order (second-chance bit). */
  recentlySeen: boolean;
}

export interface AlgorithmDecision {
  allowed: boolean;
  /** Units still available to this caller *after* the request (if allowed). Integer, >= 0. */
  remaining: number;
  /** 0 when allowed. Otherwise ms until an identical request would succeed (assuming no other traffic). */
  retryAfterMs: number;
  /** ms until the bucket is completely replenished. */
  resetInMs: number;
}

/**
 * Common polymorphic interface. One instance is bound to one policy's parameters;
 * per-key state lives outside, in the BucketStore.
 *
 * The split between `check` and `consume` is what makes hierarchical evaluation
 * atomic: the engine checks *every* applicable policy first and only consumes if
 * all of them allow, so a request rejected by one layer never drains another.
 */
export interface RateLimitAlgorithm<S extends BucketState = BucketState> {
  readonly name: AlgorithmName;
  readonly capacity: number;
  /** Window advertised in RateLimit-Policy (`w=`). */
  readonly windowSeconds: number;
  /** After this long without a consume, state == fresh state, so evicting it is lossless. */
  readonly idleTtlMs: number;
  /** Rough retained size of one state object, for memory accounting. */
  readonly stateBytes: number;

  createState(nowMs: number): S;

  /**
   * Decide without consuming. May normalise the state (apply refill, rotate windows) —
   * that is idempotent and does not change the observable quota.
   *
   * @param reserve units that must stay untouched after this request (priority headroom).
   */
  check(state: S, nowMs: number, cost: number, reserve: number): AlgorithmDecision;

  /**
   * Apply the cost. Only called after `check` returned allowed, in the same synchronous tick.
   * Does not touch `lastSeenAt` / `recentlySeen`; those belong to the store.
   */
  consume(state: S, nowMs: number, cost: number): void;
}

/** Tolerance for float rounding in refill math (e.g. 0.30000000000000004 tokens). */
export const EPSILON = 1e-9;

/**
 * Whole milliseconds, rounded UP after discarding float noise, so 999.9999999999998
 * becomes 1000 (not 1000 -> ceil -> 1001 -> Retry-After 2s, nor 999 -> retry too early).
 */
export function ceilMs(ms: number): number {
  return Math.ceil(Math.round(ms * 1e6) / 1e6);
}
