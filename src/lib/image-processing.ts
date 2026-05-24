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
import { validateFeedUrl } from './url-validation.js';
import { safeFetch } from './safe-fetch.js';
import { dispatchImageProcessedWebhook, type ImageProcessedErrorCode } from './webhook-delivery.js';
import { canContributePhotos } from './contributor-policy.js';

export const SUPPORTED_MAGIC_BYTES: Record<string, string> = {
  'ffd8ff': 'image/jpeg',
  '89504e47': 'image/png',
  '52494646': 'image/webp',
};

// Cap how many pixels Sharp will decode. A small, highly-compressed image can
// otherwise inflate to a multi-GB raw bitmap (decompression bomb) before the
// resize bound applies. 50 MP covers legitimate large photos (e.g. 8000x6000);
// Sharp's default (~268 MP) is far too permissive. Inputs are byte-capped too.
const MAX_INPUT_PIXELS = 50_000_000;

/**
 * Validate magic bytes, re-encode through Sharp (strips metadata, kills polyglots),
 * upload to R2, and return the public serving URL.
 */
export async function processAndUploadImage(entityId: string, base64: string, servingPath?: string): Promise<string> {
  // Strip data URI prefix if present (e.g. "data:image/jpeg;base64,...")
  const rawBase64 = base64.includes(',') ? base64.split(',')[1]! : base64;
  const buffer = Buffer.from(rawBase64, 'base64');
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
  const processed = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS })
    .rotate()
    .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer();

  const r2Key = `portal-events/${entityId}/image`;
  const result = await uploadToR2(r2Key, new Uint8Array(processed), 'image/jpeg');
  if (!result.success) {
    throw createError('Failed to upload image', 500, 'SERVER_ERROR');
  }

  // Direct R2 public URL when configured (CDN-fast, no Express proxy)
  if (config.r2.publicUrl) {
    return `${config.r2.publicUrl}/${r2Key}`;
  }

  // Fallback to Express proxy routes
  if (servingPath) {
    return `${config.apiBaseUrl}${servingPath}`;
  }
  return `${config.apiBaseUrl}/api/portal/events/${entityId}/image`;
}

/**
 * Download an image from a URL, re-encode through Sharp, upload to R2,
 * and set event_image_url. Used when approving newsletter/feed candidates.
 *
 * Emits an `event.image_processed` webhook on every terminal outcome
 * (success or permanent failure) so consumers polling `images[]` get a
 * stop signal in both directions.
 */
export async function downloadAndAttachImage(eventId: string, imageUrl: string): Promise<void> {
  function emitFailure(code: ImageProcessedErrorCode): void {
    void dispatchImageProcessedWebhook(eventId, 'failed', null, code);
  }

  // Contributor policy gate (defense in depth). The Service API rejects this
  // case upfront, but this function can also be invoked from contribute.ts
  // and any future caller. Look up the event's creator and refuse the fetch
  // if the account isn't authorized to contribute photos.
  // See lib/contributor-policy.ts.
  const { data: event } = await supabaseAdmin
    .from('events')
    .select('creator_account_id')
    .eq('id', eventId)
    .maybeSingle();

  if (!event?.creator_account_id || !(await canContributePhotos(event.creator_account_id))) {
    console.log(`[IMAGES] Refusing image fetch for event ${eventId}: contributor not authorized`);
    emitFailure('NOT_PERMITTED');
    return;
  }

  // SSRF protection: validate URL resolves to a public IP before fetching
  try {
    await validateFeedUrl(imageUrl);
  } catch (err) {
    console.log(`[IMAGES] URL blocked by SSRF check: ${imageUrl} — ${err instanceof Error ? err.message : err}`);
    emitFailure('URL_BLOCKED');
    return;
  }

  // safeFetch: redirect:'error' default + SSRF-strict connect-hook when enabled.
  let response: Response;
  try {
    response = await safeFetch(imageUrl, {
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NeighborhoodCommons/1.0)' },
    });
  } catch (err) {
    console.log(`[IMAGES] Fetch threw for ${imageUrl}: ${err instanceof Error ? err.message : err}`);
    emitFailure('DOWNLOAD_FAILED');
    return;
  }

  if (!response.ok) {
    console.log(`[IMAGES] Download HTTP ${response.status} for ${imageUrl}`);
    emitFailure('DOWNLOAD_FAILED');
    return;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 8) {
    emitFailure('INVALID_FORMAT');
    return;
  }

  // Magic byte check
  const hex = buffer.subarray(0, 4).toString('hex').toLowerCase();
  let valid = false;
  for (const magic of Object.keys(SUPPORTED_MAGIC_BYTES)) {
    if (hex.startsWith(magic)) { valid = true; break; }
  }
  if (!valid) {
    console.log(`[IMAGES] Unsupported format from ${imageUrl}`);
    emitFailure('INVALID_FORMAT');
    return;
  }

  // Re-encode through Sharp (strips metadata, kills polyglot payloads)
  let processed: Buffer;
  try {
    processed = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toBuffer();
  } catch (err) {
    console.error(`[IMAGES] Sharp encode failed for event ${eventId}: ${err instanceof Error ? err.message : err}`);
    emitFailure('ENCODE_FAILED');
    return;
  }

  const r2Key = `portal-events/${eventId}/image`;
  const result = await uploadToR2(r2Key, new Uint8Array(processed), 'image/jpeg');
  if (!result.success) {
    console.error(`[IMAGES] R2 upload failed for event ${eventId}`);
    emitFailure('UPLOAD_FAILED');
    return;
  }

  const finalUrl = config.r2.publicUrl
    ? `${config.r2.publicUrl}/${r2Key}`
    : `${config.apiBaseUrl}/api/portal/events/${eventId}/image`;
  await supabaseAdmin
    .from('events')
    .update({ event_image_url: finalUrl })
    .eq('id', eventId);

  console.log(`[IMAGES] Attached image to event ${eventId}`);
  void dispatchImageProcessedWebhook(eventId, 'succeeded', finalUrl, null);
}
