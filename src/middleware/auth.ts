/**
 * Authentication Middleware — The Fiber Commons
 *
 * Two auth models:
 * 1. requirePortalAuth — Supabase JWT from portal businesses
 * 2. requireCommonsAdmin — JWT + admin user ID check
 * 3. requireServiceKey — service-to-service auth (internal sync)
 */

import { Request, Response, NextFunction } from 'express';
import { SupabaseClient } from '@supabase/supabase-js';
import { createUserClient, supabaseAdmin } from '../lib/supabase.js';
import { config } from '../config.js';

// Extend Express Request
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email?: string | undefined;
      };
      portalAccountId?: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabaseClient?: SupabaseClient<any, 'public', any>;
      apiKeyInfo?: {
        id: string;
        tier: string;
        rate_limit_per_hour: number;
      };
    }
  }
}

/**
 * Extract bearer token from Authorization header.
 */
function extractToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  return authHeader.slice(7);
}

/**
 * Require portal business authentication.
 * Validates Supabase JWT and attaches user + supabaseClient to request.
 */
export async function requirePortalAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = extractToken(req);
    if (!token) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing authorization token' } });
      return;
    }

    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);

    if (error || !user) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } });
      return;
    }

    req.user = { id: user.id, email: user.email };
    req.supabaseClient = createUserClient(token);
    next();
  } catch {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication failed' } });
  }
}

/**
 * Require Commons Admin authentication.
 * Validates JWT + checks user ID against COMMONS_ADMIN_USER_IDS.
 */
export async function requireCommonsAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = extractToken(req);
    if (!token) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing authorization token' } });
      return;
    }

    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);

    if (error || !user) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } });
      return;
    }

    if (!config.admin.userIds.includes(user.id)) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Not a commons admin' } });
      return;
    }

    req.user = { id: user.id, email: user.email };
    req.supabaseClient = createUserClient(token);
    next();
  } catch {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication failed' } });
  }
}

/**
 * Require service key authentication (internal sync endpoint).
 */
export function requireServiceKey(req: Request, res: Response, next: NextFunction): void {
  const token = extractToken(req);

  if (!config.internal.serviceKey) {
    res.status(503).json({ error: { code: 'NOT_CONFIGURED', message: 'Service key not configured' } });
    return;
  }

  if (!token || token !== config.internal.serviceKey) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid service key' } });
    return;
  }

  next();
}
