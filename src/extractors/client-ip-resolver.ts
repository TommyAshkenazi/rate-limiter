import { Cidr } from './cidr';
import { formatIp } from './ip-format';
import { parseIp } from './ip-parse';
import { getHeader } from './headers';

export interface ClientIpResolverOptions {
  /** CIDRs of proxies we control (load balancer, ingress, Cloudflare ranges...). */
  trustedProxies?: string[];
  /**
   * Optional single-value header set by a trusted edge (e.g. "cf-connecting-ip",
   * "true-client-ip"). Only honoured when the TCP peer itself is a trusted proxy.
   */
  clientIpHeader?: string;
}

/**
 * Determines the real client address of an L7 request.
 *
 * X-Forwarded-For is a list that every hop *appends* to, so only the right-hand
 * entries were written by infrastructure we trust; anything to the left may have
 * been supplied by the client. We walk from the right (starting at the TCP peer)
 * and stop at the first address that is NOT a trusted proxy — that is the client.
 * A client spoofing "X-Forwarded-For: 1.2.3.4" just adds an entry on the left that
 * we never reach.
 */
export class ClientIpResolver {
  private readonly trusted: Cidr[];
  private readonly clientIpHeader?: string;

  constructor(options: ClientIpResolverOptions = {}) {
    this.trusted = (options.trustedProxies ?? []).map((c) => Cidr.parse(c));
    this.clientIpHeader = options.clientIpHeader?.toLowerCase();
  }

  isTrusted(address: string): boolean {
    const ip = parseIp(address);
    return ip !== undefined && this.trusted.some((c) => c.contains(ip));
  }

  resolve(remoteAddress: string | undefined, headers: Record<string, string | string[] | undefined>): string {
    const peer = normalise(remoteAddress ?? '');
    // Peer is not one of our proxies: headers are attacker-controlled, ignore them entirely.
    if (!peer || !this.isTrusted(peer)) return peer || 'invalid';

    if (this.clientIpHeader) {
      const value = normalise(getHeader(headers, this.clientIpHeader) ?? '');
      if (value) return value;
    }

    const xff = headers['x-forwarded-for'];
    const hops = (Array.isArray(xff) ? xff.join(',') : (xff ?? ''))
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean);

    let candidate = peer;
    for (let i = hops.length - 1; i >= 0; i--) {
      const hop = normalise(hops[i]!);
      // A malformed entry in the trusted part of the chain means the chain can't be
      // trusted past this point; use the last hop we could verify.
      if (!hop) return candidate;
      candidate = hop;
      if (!this.isTrusted(hop)) return hop;
    }
    // Every hop was a trusted proxy (e.g. internal health checks): use the left-most.
    return candidate;
  }
}

function normalise(raw: string): string | undefined {
  const ip = parseIp(raw);
  return ip ? formatIp(ip) : undefined;
}
