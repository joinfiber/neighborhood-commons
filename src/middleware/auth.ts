/**
 * Authentication Middleware — Neighborhood Commons
 *
 * Two auth models in this file:
 * 1. requirePortalAuth  — Supabase JWT from portal operators
 * 2. requireCommonsAdmin — JWT + admin user ID check
 *
 * API-key auth (X-API-Key header, contributor-tier scoped) lives in
 * src/middleware/api-key.ts. CLAUDE.md mandates exactly four auth models
 * project-wide; there is no service-to-service sync model here anymore.
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
        tier?: string;
        isAdmin?: boolean;
        /**
         * The portal_account this key is linked to via api_key_account_links.
         * For Contribute keys this is the stable ownership identity — it
         * survives key rotation. Service keys may link to multiple accounts;
         * `linkedAccountId` here is the first (or only) linked account, used
         * by Contribute-style ownership checks. Service-tier code that needs
         * the full set should query api_key_account_links directly.
         */
        linkedAccountId?: string;
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
