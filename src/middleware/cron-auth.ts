/**
 * Cron Authentication Middleware
 *
 * Verifies cron secret header for scheduled job endpoints. Errors flow
 * through next(createError(...)) so the global error handler produces
 * the canonical `{ error: { code, message } }` shape in one place.
 */

import { config } from '../config.js';
import { constantTimeCompare } from '../lib/helpers.js';
import { createError } from './error-handler.js';
import type { Request, Response, NextFunction } from 'express';

export function requireCronSecret(req: Request, _res: Response, next: NextFunction): void {
  const secret = req.headers['x-cron-secret'];

  if (!config.cron.secret) {
    return next(createError('Cron not configured', 403, 'FORBIDDEN'));
  }

  if (typeof secret !== 'string' || !constantTimeCompare(secret, config.cron.secret)) {
    return next(createError('Invalid cron secret', 403, 'FORBIDDEN'));
  }

  next();
}
