import type { RequestContext } from '../types';
import { clientIpKey } from './client-ip-key';
import { extractUserId } from './identity';

/**
 * Values derived from ONE request, computed lazily and shared by every policy
 * evaluated for it — so a request checked against 5 policies parses its IP once.
 */
export class ExtractionContext {
  private userId?: string | null;
  private readonly ipKeys = new Map<number, string>();

  constructor(
    readonly ctx: RequestContext,
    readonly normalizedRoute: string,
    readonly method: string,
  ) {}

  user(): string | undefined {
    if (this.userId === undefined) this.userId = extractUserId(this.ctx) ?? null;
    return this.userId ?? undefined;
  }

  /** The masked IP key; cached per (v6 mask, v4 mask) since policies may use different masks. */
  ip(v6Mask: number, v4Mask: number): string {
    const cacheKey = v6Mask * 256 + v4Mask;
    let key = this.ipKeys.get(cacheKey);
    if (key === undefined) {
      key = clientIpKey(this.ctx.clientIp, v6Mask, v4Mask);
      this.ipKeys.set(cacheKey, key);
    }
    return key;
  }
}
