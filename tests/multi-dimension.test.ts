import { describe, expect, it } from 'vitest';
import { req, setup, times, type PolicyInput } from './helpers';

const slow = 0.001; // practically no refill during a test

describe('[5] multi-dimension key evaluation', () => {
  const policies: PolicyInput[] = [
    { id: 'per-user', algorithm: 'token-bucket', capacity: 3, refillRatePerSecond: slow, keyStrategy: { dimensions: ['userId'] } },
    { id: 'per-ip', algorithm: 'token-bucket', capacity: 5, refillRatePerSecond: slow, keyStrategy: { dimensions: ['ip'] } },
  ];

  it('differentiates user limits from IP limits', () => {
    const { engine } = setup({ t1: policies });
    const ipA = '198.51.100.1';
    const ipB = '198.51.100.2';

    // u1 hits the user limit first (3 < 5) ...
    const u1 = times(4, () => engine.evaluate(req({ userId: 'u1', clientIp: ipA })));
    expect(u1.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(u1[3]!.policyId).toBe('per-user');

    // ... and moving to another IP doesn't help: the user key follows them.
    expect(engine.evaluate(req({ userId: 'u1', clientIp: ipB })).policyId).toBe('per-user');
    expect(engine.evaluate(req({ userId: 'u1', clientIp: ipB })).allowed).toBe(false);

    // u2 behind the same NAT IP: the shared IP has 5 - 3 = 2 left (u1's denied request wasn't charged).
    const u2 = times(3, () => engine.evaluate(req({ userId: 'u2', clientIp: ipA })));
    expect(u2.map((r) => r.allowed)).toEqual([true, true, false]);
    expect(u2[2]!.policyId).toBe('per-ip');

    // u2 from a fresh IP still has 1 of its own 3 left.
    expect(engine.evaluate(req({ userId: 'u2', clientIp: ipB })).allowed).toBe(true);
    expect(engine.evaluate(req({ userId: 'u2', clientIp: ipB })).allowed).toBe(false);
  });

  it('anonymous traffic skips user-keyed policies and is covered by IP policies', () => {
    const { engine } = setup({ t1: policies });
    const anon = times(6, () => engine.evaluate(req({ clientIp: '203.0.113.50' })));
    expect(anon.filter((r) => r.allowed)).toHaveLength(5);
    expect(anon[5]!.policyId).toBe('per-ip');
  });

  it('derives identity from Bearer tokens and API keys (hashed)', () => {
    const { engine } = setup({ t1: policies });
    const bearer = { authorization: 'Bearer abc.def.ghi' };
    times(3, (i) => engine.evaluate(req({ headers: bearer, clientIp: `198.51.100.${i + 10}` })));
    expect(engine.evaluate(req({ headers: bearer, clientIp: '198.51.100.99' }))).toMatchObject({ allowed: false, policyId: 'per-user' });
    expect(engine.evaluate(req({ headers: { Authorization: 'Bearer other' }, clientIp: '198.51.100.98' })).allowed).toBe(true);
    expect(engine.evaluate(req({ headers: { 'x-api-key': 'k1' }, clientIp: '198.51.100.97' })).allowed).toBe(true);
  });

  it('composite keys: tenantId + ip + route and header-based keys', () => {
    const { engine } = setup({
      t1: [
        {
          id: 'login',
          algorithm: 'sliding-window',
          capacity: 2,
          windowSizeSeconds: 60,
          keyStrategy: { dimensions: ['ip', 'route'] },
          match: { methods: ['POST'], routes: ['/auth/login', '/auth/reset'] },
        },
        { id: 'per-key', algorithm: 'token-bucket', capacity: 2, refillRatePerSecond: slow, keyStrategy: { dimensions: ['header'], headerName: 'X-Api-Key' } },
      ],
      t2: [
        { id: 'login', algorithm: 'sliding-window', capacity: 2, windowSizeSeconds: 60, keyStrategy: { dimensions: ['ip', 'route'] } },
      ],
    });
    const login = (tenantId = 't1', route = '/auth/login') => engine.evaluate(req({ tenantId, route, method: 'POST' }));
    expect([login(), login(), login()].map((r) => r.allowed)).toEqual([true, true, false]);
    expect(login('t1', '/auth/reset').allowed).toBe(true); // different route, different bucket
    expect(login('t2').allowed).toBe(true); // same IP + route, different tenant

    const withKey = (k: string) => engine.evaluate(req({ headers: { 'x-api-key': k } }));
    expect([withKey('a'), withKey('a'), withKey('a'), withKey('b')].map((r) => r.allowed)).toEqual([true, true, false, true]);
  });
});
