/**
 * Cron Routes — Neighborhood Commons
 *
 * Scheduled job endpoints, authenticated by cron secret header.
 * Called by Railway cron or external scheduler.
 */

import { Router } from 'express';
import { requireCronSecret } from '../middleware/cron-auth.js';
import { retryFailedWebhooks } from '../lib/webhook-delivery.js';
import { geocodeBackfill } from '../lib/geocoding.js';

const router: ReturnType<typeof Router> = Router();

// All cron routes require secret auth
router.use(requireCronSecret);

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

// ---------------------------------------------------------------------------
// POST /geocode-backfill — Geocode events with address but no coordinates
// ---------------------------------------------------------------------------

router.post('/geocode-backfill', async (_req, res, next) => {
  try {
    const result = await geocodeBackfill();

    console.log(`[CRON] geocode-backfill completed: ${result.geocoded}/${result.processed} geocoded, ${result.failed} failed`);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

export default router;
