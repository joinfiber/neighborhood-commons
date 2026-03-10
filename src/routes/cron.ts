/**
 * Cron Routes — The Fiber Commons
 *
 * Scheduled job endpoints, authenticated by cron secret header.
 * Called by Railway cron or external scheduler.
 */

import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireCronSecret } from '../middleware/cron-auth.js';
import { retryFailedWebhooks } from '../lib/webhook-delivery.js';

const router: ReturnType<typeof Router> = Router();

// All cron routes require secret auth
router.use(requireCronSecret);

// ---------------------------------------------------------------------------
// POST /cleanup-browse-dedup — Clean up expired browse dedup entries
// ---------------------------------------------------------------------------

router.post('/cleanup-browse-dedup', async (_req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin.rpc('cleanup_browse_dedup');

    if (error) {
      console.error('[CRON] cleanup_browse_dedup failed:', error.message);
      res.status(500).json({ success: false, error: error.message });
      return;
    }

    console.log('[CRON] cleanup_browse_dedup completed:', data);
    res.json({ success: true, result: data });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /retry-webhooks — Retry failed webhook deliveries
// ---------------------------------------------------------------------------

router.post('/retry-webhooks', async (_req, res, next) => {
  try {
    const retried = await retryFailedWebhooks();

    console.log(`[CRON] retry-webhooks completed: ${retried} deliveries retried`);
    res.json({ success: true, retried });
  } catch (err) {
    next(err);
  }
});

export default router;
