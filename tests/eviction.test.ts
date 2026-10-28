import { describe, expect, it } from 'vitest';
import { req, setup, times, type PolicyInput } from './helpers';

function ipFor(i: number): string {
  return `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
}

const perIp = (extra: Partial<PolicyInput> = {}): PolicyInput => ({
  id: 'per-ip',
  algorithm: 'token-bucket',
  capacity: 10,
  refillRatePerSecond: 10, // idle TTL = 1s
  keyStrategy: { dimensions: ['ip'] },
  ...extra,
});

describe('[6] memory eviction / bucket cleanup under key churn', () => {
  it('caps tracked keys under a churn of unique IPs (LRU eviction)', () => {
    const { engine } = setup({ t1: [perIp({ maxTrackedKeys: 1_000 })] });
    for (let i = 0; i < 20_000; i++) engine.evaluate(req({ clientIp: ipFor(i) }));
    const m = engine.getTenantMetrics('t1');
    expect(m.activeTrackedKeys).toBe(1_000);
    expect(m.allowedCount).toBe(20_000);
    // Bounded memory: ~1000 entries, not 20000.
    expect(m.currentMemoryEstimatedBytes).toBeLessThan(1_000 * 250);
  });

  it('evicts the least recently *seen* key — a blocked abuser cannot get evicted by a key flood', () => {
    const { engine } = setup({ t1: [perIp({ maxTrackedKeys: 3, refillRatePerSecond: 0.001 })] });
    const abuser = '198.51.100.1';
    times(10, () => engine.evaluate(req({ clientIp: abuser }))); // quota exhausted
    for (let i = 0; i < 50; i++) {
      engine.evaluate(req({ clientIp: ipFor(i) })); // churn pushes old keys out
      expect(engine.evaluate(req({ clientIp: abuser })).allowed).toBe(false); // denied hits keep it recent
    }
    // A key that stops showing up does get evicted and comes back fresh (lossy only under pressure).
    expect(engine.evaluate(req({ clientIp: ipFor(0) })).remaining).toBe(9);
  });

  it('background sweep removes idle buckets once they are equivalent to fresh ones', () => {
    const { engine, clock } = setup({ t1: [perIp()] });
    for (let i = 0; i < 5_000; i++) engine.evaluate(req({ clientIp: ipFor(i) }));
    const before = engine.getTenantMetrics('t1');
    expect(before.activeTrackedKeys).toBe(5_000);

    clock.advance(999);
    expect(engine.sweep()).toBe(0); // not idle long enough: removing would lose state

    clock.advance(2);
    expect(engine.sweep()).toBe(5_000);
    const after = engine.getTenantMetrics('t1');
    expect(after.activeTrackedKeys).toBe(0);
    expect(after.currentMemoryEstimatedBytes).toBeLessThan(before.currentMemoryEstimatedBytes / 100);

    // Lossless: an evicted key comes back with a full quota, exactly as if it had stayed.
    expect(engine.evaluate(req({ clientIp: ipFor(1) })).remaining).toBe(9);
  });

  it('sweep keeps buckets that were used recently even if they were created long ago', () => {
    const { engine, clock } = setup({ t1: [perIp()] });
    engine.evaluate(req({ clientIp: '198.51.100.1' })); // oldest entry, at the head
    for (let i = 0; i < 100; i++) engine.evaluate(req({ clientIp: ipFor(i) }));
    clock.advance(900);
    engine.evaluate(req({ clientIp: '198.51.100.1' })); // used again: second chance
    clock.advance(200); // the other 100 are idle > ttl (1000ms) now

    expect(engine.sweep()).toBe(100); // the old-but-active head was moved aside, not deleted
    expect(engine.getTenantMetrics('t1').activeTrackedKeys).toBe(1);
    clock.advance(1_000);
    expect(engine.sweep()).toBe(1); // ...and goes once it is idle for a full TTL
  });

  it('sweep work per tick is bounded so it never stalls the event loop', () => {
    const { engine, clock } = setup({ t1: [perIp()] }, { sweepBudget: 1_000 });
    for (let i = 0; i < 3_500; i++) engine.evaluate(req({ clientIp: ipFor(i) }));
    clock.advance(5_000);
    expect([engine.sweep(), engine.sweep(), engine.sweep(), engine.sweep()]).toEqual([1_000, 1_000, 1_000, 500]);
  });

  it('requests denied by another layer do not allocate buckets (flood with random IPs)', () => {
    const { engine } = setup({
      t1: [
        { id: 'pool', algorithm: 'token-bucket', capacity: 10, refillRatePerSecond: 0.001, keyStrategy: { dimensions: [] } },
        perIp(),
      ],
    });
    for (let i = 0; i < 10_000; i++) engine.evaluate(req({ clientIp: ipFor(i), priority: 'critical' }));
    // 10 allowed requests created 10 IP buckets + 1 tenant bucket; 9,990 rejected ones created nothing.
    expect(engine.getTenantMetrics('t1').activeTrackedKeys).toBe(11);
  });

  it('reject-new mode (fail-closed) keeps existing state and refuses unknown keys when full', () => {
    const { engine, clock } = setup({ t1: [perIp({ maxTrackedKeys: 2 })] }, { onStoreFull: 'reject-new' });
    engine.evaluate(req({ clientIp: '198.51.100.1' }));
    engine.evaluate(req({ clientIp: '198.51.100.2' }));
    expect(engine.evaluate(req({ clientIp: '198.51.100.3' }))).toMatchObject({ allowed: false, retryAfterSeconds: 1 });
    expect(engine.evaluate(req({ clientIp: '198.51.100.1' })).remaining).toBe(8);
    // Once an old entry expires, its slot can be reused.
    clock.advance(1_001);
    expect(engine.evaluate(req({ clientIp: '198.51.100.3' })).allowed).toBe(true);
  });
});
