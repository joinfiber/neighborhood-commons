/**
 * MFA secret encryption — AES-256-GCM, reusing WEBHOOK_ENCRYPTION_KEY.
 *
 * Same wire format and key source as `webhook-crypto.ts`, deliberately
 * matched so the operational discipline (key rotation, bytea handling)
 * stays uniform. Single master key for sensitive-data-at-rest is
 * acceptable for this scale; separating keys per concern is an additive
 * future change if a separate-trust-boundary requirement appears.
 *
 * Format: iv(12 bytes) || authTag(16 bytes) || ciphertext
 * Stored as `bytea` in api_keys.mfa_secret_encrypted.
 *
 * The "plaintext" here is the base32 TOTP secret. Decryption returns the
 * same base32 string, which the verifier in totp.ts re-decodes to bytes.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const hex = process.env.WEBHOOK_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error('WEBHOOK_ENCRYPTION_KEY must be a 64-char hex string (32 bytes)');
  }
  cachedKey = Buffer.from(hex, 'hex');
  return cachedKey;
}

/** True when the encryption key is configured. Used by callers to decide
 *  whether MFA enrollment is enabled (no key → no secret storage). */
export function isMfaCryptoConfigured(): boolean {
  const hex = process.env.WEBHOOK_ENCRYPTION_KEY;
  return !!hex && hex.length === 64;
}

/**
 * Encode a Buffer for transport into a Supabase `bytea` column. See
 * webhook-crypto.ts::bufferToBytea for the Supabase-JS-RPC-boundary
 * background; the same workaround applies.
 */
export function bufferToBytea(buf: Buffer): string {
  return '\\x' + buf.toString('hex');
}

/** Encrypt the base32 TOTP secret. Returns Buffer iv||tag||ciphertext. */
export function encryptMfaSecret(plaintextBase32: string): Buffer {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintextBase32, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]);
}

/** Decrypt the base32 TOTP secret from the stored bytea. Accepts the raw
 *  Buffer or the `\x<hex>` string Supabase-JS returns on SELECT. */
export function decryptMfaSecret(data: Buffer | string): string {
  const key = getKey();
  const buf = Buffer.isBuffer(data)
    ? data
    : typeof data === 'string' && data.startsWith('\\x')
      ? Buffer.from(data.slice(2), 'hex')
      : Buffer.from(data as string, 'base64');

  if (buf.length < IV_LENGTH + TAG_LENGTH + 1) {
    throw new Error('Invalid encrypted MFA secret: too short');
  }

  const iv = buf.subarray(0, IV_LENGTH);
  const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
