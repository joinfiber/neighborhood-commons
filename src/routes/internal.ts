/**
 * Internal Routes — Neighborhood Commons
 *
 * Health check endpoint for infrastructure monitoring.
 */

import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';

const router: ReturnType<typeof Router> = Router();

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
        version: '0.1.0',
        error: 'Database connection failed',
      });
      return;
    }

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: '0.1.0',
    });
  } catch {
    res.status(503).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      version: '0.1.0',
      error: 'Health check failed',
    });
  }
});

export default router;
