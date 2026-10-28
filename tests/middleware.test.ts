import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { RateLimiterEngine } from '../src/engine/rate-limiter';
import { ClientIpResolver } from '../src/extractors/client-ip-resolver';
import { expressRateLimit, type ExpressRateLimitOptions, type RateLimiterBackend } from '../src/middleware/express';
import { policy } from './helpers';

let server: Server | undefined;

async function start(options: Partial<ExpressRateLimitOptions> & { limiter: RateLimiterBackend }): Promise<string> {
  const app = express();
  app.use(
    expressRateLimit({
      tenantId: 'shop',
      // Tests connect from loopback, which plays the role of our load balancer.
      ipResolver: new ClientIpResolver({ trustedProxies: ['127.0.0.0/8', '::1/128'] }),
      ...options,
    }),
  );
  app.get('/hello', (_req, res) => {
    res.json({ ok: true });
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
  server = undefined;
});

function engineWith(capacity: number) {
  const engine = new RateLimiterEngine();
  engine.setTenantPolicies('shop', [
    policy({ id: 'per-ip', algorithm: 'token-bucket', capacity, refillRatePerSecond: 0.01, keyStrategy: { dimensions: ['ip'] } }),
  ]);
  return engine;
}

describe('Express middleware', () => {
  it('passes requests through with headers until the limit, then responds 429', async () => {
    const base = await start({ limiter: engineWith(2) });
    const get = () => fetch(`${base}/hello`, { headers: { 'x-forwarded-for': '198.51.100.1' } });

    const first = await get();
    expect(first.status).toBe(200);
    expect(first.headers.get('x-ratelimit-remaining')).toBe('1');
    await get();
    const blocked = await get();
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();
    expect(await blocked.json()).toMatchObject({ reason: 'CLIENT_KEY_EXCEEDED' });

    // A different client behind the same trusted proxy has its own bucket.
    const other = await fetch(`${base}/hello`, { headers: { 'x-forwarded-for': '198.51.100.2' } });
    expect(other.status).toBe(200);
  });

  it('fail-open: a broken limiter does not take the API down', async () => {
    const broken: RateLimiterBackend = { evaluate: () => Promise.reject(new Error('redis partition')) };
    const base = await start({ limiter: broken, failMode: 'open' });
    const res = await fetch(`${base}/hello`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-ratelimit-degraded')).toBe('fail-open');
  });

  it('fail-closed: a slow limiter times out and the request is refused', async () => {
    const hanging: RateLimiterBackend = { evaluate: () => new Promise(() => undefined) };
    const base = await start({ limiter: hanging, failMode: 'closed', timeoutMs: 20 });
    const res = await fetch(`${base}/hello`);
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('1');
  });
});
