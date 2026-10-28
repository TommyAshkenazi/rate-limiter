import type { Clock } from '../../clock';
import type { TenantRegistry } from '../tenants/tenant-registry';

/**
 * Periodically removes expired buckets from every store. Work per tick is
 * bounded (`budget` per store) so a sweep can never stall the event loop.
 */
export class Sweeper {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly registry: TenantRegistry,
    private readonly clock: Clock,
    private readonly intervalMs: number,
    private readonly budget: number,
  ) {}

  /** One pass over all stores. Returns how many buckets were removed. */
  sweepOnce(): number {
    const now = this.clock.nowMs();
    let removed = 0;
    for (const tenant of this.registry.all()) {
      for (const c of tenant.policies) removed += c.store.sweep(now, this.budget);
      tenant.isolation.sweep(now, this.budget);
    }
    return removed;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweepOnce(), this.intervalMs);
    // unref: the sweeper alone must never keep the process alive.
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
