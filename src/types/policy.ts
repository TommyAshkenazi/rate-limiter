/**
 * Rate-limit policy configuration (the spec's RateLimitPolicy + a few
 * fields marked "extension" that hierarchical evaluation needs).
 */

export type AlgorithmName = 'token-bucket' | 'sliding-window' | 'leaky-bucket';

export type KeyDimension = 'ip' | 'userId' | 'route' | 'header';

export type Priority = 'critical' | 'standard' | 'background';

/**
 * - `tenant`: one shared pool per tenant (optionally split by route/header).
 *   Denials are reported as TENANT_QUOTA_EXCEEDED, and priority shedding applies.
 * - `client`: one bucket per client key (ip / user / ...) inside the tenant.
 *   Denials are reported as CLIENT_KEY_EXCEEDED.
 */
export type PolicyScope = 'tenant' | 'client';

export interface RateLimitPolicy {
  id: string;
  tenantId: string;
  name: string;
  algorithm: AlgorithmName;
  /** Max tokens (token bucket), max requests per window (sliding window) or queue depth (leaky bucket). */
  capacity: number;
  /** Token bucket refill rate / leaky bucket leak rate. */
  refillRatePerSecond?: number;
  /** Sliding window size. For token/leaky bucket it is used to derive a rate when refillRatePerSecond is omitted. */
  windowSizeSeconds?: number;
  keyStrategy: {
    dimensions: KeyDimension[];
    headerName?: string;
    /** Prefix length applied to IPv6 client addresses. Default 64. */
    ipv6SubnetMask?: number;
    /** extension: prefix length applied to IPv4 client addresses. Default 32 (exact address). */
    ipv4SubnetMask?: number;
  };
  /**
   * Fraction of `capacity` a priority class may push utilisation up to.
   * e.g. { background: 0.9 } => background traffic is shed once the pool is >90% used.
   */
  priorityWeights?: Partial<Record<Priority, number>>;
  /** extension: defaults to 'tenant' when dimensions is empty, otherwise 'client'. */
  scope?: PolicyScope;
  /** extension: restrict the policy to some routes / methods. Omitted = applies to everything. */
  match?: {
    methods?: string[];
    /** Exact paths, `:param` segments, or a trailing `/*` wildcard. */
    routes?: string[];
  };
  /** extension: per-policy cap on tracked keys (memory bound). */
  maxTrackedKeys?: number;
}

/** A tenant and its policy set, as loaded from config/policies.json. */
export interface TenantConfig {
  tenantId: string;
  policies: RateLimitPolicy[];
}
