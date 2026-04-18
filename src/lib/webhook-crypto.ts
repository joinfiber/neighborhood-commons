/**
 * Webhook Secret Encryption -- AES-256-GCM
 *
 * Encrypts/decrypts webhook signing secrets at rest.
 * Uses a server-side encryption key from WEBHOOK_ENCRYPTION_KEY env var.
 *
 * Format: iv(12 bytes) || authTag(16 bytes) || ciphertext
 * Stored as bytea in webhook_subscriptions.signing_secret_encrypted.
 *
 * SECURITY: The encryption key must be a 32-byte (64 hex char) secret.
 * Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

let encryptionKey: Buffer | null = null;

function getKey(): Buffer {
  if (encryptionKey) return encryptionKey;

  const hex = process.env.WEBHOOK_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error('WEBHOOK_ENCRYPTION_KEY must be a 64-char hex string (32 bytes)');
  }

  encryptionKey = Buffer.from(hex, 'hex');
  return encryptionKey;
}

/**
 * Check if webhook secret encryption is configured.
 */
export function isEncryptionConfigured(): boolean {
  const hex = process.env.WEBHOOK_ENCRYPTION_KEY;
  return !!hex && hex.length === 64;
}

/**
 * Encode a Buffer for transport across the Supabase JS RPC boundary into a
 * `bytea` column or parameter. Supabase-js serializes RPC parameters as JSON,
 * and a Node Buffer passed directly becomes `{"type":"Buffer","data":[...]}`
 * — that string's bytes then get stored as bytea, producing garbage that
 * looks like `\x7b...` (leading `{`) and fails AES-GCM authentication.
 *
 * The correct wire format is Postgres's bytea hex literal: `\x<hex>`. The
 * server-side decoder (pg parser) converts that to actual bytea bytes.
 *
 * This helper pairs with the bytea-parsing logic in decryptSecret, which
 * already handles both raw Buffers (direct driver use) and `\x`-prefixed
 * hex strings (what Supabase-js returns on SELECT).
 */
export function bufferToBytea(buf: Buffer): string {
  return '\\x' + buf.toString('hex');
}

/**
 * Encrypt a signing secret.
 * Returns a Buffer: iv(12) || authTag(16) || ciphertext
 */
export function encryptSecret(plaintext: string): Buffer {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  // iv || tag || ciphertext
  return Buffer.concat([iv, authTag, encrypted]);
}

/**
 * Decrypt a signing secret from the stored format.
 * Input: Buffer of iv(12) || authTag(16) || ciphertext
 */
export function decryptSecret(data: Buffer | string): string {
  const key = getKey();

  // Supabase returns bytea columns as hex-encoded strings (\\x prefix)
  const buf = Buffer.isBuffer(data)
    ? data
    : typeof data === 'string' && data.startsWith('\\x')
      ? Buffer.from(data.slice(2), 'hex')
      : Buffer.from(data as string, 'base64');

  if (buf.length < IV_LENGTH + TAG_LENGTH + 1) {
    throw new Error('Invalid encrypted data: too short');
  }

  const iv = buf.subarray(0, IV_LENGTH);
  const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}
