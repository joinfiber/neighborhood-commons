/**
 * API Key Middleware — The Fiber Commons
 *
 * Validates X-API-Key header against api_keys table.
 * All v1 API access requires a valid key. Keys are free.
 */

import { Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';

/**
 * Require a valid API key. Rejects requests without one.
 */
export async function requireApiKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || typeof apiKey !== 'string') {
    res.status(401).json({
      error: {
        code: 'API_KEY_REQUIRED',
        message: 'X-API-Key header is required. Get a free key at https://commons.joinfiber.app/api/v1/events/terms',
      },
    });
    return;
  }

  try {
    const { data: keyInfo } = await supabaseAdmin
      .from('api_keys')
      .select('id')
      .eq('key', apiKey)
      .eq('is_active', true)
      .maybeSingle();

    if (!keyInfo) {
      res.status(401).json({ error: { code: 'INVALID_API_KEY', message: 'Invalid or inactive API key' } });
      return;
    }

    req.apiKeyInfo = { id: keyInfo.id };
    next();
  } catch {
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'API key validation failed' } });
  }
}
