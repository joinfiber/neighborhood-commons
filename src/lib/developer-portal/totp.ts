/**
 * TOTP — RFC 6238 over RFC 4226 HOTP.
 *
 * Hand-rolled because the algorithm is short and well-defined: HMAC-SHA1
 * over an 8-byte big-endian counter, dynamic truncation, modulo 10^digits.
 * Avoiding a runtime dep keeps the auditable surface minimal — a security
 * primitive is exactly the place where you want every byte of the code on
 * one screen, not buried in a vendor's release-notes diff.
 *
 * Standard parameters per RFC 6238 §4 and Google Authenticator defaults:
 *   - Algorithm: SHA1
 *   - Period: 30 seconds
 *   - Digits: 6
 *
 * Verification accepts ±1 step (±30s) to absorb clock skew between the
 * server and the authenticator app. Per RFC 6238 §5.2 this is the
 * recommended default; tighter is needlessly fragile, wider weakens
 * brute-force protection.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

const PERIOD_SECONDS = 30;
const DIGITS = 6;
const ALGORITHM = 'sha1';
const SECRET_BYTES = 20; // 160 bits, RFC 4226 §4 recommendation
const TOLERANCE_STEPS = 1;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Generate a fresh 160-bit TOTP secret, base32-encoded (no padding). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(SECRET_BYTES));
}

/**
 * Build the otpauth URL an authenticator app reads (manual entry, QR
 * scan, or deep-link). `issuer` and `accountName` together appear in the
 * authenticator as "Issuer (accountName)".
 *
 * Per the de-facto Google Authenticator URI format. Both label and
 * issuer are URL-encoded; the `issuer` query parameter mirrors the
 * label prefix because some authenticators read one, others the other.
 */
export function otpauthUrl(args: { issuer: string; accountName: string; secret: string }): string {
  const label = `${args.issuer}:${args.accountName}`;
  const params = new URLSearchParams({
    secret: args.secret,
    issuer: args.issuer,
    algorithm: ALGORITHM.toUpperCase(),
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

/**
 * Verify a user-supplied TOTP code against `secret`. Returns true if the
 * code matches the current step or one step on either side. Always runs
 * all three comparisons in constant time — leaking which step matched is
 * a tiny but real information leak about the server clock.
 */
export function verifyTotp(secret: string, submittedCode: string): boolean {
  return verifyTotpStep(secret, submittedCode) !== null;
}

/**
 * Like verifyTotp, but returns the matched TOTP time-step (counter) on success
 * or null on failure. Exposing the step lets callers enforce single-use —
 * rejecting a step that was already consumed defeats replay within the ±1
 * validity window. Runs all comparisons regardless of an early match to keep
 * the comparison count (and timing) constant.
 */
export function verifyTotpStep(secret: string, submittedCode: string): number | null {
  if (!secret || !submittedCode) return null;
  const cleaned = submittedCode.replace(/\s+/g, '');
  if (!/^[0-9]{6}$/.test(cleaned)) return null;

  const key = base32Decode(secret);
  if (!key) return null;

  const nowStep = Math.floor(Date.now() / 1000 / PERIOD_SECONDS);
  const submitted = Buffer.from(cleaned, 'utf8');

  let matchedStep: number | null = null;
  for (let offset = -TOLERANCE_STEPS; offset <= TOLERANCE_STEPS; offset++) {
    const step = nowStep + offset;
    const expectedBuf = Buffer.from(hotp(key, step), 'utf8');
    if (expectedBuf.length === submitted.length && timingSafeEqual(expectedBuf, submitted)) {
      matchedStep = step;
      // Don't `break` — letting the loop finish keeps comparison count constant.
    }
  }
  return matchedStep;
}

/** Compute HOTP(K, C) per RFC 4226 §5.3. Returns a 6-digit zero-padded string. */
function hotp(key: Buffer, counter: number): string {
  // 8-byte big-endian counter
  const counterBuf = Buffer.alloc(8);
  // JS bitwise ops are 32-bit; split high/low halves for the BE write.
  // Counter never exceeds 2^53 in practice (50M years at 30s steps).
  const high = Math.floor(counter / 0x100000000);
  const low = counter >>> 0;
  counterBuf.writeUInt32BE(high, 0);
  counterBuf.writeUInt32BE(low, 4);

  const hmac = createHmac(ALGORITHM, key).update(counterBuf).digest();
  // Dynamic truncation: low nibble of last byte is the offset.
  const offset = hmac[hmac.length - 1] & 0xf;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  const code = binary % 10 ** DIGITS;
  return code.toString().padStart(DIGITS, '0');
}

/** Base32 encode (RFC 4648, no padding). Used for TOTP secrets. */
function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

/** Base32 decode (RFC 4648, padding-tolerant). Returns null on malformed input. */
function base32Decode(input: string): Buffer | null {
  const cleaned = input.replace(/=+$/, '').toUpperCase().replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (let i = 0; i < cleaned.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(cleaned[i]);
    if (idx < 0) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/**
 * Format a base32 secret with spaces every 4 characters for easier
 * manual entry into an authenticator. Doesn't change the secret — most
 * authenticator apps strip whitespace before consuming.
 */
export function formatSecretForDisplay(secret: string): string {
  return secret.replace(/(.{4})/g, '$1 ').trim();
}

// Re-exports for use sites that want to validate input format without
// going through the full verify path.
export const TOTP_DIGITS = DIGITS;
export const TOTP_PERIOD_SECONDS = PERIOD_SECONDS;
