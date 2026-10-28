import { readFileSync } from 'node:fs';
import type { StoreFullBehaviour } from './engine/storage/store-options';
import type { PolicyTemplate } from './engine/rate-limiter';
import type { FailMode, TenantConfig } from './types';

export interface PolicyFile {
  tenants: TenantConfig[];
  defaultTenantPolicies?: PolicyTemplate[];
}

export interface AppConfig {
  port: number;
  host: string;
  failMode: FailMode;
  adminToken?: string;
  maxTrackedKeysPerPolicy: number;
  onStoreFull: StoreFullBehaviour;
  maxDynamicTenants: number;
  sweepIntervalMs: number;
  policies: PolicyFile;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function loadConfig(env = process.env): AppConfig {
  const failMode = (env.FAIL_MODE ?? 'open') as FailMode;
  if (failMode !== 'open' && failMode !== 'closed') throw new Error('FAIL_MODE must be "open" or "closed"');
  const policyPath = env.POLICY_FILE ?? 'config/policies.json';
  const policies = JSON.parse(readFileSync(policyPath, 'utf8')) as PolicyFile;
  return {
    port: int('PORT', 3000),
    host: env.HOST ?? '0.0.0.0',
    failMode,
    adminToken: env.ADMIN_TOKEN || undefined,
    maxTrackedKeysPerPolicy: int('MAX_TRACKED_KEYS_PER_POLICY', 1_000_000),
    // Fail-closed deployments also refuse to forget live buckets under key floods.
    onStoreFull: (env.ON_STORE_FULL as StoreFullBehaviour | undefined) ?? (failMode === 'closed' ? 'reject-new' : 'evict-lru'),
    maxDynamicTenants: int('MAX_DYNAMIC_TENANTS', 1_000),
    sweepIntervalMs: int('SWEEP_INTERVAL_MS', 5_000),
    policies,
  };
}
