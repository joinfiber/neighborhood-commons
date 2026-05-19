/**
 * Logo upload pipeline for contributor profiles.
 *
 * Mirrors the security shape of `src/lib/image-processing.ts`
 * (magic-byte check → Sharp re-encode → R2 upload) but tuned for logo
 * dimensions and keyed under `contributor-profiles/{profileId}/logo.jpg`.
 *
 * Logos are smaller than event photos (400×400 max, JPEG q85). Sharp
 * re-encoding strips EXIF/GPS/XMP and kills polyglot payloads — every
 * portal logo upload runs through this one auditable surface.
 */

import sharp from 'sharp';
import { uploadToR2, deleteFromR2 } from '../cloudflare.js';
import { config } from '../../config.js';

const SUPPORTED_MAGIC_BYTES: Record<string, string> = {
  ffd8ff: 'image/jpeg',
  '89504e47': 'image/png',
  '52494646': 'image/webp',
};

const MAX_DIMENSION = 400;
const JPEG_QUALITY = 85;

export interface LogoUploadResult {
  /** Public-serving URL to put in `contributor_profiles.logo_url`. */
  url: string;
  /** R2 key — needed if the caller wants to delete this object later. */
  r2Key: string;
}

function buildR2Key(profileId: string): string {
  return `contributor-profiles/${profileId}/logo.jpg`;
}

function buildPublicUrl(r2Key: string): string {
  // Direct R2 public URL when configured (CDN-fast). Without it, fall
  // back to a path on the Express base URL — but the portal expects the
  // public URL form, so misconfig surfaces visibly via missing logos.
  if (config.r2.publicUrl) {
    return `${config.r2.publicUrl}/${r2Key}`;
  }
  return `${config.apiBaseUrl || ''}/api/internal/contributor-profile-logo?key=${encodeURIComponent(r2Key)}`;
}

/**
 * Validate + process + upload a logo from a raw buffer (the multer file).
 * Returns the URL to persist on `contributor_profiles.logo_url` and the
 * R2 key (for later delete).
 *
 * Throws on invalid magic bytes, Sharp failure, or R2 upload failure.
 * Caller surfaces the error to the user with a 400 + reason.
 */
export async function processAndUploadLogo(profileId: string, buffer: Buffer): Promise<LogoUploadResult> {
  if (!buffer || buffer.length < 8) {
    throw new Error('Empty or truncated upload — pick a JPEG, PNG, or WebP.');
  }

  // Magic-byte gate. Sharp will also reject malformed payloads, but
  // checking up front means we don't even hand polyglot-shaped bytes to
  // the image decoder.
  const hex = buffer.subarray(0, 4).toString('hex').toLowerCase();
  let valid = false;
  for (const magic of Object.keys(SUPPORTED_MAGIC_BYTES)) {
    if (hex.startsWith(magic)) {
      valid = true;
      break;
    }
  }
  if (!valid) {
    throw new Error('Unsupported image format — JPEG, PNG, or WebP only.');
  }

  // Re-encode: strips ALL metadata, kills polyglots, caps dimensions, normalises orientation.
  let processed: Buffer;
  try {
    processed = await sharp(buffer)
      .rotate()
      .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer();
  } catch (err) {
    throw new Error(`Image could not be processed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const r2Key = buildR2Key(profileId);
  const result = await uploadToR2(r2Key, new Uint8Array(processed), 'image/jpeg');
  if (!result.success) {
    throw new Error(`Storage upload failed${result.error ? ': ' + result.error : ''}`);
  }

  return {
    url: buildPublicUrl(r2Key),
    r2Key,
  };
}

/**
 * Remove the logo from R2. Best-effort — a failure here just leaves an
 * orphan object, which is recoverable (operator can sweep). Callers
 * should clear `contributor_profiles.logo_url` regardless of the result.
 */
export async function deleteLogo(profileId: string): Promise<void> {
  const r2Key = buildR2Key(profileId);
  try {
    await deleteFromR2(r2Key);
  } catch (err) {
    // Swallow — orphan R2 objects are not a functional problem
    console.warn('[DEV_PORTAL] Logo delete failed (orphan left in R2):', err instanceof Error ? err.message : err);
  }
}

export const LOGO_MAX_BYTES = 5 * 1024 * 1024;
export const LOGO_MAX_DIMENSION = MAX_DIMENSION;
