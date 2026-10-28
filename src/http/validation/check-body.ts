import { isObject, isStringOfLength as str } from './primitives';

const PRIORITIES = ['critical', 'standard', 'background'];

/**
 * Validates the body of POST /v1/rate-limit/check.
 * Returns an error message, or undefined when the body is a valid RequestContext.
 * Length limits keep attacker-sized strings out of keys and logs.
 */
export function validateCheckBody(b: unknown): string | undefined {
  if (!isObject(b)) return 'body must be a JSON object';
  if (!str(b.tenantId, 1, 128)) return 'tenantId: string (1-128) required';
  if (!str(b.clientIp, 1, 64)) return 'clientIp: string (1-64) required';
  if (!str(b.route, 1, 2048)) return 'route: string (1-2048) required';
  if (!str(b.method, 1, 16)) return 'method: string (1-16) required';
  if (b.userId !== undefined && !str(b.userId, 1, 256)) return 'userId: string (1-256)';
  if (b.priority !== undefined && !PRIORITIES.includes(b.priority as string)) return 'priority: critical|standard|background';
  if (b.cost !== undefined && !(Number.isInteger(b.cost) && (b.cost as number) >= 1 && (b.cost as number) <= 10_000)) {
    return 'cost: integer 1-10000';
  }
  if (b.headers !== undefined) return validateHeaders(b.headers);
  return undefined;
}

function validateHeaders(headers: unknown): string | undefined {
  if (!isObject(headers) || Object.keys(headers).length > 64) return 'headers: object with at most 64 entries';
  for (const v of Object.values(headers)) {
    const ok = typeof v === 'string' || (Array.isArray(v) && v.every((x) => typeof x === 'string'));
    if (!ok) return 'headers: values must be string or string[]';
  }
  return undefined;
}
