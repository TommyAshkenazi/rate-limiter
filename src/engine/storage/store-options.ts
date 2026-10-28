/**
 * What to do when a store is at `maxKeys` and no entry has expired:
 * - evict-lru:  drop the least recently seen bucket (its key gets a fresh quota
 *               next time — a fail-open choice that keeps serving new clients).
 * - reject-new: refuse to start tracking new keys (new clients get 429 — fail-closed,
 *               existing clients keep their accurate state).
 */
export type StoreFullBehaviour = 'evict-lru' | 'reject-new';

export interface StoreOptions {
  /** Hard cap on keys in this store (memory bound). */
  maxKeys: number;
  /** Idle time after which a bucket equals a fresh one and can be dropped losslessly. */
  ttlMs: number;
  /** Size of one state object, for memory accounting. */
  stateBytes: number;
  onFull: StoreFullBehaviour;
}
