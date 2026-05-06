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
import { createError } from './error-handler.js';

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
        /**
         * App branding for verification emails (1.0.0+).
         * Set by operator at issuance via api_keys.brand_config.
         * Per-app domains must be verified in the shared Resend account.
         */
        brandConfig?: {
          app_name?: string;
          from_email?: string;
          from_name?: string;
          subjects?: Record<string, string>;
        };
        /**
         * Methods this key may auto-approve manual verifications for, e.g.
         * ["manual_review:in_person"]. Empty/null means submissions queue
         * for admin review. Granted by operator after onboarding review.
         */
        verificationAuthority?: string[];
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
export async function requirePortalAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token = extractToken(req);
    if (!token) {
      return next(createError('Missing authorization token', 401, 'UNAUTHORIZED'));
    }

    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);

    if (error || !user) {
      return next(createError('Invalid or expired token', 401, 'UNAUTHORIZED'));
    }

    req.user = { id: user.id, email: user.email };
    req.supabaseClient = createUserClient(token);
    next();
  } catch {
    return next(createError('Authentication failed', 401, 'UNAUTHORIZED'));
  }
}

/**
 * Require Commons Admin authentication.
 * Validates JWT + checks user ID against COMMONS_ADMIN_USER_IDS.
 */
export async function requireCommonsAdmin(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token = extractToken(req);
    if (!token) {
      return next(createError('Missing authorization token', 401, 'UNAUTHORIZED'));
    }

    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);

    if (error || !user) {
      return next(createError('Invalid or expired token', 401, 'UNAUTHORIZED'));
    }

    if (!config.admin.userIds.includes(user.id)) {
      return next(createError('Not a commons admin', 403, 'FORBIDDEN'));
    }

    req.user = { id: user.id, email: user.email };
    req.supabaseClient = createUserClient(token);
    next();
  } catch {
    return next(createError('Authentication failed', 401, 'UNAUTHORIZED'));
  }
}
