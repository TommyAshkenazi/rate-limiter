import { describe, expect, it } from 'vitest';
import { LeakyBucket, SlidingWindowCounter, TokenBucket, type RateLimitAlgorithm } from '../src/algorithms';

function hit(algo: RateLimitAlgorithm, state: ReturnType<RateLimitAlgorithm['createState']>, now: number, cost = 1) {
  const d = algo.check(state, now, cost, 0);
  if (d.allowed) algo.consume(state, now, cost);
  return d;
}

describe('TokenBucket', () => {
  it('allows a burst up to capacity, then denies with an exact retry time', () => {
    const tb = new TokenBucket(5, 1);
    const s = tb.createState(0);
    const remaining = [0, 1, 2, 3, 4].map(() => hit(tb, s, 0).remaining);
    expect(remaining).toEqual([4, 3, 2, 1, 0]);
    const denied = hit(tb, s, 0);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(1000);
  });

  it('refills continuously from elapsed time (no timers, no drift)', () => {
    const tb = new TokenBucket(10, 10); // 1 token / 100ms
    const s = tb.createState(0);
    for (let i = 0; i < 10; i++) hit(tb, s, 0);
    expect(hit(tb, s, 99).allowed).toBe(false);
    expect(hit(tb, s, 100).allowed).toBe(true);
    // 1000 small steps must add up exactly like one big step.
    let t = 100;
    let allowed = 0;
    for (let i = 0; i < 1000; i++) {
      t += 1;
      if (hit(tb, s, t).allowed) allowed++;
    }
    expect(allowed).toBe(10);
  });

  it('never exceeds capacity after a long idle period', () => {
    const tb = new TokenBucket(3, 1);
    const s = tb.createState(0);
    hit(tb, s, 0);
    expect(hit(tb, s, 1_000_000).remaining).toBe(2);
  });

  it('honours a priority reserve', () => {
    const tb = new TokenBucket(10, 1);
    const s = tb.createState(0);
    // reserve 2 => only 8 of 10 tokens are usable
    let allowed = 0;
    for (let i = 0; i < 10; i++) {
      const d = tb.check(s, 0, 1, 2);
      if (d.allowed) {
        tb.consume(s, 0, 1);
        allowed++;
      }
    }
    expect(allowed).toBe(8);
    expect(tb.check(s, 0, 1, 0).allowed).toBe(true);
  });
});

describe('SlidingWindowCounter', () => {
  it('enforces the limit within a window', () => {
    const sw = new SlidingWindowCounter(10, 10);
    const s = sw.createState(0);
    for (let i = 0; i < 10; i++) expect(hit(sw, s, 1000).allowed).toBe(true);
    expect(hit(sw, s, 1000).allowed).toBe(false);
  });

  it('eliminates the fixed-window boundary burst', () => {
    const sw = new SlidingWindowCounter(10, 10);
    const s = sw.createState(0);
    // 10 requests at the very end of window 0 ...
    for (let i = 0; i < 10; i++) hit(sw, s, 9_999);
    // ... a fixed window would allow 10 more at t=10s. The sliding estimate is still ~10.
    const d = hit(sw, s, 10_000);
    expect(d.allowed).toBe(false);
    expect(d.retryAfterMs).toBe(1000); // 10% of previous window must slide out
    expect(hit(sw, s, 10_999).allowed).toBe(false);
    expect(hit(sw, s, 11_000).allowed).toBe(true);
  });

  it('fully resets after two idle windows', () => {
    const sw = new SlidingWindowCounter(5, 1);
    const s = sw.createState(0);
    for (let i = 0; i < 5; i++) hit(sw, s, 0);
    expect(hit(sw, s, 500).allowed).toBe(false);
    expect(hit(sw, s, 2_000).remaining).toBe(4);
  });

  it('computes retry time that is neither early nor late', () => {
    const sw = new SlidingWindowCounter(4, 10);
    const s = sw.createState(0);
    for (let i = 0; i < 4; i++) hit(sw, s, 5_000);
    const d = hit(sw, s, 5_000);
    expect(d.allowed).toBe(false);
    expect(hit(sw, s, 5_000 + d.retryAfterMs - 1).allowed).toBe(false);
    expect(hit(sw, s, 5_000 + d.retryAfterMs).allowed).toBe(true);
  });
});

describe('LeakyBucket (GCRA)', () => {
  it('admits up to capacity then drains at a constant rate', () => {
    const lb = new LeakyBucket(3, 1);
    const s = lb.createState(0);
    expect([hit(lb, s, 0), hit(lb, s, 0), hit(lb, s, 0)].every((d) => d.allowed)).toBe(true);
    const denied = hit(lb, s, 0);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(1000);
    expect(hit(lb, s, 999).allowed).toBe(false);
    expect(hit(lb, s, 1000).allowed).toBe(true);
  });
});

describe('common interface', () => {
  it.each<[string, RateLimitAlgorithm]>([
    ['token-bucket', new TokenBucket(3, 3)],
    ['sliding-window', new SlidingWindowCounter(3, 1)],
    ['leaky-bucket', new LeakyBucket(3, 3)],
  ])('%s: a state older than idleTtlMs behaves like a fresh one', (_name, algo) => {
    const s = algo.createState(0);
    for (let i = 0; i < 3; i++) hit(algo, s, 0);
    const later = algo.idleTtlMs;
    const fresh = algo.createState(later);
    expect(algo.check(s, later, 1, 0)).toEqual(algo.check(fresh, later, 1, 0));
  });
});
