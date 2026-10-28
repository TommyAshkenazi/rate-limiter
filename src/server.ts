import { loadConfig } from './config';
import { RateLimiterEngine } from './engine/rate-limiter';
import { buildApp } from './http/app';

function log(msg: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level: 'info', time: Date.now(), msg, ...extra }));
}

function main(): void {
  const config = loadConfig();

  const engine = new RateLimiterEngine({
    defaultMaxTrackedKeys: config.maxTrackedKeysPerPolicy,
    onStoreFull: config.onStoreFull,
    defaultTenantPolicies: config.policies.defaultTenantPolicies,
    maxDynamicTenants: config.maxDynamicTenants,
    sweepIntervalMs: config.sweepIntervalMs,
  });
  for (const tenant of config.policies.tenants) {
    engine.setTenantPolicies(tenant.tenantId, tenant.policies);
  }
  engine.start();

  const app = buildApp({ engine, failMode: config.failMode, adminToken: config.adminToken, logger: true });
  const server = app.listen(config.port, config.host, () => {
    log('rate limiter ready', {
      port: config.port,
      tenants: config.policies.tenants.length,
      failMode: config.failMode,
      onStoreFull: config.onStoreFull,
    });
  });

  const shutdown = (signal: string) => {
    log('shutting down', { signal });
    engine.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
