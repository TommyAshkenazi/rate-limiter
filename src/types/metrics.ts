/** Body of GET /v1/tenants/{tenantId}/metrics. */
export interface TenantMetrics {
  tenantId: string;
  activeTrackedKeys: number;
  totalEvaluations: number;
  allowedCount: number;
  blockedCount: number;
  noisyNeighborsIsolated: number;
  currentMemoryEstimatedBytes: number;
}
