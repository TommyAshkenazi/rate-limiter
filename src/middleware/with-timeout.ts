export class LimiterTimeoutError extends Error {}

/**
 * Reject if `value` (a promise) doesn't settle within `ms`. Synchronous values pass
 * straight through, so the in-process engine pays nothing for this.
 */
export function withTimeout<T>(value: T | Promise<T>, ms: number): T | Promise<T> {
  if (!(value instanceof Promise)) return value;
  let timer: NodeJS.Timeout;
  return Promise.race([
    value,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new LimiterTimeoutError(`rate limiter timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
