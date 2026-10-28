import { formatIp } from './ip-format';
import { maskIp } from './ip-mask';
import { parseIp } from './ip-parse';

/**
 * Rate-limiting identity for an address: IPv4 by default exact (/32), IPv6 grouped
 * to the /64 an ISP hands to one subscriber. Returns e.g. "203.0.113.7" or "2001:db8:85a3::/64".
 * Unparseable input maps to one shared "invalid" bucket so garbage can't dodge the limit.
 */
export function clientIpKey(raw: string, ipv6Prefix = 64, ipv4Prefix = 32): string {
  const parsed = parseIp(raw);
  if (!parsed) return 'invalid';
  const prefix = parsed.version === 4 ? ipv4Prefix : ipv6Prefix;
  const fullLength = parsed.version === 4 ? 32 : 128;
  const text = formatIp(maskIp(parsed, prefix));
  return prefix >= fullLength ? text : `${text}/${prefix}`;
}
