/**
 * Internal Routes — Neighborhood Commons
 *
 * Health check endpoint for infrastructure monitoring.
 */

import { Router } from 'express';
import { readFileSync } from 'fs';
import { supabaseAdmin } from '../lib/supabase.js';

const router: ReturnType<typeof Router> = Router();

// Read version once at startup from package.json
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'));
const API_VERSION: string = pkg.version;

// ---------------------------------------------------------------------------
// GET /health — Health check
// ---------------------------------------------------------------------------

router.get('/health', async (_req, res) => {
  try {
    const { error } = await supabaseAdmin
      .from('regions')
      .select('id')
      .limit(1);

    if (error) {
      console.error('[HEALTH] DB check failed:', error.message);
      res.status(503).json({
        status: 'error',
        timestamp: new Date().toISOString(),
        version: API_VERSION,
        error: 'Database connection failed',
      });
      return;
    }

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: API_VERSION,
    });
  } catch {
    res.status(503).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      version: API_VERSION,
      error: 'Health check failed',
    });
  }
});

export default router;
