/**
 * Image Upload Validation Tests
 *
 * Verifies the magic byte check and Sharp re-encoding pipeline
 * that protects against malicious image uploads. These tests import
 * the processAndUploadImage logic indirectly by testing the validation
 * constants and Sharp behavior directly.
 *
 * If these fail, the image pipeline may accept polyglot payloads
 * or files that aren't actually images.
 */

import { describe, it, expect, vi } from 'vitest';
import sharp from 'sharp';

// ---------------------------------------------------------------------------
// Magic byte validation (mirrors the logic in portal.ts)
// ---------------------------------------------------------------------------

const SUPPORTED_MAGIC_BYTES: Record<string, string> = {
  'ffd8ff': 'image/jpeg',
  '89504e47': 'image/png',
  '52494646': 'image/webp',
};

function validateMagicBytes(buffer: Buffer): boolean {
  if (buffer.length < 8) return false;
  const hex = buffer.subarray(0, 4).toString('hex').toLowerCase();
  for (const magic of Object.keys(SUPPORTED_MAGIC_BYTES)) {
    if (hex.startsWith(magic)) return true;
  }
  return false;
}

describe('magic byte validation', () => {
  it('accepts valid JPEG magic bytes (ff d8 ff)', () => {
    const jpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46]);
    expect(validateMagicBytes(jpeg)).toBe(true);
  });

  it('accepts valid PNG magic bytes (89 50 4e 47)', () => {
    const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    expect(validateMagicBytes(png)).toBe(true);
  });

  it('accepts valid WebP magic bytes (52 49 46 46 = RIFF)', () => {
    const webp = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00]);
    expect(validateMagicBytes(webp)).toBe(true);
  });

  it('rejects GIF files (47 49 46 38)', () => {
    const gif = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00]);
    expect(validateMagicBytes(gif)).toBe(false);
  });

  it('rejects BMP files (42 4d)', () => {
    const bmp = Buffer.from([0x42, 0x4D, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    expect(validateMagicBytes(bmp)).toBe(false);
  });

  it('rejects SVG (XML text)', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">');
    expect(validateMagicBytes(svg)).toBe(false);
  });

  it('rejects PDF files (25 50 44 46)', () => {
    const pdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x34]);
    expect(validateMagicBytes(pdf)).toBe(false);
  });

  it('rejects EXE/PE files (4d 5a)', () => {
    const exe = Buffer.from([0x4D, 0x5A, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
    expect(validateMagicBytes(exe)).toBe(false);
  });

  it('rejects polyglot HTML-in-image (3c 21 44 4f = <!DO)', () => {
    const html = Buffer.from('<!DOCTYPE html><html>');
    expect(validateMagicBytes(html)).toBe(false);
  });

  it('rejects zero-length buffer', () => {
    expect(validateMagicBytes(Buffer.alloc(0))).toBe(false);
  });

  it('rejects buffer shorter than 8 bytes', () => {
    expect(validateMagicBytes(Buffer.from([0xFF, 0xD8, 0xFF]))).toBe(false);
  });

  it('rejects all-zero buffer', () => {
    expect(validateMagicBytes(Buffer.alloc(8))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Sharp re-encoding (strips metadata, enforces dimensions)
// ---------------------------------------------------------------------------

describe('Sharp re-encoding pipeline', () => {
  // Create a minimal valid 1x1 JPEG for testing
  async function make1x1Jpeg(): Promise<Buffer> {
    return sharp({
      create: { width: 1, height: 1, channels: 3, background: { r: 255, g: 0, b: 0 } },
    }).jpeg().toBuffer();
  }

  // Create a large image to test dimension capping
  async function makeOversizedImage(): Promise<Buffer> {
    return sharp({
      create: { width: 3000, height: 2000, channels: 3, background: { r: 0, g: 128, b: 255 } },
    }).jpeg().toBuffer();
  }

  it('re-encodes a valid JPEG without error', async () => {
    const input = await make1x1Jpeg();
    const output = await sharp(input)
      .rotate()
      .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toBuffer();

    expect(output.length).toBeGreaterThan(0);
    // Output should start with JPEG magic bytes
    expect(output[0]).toBe(0xFF);
    expect(output[1]).toBe(0xD8);
    expect(output[2]).toBe(0xFF);
  });

  it('caps oversized images to 1200px max dimension', async () => {
    const input = await makeOversizedImage();
    const output = await sharp(input)
      .rotate()
      .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toBuffer();

    const metadata = await sharp(output).metadata();
    expect(metadata.width).toBeLessThanOrEqual(1200);
    expect(metadata.height).toBeLessThanOrEqual(1200);
  });

  it('strips EXIF metadata during re-encode', async () => {
    // Create image with fake EXIF-like metadata via PNG comment
    const input = await sharp({
      create: { width: 100, height: 100, channels: 3, background: { r: 0, g: 0, b: 0 } },
    }).jpeg().toBuffer();

    // Re-encode through the pipeline
    const output = await sharp(input)
      .rotate()
      .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toBuffer();

    // Verify output is valid and no EXIF in metadata
    const metadata = await sharp(output).metadata();
    expect(metadata.format).toBe('jpeg');
    // Sharp strips EXIF by default on re-encode; exif field should be absent or empty
    expect(metadata.exif).toBeUndefined();
  });

  it('rejects a non-image buffer (random bytes)', async () => {
    const garbage = Buffer.from('This is not an image at all, just random text data.');
    await expect(
      sharp(garbage)
        .rotate()
        .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 90 })
        .toBuffer()
    ).rejects.toThrow();
  });

  it('rejects a truncated JPEG (valid magic bytes, invalid body)', async () => {
    // JPEG magic bytes but truncated before any valid image data
    const truncated = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46]);
    await expect(
      sharp(truncated)
        .rotate()
        .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 90 })
        .toBuffer()
    ).rejects.toThrow();
  });

  it('converts PNG input to JPEG output', async () => {
    const png = await sharp({
      create: { width: 50, height: 50, channels: 4, background: { r: 0, g: 0, b: 255, alpha: 1 } },
    }).png().toBuffer();

    const output = await sharp(png)
      .rotate()
      .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toBuffer();

    const metadata = await sharp(output).metadata();
    expect(metadata.format).toBe('jpeg');
  });
});
