import type { CompiledPolicy } from './compiled-policy';

/**
 * Does this policy apply to the request? Returns the route key to use in the
 * bucket key (the matched pattern, e.g. "/users/:id"), or undefined if it doesn't apply.
 */
export function matchPolicy(compiled: CompiledPolicy, method: string, route: string): string | undefined {
  if (compiled.methods && !compiled.methods.has(method)) return undefined;
  if (!compiled.routes) return route;
  const hit = compiled.routes.find((r) => r.test(route));
  return hit?.pattern;
}
