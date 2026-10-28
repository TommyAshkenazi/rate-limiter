import type { Priority } from './policy';

/** What the caller tells us about one incoming request (the spec's RequestContext). */
export interface RequestContext {
  tenantId: string;
  clientIp: string;
  userId?: string;
  route: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | string;
  headers: Record<string, string | string[] | undefined>;
  priority?: Priority;
  cost?: number; // default: 1 token
}
