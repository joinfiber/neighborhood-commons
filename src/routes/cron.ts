/**
 * Cron Routes — Neighborhood Commons
 *
 * Scheduled job endpoints, authenticated by cron secret header.
 * Called by Railway cron or external scheduler.
 */

import { Router } from 'express';
import { requireCronSecret } from '../middleware/cron-auth.js';
import { writeLimiter } from '../middleware/rate-limit.js';
import { retryFailedWebhooks } from '../lib/webhook-delivery.js';
import { geocodeBackfill } from '../lib/geocoding.js';
import { verifyEventImages, verifyAccountImages } from '../lib/image-verification.js';


const router: ReturnType<typeof Router> = Router();

// All cron routes require secret auth + rate limiting
// Rate limiting provides defense-in-depth if the cron secret is compromised
router.use(requireCronSecret);
router.use(writeLimiter);

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

// ---------------------------------------------------------------------------
// POST /verify-images — Check that image URLs are reachable
// ---------------------------------------------------------------------------

router.post('/verify-images', async (_req, res, next) => {
  try {
    const [events, accounts] = await Promise.all([
      verifyEventImages(),
      verifyAccountImages(),
    ]);

    console.log(`[CRON] verify-images: events ${events.broken}/${events.checked} broken (${events.cleared} cleared), accounts ${accounts.broken}/${accounts.checked} broken (${accounts.cleared} cleared)`);
    res.json({ success: true, events, accounts });
  } catch (err) {
    next(err);
  }
});

export default router;
