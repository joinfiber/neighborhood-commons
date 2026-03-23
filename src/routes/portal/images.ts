/**
 * Portal Image Routes
 *
 * Image serving (public) and upload (authenticated).
 */

import { Router, json as expressJson } from "express";
import { z } from "zod";
import { createError } from "../../middleware/error-handler.js";
import { validateRequest, validateUuidParam } from "../../lib/helpers.js";
import { getFromR2 } from "../../lib/cloudflare.js";
import { requirePortalAuth } from "../../middleware/auth.js";
import { imageUploadLimiter } from "../../middleware/rate-limit.js";
import { processAndUploadImage } from "../../lib/image-processing.js";
import { getUserClient, getPortalAccountId } from "../../lib/portal-helpers.js";

const router: ReturnType<typeof Router> = Router();

// PUBLIC: Image serving (no auth — business events are public)
// =============================================================================

/**
 * GET /api/portal/events/:id/image
 * Serve a portal event image from R2. No auth required.
 */
router.get('/events/:id/image', async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'event ID');
    const r2Key = `portal-events/${req.params.id}/image`;
    const { data, contentType, error } = await getFromR2(r2Key);

    if (error || !data) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Image not found' } });
      return;
    }

    res.set('Content-Type', contentType || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(Buffer.from(data));
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// IMAGE UPLOAD (authenticated)
// =============================================================================

router.use(requirePortalAuth);

// SUPPORTED_MAGIC_BYTES — now imported from lib/image-processing.ts

const imageUploadSchema = z.object({
  image: z.string().min(1).max(14_000_000),
});

/** Per-route body limit override for image uploads (12MB vs global 5MB) */
const imageBodyLimit = expressJson({ limit: '12mb' });

// processAndUploadImage — now imported from lib/image-processing.ts

/**
 * POST /api/portal/events/:id/image
 * Upload an event image (base64 -> sharp re-encode -> R2).
 */
router.post('/events/:id/image', imageBodyLimit, imageUploadLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'event ID');
    await getPortalAccountId(req);
    const { image } = validateRequest(imageUploadSchema, req.body);

    // Verify event exists and is owned by this user [RLS]
    const { data: event } = await getUserClient(req)
      .from('events')
      .select('id')
      .eq('id', req.params.id)
      .maybeSingle();

    if (!event) {
      throw createError('Event not found', 404, 'NOT_FOUND');
    }

    const imageUrl = await processAndUploadImage(req.params.id, image);

    // Update event with full serving URL [RLS]
    const { error: updateError } = await getUserClient(req)
      .from('events')
      .update({ event_image_url: imageUrl })
      .eq('id', req.params.id);

    if (updateError) {
      console.error('[PORTAL] Image URL update error:', updateError.message);
      throw createError('Failed to save image reference', 500, 'SERVER_ERROR');
    }

    res.json({ image_url: imageUrl });
  } catch (err) {
    next(err);
  }
});


export default router;
