import { MAP_ENTRY_BYTES, STRING_HEADER_BYTES } from '../storage/memory-model';

/**
 * Counts "isolation episodes": a client key that was being served and then got
 * contained by its own sub-quota. Repeated 429s inside the same block period are
 * one episode, not many. Bounded so a key-churn attack can't grow it.
 */
export class IsolationTracker {
  private readonly blockedUntil = new Map<string, number>();
  isolatedTotal = 0;

  // Per tenant: 10k x ~150B = ~1.5MB, so 1,000 tenants cost <= ~1.5GB worst case (100k would be ~15GB).
  constructor(private readonly maxEntries = 10_000) {}

  recordDenial(key: string, nowMs: number, blockedForMs: number): void {
    const previous = this.blockedUntil.get(key);
    if (previous === undefined || previous <= nowMs) this.isolatedTotal++;
    if (previous === undefined && this.blockedUntil.size >= this.maxEntries) {
      const oldest = this.blockedUntil.keys().next().value;
      if (oldest !== undefined) this.blockedUntil.delete(oldest);
    }
    // Updating an existing key keeps its Map position (no delete+insert on the hot path);
    // order is therefore "first isolated", which is all the sweeper needs.
    this.blockedUntil.set(key, nowMs + blockedForMs);
  }

  /** Currently-blocked keys (approximate: stale entries are dropped by sweep). */
  get trackedKeys(): number {
    return this.blockedUntil.size;
  }

  sweep(nowMs: number, budget: number): number {
    let removed = 0;
    let processed = 0;
    for (const [key, until] of this.blockedUntil) {
      if (processed++ >= budget) break;
      if (until <= nowMs) {
        this.blockedUntil.delete(key);
        removed++;
      }
    }
    return removed;
  }

  clear(): void {
    this.blockedUntil.clear();
  }

  estimatedBytes(): number {
    // key string (~64 chars typical) + Map slot + boxed number
    return this.blockedUntil.size * (MAP_ENTRY_BYTES + STRING_HEADER_BYTES + 64 + 16);
  }
}
