import { isIPv4, isIPv6 } from 'node:net';

/** An address as numbers, so it can be masked and compared bit by bit. */
export type ParsedIp =
  | { version: 4; value: number } // unsigned 32-bit
  | { version: 6; groups: number[] }; // eight 16-bit groups

/**
 * Parse any textual address. IPv4-mapped IPv6 (::ffff:a.b.c.d) is unwrapped to IPv4,
 * otherwise a dual-stack socket would give the same client two different keys.
 */
export function parseIp(raw: string): ParsedIp | undefined {
  const s = clean(raw);
  if (isIPv4(s)) return { version: 4, value: parseIPv4(s) };
  if (!isIPv6(s)) return undefined;
  const groups = parseIPv6(s);
  const isMapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  if (isMapped) return { version: 4, value: groups[6]! * 0x10000 + groups[7]! };
  return { version: 6, groups };
}

/** Strip brackets ("[::1]"), zone ids ("fe80::1%eth0") and an IPv4 port ("1.2.3.4:8080"). */
function clean(raw: string): string {
  let s = raw.trim();
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    if (end > 0) s = s.slice(1, end);
  }
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  // "a.b.c.d:port" — exactly one colon means IPv4 with a port, never IPv6.
  const colon = s.indexOf(':');
  if (colon > 0 && colon === s.lastIndexOf(':') && s.includes('.')) s = s.slice(0, colon);
  return s;
}

function parseIPv4(text: string): number {
  const parts = text.split('.');
  // Multiply instead of `<<` so the result stays an unsigned 32-bit value.
  return ((Number(parts[0]) * 256 + Number(parts[1])) * 256 + Number(parts[2])) * 256 + Number(parts[3]);
}

function parseIPv6(text: string): number[] {
  let input = text;
  // An embedded dotted quad (::ffff:1.2.3.4, 64:ff9b::1.2.3.4) becomes the last two groups.
  const lastColon = input.lastIndexOf(':');
  const tail = input.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail);
    input = `${input.slice(0, lastColon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }

  // "::" stands for "as many zero groups as needed to reach 8".
  const halves = input.split('::');
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  const groups: number[] = new Array<number>(8).fill(0);
  head.forEach((g, i) => (groups[i] = parseInt(g, 16)));
  rest.forEach((g, i) => (groups[8 - rest.length + i] = parseInt(g, 16)));
  return groups;
}
