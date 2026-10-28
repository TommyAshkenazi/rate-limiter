import type { BucketState } from '../../algorithms/types';
import { flattenKey, MAP_ENTRY_BYTES, STRING_HEADER_BYTES } from './memory-model';
import type { StoreOptions } from './store-options';

/** How many recently-seen entries eviction may skip over before evicting one anyway. */
const MAX_SECOND_CHANCES = 64;

/**
 * Bounded key -> state map for ONE policy, with lazy ("CLOCK" / second-chance) LRU.
 *
 * The hot path never mutates the Map for an existing key: `touch` only writes
 * `state.lastSeenAt`. The Map's insertion order is "position order"; an entry is moved
 * to the tail lazily, only when the sweeper or the evictor reaches it at the head and
 * sees it was used since it was positioned. (Re-inserting into a large Map on every
 * request cost ~10µs/op under real traffic and dominated the profile — see DECISIONS.md.)
 *
 * Ordering is approximate by design: entries sit in the order they were (re)positioned,
 * and an untouched entry's expiry equals its position time + ttl. The sweep therefore
 * stops at the first entry that is neither expired nor recently seen, costing
 * O(expired + repositioned) rather than O(size). An expired entry hiding behind it
 * lingers at most ~one extra TTL — harmless, because expiry is lossless and the
 * capacity bound is enforced separately by makeRoom.
 *
 * TTL = the algorithm's idle time to full replenishment, so expiry is lossless —
 * a re-created state behaves identically to the evicted one.
 */
export class BucketStore<S extends BucketState = BucketState> {
  private readonly map = new Map<string, S>();
  private keyBytes = 0;
  evictedExpired = 0;
  evictedCapacity = 0;
  rejectedNew = 0;

  constructor(private options: StoreOptions) {}

  get size(): number {
    return this.map.size;
  }

  get ttlMs(): number {
    return this.options.ttlMs;
  }

  /** Policy update: same store, new limits. */
  reconfigure(options: StoreOptions): void {
    this.options = options;
  }

  get(key: string): S | undefined {
    return this.map.get(key);
  }

  /** Can a brand-new key be inserted right now? (Only ever false in reject-new mode.) */
  canAdmit(nowMs: number): boolean {
    if (this.map.size < this.options.maxKeys || this.options.onFull === 'evict-lru') return true;
    this.sweep(nowMs, MAX_SECOND_CHANCES);
    return this.map.size < this.options.maxKeys;
  }

  /** Start tracking a key (state came from algorithm.createState). */
  insert(key: string, state: S, nowMs: number): void {
    this.makeRoom(nowMs);
    state.lastSeenAt = nowMs;
    state.recentlySeen = false;
    this.keyBytes += key.length;
    this.map.set(flattenKey(key), state);
  }

  /** Record use of an existing key — allowed or denied. O(1), no Map mutation. */
  touch(state: S, nowMs: number): void {
    state.lastSeenAt = nowMs;
    state.recentlySeen = true;
  }

  private isExpired(state: S, nowMs: number): boolean {
    return state.lastSeenAt + this.options.ttlMs <= nowMs;
  }

  private reposition(key: string, state: S): void {
    this.map.delete(key);
    state.recentlySeen = false;
    this.map.set(key, state);
  }

  private makeRoom(nowMs: number): void {
    let chances = 0;
    while (this.map.size >= this.options.maxKeys) {
      const next = this.map.entries().next();
      if (next.done) return;
      const [key, state] = next.value;
      if (this.isExpired(state, nowMs)) {
        this.evictedExpired++;
        this.remove(key);
      } else if (state.recentlySeen && chances++ < MAX_SECOND_CHANCES) {
        // Used since it was positioned (e.g. a blocked abuser still hammering us):
        // don't evict it — a key flood must not be able to reset an active bucket.
        this.reposition(key, state);
      } else {
        this.evictedCapacity++;
        this.remove(key);
      }
    }
  }

  delete(key: string): boolean {
    return this.remove(key);
  }

  private remove(key: string): boolean {
    if (!this.map.delete(key)) return false;
    this.keyBytes -= key.length;
    return true;
  }

  /**
   * Remove expired entries from the head, repositioning recently used ones.
   * At most `budget` entries are processed per call. Returns how many were removed.
   */
  sweep(nowMs: number, budget: number): number {
    let removed = 0;
    let processed = 0;
    for (const [key, state] of this.map) {
      if (processed++ >= budget) break;
      if (this.isExpired(state, nowMs)) {
        this.remove(key);
        removed++;
      } else if (state.recentlySeen) {
        // Appended to the tail with the bit cleared; if the iterator reaches it again
        // it is no longer recentlySeen, so the loop terminates there at the latest.
        this.reposition(key, state);
      } else {
        break;
      }
    }
    this.evictedExpired += removed;
    return removed;
  }

  /** Admin reset helper. O(n) — fine for an operator action, never on the hot path. */
  deleteWhere(predicate: (key: string) => boolean): number {
    let removed = 0;
    for (const key of this.map.keys()) {
      if (predicate(key)) {
        this.remove(key);
        removed++;
      }
    }
    return removed;
  }

  clear(): number {
    const n = this.map.size;
    this.map.clear();
    this.keyBytes = 0;
    return n;
  }

  estimatedBytes(): number {
    const perEntry = MAP_ENTRY_BYTES + STRING_HEADER_BYTES + this.options.stateBytes;
    return this.map.size * perEntry + this.keyBytes;
  }
}
