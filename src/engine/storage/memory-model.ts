/**
 * Retained-size model of one Map entry (64-bit V8; verified by scripts/memory.ts,
 * see DECISIONS.md §4): OrderedHashMap slot + bucket share, and the string header of the key.
 */
export const MAP_ENTRY_BYTES = 40;
export const STRING_HEADER_BYTES = 24;

/**
 * Keys are built by concatenation, which V8 represents as a ConsString (a rope of
 * pieces, 32B header each). Kept as a Map key, the rope and all its pieces stay
 * alive. Converting to a number forces V8 to flatten it; the GC then drops the rope.
 * Measured: IPv6 keys 237 -> ~120 B/entry.
 */
let flattenSink = 0;
export function flattenKey(s: string): string {
  flattenSink ^= (s as unknown as number) | 0;
  return s;
}
