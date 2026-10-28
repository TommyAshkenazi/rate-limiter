import { isObject, isStringOfLength as str } from './primitives';

/** Validates the body of POST /v1/rate-limit/reset. Returns an error message or undefined. */
export function validateResetBody(b: unknown): string | undefined {
  if (!isObject(b)) return 'body must be a JSON object';
  if (!str(b.tenantId, 1, 1024)) return 'tenantId: string required';
  if (b.policyId !== undefined && !str(b.policyId, 1, 1024)) return 'policyId: string';
  if (b.dimensions !== undefined) {
    if (!isObject(b.dimensions)) return 'dimensions: object';
    for (const k of ['ip', 'userId', 'route']) {
      if (b.dimensions[k] !== undefined && typeof b.dimensions[k] !== 'string') return `dimensions.${k}: string`;
    }
  }
  return undefined;
}
