import type { ErrorRequestHandler } from 'express';
import type { Logger } from '../logger';
import { sendError } from '../responses/send-error';

/** Malformed JSON, oversized bodies, unexpected throws -> JSON error instead of an HTML stack trace. */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err: { status?: number; statusCode?: number }, _req, res, _next) => {
    const status = err.status ?? err.statusCode ?? 500;
    if (status >= 500) {
      logger.error('unhandled error', err);
      sendError(res, 500, 'INTERNAL_ERROR');
    } else {
      sendError(res, status, 'INVALID_REQUEST');
    }
  };
}
