/**
 * What callers see when the limiter itself fails:
 * - open:   let traffic through (availability first)
 * - closed: reject traffic (protection first)
 */
export type FailMode = 'open' | 'closed';
