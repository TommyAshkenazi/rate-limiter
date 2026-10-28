import { maskIp } from './ip-mask';
import { parseIp, type ParsedIp } from './ip-parse';

/** A network range such as "10.0.0.0/8" or "2400:cb00::/32", used for trusted proxies. */
export class Cidr {
  private constructor(
    private readonly network: ParsedIp,
    private readonly prefix: number,
  ) {}

  static parse(text: string): Cidr {
    const [addr, len] = text.split('/');
    const ip = addr ? parseIp(addr) : undefined;
    if (!ip) throw new Error(`invalid CIDR: ${text}`);
    const fullLength = ip.version === 4 ? 32 : 128;
    let prefix = len === undefined ? fullLength : Number(len);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > fullLength) throw new Error(`invalid CIDR: ${text}`);
    // "::ffff:10.0.0.0/104" was unwrapped to IPv4; shift the prefix accordingly.
    if (ip.version === 4 && addr!.includes(':')) prefix = Math.max(0, prefix - 96);
    return new Cidr(maskIp(ip, prefix), prefix);
  }

  contains(ip: ParsedIp): boolean {
    const masked = maskIp(ip, this.prefix);
    const net = this.network;
    if (masked.version === 4 && net.version === 4) return masked.value === net.value;
    if (masked.version === 6 && net.version === 6) return masked.groups.every((g, i) => g === net.groups[i]);
    return false;
  }
}
