import { createHash } from 'node:crypto';
import type { RequestContext } from '../types';
import { getHeader } from './headers';

function digest(secret: string): string {
  return createHash('sha256').update(secret).digest('base64url').slice(0, 22);
}

/**
 * Identity used for the `userId` dimension, in order of trust:
 *  1. `ctx.userId` — set by the caller after it authenticated the request.
 *  2. Bearer token / X-API-Key — hashed, never stored in clear text. We deliberately
 *     do NOT decode an unverified JWT and key by its `sub`: anyone could mint a token
 *     claiming a victim's `sub` and exhaust the victim's quota. Keying by the token
 *     itself means a forged token only ever hurts its own bucket.
 */
export function extractUserId(ctx: RequestContext): string | undefined {
  if (ctx.userId) return ctx.userId;

  const auth = getHeader(ctx.headers, 'authorization');
  if (auth && auth.length > 7 && auth.slice(0, 7).toLowerCase() === 'bearer ') {
    const token = auth.slice(7).trim();
    if (token) return `tok_${digest(token)}`;
  }

  const apiKey = getHeader(ctx.headers, 'x-api-key');
  if (apiKey) return `key_${digest(apiKey)}`;

  return undefined;
}
