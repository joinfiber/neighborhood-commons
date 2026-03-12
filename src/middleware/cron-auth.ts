/**
 * Cron Authentication Middleware
 *
 * Verifies cron secret header for scheduled job endpoints.
 */

import { config } from '../config.js';
import { constantTimeCompare } from '../lib/helpers.js';
import type { Request, Response, NextFunction } from 'express';

export function requireCronSecret(req: Request, res: Response, next: NextFunction): void {
  const secret = req.headers['x-cron-secret'];

  if (!config.cron.secret) {
    res.status(403).json({ error: 'Cron not configured' });
    return;
  }

  if (typeof secret !== 'string' || !constantTimeCompare(secret, config.cron.secret)) {
    res.status(403).json({ error: 'Invalid cron secret' });
    return;
  }

  next();
}
