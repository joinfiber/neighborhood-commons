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
import { supabaseAdmin } from '../../lib/supabase.js';
import { createError } from '../../middleware/error-handler.js';
import { validateUuidParam, resolveEventImageUrl } from '../../lib/helpers.js';
import { serviceLimiter } from '../../middleware/rate-limit.js';
import { processAndUploadImage, downloadAndAttachImage } from '../../lib/image-processing.js';
import { config } from '../../config.js';
import { assertLinkedEvent } from './helpers.js';

const router: ReturnType<typeof Router> = Router();

/** Per-route body limit override for image uploads (12MB vs global 5MB) */
const imageBodyLimit = expressJson({ limit: '12mb' });

/**
 * POST /service/events/:id/image — Upload event image
 *
 * Accepts three formats:
 * 1. JSON: { "image": "<base64>" } — legacy, backward compatible
 * 2. JSON: { "image_url": "https://..." } — download from URL (preferred for scraped images)
 * 3. Multipart: form field "file" — standard file upload (preferred for user uploads)
 */
router.post('/events/:id/image', imageBodyLimit, serviceLimiter, async (req, res, next) => {
  try {
    validateUuidParam(req.params.id, 'event ID');
    await assertLinkedEvent(req, req.params.id);
    const eventId = req.params.id;

    const contentType = req.headers['content-type'] || '';

    if (contentType.includes('multipart/form-data')) {
      // Multipart file upload — read raw body chunks with size limit
      const MAX_IMAGE_SIZE = 12 * 1024 * 1024; // 12MB, matching JSON body limit
      const chunks: Buffer[] = [];
      let totalSize = 0;
      for await (const chunk of req) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalSize += buf.length;
        if (totalSize > MAX_IMAGE_SIZE) {
          throw createError('Image too large (max 12MB)', 413, 'PAYLOAD_TOO_LARGE');
        }
        chunks.push(buf);
      }
      const body = Buffer.concat(chunks);

      // Parse multipart boundary
      const boundaryMatch = contentType.match(/boundary=(.+)/);
      if (!boundaryMatch) throw createError('Missing multipart boundary', 400, 'VALIDATION_ERROR');

      // Extract the file data between boundaries
      const boundary = boundaryMatch[1];
      const parts = body.toString('binary').split(`--${boundary}`);
      let fileBuffer: Buffer | null = null;

      for (const part of parts) {
        if (part.includes('filename=')) {
          const headerEnd = part.indexOf('\r\n\r\n');
          if (headerEnd >= 0) {
            const fileData = part.slice(headerEnd + 4).replace(/\r\n$/, '');
            fileBuffer = Buffer.from(fileData, 'binary');
          }
        }
      }

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

export default router;
