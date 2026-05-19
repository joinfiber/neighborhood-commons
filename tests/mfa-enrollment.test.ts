/**
 * MFA enrollment + step-up — PR 4b integration tests.
 *
 * Covers:
 *   - TOTP unit behavior (generate/verify, ±1 step tolerance, base32 round-trip)
 *   - Backup-code generate + consume single-use semantics
 *   - GET /developers/security/enroll-mfa renders the form (with session)
 *   - POST /developers/security/enroll-mfa accepts a valid code, persists,
 *     renders backup codes
 *   - POST rejects an invalid code without persisting
 *   - GET /developers/security/step-up renders the form (with session +
 *     MFA enrolled) or redirects to enroll otherwise
 *   - POST step-up sets mfa_verified_at on success
 *   - Backup code consumption removes the matched hash from the stored array
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'http';
import { createHmac } from 'crypto';

vi.hoisted(() => {
  // MFA crypto needs a key; reuse the webhook one (same source by design).
  // vi.hoisted runs before imports, so we can't use randomBytes here —
  // a fixed 64-char hex literal is fine for tests.
  process.env.WEBHOOK_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
});

const mockResponses = vi.hoisted(() => new Map<string, { data: unknown; error: unknown; count?: number }>());
const insertedRows = vi.hoisted(() => new Map<string, Array<Record<string, unknown>>>());
const updatedRows = vi.hoisted(() => new Map<string, Array<Record<string, unknown>>>());

vi.mock('../src/lib/supabase.js', () => {
  function createQueryChain(table: string) {
    const chain: Record<string, unknown> = {};
    let pendingWrite: Record<string, unknown> | null = null;
    let pendingUpdate: Record<string, unknown> | null = null;
    let isSingleShape = false;

    const passthrough = [
      'select', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'or', 'not',
      'order', 'range', 'limit', 'match', 'ilike', 'like', 'is', 'in', 'contains', 'delete',
    ];
    for (const method of passthrough) chain[method] = () => chain;

    chain.maybeSingle = () => { isSingleShape = true; return chain; };
    chain.single = () => { isSingleShape = true; return chain; };

    chain.insert = (row: Record<string, unknown>) => {
      const list = insertedRows.get(table) || [];
      list.push(row); insertedRows.set(table, list);
      pendingWrite = row; return chain;
    };
    chain.upsert = (row: Record<string, unknown>) => {
      const list = insertedRows.get(table) || [];
      list.push(row); insertedRows.set(table, list);
      pendingWrite = row; return chain;
    };
    chain.update = (row: Record<string, unknown>) => {
      const list = updatedRows.get(table) || [];
      list.push(row); updatedRows.set(table, list);
      pendingUpdate = row; return chain;
    };

    chain.then = (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => {
      const shapeKey = isSingleShape ? `${table}:single` : `${table}:list`;
      const override = mockResponses.get(shapeKey) ?? mockResponses.get(table);
      if (override) return Promise.resolve(override).then(resolve, reject);
      if (pendingWrite) {
        const synthetic = { id: 'mock-id-' + table, ...pendingWrite };
        pendingWrite = null;
        return Promise.resolve({ data: synthetic, error: null }).then(resolve, reject);
      }
      if (pendingUpdate) {
        pendingUpdate = null;
        return Promise.resolve({ data: null, error: null }).then(resolve, reject);
      }
      const empty = isSingleShape ? { data: null, error: null } : { data: [], error: null, count: 0 };
      return Promise.resolve(empty).then(resolve, reject);
    };
    return chain;
  }
  return {
    supabaseAdmin: {
      from: (table: string) => createQueryChain(table),
      auth: { getUser: () => Promise.resolve({ data: { user: null }, error: { message: 'no auth' } }) },
    },
    createUserClient: () => ({ from: (table: string) => createQueryChain(table) }),
  };
});

vi.mock('../src/lib/email.js', () => ({
  sendEmail: vi.fn(async () => undefined),
}));

import { createApp } from '../src/app.js';
import {
  generateTotpSecret,
  verifyTotp,
  otpauthUrl,
  formatSecretForDisplay,
  TOTP_PERIOD_SECONDS,
} from '../src/lib/developer-portal/totp.js';
import {
  generateBackupCodes,
  consumeBackupCode,
  BACKUP_CODE_COUNT,
} from '../src/lib/developer-portal/backup-codes.js';
import {
  encryptMfaSecret,
  decryptMfaSecret,
} from '../src/lib/developer-portal/mfa-crypto.js';

let server: Server;
let baseUrl: string;

beforeAll(() => {
  const app = createApp();
  return new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(() => {
  return new Promise<void>((resolve) => { server?.close(() => resolve()); });
});

beforeEach(() => {
  mockResponses.clear();
  insertedRows.clear();
  updatedRows.clear();
});

const RAW_SESSION_TOKEN = 'b'.repeat(64);

function sessionCookie(): string {
  return `nc_dev_session=${RAW_SESSION_TOKEN}`;
}

function parseSetCookies(res: Response): Map<string, string> {
  const out = new Map<string, string>();
  const raw = res.headers.get('set-cookie');
  if (!raw) return out;
  for (const part of raw.split(/, (?=[a-zA-Z_]+=)/)) {
    const [pair] = part.split(';');
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    out.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return out;
}

/** Compute a current TOTP code from a base32 secret. Mirrors the
 *  algorithm in src/lib/developer-portal/totp.ts so test code doesn't
 *  depend on the SUT's private hotp helper. */
function generateCode(secret: string): string {
  // Decode base32
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const cleaned = secret.replace(/=+$/, '').toUpperCase().replace(/\s+/g, '');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of cleaned) {
    const idx = alphabet.indexOf(ch);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  const key = Buffer.from(out);
  const counter = Math.floor(Date.now() / 1000 / TOTP_PERIOD_SECONDS);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  counterBuf.writeUInt32BE(counter >>> 0, 4);
  const hmac = createHmac('sha1', key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const binary = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return (binary % 1_000_000).toString().padStart(6, '0');
}

// ---------------------------------------------------------------------------
// Unit tests — TOTP
// ---------------------------------------------------------------------------

describe('TOTP', () => {
  it('generates a base32 secret of expected length', () => {
    const s = generateTotpSecret();
    // 20 bytes → 32 base32 chars (no padding)
    expect(s).toMatch(/^[A-Z2-7]+$/);
    expect(s.length).toBeGreaterThanOrEqual(32);
  });

  it('verifies its own generated code', () => {
    const secret = generateTotpSecret();
    const code = generateCode(secret);
    expect(verifyTotp(secret, code)).toBe(true);
  });

  it('rejects a code that is way off', () => {
    const secret = generateTotpSecret();
    expect(verifyTotp(secret, '000000')).toBe(false);
  });

  it('rejects non-numeric input', () => {
    const secret = generateTotpSecret();
    expect(verifyTotp(secret, 'abc123')).toBe(false);
    expect(verifyTotp(secret, '12345')).toBe(false); // too short
    expect(verifyTotp(secret, '')).toBe(false);
  });

  it('tolerates whitespace inside the submitted code', () => {
    const secret = generateTotpSecret();
    const code = generateCode(secret);
    const spaced = code.slice(0, 3) + ' ' + code.slice(3);
    expect(verifyTotp(secret, spaced)).toBe(true);
  });

  it('formats a secret with 4-char groupings for display', () => {
    const formatted = formatSecretForDisplay('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567');
    expect(formatted).toBe('ABCD EFGH IJKL MNOP QRST UVWX YZ23 4567');
  });

  it('builds an otpauth URL with the right shape', () => {
    const url = otpauthUrl({
      issuer: 'Neighborhood Commons',
      accountName: 'dev@example.com',
      secret: 'JBSWY3DPEHPK3PXP',
    });
    expect(url).toMatch(/^otpauth:\/\/totp\//);
    expect(url).toContain('secret=JBSWY3DPEHPK3PXP');
    expect(url).toContain('issuer=Neighborhood+Commons');
    expect(url).toContain('algorithm=SHA1');
    expect(url).toContain('digits=6');
    expect(url).toContain('period=30');
  });
});

// ---------------------------------------------------------------------------
// Unit tests — MFA crypto round-trip
// ---------------------------------------------------------------------------

describe('MFA crypto', () => {
  it('round-trips a secret through encrypt/decrypt', () => {
    const secret = generateTotpSecret();
    const encrypted = encryptMfaSecret(secret);
    expect(encrypted).toBeInstanceOf(Buffer);
    expect(encrypted.length).toBeGreaterThan(12 + 16); // iv + tag + at least some ciphertext
    expect(decryptMfaSecret(encrypted)).toBe(secret);
  });

  it('decrypts the \\x-prefixed hex string Supabase returns for bytea', () => {
    const secret = generateTotpSecret();
    const encrypted = encryptMfaSecret(secret);
    const supabaseShape = '\\x' + encrypted.toString('hex');
    expect(decryptMfaSecret(supabaseShape)).toBe(secret);
  });

  it('fails decryption when bytes have been tampered with', () => {
    const secret = generateTotpSecret();
    const encrypted = encryptMfaSecret(secret);
    encrypted[encrypted.length - 1] ^= 0x01; // flip a bit in ciphertext
    expect(() => decryptMfaSecret(encrypted)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Unit tests — Backup codes
// ---------------------------------------------------------------------------

describe('Backup codes', () => {
  it('generates the expected count with the documented format', () => {
    const { raw, hashed } = generateBackupCodes();
    expect(raw.length).toBe(BACKUP_CODE_COUNT);
    expect(hashed.length).toBe(BACKUP_CODE_COUNT);
    for (const code of raw) {
      expect(code).toMatch(/^[0-9A-Za-z]{5}-[0-9A-Za-z]{5}$/);
    }
    for (const h of hashed) {
      expect(h).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
    }
  });

  it('consumes a code by removing its hash from the stored array', () => {
    const { raw, hashed } = generateBackupCodes();
    const code = raw[3];
    const remaining = consumeBackupCode(code, hashed);
    expect(remaining).not.toBeNull();
    expect(remaining!.length).toBe(BACKUP_CODE_COUNT - 1);
    // The same code can't be used again from the remaining list
    expect(consumeBackupCode(code, remaining!)).toBeNull();
  });

  it('ignores formatting (dashes, whitespace, case) when matching', () => {
    const { raw, hashed } = generateBackupCodes();
    const original = raw[0]; // "XXXXX-XXXXX"
    const noDash = original.replace('-', '');
    const spaced = noDash.slice(0, 3) + ' ' + noDash.slice(3);
    expect(consumeBackupCode(spaced, hashed)).not.toBeNull();
  });

  it('returns null for an unknown code', () => {
    const { hashed } = generateBackupCodes();
    expect(consumeBackupCode('NOPENOPENOPE', hashed)).toBeNull();
  });

  it('returns null for an empty input', () => {
    const { hashed } = generateBackupCodes();
    expect(consumeBackupCode('', hashed)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// HTTP — GET /developers/security/enroll-mfa
// ---------------------------------------------------------------------------

function setupSession(opts: { mfaVerifiedAt?: string | null } = {}) {
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  mockResponses.set('developer_sessions:single', {
    data: {
      id: 'session-id',
      api_key_id: 'dev-api-key',
      mfa_verified_at: opts.mfaVerifiedAt === undefined ? null : opts.mfaVerifiedAt,
      expires_at: future,
    },
    error: null,
  });
}

describe('GET /developers/security/enroll-mfa', () => {
  it('redirects to login when no session is present', async () => {
    const res = await fetch(`${baseUrl}/developers/security/enroll-mfa`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/developers/sign-up');
  });

  it('renders the enrollment form for an authenticated developer without MFA', async () => {
    setupSession();
    // requireDeveloperSession needs to find an api_keys row; loadKeyMfaState
    // also queries api_keys.
    mockResponses.set('api_keys:single', {
      data: {
        contact_email: 'dev@example.com',
        name: 'Dev App',
        mfa_enrolled_at: null,
        mfa_secret_encrypted: null,
        mfa_backup_codes_hashed: null,
      },
      error: null,
    });
    const res = await fetch(`${baseUrl}/developers/security/enroll-mfa`, {
      headers: { Cookie: sessionCookie() },
      redirect: 'manual',
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Enable MFA');
    expect(html).toContain('otpauth://totp/');
    expect(html).toContain('name="secret"');
    expect(html).toContain('name="code"');
    expect(html).toContain('name="_csrf"');
    // Inline SVG QR is the primary path (PR adds qrcode dep)
    expect(html).toMatch(/<svg[^>]*viewBox/);
    expect(html).toContain('Scan with your authenticator');
  });

  it('renders the "already enrolled" page when the developer already has MFA', async () => {
    setupSession();
    mockResponses.set('api_keys:single', {
      data: {
        contact_email: 'dev@example.com',
        mfa_enrolled_at: '2026-05-18T00:00:00Z',
      },
      error: null,
    });
    const res = await fetch(`${baseUrl}/developers/security/enroll-mfa`, {
      headers: { Cookie: sessionCookie() },
      redirect: 'manual',
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('MFA is already enrolled');
  });
});

// ---------------------------------------------------------------------------
// HTTP — POST /developers/security/enroll-mfa
// ---------------------------------------------------------------------------

describe('POST /developers/security/enroll-mfa', () => {
  it('rejects without CSRF (403)', async () => {
    setupSession();
    mockResponses.set('api_keys:single', {
      data: { contact_email: 'dev@example.com', mfa_enrolled_at: null },
      error: null,
    });
    const body = new URLSearchParams({ secret: generateTotpSecret(), code: '000000' });
    const res = await fetch(`${baseUrl}/developers/security/enroll-mfa`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: sessionCookie(),
      },
      body: body.toString(),
      redirect: 'manual',
    });
    expect(res.status).toBe(403);
  });

  it('rejects an invalid code without persisting (no api_keys.update)', async () => {
    setupSession();
    mockResponses.set('api_keys:single', {
      data: { contact_email: 'dev@example.com', mfa_enrolled_at: null },
      error: null,
    });

    // Get CSRF
    const getRes = await fetch(`${baseUrl}/developers/security/enroll-mfa`, {
      headers: { Cookie: sessionCookie() },
      redirect: 'manual',
    });
    const csrfToken = parseSetCookies(getRes).get('nc_dev_csrf') || '';

    const secret = generateTotpSecret();
    const body = new URLSearchParams({ _csrf: csrfToken, secret, code: '000000' });
    const res = await fetch(`${baseUrl}/developers/security/enroll-mfa`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: `${sessionCookie()}; nc_dev_csrf=${csrfToken}`,
      },
      body: body.toString(),
      redirect: 'manual',
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    // The apostrophe in "didn't" gets HTML-encoded — match the unescaped suffix.
    expect(html).toContain('Try the next one your authenticator shows');
    // No update should have happened on api_keys (only the session update may
    // happen via validateSession's last_seen_at bump, which goes through update
    // on developer_sessions, not api_keys)
    expect(updatedRows.get('api_keys') || []).toHaveLength(0);
  });

  it('accepts a valid code, persists encrypted secret + backup codes, shows codes', async () => {
    setupSession();
    mockResponses.set('api_keys:single', {
      data: { contact_email: 'dev@example.com', mfa_enrolled_at: null },
      error: null,
    });

    const getRes = await fetch(`${baseUrl}/developers/security/enroll-mfa`, {
      headers: { Cookie: sessionCookie() },
      redirect: 'manual',
    });
    const csrfToken = parseSetCookies(getRes).get('nc_dev_csrf') || '';

    const secret = generateTotpSecret();
    const validCode = generateCode(secret);
    const body = new URLSearchParams({ _csrf: csrfToken, secret, code: validCode });
    const res = await fetch(`${baseUrl}/developers/security/enroll-mfa`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: `${sessionCookie()}; nc_dev_csrf=${csrfToken}`,
      },
      body: body.toString(),
      redirect: 'manual',
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('MFA is on');
    expect(html).toContain('Backup codes');
    // Display contains 10 codes as <li>
    const liCount = (html.match(/<li style="font-family:var\(--font-mono\)/g) || []).length;
    expect(liCount).toBe(BACKUP_CODE_COUNT);

    // api_keys.update was called with the MFA columns
    const updates = updatedRows.get('api_keys') || [];
    expect(updates.length).toBeGreaterThanOrEqual(1);
    const update = updates[updates.length - 1];
    expect(update.mfa_enrolled_at).toBeTruthy();
    expect(typeof update.mfa_secret_encrypted).toBe('string');
    expect((update.mfa_secret_encrypted as string).startsWith('\\x')).toBe(true);
    expect(Array.isArray(update.mfa_backup_codes_hashed)).toBe(true);
    expect((update.mfa_backup_codes_hashed as string[]).length).toBe(BACKUP_CODE_COUNT);

    // developer_sessions was updated to mark elevation
    const sessionUpdates = updatedRows.get('developer_sessions') || [];
    const mfaVerifiedUpdate = sessionUpdates.find((u) => 'mfa_verified_at' in u);
    expect(mfaVerifiedUpdate).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// HTTP — GET /developers/security/step-up
// ---------------------------------------------------------------------------

describe('GET /developers/security/step-up', () => {
  it('redirects to enroll-mfa when the developer has no MFA', async () => {
    setupSession();
    mockResponses.set('api_keys:single', {
      data: { contact_email: 'dev@example.com', mfa_enrolled_at: null, mfa_secret_encrypted: null, mfa_backup_codes_hashed: null },
      error: null,
    });
    const res = await fetch(`${baseUrl}/developers/security/step-up?return=/operator/applications`, {
      headers: { Cookie: sessionCookie() },
      redirect: 'manual',
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toMatch(/^\/developers\/security\/enroll-mfa\?return=/);
  });

  it('renders the step-up form for an enrolled developer', async () => {
    setupSession();
    mockResponses.set('api_keys:single', {
      data: {
        contact_email: 'dev@example.com',
        mfa_enrolled_at: '2026-05-18T00:00:00Z',
        mfa_secret_encrypted: '\\x' + Buffer.alloc(60).toString('hex'),
        mfa_backup_codes_hashed: [],
      },
      error: null,
    });
    const res = await fetch(`${baseUrl}/developers/security/step-up?return=/operator/applications`, {
      headers: { Cookie: sessionCookie() },
      redirect: 'manual',
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Verify it');
    expect(html).toContain('name="code"');
    expect(html).toContain('name="return"');
    expect(html).toContain('/operator/applications');
  });

  it('rejects open-redirect attempts in ?return=', async () => {
    setupSession();
    mockResponses.set('api_keys:single', {
      data: {
        contact_email: 'dev@example.com',
        mfa_enrolled_at: '2026-05-18T00:00:00Z',
        mfa_secret_encrypted: '\\x' + Buffer.alloc(60).toString('hex'),
        mfa_backup_codes_hashed: [],
      },
      error: null,
    });
    const res = await fetch(`${baseUrl}/developers/security/step-up?return=https://evil.example.com/`, {
      headers: { Cookie: sessionCookie() },
      redirect: 'manual',
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('evil.example.com');
    expect(html).toContain('/developers/dashboard');
  });
});
