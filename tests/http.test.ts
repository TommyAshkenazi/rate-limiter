import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManualClock } from '../src/clock';
import { RateLimiterEngine } from '../src/engine/rate-limiter';
import { buildApp } from '../src/http/app';
import type { FailMode } from '../src/types';
import { policy } from './helpers';

const TOKEN = 'secret-admin';

async function makeApp(failMode: FailMode = 'open') {
  const clock = new ManualClock();
  const engine = new RateLimiterEngine({
    clock,
    defaultTenantPolicies: [
      { id: 'pool', name: 'pool', algorithm: 'token-bucket', capacity: 50, refillRatePerSecond: 50, keyStrategy: { dimensions: [] } },
    ],
  });
  engine.setTenantPolicies('org-acme-prod', [
    policy({ id: 'pool', algorithm: 'token-bucket', capacity: 5000, refillRatePerSecond: 5000, keyStrategy: { dimensions: [] } }),
    policy({
      id: 'payments',
      algorithm: 'sliding-window',
      capacity: 2,
      windowSizeSeconds: 60,
      keyStrategy: { dimensions: ['userId', 'route'] },
      match: { methods: ['POST'], routes: ['/api/v1/payments'] },
    }),
  ]);
  const server: Server = await new Promise((resolve) => {
    const s: Server = buildApp({ engine, failMode, adminToken: TOKEN, clock }).listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  /** Minimal inject-like helper over real HTTP. */
  const app = {
    async inject(o: { method: string; url: string; payload?: unknown; headers?: Record<string, string> }) {
      const res = await fetch(base + o.url, {
        method: o.method,
        headers: { ...(o.payload !== undefined ? { 'content-type': 'application/json' } : {}), ...o.headers },
        body: o.payload !== undefined ? JSON.stringify(o.payload) : undefined,
      });
      const text = await res.text();
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => (headers[k] = v));
      return {
        statusCode: res.status,
        headers,
        body: text,
        json: () => JSON.parse(text) as any,
      };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  return { app, engine, clock };
}

const body = {
  tenantId: 'org-acme-prod',
  clientIp: '2001:0db8:85a3:0000:0000:8a2e:0370:7334',
  userId: 'usr_99812',
  route: '/api/v1/payments',
  method: 'POST',
  priority: 'critical',
};

describe('HTTP API', () => {
  let current: Awaited<ReturnType<typeof makeApp>> | undefined;
  afterEach(async () => {
    await current?.app.close();
    vi.restoreAllMocks();
  });

  it('POST /v1/rate-limit/check returns 200 + headers, then 429 + Retry-After', async () => {
    current = await makeApp();
    const { app } = current;
    const ok = await app.inject({ method: 'POST', url: '/v1/rate-limit/check', payload: body });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ allowed: true, limit: 2, remaining: 1 });
    expect(ok.headers['x-ratelimit-limit']).toBe('2');
    expect(ok.headers['x-ratelimit-remaining']).toBe('1');
    expect(ok.headers['ratelimit-policy']).toBe('2;w=60');
    expect(ok.headers['retry-after']).toBeUndefined();

    await app.inject({ method: 'POST', url: '/v1/rate-limit/check', payload: body });
    const blocked = await app.inject({ method: 'POST', url: '/v1/rate-limit/check', payload: body });
    expect(blocked.statusCode).toBe(429);
    const json = blocked.json();
    expect(json).toMatchObject({ allowed: false, remaining: 0, reason: 'CLIENT_KEY_EXCEEDED' });
    expect(blocked.headers['retry-after']).toBe(String(json.retryAfterSeconds));
    expect(blocked.headers['x-ratelimit-reset']).toBe(String(json.resetAt));
  });

  it('validates input', async () => {
    current = await makeApp();
    const { app } = current;
    const missing = await app.inject({ method: 'POST', url: '/v1/rate-limit/check', payload: { clientIp: '1.2.3.4' } });
    expect(missing.statusCode).toBe(400);
    const badIp = await app.inject({ method: 'POST', url: '/v1/rate-limit/check', payload: { ...body, clientIp: 'nope' } });
    expect(badIp.json()).toEqual({ error: 'INVALID_CLIENT_IP' });
    const badCost = await app.inject({ method: 'POST', url: '/v1/rate-limit/check', payload: { ...body, cost: -1 } });
    expect(badCost.statusCode).toBe(400);
  });

  it('auto-provisions unknown tenants from the default template', async () => {
    current = await makeApp();
    const res = await current.app.inject({ method: 'POST', url: '/v1/rate-limit/check', payload: { ...body, tenantId: 'new-tenant' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().limit).toBe(50);
  });

  it('GET /v1/tenants/:id/metrics reports counters and memory', async () => {
    current = await makeApp();
    const { app } = current;
    for (let i = 0; i < 3; i++) await app.inject({ method: 'POST', url: '/v1/rate-limit/check', payload: body });
    const res = await app.inject({ method: 'GET', url: '/v1/tenants/org-acme-prod/metrics' });
    expect(res.json()).toMatchObject({
      tenantId: 'org-acme-prod',
      activeTrackedKeys: 2,
      totalEvaluations: 3,
      allowedCount: 2,
      blockedCount: 1,
      noisyNeighborsIsolated: 1,
    });
    expect(res.json().currentMemoryEstimatedBytes).toBeGreaterThan(0);
    expect((await app.inject({ method: 'GET', url: '/v1/tenants/ghost/metrics' })).statusCode).toBe(404);
  });

  it('admin reset clears a user quota and requires the admin token', async () => {
    current = await makeApp();
    const { app } = current;
    for (let i = 0; i < 3; i++) await app.inject({ method: 'POST', url: '/v1/rate-limit/check', payload: body });

    const resetPayload = { tenantId: 'org-acme-prod', dimensions: { userId: 'usr_99812' } };
    const denied = await app.inject({ method: 'POST', url: '/v1/rate-limit/reset', payload: resetPayload });
    expect(denied.statusCode).toBe(401);

    const reset = await app.inject({
      method: 'POST',
      url: '/v1/rate-limit/reset',
      payload: resetPayload,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(reset.json()).toEqual({ tenantId: 'org-acme-prod', removedBuckets: 1 });
    const after = await app.inject({ method: 'POST', url: '/v1/rate-limit/check', payload: body });
    expect(after.statusCode).toBe(200);
  });

  it('PUT policies updates limits at runtime and rejects invalid policies atomically', async () => {
    current = await makeApp();
    const { app } = current;
    const auth = { authorization: `Bearer ${TOKEN}` };
    const bad = await app.inject({
      method: 'PUT',
      url: '/v1/tenants/org-acme-prod/policies',
      headers: auth,
      payload: { policies: [{ id: 'x', name: 'x', algorithm: 'sliding-window', capacity: 5, keyStrategy: { dimensions: [] } }] },
    });
    expect(bad.statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/v1/tenants/org-acme-prod/policies' })).json().policies).toHaveLength(2);

    const ok = await app.inject({
      method: 'PUT',
      url: '/v1/tenants/org-acme-prod/policies',
      headers: auth,
      payload: { policies: [{ id: 'tiny', name: 'tiny', algorithm: 'token-bucket', capacity: 1, refillRatePerSecond: 1, keyStrategy: { dimensions: ['ip'] } }] },
    });
    expect(ok.statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/v1/rate-limit/check', payload: body })).json().limit).toBe(1);
  });

  it('exposes Prometheus metrics', async () => {
    current = await makeApp();
    const { app } = current;
    await app.inject({ method: 'POST', url: '/v1/rate-limit/check', payload: body });
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('ratelimit_evaluations_total{tenant="org-acme-prod",decision="allowed"} 1');
    expect(res.body).toContain('ratelimit_tracked_keys{tenant="org-acme-prod",policy="payments"} 1');
  });

  it.each([
    ['open', 200, true],
    ['closed', 503, false],
  ] as const)('engine failure with FAIL_MODE=%s -> %i', async (mode, status, allowed) => {
    current = await makeApp(mode);
    vi.spyOn(current.engine, 'evaluate').mockImplementation(() => {
      throw new Error('boom');
    });
    const res = await current.app.inject({ method: 'POST', url: '/v1/rate-limit/check', payload: body });
    expect(res.statusCode).toBe(status);
    expect(res.json()).toEqual({ allowed, degraded: true });
    expect(res.headers['x-ratelimit-degraded']).toBe(`fail-${mode}`);
  });
});
