/**
 * Image Processing Pipeline — Neighborhood Commons
 *
 * Security-critical image validation and re-encoding. All uploaded images
 * pass through this pipeline: magic byte check → Sharp re-encode → R2 upload.
 *
 * Sharp re-encoding strips EXIF/GPS/XMP metadata and kills polyglot payloads.
 * This is the ONLY place image processing should happen — one auditable location.
 */

import sharp from 'sharp';
import { uploadToR2 } from './cloudflare.js';
import { supabaseAdmin } from './supabase.js';
import { config } from '../config.js';
import { createError } from '../middleware/error-handler.js';

export const SUPPORTED_MAGIC_BYTES: Record<string, string> = {
  'ffd8ff': 'image/jpeg',
  '89504e47': 'image/png',
  '52494646': 'image/webp',
};

/**
 * Validate magic bytes, re-encode through Sharp (strips metadata, kills polyglots),
 * upload to R2, and return the public serving URL.
 */
export async function processAndUploadImage(eventId: string, base64: string): Promise<string> {
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length < 8) {
    throw createError('Invalid image data — upload a JPEG, PNG, or WebP file', 400, 'VALIDATION_ERROR');
  }

  const hex = buffer.subarray(0, 4).toString('hex').toLowerCase();
  let valid = false;
  for (const magic of Object.keys(SUPPORTED_MAGIC_BYTES)) {
    if (hex.startsWith(magic)) { valid = true; break; }
  }
  if (!valid) {
    throw createError('Unsupported image format (JPEG, PNG, WebP only)', 400, 'VALIDATION_ERROR');
  }

  // Re-encode through Sharp: strips ALL metadata (EXIF, GPS, XMP, ICC),
  // kills polyglot payloads, normalizes orientation, enforces max dimensions
  const processed = await sharp(buffer)
    .rotate()
    .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer();

  const r2Key = `portal-events/${eventId}/image`;
  const result = await uploadToR2(r2Key, new Uint8Array(processed), 'image/jpeg');
  if (!result.success) {
    throw createError('Failed to upload image', 500, 'SERVER_ERROR');
  }

  return `${config.apiBaseUrl}/api/portal/events/${eventId}/image`;
}

/**
 * Download an image from a URL, re-encode through Sharp, upload to R2,
 * and set event_image_url. Used when approving newsletter/feed candidates.
 */
export async function downloadAndAttachImage(eventId: string, imageUrl: string): Promise<void> {
  const response = await fetch(imageUrl, {
    signal: AbortSignal.timeout(10000),
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NeighborhoodCommons/1.0)' },
    redirect: 'follow',
  });

  if (!response.ok) {
    console.log(`[IMAGES] Download HTTP ${response.status} for ${imageUrl}`);
    return;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 8) return;

  // Magic byte check
  const hex = buffer.subarray(0, 4).toString('hex').toLowerCase();
  let valid = false;
  for (const magic of Object.keys(SUPPORTED_MAGIC_BYTES)) {
    if (hex.startsWith(magic)) { valid = true; break; }
  }
  if (!valid) {
    console.log(`[IMAGES] Unsupported format from ${imageUrl}`);
    return;
  }

  // Re-encode through Sharp (strips metadata, kills polyglot payloads)
  const processed = await sharp(buffer)
    .rotate()
    .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer();

  const r2Key = `portal-events/${eventId}/image`;
  const result = await uploadToR2(r2Key, new Uint8Array(processed), 'image/jpeg');
  if (!result.success) {
    console.error(`[IMAGES] R2 upload failed for event ${eventId}`);
    return;
  }

  const finalUrl = `${config.apiBaseUrl}/api/portal/events/${eventId}/image`;
  await supabaseAdmin
    .from('events')
    .update({ event_image_url: finalUrl })
    .eq('id', eventId);

  console.log(`[IMAGES] Attached image to event ${eventId}`);
}
