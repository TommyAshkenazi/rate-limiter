import type { Response } from 'express';

/** Every error response has the same shape: { error: CODE, message?: detail }. */
export function sendError(res: Response, status: number, error: string, message?: string): void {
  res.status(status).json(message === undefined ? { error } : { error, message });
}
