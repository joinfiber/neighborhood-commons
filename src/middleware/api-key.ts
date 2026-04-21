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

    // Resolve the key's linked portal account (if any). For Contribute keys
    // this is the stable ownership identity — survives key rotation.
    const { data: link } = await supabaseAdmin
      .from('api_key_account_links')
      .select('portal_account_id')
      .eq('api_key_id', keyInfo.id)
      .limit(1)
      .maybeSingle();

    req.apiKeyInfo = {
      id: keyInfo.id,
      tier: keyInfo.contributor_tier,
      linkedAccountId: link?.portal_account_id || undefined,
    };
    next();
  } catch {
    return next(createError('API key validation failed', 500, 'INTERNAL_ERROR'));
  }
}

/**
 * Require a service-tier API key. Full CRUD access to accounts and events.
 * Service keys are issued manually by the platform operator.
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
      .select('id, contributor_tier, is_admin')
      .eq('key_hash', keyHash)
      .eq('status', 'active')
      .maybeSingle();

    if (!keyInfo) {
      return next(createError('Invalid or inactive API key', 401, 'INVALID_API_KEY'));
    }

    if (keyInfo.contributor_tier !== 'service') {
      return next(createError('This endpoint requires a service-tier API key', 403, 'INSUFFICIENT_TIER'));
    }

    req.apiKeyInfo = { id: keyInfo.id, tier: keyInfo.contributor_tier, isAdmin: keyInfo.is_admin === true };
    next();
  } catch {
    return next(createError('API key validation failed', 500, 'INTERNAL_ERROR'));
  }
}
