/**
 * API Key Middleware — The Fiber Commons
 *
 * Extracts X-API-Key header and attaches tier info to request.
 * Used by v1 Neighborhood API for tiered rate limits.
 */

import { Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';

/**
 * Optional API key extraction. Does not reject requests without a key.
 * Attaches apiKeyInfo to request for downstream rate limiting.
 */
export async function optionalApiKey(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || typeof apiKey !== 'string') {
    next();
    return;
  }

  try {
    const { data: keyInfo } = await supabaseAdmin
      .from('api_keys')
      .select('id, tier, rate_limit_per_hour')
      .eq('key', apiKey)
      .eq('is_active', true)
      .maybeSingle();

    if (keyInfo) {
      req.apiKeyInfo = {
        id: keyInfo.id,
        tier: keyInfo.tier,
        rate_limit_per_hour: keyInfo.rate_limit_per_hour,
      };
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
    const { data: keyInfo } = await supabaseAdmin
      .from('api_keys')
      .select('id, tier, rate_limit_per_hour')
      .eq('key', apiKey)
      .eq('is_active', true)
      .maybeSingle();

    if (!keyInfo) {
      res.status(401).json({ error: { code: 'INVALID_API_KEY', message: 'Invalid or inactive API key' } });
      return;
    }

    req.apiKeyInfo = {
      id: keyInfo.id,
      tier: keyInfo.tier,
      rate_limit_per_hour: keyInfo.rate_limit_per_hour,
    };
    next();
  } catch {
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'API key validation failed' } });
  }
}
