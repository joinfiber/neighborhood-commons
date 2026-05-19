/**
 * MFA backup codes — single-use recovery codes.
 *
 * Issued once at MFA enrollment. Stored hashed in
 * `api_keys.mfa_backup_codes_hashed` (text[]). Each consumption removes
 * the hash from the array — single use, audit-friendly.
 *
 * Format: 10 codes, each 10 chars, alphanumeric (no ambiguous chars).
 * Displayed grouped as `xxxxx-xxxxx` for legibility. 10 chars over a
 * 32-char alphabet ≈ 50 bits of entropy per code — well above the bar
 * for a single-use recovery token.
 *
 * Hash: SHA-256 (single round). PBKDF2/bcrypt would be overkill — these
 * are high-entropy random tokens, not user-chosen passwords.
 */

import { randomBytes, createHash, timingSafeEqual } from 'crypto';

const CODES_PER_BATCH = 10;
const CHARS_PER_CODE = 10;
// 32-char alphabet — no 0/O, no 1/I/L (lookalikes), 5 bits per char so
// each byte from randomBytes yields one char with zero modulo bias. The
// lowercase a/b/c pad the count to 32 without re-introducing lookalikes.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZabc';

/** Generate one random code character from a single byte (5 bits used). */
function charFromByte(b: number): string {
  return ALPHABET[b & 0x1f];
}

/** Generate a single 10-char code (no separator). */
function generateOne(): string {
  const bytes = randomBytes(CHARS_PER_CODE);
  let out = '';
  for (let i = 0; i < CHARS_PER_CODE; i++) out += charFromByte(bytes[i]);
  return out;
}

/** Hash a code to its stored form (SHA-256 hex). Normalized to upper-case
 *  alphanum before hashing so display formatting doesn't change the hash. */
function hashCode(code: string): string {
  const normalized = code.replace(/[^0-9a-zA-Z]/g, '');
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * Generate a batch of backup codes. Returns both the raw display strings
 * (formatted `xxxxx-xxxxx`) and the hashed form for storage. Caller
 * shows the raw forms ONCE to the developer; only the hashed forms
 * persist.
 */
export function generateBackupCodes(): { raw: string[]; hashed: string[] } {
  const raw: string[] = [];
  const hashed: string[] = [];
  for (let i = 0; i < CODES_PER_BATCH; i++) {
    const code = generateOne();
    raw.push(`${code.slice(0, 5)}-${code.slice(5)}`);
    hashed.push(hashCode(code));
  }
  return { raw, hashed };
}

/**
 * Attempt to consume a backup code against a stored set. Returns the
 * updated hashed-list (with the matched hash removed) if the submitted
 * code matches one of the stored hashes, or null on no-match.
 *
 * Caller persists the returned array back to
 * `api_keys.mfa_backup_codes_hashed` — that's what makes a code
 * single-use.
 */
export function consumeBackupCode(submitted: string, storedHashes: string[]): string[] | null {
  if (!submitted || !Array.isArray(storedHashes) || storedHashes.length === 0) return null;
  const candidateHash = hashCode(submitted);
  const candidateBuf = Buffer.from(candidateHash);

  let matchedIdx = -1;
  for (let i = 0; i < storedHashes.length; i++) {
    const storedBuf = Buffer.from(storedHashes[i]);
    if (storedBuf.length !== candidateBuf.length) continue;
    if (timingSafeEqual(candidateBuf, storedBuf)) {
      matchedIdx = i;
      // Don't break — constant-time comparison count.
    }
  }
  if (matchedIdx < 0) return null;

  // Remove the matched entry; return the new array
  return storedHashes.filter((_, idx) => idx !== matchedIdx);
}

export const BACKUP_CODE_COUNT = CODES_PER_BATCH;
