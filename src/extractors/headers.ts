export type HeaderBag = Record<string, string | string[] | undefined>;

/**
 * Case-insensitive single-value header lookup. Node lowercases incoming headers,
 * but contexts posted to the HTTP API may not, so fall back to a scan.
 */
export function getHeader(headers: HeaderBag | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  let value = headers[lower];
  if (value === undefined) {
    for (const key in headers) {
      if (key.toLowerCase() === lower) {
        value = headers[key];
        break;
      }
    }
  }
  if (Array.isArray(value)) return value[0];
  return value;
}
