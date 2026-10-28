import type { DenyReason, EvaluationResult } from '../../types';
import type { CompiledPolicy } from '../policies/compiled-policy';
import { IsolationTracker } from './isolation-tracker';

export interface TenantCounters {
  total: number;
  allowed: number;
  blocked: number;
  blockedByReason: Record<DenyReason, number>;
}

/** Everything the engine holds for one tenant: its policies, counters and isolation tracker. */
export class TenantRuntime {
  /** Client-scope policies first, then tenant pools (see TenantRegistry). */
  policies: CompiledPolicy[] = [];
  readonly isolation = new IsolationTracker();
  readonly counters: TenantCounters = {
    total: 0,
    allowed: 0,
    blocked: 0,
    blockedByReason: { TENANT_QUOTA_EXCEEDED: 0, CLIENT_KEY_EXCEEDED: 0, NOISY_NEIGHBOR_THROTTLED: 0 },
  };

  constructor(
    readonly tenantId: string,
    /** Auto-provisioned from the default template rather than configured. */
    readonly dynamic: boolean,
  ) {}

  recordOutcome(result: EvaluationResult): void {
    this.counters.total++;
    if (result.allowed) {
      this.counters.allowed++;
    } else {
      this.counters.blocked++;
      this.counters.blockedByReason[result.reason!]++;
    }
  }
}
