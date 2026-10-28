import { createHash } from 'node:crypto';

const MAX_VALUE_LENGTH = 128;

/**
 * Make a value safe to embed in a composite key:
 * - `|` separates key segments, so it is escaped ("a|user=b" can't forge a segment);
 * - oversized values (attacker-controlled headers) are hashed so key memory stays bounded.
 */
export function escapeKeyValue(value: string): string {
  if (value.length > MAX_VALUE_LENGTH) {
    return `#${createHash('sha256').update(value).digest('base64url').slice(0, 22)}`;
  }
  return value.includes('|') ? value.replace(/\|/g, '%7C') : value;
}
