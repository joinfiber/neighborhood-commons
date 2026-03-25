/**
 * API Key Middleware — Neighborhood Commons
 *
 * Optional API key extraction. If present and valid, attaches key info
 * to the request for rate limit keying. If absent, requests proceed
 * with IP-based rate limiting.
 *
 * Keys exist as an upgrade path for consumers who need higher limits,
 * not as a gate on public data.
 */

import { createHash } from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';

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
export async function requireApiKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || typeof apiKey !== 'string') {
    res.status(401).json({ error: { code: 'API_KEY_REQUIRED', message: 'X-API-Key header is required' } });
    return;
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
      res.status(401).json({ error: { code: 'INVALID_API_KEY', message: 'Invalid or inactive API key' } });
      return;
    }

    req.apiKeyInfo = { id: keyInfo.id, tier: keyInfo.contributor_tier };
    next();
  } catch {
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'API key validation failed' } });
  }
}

/**
 * Require a service-tier API key. Full CRUD access to accounts and events.
 * Service keys are issued manually by the platform operator.
 */
export async function requireServiceApiKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || typeof apiKey !== 'string') {
    res.status(401).json({ error: { code: 'API_KEY_REQUIRED', message: 'X-API-Key header is required' } });
    return;
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
      res.status(401).json({ error: { code: 'INVALID_API_KEY', message: 'Invalid or inactive API key' } });
      return;
    }

    if (keyInfo.contributor_tier !== 'service') {
      res.status(403).json({ error: { code: 'INSUFFICIENT_TIER', message: 'This endpoint requires a service-tier API key' } });
      return;
    }

    req.apiKeyInfo = { id: keyInfo.id, tier: keyInfo.contributor_tier };
    next();
  } catch {
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'API key validation failed' } });
  }
}
