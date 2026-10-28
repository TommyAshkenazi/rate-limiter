import { describe, expect, it } from 'vitest';
import { buildRateLimitHeaders } from '../src/engine/output/headers';
import { bigTenantPool, req, setup, times } from './helpers';

const WALL_START_S = 1_774_348_800;

describe('[1] basic enforcement: allow until limit, then 429', () => {
  it('allows exactly `capacity` requests and then blocks with CLIENT_KEY_EXCEEDED', () => {
    const { engine } = setup({
      t1: [
        bigTenantPool,
        { id: 'per-user', algorithm: 'token-bucket', capacity: 3, refillRatePerSecond: 1, keyStrategy: { dimensions: ['userId'] } },
      ],
    });
    const results = times(4, () => engine.evaluate(req({ userId: 'alice' })));

    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results.map((r) => r.remaining)).toEqual([2, 1, 0, 0]);
    expect(results[0]).toMatchObject({ limit: 3, policyId: 'per-user' });
    expect(results[3]).toMatchObject({
      allowed: false,
      limit: 3,
      remaining: 0,
      retryAfterSeconds: 1,
      resetAt: WALL_START_S + 1,
      reason: 'CLIENT_KEY_EXCEEDED',
    });
  });

  it('produces spec + IETF headers with seconds, not milliseconds', () => {
    const { engine, clock } = setup({
      t1: [{ id: 'p', algorithm: 'sliding-window', capacity: 1, windowSizeSeconds: 30, keyStrategy: { dimensions: ['ip'] } }],
    });
    engine.evaluate(req());
    const denied = engine.evaluate(req());
    const headers = buildRateLimitHeaders(denied, { nowMs: clock.wallMs() });
    expect(headers).toMatchObject({
      'X-RateLimit-Limit': '1',
      'X-RateLimit-Remaining': '0',
      'RateLimit-Limit': '1',
      'RateLimit-Policy': '1;w=30',
    });
    const retry = Number(headers['Retry-After']);
    expect(Number.isInteger(retry)).toBe(true);
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(60);
    expect(Number(headers['X-RateLimit-Reset'])).toBe(WALL_START_S + retry);
    expect(Number(headers['RateLimit-Reset'])).toBe(retry);
  });

  it('a request with cost > 1 consumes that many units', () => {
    const { engine } = setup({
      t1: [{ id: 'p', algorithm: 'token-bucket', capacity: 10, refillRatePerSecond: 1, keyStrategy: { dimensions: ['ip'] } }],
    });
    expect(engine.evaluate(req({ cost: 7 })).remaining).toBe(3);
    expect(engine.evaluate(req({ cost: 4 })).allowed).toBe(false);
    expect(engine.evaluate(req({ cost: 3 })).allowed).toBe(true);
  });

  it('a request no policy applies to is allowed without headers', () => {
    const { engine } = setup({
      t1: [
        { id: 'login', algorithm: 'sliding-window', capacity: 1, windowSizeSeconds: 60, keyStrategy: { dimensions: ['ip'] }, match: { routes: ['/auth/login'] } },
      ],
    });
    const r = engine.evaluate(req({ route: '/public' }));
    expect(r.allowed).toBe(true);
    expect(buildRateLimitHeaders(r)).toEqual({});
  });
});

describe('[2] accurate refill / window reset over time', () => {
  it('token bucket: one token back exactly every 1/rate seconds', () => {
    const { engine, clock } = setup({
      t1: [{ id: 'p', algorithm: 'token-bucket', capacity: 2, refillRatePerSecond: 2, keyStrategy: { dimensions: ['ip'] } }],
    });
    engine.evaluate(req());
    engine.evaluate(req());
    expect(engine.evaluate(req()).allowed).toBe(false);

    clock.advance(499);
    expect(engine.evaluate(req()).allowed).toBe(false);
    clock.advance(1);
    expect(engine.evaluate(req()).allowed).toBe(true);
    expect(engine.evaluate(req()).allowed).toBe(false);

    clock.advance(10_000); // long idle: refills to capacity, never above
    expect(times(3, () => engine.evaluate(req()).allowed)).toEqual([true, true, false]);
  });

  it('sliding window: quota comes back as the window slides, not all at once', () => {
    const { engine, clock } = setup({
      t1: [{ id: 'p', algorithm: 'sliding-window', capacity: 10, windowSizeSeconds: 10, keyStrategy: { dimensions: ['ip'] } }],
    });
    // ManualClock starts at mono=1000ms => 1s into window 0.
    expect(times(11, () => engine.evaluate(req()).allowed).filter(Boolean)).toHaveLength(10);

    clock.advance(9_000); // t=10s: start of window 1; previous window still fully weighted
    expect(engine.evaluate(req()).allowed).toBe(false);
    clock.advance(5_000); // t=15s: half of the previous 10 slid out
    expect(times(6, () => engine.evaluate(req()).allowed).filter(Boolean)).toHaveLength(5);
    clock.advance(20_000); // two full windows idle: complete reset
    expect(engine.evaluate(req()).remaining).toBe(9);
  });

  it('Retry-After is honest: retrying exactly then succeeds', () => {
    const { engine, clock } = setup({
      t1: [{ id: 'p', algorithm: 'token-bucket', capacity: 1, refillRatePerSecond: 0.25, keyStrategy: { dimensions: ['ip'] } }],
    });
    engine.evaluate(req());
    const denied = engine.evaluate(req());
    expect(denied.retryAfterSeconds).toBe(4);
    clock.advance(denied.retryAfterSeconds! * 1000);
    expect(engine.evaluate(req()).allowed).toBe(true);
  });
});
