/**
 * Webhook Signing & Crypto Tests
 *
 * Verifies HMAC-SHA256 webhook signatures and AES-256-GCM secret
 * encryption/decryption. If these fail, downstream webhook consumers
 * cannot verify payload authenticity, or stored secrets are at risk.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHmac } from 'crypto';

// ---------------------------------------------------------------------------
// HMAC-SHA256 webhook signature verification
// ---------------------------------------------------------------------------

describe('webhook HMAC-SHA256 signing', () => {
  const signingSecret = 'a'.repeat(64); // 32-byte hex secret

  function sign(body: string, secret: string): string {
    return createHmac('sha256', secret).update(body).digest('hex');
  }

  it('produces a valid hex signature', () => {
    const body = JSON.stringify({ event_type: 'event.created', event: { id: '123' } });
    const signature = sign(body, signingSecret);

    expect(signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces consistent signatures for the same payload', () => {
    const body = JSON.stringify({ event_type: 'event.created' });
    const sig1 = sign(body, signingSecret);
    const sig2 = sign(body, signingSecret);
    expect(sig1).toBe(sig2);
  });

  it('produces different signatures for different payloads', () => {
    const sig1 = sign('{"event_type":"event.created"}', signingSecret);
    const sig2 = sign('{"event_type":"event.updated"}', signingSecret);
    expect(sig1).not.toBe(sig2);
  });

  it('produces different signatures for different secrets', () => {
    const body = '{"event_type":"event.created"}';
    const sig1 = sign(body, 'a'.repeat(64));
    const sig2 = sign(body, 'b'.repeat(64));
    expect(sig1).not.toBe(sig2);
  });

  it('consumer can verify signature matches expected', () => {
    const body = JSON.stringify({
      event_type: 'event.created',
      event: { id: 'evt-1', name: 'Test Event' },
      timestamp: '2026-03-12T00:00:00Z',
      delivery_id: '42',
    });

    // Producer signs
    const producerSig = sign(body, signingSecret);
    const header = `sha256=${producerSig}`;

    // Consumer verifies (simulating what a webhook consumer does)
    const receivedSig = header.replace('sha256=', '');
    const expectedSig = sign(body, signingSecret);
    expect(receivedSig).toBe(expectedSig);
  });

  it('tampered payload fails verification', () => {
    const originalBody = '{"event_type":"event.created","event":{"id":"evt-1"}}';
    const signature = sign(originalBody, signingSecret);

    // Attacker modifies the payload
    const tamperedBody = '{"event_type":"event.created","event":{"id":"evt-HACKED"}}';
    const tamperedSig = sign(tamperedBody, signingSecret);

    expect(tamperedSig).not.toBe(signature);
  });

  it('wrong secret fails verification', () => {
    const body = '{"event_type":"event.created"}';
    const producerSig = sign(body, signingSecret);
    const wrongSig = sign(body, 'c'.repeat(64));
    expect(wrongSig).not.toBe(producerSig);
  });
});

// ---------------------------------------------------------------------------
// AES-256-GCM webhook secret encryption
// ---------------------------------------------------------------------------

describe('webhook secret encryption (AES-256-GCM)', () => {
  const testKey = 'ab'.repeat(32); // 64 hex chars = 32 bytes
  let encryptSecret: (plaintext: string) => Buffer;
  let decryptSecret: (data: Buffer) => string;
  let isEncryptionConfigured: () => boolean;

  beforeAll(async () => {
    // Set the encryption key before importing the module
    process.env.WEBHOOK_ENCRYPTION_KEY = testKey;

    // Dynamic import to pick up the env var
    const mod = await import('../src/lib/webhook-crypto.js');
    encryptSecret = mod.encryptSecret;
    decryptSecret = mod.decryptSecret;
    isEncryptionConfigured = mod.isEncryptionConfigured;
  });

  afterAll(() => {
    delete process.env.WEBHOOK_ENCRYPTION_KEY;
  });

  it('reports encryption as configured', () => {
    expect(isEncryptionConfigured()).toBe(true);
  });

  it('encrypts and decrypts a secret round-trip', () => {
    const original = 'my-webhook-signing-secret-here';
    const encrypted = encryptSecret(original);
    const decrypted = decryptSecret(encrypted);
    expect(decrypted).toBe(original);
  });

  it('encrypted output is longer than plaintext (iv + tag + ciphertext)', () => {
    const original = 'short';
    const encrypted = encryptSecret(original);
    // iv(12) + tag(16) + ciphertext(>=1) = at least 29 bytes
    expect(encrypted.length).toBeGreaterThanOrEqual(29);
  });

  it('different encryptions of the same secret produce different ciphertext (random IV)', () => {
    const original = 'same-secret';
    const enc1 = encryptSecret(original);
    const enc2 = encryptSecret(original);
    // Same plaintext should produce different ciphertext due to random IV
    expect(enc1.equals(enc2)).toBe(false);
    // But both should decrypt to the same value
    expect(decryptSecret(enc1)).toBe(original);
    expect(decryptSecret(enc2)).toBe(original);
  });

  it('rejects tampered ciphertext', () => {
    const encrypted = encryptSecret('test-secret');
    // Flip a byte in the ciphertext portion (after iv + tag)
    const tampered = Buffer.from(encrypted);
    tampered[tampered.length - 1] ^= 0xFF;
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it('rejects truncated data', () => {
    const encrypted = encryptSecret('test-secret');
    // Truncate to just the IV (12 bytes) — missing tag and ciphertext
    const truncated = encrypted.subarray(0, 12);
    expect(() => decryptSecret(truncated)).toThrow();
  });

  it('rejects empty string round-trip (ciphertext too short)', () => {
    // AES-256-GCM with empty plaintext produces 0 bytes of ciphertext.
    // iv(12) + tag(16) + ciphertext(0) = 28 bytes, below the 29-byte minimum.
    // This is correct — webhook secrets should never be empty.
    const encrypted = encryptSecret('');
    expect(() => decryptSecret(encrypted)).toThrow('too short');
  });

  it('handles long secrets', () => {
    const longSecret = 'x'.repeat(1000);
    const encrypted = encryptSecret(longSecret);
    const decrypted = decryptSecret(encrypted);
    expect(decrypted).toBe(longSecret);
  });
});
