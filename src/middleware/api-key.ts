/**
 * API Key Middleware — Neighborhood Commons
 *
 * Optional API key extraction. If present and valid, attaches key info
 * to the request for rate limit keying. If absent, requests proceed
 * with IP-based rate limiting.
 *
 * Keys exist as an upgrade path for consumers who need higher limits,
 * not as a gate on public data.
 *
 * Errors flow through next(createError(...)) so the global error handler
 * produces the canonical `{ error: { code, message } }` shape in one place.
 */

import { createHash } from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { createError } from './error-handler.js';

// Extend Express Request with the API-key info we attach to authenticated
// requests. Lives here (not auth.ts) since this is the only middleware
// that populates it after the Portal JWT auth was retired.
declare global {
  namespace Express {
    interface Request {
      apiKeyInfo?: {
        id: string;
        tier?: string;
        isAdmin?: boolean;
        /**
         * App branding for verification emails (1.0.0+).
         * Set by operator at issuance via api_keys.brand_config.
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
        /**
         * Collective-witnessing capability flag (v2). When true, this key
         * may write events with `source_method='witnessed'` attributed to
         * a collective publisher organization (e.g., "Fiber Community").
         * The witnessed-evidence authority path bypasses
         * api_key_organization_links scope. Granted at activation.
         */
        witnessAuthority?: boolean;
      };
    }
  }
}

/** Hash an incoming raw API key to match the stored key_hash column. */
function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

/**
 * Optional API key extraction. Does not reject requests without a key.
 * If a key is present but invalid, the request proceeds without key info
 * (falls back to IP-based rate limiting).
 */
export async function optionalApiKey(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || typeof apiKey !== 'string') {
    next();
    return;
  }

  try {
    const keyHash = hashApiKey(apiKey);
    const { data: keyInfo } = await supabaseAdmin
      .from('api_keys')
      .select('id')
      .eq('key_hash', keyHash)
      .eq('status', 'active')
      .maybeSingle();

    if (keyInfo) {
      req.apiKeyInfo = { id: keyInfo.id };
    }
  } catch {
    // Non-fatal — proceed without API key info
  }

  next();
}

/**
 * Required API key validation. Rejects requests without a valid key.
 * Used for webhook subscription management.
 */
export async function requireApiKey(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || typeof apiKey !== 'string') {
    return next(createError('X-API-Key header is required', 401, 'API_KEY_REQUIRED'));
  }

  try {
    const keyHash = hashApiKey(apiKey);
    const { data: keyInfo } = await supabaseAdmin
      .from('api_keys')
      .select('id, contributor_tier')
      .eq('key_hash', keyHash)
      .eq('status', 'active')
      .maybeSingle();

    if (!keyInfo) {
      return next(createError('Invalid or inactive API key', 401, 'INVALID_API_KEY'));
    }

    req.apiKeyInfo = {
      id: keyInfo.id,
      tier: keyInfo.contributor_tier,
    };
    next();
  } catch {
    return next(createError('API key validation failed', 500, 'INTERNAL_ERROR'));
  }
}

/**
 * Require an activated service-tier API key. Full CRUD access to typed
 * resources, broadcasts, lists, verifications.
 *
 * Service keys can be self-issued via `/v1/service/register/*` — those land
 * with `activated_at = NULL` and authenticate for reads but get rejected
 * here with `KEY_PENDING` until a one-time admin review flips them on.
 */
export async function requireServiceApiKey(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || typeof apiKey !== 'string') {
    return next(createError('X-API-Key header is required', 401, 'API_KEY_REQUIRED'));
  }

  try {
    const keyHash = hashApiKey(apiKey);
    const { data: keyInfo } = await supabaseAdmin
      .from('api_keys')
      .select('id, contributor_tier, is_admin, brand_config, verification_authority, witness_authority, activated_at')
      .eq('key_hash', keyHash)
      .eq('status', 'active')
      .maybeSingle();

    if (!keyInfo) {
      return next(createError('Invalid or inactive API key', 401, 'INVALID_API_KEY'));
    }

    if (keyInfo.contributor_tier !== 'service') {
      return next(createError('This endpoint requires a service-tier API key', 403, 'INSUFFICIENT_TIER'));
    }

    if (keyInfo.activated_at === null) {
      return next(createError(
        'Your service key is registered but pending one-time activation. Reads work; writes resume after activation. Email hi@neighborhood-commons.org to request activation.',
        403,
        'KEY_PENDING',
      ));
    }

    req.apiKeyInfo = {
      id: keyInfo.id,
      tier: keyInfo.contributor_tier,
      isAdmin: keyInfo.is_admin === true,
      brandConfig: (keyInfo.brand_config as Record<string, unknown> | null) || undefined,
      verificationAuthority: Array.isArray(keyInfo.verification_authority)
        ? (keyInfo.verification_authority as string[])
        : undefined,
      witnessAuthority: keyInfo.witness_authority === true,
    };
    next();
  } catch {
    return next(createError('API key validation failed', 500, 'INTERNAL_ERROR'));
  }
}
