import { systemClock, type Clock } from '../clock';
import type { EvaluationResult, RateLimitPolicy, RequestContext, TenantMetrics } from '../types';
import { resetBuckets, type ResetSelector } from './admin/reset';
import { computeTenantMetrics, snapshotTenant, type TenantSnapshot } from './admin/tenant-metrics';
import { resolveEngineOptions, type EngineOptions } from './engine-options';
import { commitAllowed } from './evaluation/allow-phase';
import { checkAllPolicies } from './evaluation/check-phase';
import { rejectDenied } from './evaluation/deny-phase';
import { Sweeper } from './maintenance/sweeper';
import { TenantRegistry } from './tenants/tenant-registry';

export { UnknownTenantError } from './errors';
export type { EngineOptions, PolicyTemplate } from './engine-options';
export type { ResetSelector } from './admin/reset';

/**
 * The public face of the rate limiter. It only wires the pieces together:
 *
 *   evaluate(request)
 *     1. registry.resolve()     -> which tenant          (tenants/tenant-registry.ts)
 *     2. checkAllPolicies()     -> phase 1: check all     (evaluation/check-phase.ts)
 *     3. commitAllowed()        -> phase 2a: consume all  (evaluation/allow-phase.ts)
 *        or rejectDenied()      -> phase 2b: consume none (evaluation/deny-phase.ts)
 *
 * `evaluate` is fully synchronous. Node never interleaves another request between
 * the check and the decrement, so the read-modify-write is atomic without locks.
 */
export class RateLimiterEngine {
  private readonly clock: Clock;
  private readonly registry: TenantRegistry;
  private readonly sweeper: Sweeper;

  constructor(options: EngineOptions = {}) {
    const resolved = resolveEngineOptions(options);
    this.clock = options.clock ?? systemClock;
    this.registry = new TenantRegistry(resolved);
    this.sweeper = new Sweeper(this.registry, this.clock, resolved.sweepIntervalMs, resolved.sweepBudget);
  }

  // ---- hot path ----------------------------------------------------------------

  evaluate(ctx: RequestContext): EvaluationResult {
    const tenant = this.registry.resolve(ctx.tenantId);
    const now = this.clock.nowMs();
    const cost = ctx.cost ?? 1;

    const { checks, anyDenied } = checkAllPolicies(tenant, ctx, now, cost);
    const result = anyDenied
      ? rejectDenied(tenant, checks, now, cost, this.clock)
      : commitAllowed(checks, now, cost, this.clock);

    tenant.recordOutcome(result);
    return result;
  }

  // ---- configuration -----------------------------------------------------------

  setTenantPolicies(tenantId: string, policies: RateLimitPolicy[]): void {
    this.registry.setPolicies(tenantId, policies);
  }

  getTenantPolicies(tenantId: string): RateLimitPolicy[] | undefined {
    if (!this.registry.has(tenantId)) return undefined;
    return this.registry.getOrThrow(tenantId).policies.map((c) => c.policy);
  }

  hasTenant(tenantId: string): boolean {
    return this.registry.has(tenantId);
  }

  // ---- admin & metrics ---------------------------------------------------------

  /** Returns the number of buckets removed. */
  reset(selector: ResetSelector): number {
    return resetBuckets(this.registry.getOrThrow(selector.tenantId), selector);
  }

  getTenantMetrics(tenantId: string): TenantMetrics {
    return computeTenantMetrics(this.registry.getOrThrow(tenantId));
  }

  /** Raw view for the Prometheus exporter. */
  *snapshot(): Generator<TenantSnapshot> {
    for (const tenant of this.registry.all()) yield snapshotTenant(tenant);
  }

  // ---- maintenance -------------------------------------------------------------

  /** Drop expired buckets now. Returns how many were removed. */
  sweep(): number {
    return this.sweeper.sweepOnce();
  }

  /** Start the background sweeper. */
  start(): void {
    this.sweeper.start();
  }

  stop(): void {
    this.sweeper.stop();
  }
}
