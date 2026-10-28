import type { ParsedIp } from './ip-parse';

/** RFC 5952 canonical text: lowercase, no leading zeros, longest zero run (>=2 groups) compressed to "::". */
export function formatIp(ip: ParsedIp): string {
  if (ip.version === 4) {
    const v = ip.value;
    return `${Math.floor(v / 0x1000000) & 255}.${(v >>> 16) & 255}.${(v >>> 8) & 255}.${v & 255}`;
  }

  const g = ip.groups;
  const { start, length } = longestZeroRun(g);
  const hex = (arr: number[]) => arr.map((x) => x.toString(16)).join(':');
  if (start < 0) return hex(g);
  return `${hex(g.slice(0, start))}::${hex(g.slice(start + length))}`;
}

/** Position of the longest run of zero groups (at least 2), or start = -1 if none. */
function longestZeroRun(groups: number[]): { start: number; length: number } {
  let start = -1;
  let length = 0;
  for (let i = 0; i < groups.length; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < groups.length && groups[j] === 0) j++;
    if (j - i > length && j - i >= 2) {
      start = i;
      length = j - i;
    }
    i = j;
  }
  return { start, length };
}
