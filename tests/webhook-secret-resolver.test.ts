/**
 * resolveSigningSecret tests (PR 8 — stuck-pending-delivery bug fix)
 *
 * Core property under test: a decryption failure MUST mark the delivery row
 * as `failed` with a clear error message, not leave it stuck in `pending`
 * forever. Pre-fix, decryptSecret threw outside any try/catch, and the outer
 * fire-and-forget IIFE's `.catch()` logged but never touched the delivery row.
 * Observed in prod: 5 deliveries across 3 days all stuck in `pending` with
 * no error_message, while Railway logs showed the AES-GCM auth failure.
 *
 * These tests lock in the fix by calling the resolver directly and asserting
 * both (a) the exception is raised and (b) the delivery row was updated
 * BEFORE the raise.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

// Capture every `.update()` call against webhook_deliveries so tests can
// assert what row mutations happened.
const capturedUpdates = vi.hoisted(() => {
  return [] as Array<{ table: string; update: Record<string, unknown>; id: unknown }>;
});

vi.mock('../src/lib/supabase.js', () => {
  function queryChain(table: string) {
    let pendingUpdate: Record<string, unknown> | null = null;
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.select = () => chain;
    chain.eq = (col: string, val: unknown) => {
      if (pendingUpdate) {
        capturedUpdates.push({ table, update: pendingUpdate, id: val });
        pendingUpdate = null;
      }
      return chain;
    };
    chain.update = (values: Record<string, unknown>) => {
      pendingUpdate = values;
      return chain;
    };
    chain.then = (resolve: (v: unknown) => void) =>
      Promise.resolve({ data: null, error: null }).then(resolve);
    return chain;
  }
  return {
    supabaseAdmin: {
      from: (table: string) => queryChain(table),
    },
    createUserClient: () => ({}),
  };
});

// Mock webhook-crypto so we can control isEncryptionConfigured and force
// decryptSecret to throw on demand.
const cryptoMockState = vi.hoisted(() => {
  return { configured: true, shouldThrow: false as false | string };
});

vi.mock('../src/lib/webhook-crypto.js', () => ({
  isEncryptionConfigured: vi.fn(() => cryptoMockState.configured),
  decryptSecret: vi.fn((_data: Buffer | string) => {
    if (cryptoMockState.shouldThrow) throw new Error(cryptoMockState.shouldThrow);
    return 'the-real-secret';
  }),
  encryptSecret: vi.fn((s: string) => Buffer.from(s)),
  bufferToBytea: vi.fn((b: Buffer) => '\\x' + b.toString('hex')),
}));

// ---------------------------------------------------------------------------
// Load the module after mocks are installed
// ---------------------------------------------------------------------------

let resolveSigningSecret: (sub: {
  id: string;
  url: string;
  signing_secret: string;
  signing_secret_encrypted?: Buffer | string | null;
  event_types: string[];
}, deliveryId: number) => Promise<string>;

beforeAll(async () => {
  const mod = await import('../src/lib/webhook-delivery.js');
  resolveSigningSecret = mod._resolveSigningSecretForTests;
});

beforeEach(() => {
  capturedUpdates.length = 0;
  cryptoMockState.configured = true;
  cryptoMockState.shouldThrow = false;
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveSigningSecret — encrypted path', () => {
  it('returns the decrypted secret when decryption succeeds', async () => {
    const sub = {
      id: 'sub-1', url: 'https://example.com/hook',
      signing_secret: 'plaintext-fallback',
      signing_secret_encrypted: '\\xdeadbeef',
      event_types: ['event.created'],
    };

    const secret = await resolveSigningSecret(sub, 42);

    expect(secret).toBe('the-real-secret');
    // No delivery row update on success
    expect(capturedUpdates).toHaveLength(0);
  });

  it('marks delivery failed when decryption throws (the pre-fix bug)', async () => {
    cryptoMockState.shouldThrow = 'Unsupported state or unable to authenticate data';
    const sub = {
      id: 'sub-1', url: 'https://example.com/hook',
      signing_secret: 'plaintext-fallback',
      signing_secret_encrypted: '\\xgarbage',
      event_types: ['event.created'],
    };

    await expect(resolveSigningSecret(sub, 99)).rejects.toThrow('Unsupported state');

    // The delivery row MUST have been updated to failed before the throw.
    // Pre-fix this didn't happen — the row stayed 'pending' forever.
    expect(capturedUpdates).toHaveLength(1);
    const { table, update, id } = capturedUpdates[0]!;
    expect(table).toBe('webhook_deliveries');
    expect(id).toBe(99);
    expect(update.status).toBe('failed');
    expect(update.error_message).toContain('Signing secret decryption failed');
    expect(update.error_message).toContain('Unsupported state');
  });

  it('marks delivery failed when encrypted column is missing', async () => {
    const sub = {
      id: 'sub-1', url: 'https://example.com/hook',
      signing_secret: 'plaintext',
      signing_secret_encrypted: null,
      event_types: ['event.created'],
    };

    await expect(resolveSigningSecret(sub, 7)).rejects.toThrow('missing encrypted secret');

    expect(capturedUpdates).toHaveLength(1);
    expect(capturedUpdates[0]!.update.status).toBe('failed');
    expect(capturedUpdates[0]!.update.error_message).toBe('Missing encrypted signing secret');
  });
});

describe('resolveSigningSecret — plaintext fallback', () => {
  it('returns plaintext when encryption is not configured (dev/test)', async () => {
    cryptoMockState.configured = false;
    const sub = {
      id: 'sub-1', url: 'https://example.com/hook',
      signing_secret: 'plaintext-only',
      signing_secret_encrypted: null,
      event_types: ['event.created'],
    };

    const secret = await resolveSigningSecret(sub, 1);

    expect(secret).toBe('plaintext-only');
    // No row update; no failure path taken
    expect(capturedUpdates).toHaveLength(0);
  });

  it('uses plaintext even when encrypted column exists, if encryption is off', async () => {
    cryptoMockState.configured = false;
    const sub = {
      id: 'sub-1', url: 'https://example.com/hook',
      signing_secret: 'plaintext-preferred',
      signing_secret_encrypted: '\\xdeadbeef',
      event_types: ['event.created'],
    };

    const secret = await resolveSigningSecret(sub, 1);
    expect(secret).toBe('plaintext-preferred');
  });
});
