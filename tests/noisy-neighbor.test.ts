import { describe, expect, it } from 'vitest';
import { req, setup, times, type PolicyInput } from './helpers';

const noShedding = { critical: 1, standard: 1, background: 1 };

describe('[3] noisy neighbor: hierarchical tenant vs client limits', () => {
  const policies: PolicyInput[] = [
    {
      id: 'tenant-pool',
      algorithm: 'token-bucket',
      capacity: 30,
      refillRatePerSecond: 0.001, // effectively no refill during the test
      keyStrategy: { dimensions: [] },
      priorityWeights: noShedding,
    },
    { id: 'per-user', algorithm: 'token-bucket', capacity: 10, refillRatePerSecond: 1, keyStrategy: { dimensions: ['userId'] } },
  ];

  it('user A exhausting their sub-quota does not drain the tenant pool or affect user B', () => {
    const { engine } = setup({ X: policies });

    const a = times(200, () => engine.evaluate(req({ tenantId: 'X', userId: 'A' })));
    expect(a.filter((r) => r.allowed)).toHaveLength(10);
    expect(a.slice(10).every((r) => r.reason === 'CLIENT_KEY_EXCEEDED')).toBe(true);

    // If A's 190 rejected requests had consumed the 30-unit tenant pool, B would be starved.
    const b = times(10, () => engine.evaluate(req({ tenantId: 'X', userId: 'B' })));
    expect(b.every((r) => r.allowed)).toBe(true);

    // Pool: 30 - 10 (A) - 10 (B) = 10 left for everyone else.
    const c = times(11, () => engine.evaluate(req({ tenantId: 'X', userId: 'C' })));
    expect(c.filter((r) => r.allowed)).toHaveLength(10);
    expect(c[10]!.reason).toBe('CLIENT_KEY_EXCEEDED'); // C hit its own 10 first

    const metrics = engine.getTenantMetrics('X');
    expect(metrics.totalEvaluations).toBe(221);
    expect(metrics.allowedCount).toBe(30);
    expect(metrics.blockedCount).toBe(191);
    expect(metrics.noisyNeighborsIsolated).toBe(2); // A once (not 190 times), C once
  });

  it('when the tenant pool itself is empty everyone gets TENANT_QUOTA_EXCEEDED, and user quota is not charged', () => {
    const { engine, clock } = setup({ X: policies });
    for (const u of ['u1', 'u2', 'u3']) times(10, () => engine.evaluate(req({ tenantId: 'X', userId: u })));
    const blocked = engine.evaluate(req({ tenantId: 'X', userId: 'u4' }));
    expect(blocked).toMatchObject({ allowed: false, reason: 'TENANT_QUOTA_EXCEEDED' });

    // u4 was refused by the tenant layer; its personal bucket must still be full.
    // Raise the tenant pool (runtime policy update keeps existing buckets) to look at u4's own quota.
    engine.setTenantPolicies('X', [
      { ...policies[0]!, refillRatePerSecond: 1_000_000, tenantId: 'X', name: 'pool' },
      { ...policies[1]!, tenantId: 'X', name: 'per-user' },
    ]);
    clock.advance(1);
    expect(engine.evaluate(req({ tenantId: 'X', userId: 'u4' })).remaining).toBe(9);
  });

  it('tenants are isolated from each other', () => {
    const { engine } = setup({ X: policies, Y: policies });
    times(100, (i) => engine.evaluate(req({ tenantId: 'X', userId: `user-${i}` })));
    expect(engine.evaluate(req({ tenantId: 'X', userId: 'late' })).allowed).toBe(false);
    expect(engine.evaluate(req({ tenantId: 'Y', userId: 'late' })).allowed).toBe(true);
  });
});

describe('priority classes / QoS shedding', () => {
  it('sheds background at >90% and standard at >95% while critical can use the full pool', () => {
    const { engine } = setup({
      X: [{ id: 'pool', algorithm: 'token-bucket', capacity: 100, refillRatePerSecond: 0.001, keyStrategy: { dimensions: [] } }],
    });
    const run = (priority: 'critical' | 'standard' | 'background', n: number) =>
      times(n, () => engine.evaluate(req({ tenantId: 'X', priority })));

    const bg = run('background', 100);
    expect(bg.filter((r) => r.allowed)).toHaveLength(90);
    expect(bg[90]).toMatchObject({ allowed: false, reason: 'NOISY_NEIGHBOR_THROTTLED' });

    expect(run('standard', 10).filter((r) => r.allowed)).toHaveLength(5);
    const critical = run('critical', 6);
    expect(critical.filter((r) => r.allowed)).toHaveLength(5);
    expect(critical[5]).toMatchObject({ allowed: false, reason: 'TENANT_QUOTA_EXCEEDED' });
  });

  it('a background flood cannot starve critical traffic', () => {
    const { engine } = setup({
      X: [{ id: 'pool', algorithm: 'sliding-window', capacity: 1000, windowSizeSeconds: 1, keyStrategy: { dimensions: [] } }],
    });
    times(5000, () => engine.evaluate(req({ tenantId: 'X', priority: 'background' })));
    const critical = times(50, () => engine.evaluate(req({ tenantId: 'X', priority: 'critical' })));
    expect(critical.every((r) => r.allowed)).toBe(true);
  });
});
