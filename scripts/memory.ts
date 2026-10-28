/**
 * Measures real retained heap per tracked key and compares it with the engine's estimate.
 *   npm run bench:memory            # 1,000,000 unique IPs
 */
import { ManualClock } from '../src/clock';
import { RateLimiterEngine } from '../src/engine/rate-limiter';
import type { AlgorithmName } from '../src/types';

const KEYS = Number(process.argv[2] ?? 1_000_000);
const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error('run with --expose-gc (npm run bench:memory)');

function measure(algorithm: AlgorithmName, v6: boolean): void {
  const clock = new ManualClock();
  const engine = new RateLimiterEngine({ clock, defaultMaxTrackedKeys: KEYS * 2 });
  engine.setTenantPolicies('t', [
    {
      id: 'per-ip',
      tenantId: 't',
      name: 'per-ip',
      algorithm,
      capacity: 100,
      refillRatePerSecond: 10,
      windowSizeSeconds: 60,
      keyStrategy: { dimensions: ['ip'], ipv6SubnetMask: 64 },
    },
  ]);
  gc!();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < KEYS; i++) {
    const ip = v6
      ? `2001:db8:${((i >>> 16) & 0xffff).toString(16)}:${(i & 0xffff).toString(16)}::1`
      : `10.${(i >>> 16) & 255}.${(i >>> 8) & 255}.${i & 255}`;
    engine.evaluate({ tenantId: 't', clientIp: ip, route: '/', method: 'GET', headers: {} });
  }
  gc!();
  const after = process.memoryUsage().heapUsed;
  const m = engine.getTenantMetrics('t');
  const real = (after - before) / m.activeTrackedKeys;
  const est = m.currentMemoryEstimatedBytes / m.activeTrackedKeys;
  console.log(
    `${algorithm.padEnd(15)} ${v6 ? 'IPv6 /64' : 'IPv4    '}  keys=${m.activeTrackedKeys.toLocaleString().padStart(9)}  ` +
      `measured=${real.toFixed(0).padStart(4)} B/key  estimated=${est.toFixed(0).padStart(4)} B/key  ` +
      `total=${((after - before) / 1024 / 1024).toFixed(0)} MiB`,
  );
}

for (const algo of ['token-bucket', 'sliding-window', 'leaky-bucket'] as const) {
  measure(algo, false);
  measure(algo, true);
}
