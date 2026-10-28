import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { sendError } from '../responses/send-error';

/**
 * Protects admin routes with "Authorization: Bearer <token>".
 * Without a configured token, admin routes are open (local development).
 * timingSafeEqual: comparison time doesn't reveal how many characters matched.
 */
export function requireAdmin(adminToken: string | undefined): RequestHandler {
  return (req, res, next) => {
    if (!adminToken) return next();
    const header = req.headers.authorization ?? '';
    const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
    const expected = Buffer.from(adminToken);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      sendError(res, 401, 'UNAUTHORIZED');
      return;
    }
    next();
  };
}
