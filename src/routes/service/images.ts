/**
 * Service API — Image uploads (v2)
 *
 * Event image upload. Event images live on the events table; profile
 * images live on organizations now (migration 082 dropped logo_url and
 * cover_image_url from portal_accounts). Use
 * POST /service/organizations/:id/logo and /:id/image for org imagery.
 *
 * All uploads funnel through the shared Sharp pipeline in
 * lib/image-processing.ts: magic-byte check → Sharp re-encode (strips
 * metadata, kills polyglots) → R2 upload → store public URL. URL-based
 * inputs go through safeFetch with SSRF-strict connect-hook defense.
 */

import { Router, json as expressJson } from 'express';
import multer from 'multer';
import { supabaseAdmin } from '../../lib/supabase.js';
import { createError } from '../../middleware/error-handler.js';
import { validateUuidParam, resolveEventImageUrl } from '../../lib/helpers.js';
import { serviceLimiter } from '../../middleware/rate-limit.js';
import { processAndUploadImage, downloadAndAttachImage } from '../../lib/image-processing.js';
import { deleteFromR2 } from '../../lib/cloudflare.js';
import { config } from '../../config.js';
import { assertLinkedEvent } from './helpers.js';

const router: ReturnType<typeof Router> = Router();

/** Per-route body limit override for image uploads (12MB vs global 5MB) */
const imageBodyLimit = expressJson({ limit: '12mb' });

/**
 * Multipart parser for file uploads. memoryStorage keeps the bytes in RAM for
 * the Sharp pipeline; fileSize matches the JSON body cap. Replaces the former
 * hand-rolled boundary splitting (`body.toString('binary').split(...)`), which
 * allocated several copies of the payload and could mis-slice on binary data.
 */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024, files: 1 } });

/**
 * POST /service/events/:id/image — Upload event image
 *
 * Accepts three formats:
 * 1. JSON: { "image": "<base64>" } — legacy, backward compatible
 * 2. JSON: { "image_url": "https://..." } — download from URL (preferred for scraped images)
 * 3. Multipart: form field "file" — standard file upload (preferred for user uploads)
 */
router.post('/events/:id/image', imageBodyLimit, upload.any(), serviceLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'event ID');
    await assertLinkedEvent(req, req.params.id);
    const eventId = req.params.id;

    const files = (req.files as Express.Multer.File[] | undefined) || [];

    if (files.length > 0) {
      // Multipart file upload, parsed by multer (above). memoryStorage gives us
      // the bytes directly; the shared pipeline does magic-byte + Sharp re-encode.
      const fileBuffer = files[0]!.buffer;
      if (!fileBuffer || fileBuffer.length < 8) {
        throw createError('No valid file found in upload', 400, 'VALIDATION_ERROR');
      }

      const base64 = fileBuffer.toString('base64');
      const imageUrl = await processAndUploadImage(eventId, base64);

      await supabaseAdmin.from('events').update({ event_image_url: imageUrl }).eq('id', eventId);
      res.json({ image_url: resolveEventImageUrl(imageUrl, config.apiBaseUrl) });

    } else if (req.body?.image_url) {
      // URL-based: download, process, upload
      const { image_url } = req.body;
      if (typeof image_url !== 'string' || !image_url.startsWith('http')) {
        throw createError('image_url must be a valid HTTP URL', 400, 'VALIDATION_ERROR');
      }

      await downloadAndAttachImage(eventId, image_url);

      // Re-fetch to get the stored URL
      const { data: updated } = await supabaseAdmin
        .from('events')
        .select('event_image_url')
        .eq('id', eventId)
        .maybeSingle();

      res.json({ image_url: resolveEventImageUrl(updated?.event_image_url || '', config.apiBaseUrl) });

    } else if (req.body?.image) {
      // Legacy base64 JSON
      const image = req.body.image as string;
      if (typeof image !== 'string' || image.length < 1) {
        throw createError('image must be a non-empty base64 string', 400, 'VALIDATION_ERROR');
      }

      const imageUrl = await processAndUploadImage(eventId, image);
      await supabaseAdmin.from('events').update({ event_image_url: imageUrl }).eq('id', eventId);
      res.json({ image_url: resolveEventImageUrl(imageUrl, config.apiBaseUrl) });

    } else {
      throw createError('Provide "image" (base64), "image_url" (URL), or a multipart file upload', 400, 'VALIDATION_ERROR');
    }
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /service/events/:id/image — Remove event image
 *
 * Idempotent. Clears event_image_url and resets event_image_focal_y to its
 * default. When the stored value is a Commons-hosted R2 object (its URL
 * carries our deterministic key portal-events/{id}/image), the underlying R2
 * object is deleted too. External image URLs (DICE, Eventbrite, etc.) are
 * left untouched upstream — only the DB reference is cleared.
 */
router.delete('/events/:id/image', serviceLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'event ID');
    await assertLinkedEvent(req, req.params.id);
    const eventId = req.params.id;

    const { data: event } = await supabaseAdmin
      .from('events')
      .select('event_image_url')
      .eq('id', eventId)
      .maybeSingle();

    if (!event) throw createError('Event not found', 404, 'NOT_FOUND');

    const stored = (event.event_image_url ?? null) as string | null;
    if (!stored) {
      res.json({ deleted: true, r2_deleted: false, external: false, skipped: 'no_image' });
      return;
    }

    // Commons-hosted images carry our deterministic R2 key in the URL; only
    // those get the object deleted. deleteFromR2 takes the KEY, not the URL.
    const r2Key = `portal-events/${eventId}/image`;
    let r2Deleted = false;
    let external = false;

    if (stored.includes(r2Key)) {
      const result = await deleteFromR2(r2Key);
      r2Deleted = result.success;
      if (!result.success) {
        console.error('[IMAGES] R2 delete failed for', r2Key, '-', result.error);
      }
    } else {
      external = true;
    }

    const { error } = await supabaseAdmin
      .from('events')
      .update({ event_image_url: null, event_image_focal_y: 0.5 })
      .eq('id', eventId);

    if (error) throw createError('Failed to clear image reference', 500, 'SERVER_ERROR');

    res.json({ deleted: true, r2_deleted: r2Deleted, external });
  } catch (err) {
    next(err);
  }
});

export default router;
