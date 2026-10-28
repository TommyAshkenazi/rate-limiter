/**
 * Single-core throughput of the evaluation engine (no HTTP).
 *   npm run bench            # default 2,000,000 evaluations
 *   npm run bench -- 5000000
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import type { PolicyFile } from '../src/config';
import { RateLimiterEngine } from '../src/engine/rate-limiter';
import type { RequestContext } from '../src/types';

const N = Number(process.argv[2] ?? 2_000_000);
const config = JSON.parse(readFileSync('config/policies.json', 'utf8')) as PolicyFile;

const engine = new RateLimiterEngine();
for (const t of config.tenants) engine.setTenantPolicies(t.tenantId, t.policies);

// Realistic mix: 20k users, 50k addresses (1/3 IPv6), several routes, all priorities.
const routes = [
  ['GET', '/api/v1/items'],
  ['GET', '/api/v1/items/42'],
  ['POST', '/api/v1/payments'],
  ['POST', '/auth/login'],
  ['POST', '/checkout'],
] as const;
const priorities = ['critical', 'standard', 'background'] as const;
const POOL = 100_000;
const contexts: RequestContext[] = Array.from({ length: POOL }, (_, i) => {
  const ip = i % 3 === 0 ? `2001:db8:${(i % 50_000).toString(16)}::${(i * 7).toString(16)}` : `198.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
  const [method, route] = routes[i % routes.length]!;
  return {
    tenantId: 'org-acme-prod',
    clientIp: ip,
    userId: `usr_${i % 20_000}`,
    route,
    method,
    headers: {},
    priority: priorities[i % 3],
  };
});

// Warm up the JIT.
for (let i = 0; i < 200_000; i++) engine.evaluate(contexts[i % POOL]!);

let allowed = 0;
const start = performance.now();
for (let i = 0; i < N; i++) {
  if (engine.evaluate(contexts[i % POOL]!).allowed) allowed++;
}
const elapsedMs = performance.now() - start;

const perSec = Math.round(N / (elapsedMs / 1000));
const m = engine.getTenantMetrics('org-acme-prod');
console.log(`evaluations:        ${N.toLocaleString()}`);
console.log(`elapsed:            ${elapsedMs.toFixed(0)} ms`);
console.log(`throughput:         ${perSec.toLocaleString()} evaluations/sec (single thread)`);
console.log(`mean latency:       ${((elapsedMs * 1000) / N).toFixed(2)} µs/evaluation`);
console.log(`allowed / blocked:  ${allowed.toLocaleString()} / ${(N - allowed).toLocaleString()}`);
console.log(`tracked keys:       ${m.activeTrackedKeys.toLocaleString()}`);
console.log(`estimated memory:   ${(m.currentMemoryEstimatedBytes / 1024 / 1024).toFixed(1)} MiB`);
console.log(perSec > 20_000 ? 'PASS: > 20,000 evaluations/sec' : 'FAIL: below 20,000 evaluations/sec');
