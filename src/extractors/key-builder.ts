import type { KeyDimension } from '../types';
import type { ExtractionContext } from './extraction-context';
import { getHeader } from './headers';
import { escapeKeyValue } from './key-value-escape';

/** Which request attributes a policy keys on. */
export interface KeySpec {
  dimensions: KeyDimension[];
  headerName?: string;
  ipv6SubnetMask: number;
  ipv4SubnetMask: number;
}

/**
 * Builds the composite key for one policy, e.g.
 *   "ip=2001:db8:85a3::/64|route=POST /auth/login"
 *
 * Returns undefined when a required dimension is absent (e.g. anonymous request
 * under a per-user policy) — the policy then doesn't apply, and IP-keyed policies
 * are expected to cover anonymous traffic.
 *
 * `routeKey` is the policy's matched pattern when it has one ("/users/:id"), so
 * keying by route can't explode into one bucket per user id in the path.
 * A policy with no dimensions (a tenant-wide pool) gets the single key "*".
 */
export function buildKey(spec: KeySpec, x: ExtractionContext, routeKey: string): string | undefined {
  let key = '';
  for (const dim of spec.dimensions) {
    const part = keyPart(dim, spec, x, routeKey);
    if (part === undefined) return undefined;
    key = key ? `${key}|${part}` : part;
  }
  return key || '*';
}

/** One "name=value" segment of the key, or undefined if the request lacks that attribute. */
function keyPart(dim: KeyDimension, spec: KeySpec, x: ExtractionContext, routeKey: string): string | undefined {
  switch (dim) {
    case 'ip':
      return `ip=${x.ip(spec.ipv6SubnetMask, spec.ipv4SubnetMask)}`;
    case 'userId': {
      const user = x.user();
      return user === undefined ? undefined : `user=${escapeKeyValue(user)}`;
    }
    case 'route':
      return `route=${x.method} ${escapeKeyValue(routeKey)}`;
    case 'header': {
      const value = spec.headerName ? getHeader(x.ctx.headers, spec.headerName) : undefined;
      if (value === undefined || value === '') return undefined;
      return `h:${spec.headerName!.toLowerCase()}=${escapeKeyValue(value)}`;
    }
    default:
      return undefined;
  }
}
