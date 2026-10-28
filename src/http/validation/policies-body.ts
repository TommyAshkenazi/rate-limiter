import { isObject } from './primitives';

/**
 * Validates the envelope of PUT /v1/tenants/{id}/policies. The policies themselves
 * are validated by the engine when it compiles them.
 */
export function validatePoliciesBody(b: unknown): string | undefined {
  if (!isObject(b) || !Array.isArray(b.policies)) return 'policies: array required';
  return undefined;
}
