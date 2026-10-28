import type { RateLimiterEngine } from '../rate-limiter';

function label(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Prometheus text exposition format 0.0.4, generated on scrape (no per-request cost). */
export function renderPrometheus(engine: RateLimiterEngine): string {
  const lines: string[] = [];
  const family = (name: string, type: 'counter' | 'gauge', help: string) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
  };

  const snapshots = [...engine.snapshot()];

  family('ratelimit_evaluations_total', 'counter', 'Rate limit decisions by outcome.');
  for (const s of snapshots) {
    const t = label(s.tenantId);
    lines.push(`ratelimit_evaluations_total{tenant="${t}",decision="allowed"} ${s.metrics.allowedCount}`);
    for (const [reason, n] of Object.entries(s.blockedByReason)) {
      lines.push(`ratelimit_evaluations_total{tenant="${t}",decision="blocked",reason="${reason}"} ${n}`);
    }
  }

  family('ratelimit_noisy_neighbors_isolated_total', 'counter', 'Client keys contained by their own sub-quota.');
  for (const s of snapshots) {
    lines.push(`ratelimit_noisy_neighbors_isolated_total{tenant="${label(s.tenantId)}"} ${s.metrics.noisyNeighborsIsolated}`);
  }

  family('ratelimit_tracked_keys', 'gauge', 'Buckets currently held in memory.');
  for (const s of snapshots) {
    for (const p of s.policies) {
      lines.push(`ratelimit_tracked_keys{tenant="${label(s.tenantId)}",policy="${label(p.id)}"} ${p.keys}`);
    }
  }

  family('ratelimit_evictions_total', 'counter', 'Buckets removed from memory.');
  for (const s of snapshots) {
    for (const p of s.policies) {
      const base = `tenant="${label(s.tenantId)}",policy="${label(p.id)}"`;
      lines.push(`ratelimit_evictions_total{${base},cause="expired"} ${p.evictedExpired}`);
      lines.push(`ratelimit_evictions_total{${base},cause="capacity"} ${p.evictedCapacity}`);
      lines.push(`ratelimit_evictions_total{${base},cause="rejected_new"} ${p.rejectedNew}`);
    }
  }

  family('ratelimit_memory_estimated_bytes', 'gauge', 'Estimated retained bytes of limiter state.');
  for (const s of snapshots) {
    lines.push(`ratelimit_memory_estimated_bytes{tenant="${label(s.tenantId)}"} ${s.metrics.currentMemoryEstimatedBytes}`);
  }

  const mem = process.memoryUsage();
  family('process_heap_used_bytes', 'gauge', 'V8 heap in use.');
  lines.push(`process_heap_used_bytes ${mem.heapUsed}`);
  family('process_resident_memory_bytes', 'gauge', 'Resident set size.');
  lines.push(`process_resident_memory_bytes ${mem.rss}`);

  return `${lines.join('\n')}\n`;
}
