import type { ParsedIp } from './ip-parse';

/**
 * Keep the first `prefix` bits of the address and zero the rest.
 * e.g. 2001:db8:85a3:0:8a2e:370:7334:1 with prefix 64 -> 2001:db8:85a3:0:0:0:0:0
 */
export function maskIp(ip: ParsedIp, prefix: number): ParsedIp {
  if (ip.version === 4) {
    const bits = Math.max(0, Math.min(32, prefix));
    if (bits === 32) return ip;
    if (bits === 0) return { version: 4, value: 0 };
    const mask = (0xffffffff << (32 - bits)) >>> 0;
    return { version: 4, value: (ip.value & mask) >>> 0 };
  }

  const bits = Math.max(0, Math.min(128, prefix));
  const groups = ip.groups.map((g, i) => {
    // How many bits of this 16-bit group survive the mask.
    const keep = Math.max(0, Math.min(16, bits - i * 16));
    if (keep === 16) return g;
    if (keep === 0) return 0;
    return g & ((0xffff << (16 - keep)) & 0xffff);
  });
  return { version: 6, groups };
}
