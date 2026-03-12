/**
 * SSRF Protection Tests — URL Validation
 *
 * Verifies that webhook URL validation correctly blocks private/internal
 * IP ranges and only allows public HTTPS endpoints. If these fail,
 * the system is vulnerable to server-side request forgery.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';

let validateWebhookUrl: (url: string) => Promise<void>;

// Mock DNS to control IP resolution without real network calls
vi.mock('dns', () => ({
  promises: {
    lookup: vi.fn(),
  },
}));

import { promises as dns } from 'dns';
const mockLookup = dns.lookup as ReturnType<typeof vi.fn>;

beforeAll(async () => {
  const mod = await import('../src/lib/url-validation.js');
  validateWebhookUrl = mod.validateWebhookUrl;
});

// ---------------------------------------------------------------------------
// Protocol enforcement
// ---------------------------------------------------------------------------

describe('protocol enforcement', () => {
  it('rejects HTTP URLs', async () => {
    await expect(validateWebhookUrl('http://example.com/webhook'))
      .rejects.toThrow('URL must use HTTPS');
  });

  it('rejects FTP URLs', async () => {
    await expect(validateWebhookUrl('ftp://example.com/webhook'))
      .rejects.toThrow('URL must use HTTPS');
  });

  it('rejects invalid URLs', async () => {
    await expect(validateWebhookUrl('not-a-url'))
      .rejects.toThrow('Invalid URL');
  });

  it('rejects empty string', async () => {
    await expect(validateWebhookUrl(''))
      .rejects.toThrow('Invalid URL');
  });
});

// ---------------------------------------------------------------------------
// Blocked hostnames
// ---------------------------------------------------------------------------

describe('blocked hostnames', () => {
  it('rejects localhost', async () => {
    await expect(validateWebhookUrl('https://localhost/webhook'))
      .rejects.toThrow('hostname is not allowed');
  });

  it('rejects localhost.localdomain', async () => {
    await expect(validateWebhookUrl('https://localhost.localdomain/webhook'))
      .rejects.toThrow('hostname is not allowed');
  });

  it('rejects 0.0.0.0', async () => {
    await expect(validateWebhookUrl('https://0.0.0.0/webhook'))
      .rejects.toThrow('hostname is not allowed');
  });
});

// ---------------------------------------------------------------------------
// Private IPv4 ranges (RFC 1918 + reserved)
// ---------------------------------------------------------------------------

describe('private IPv4 blocking', () => {
  it('blocks 127.0.0.1 (loopback)', async () => {
    mockLookup.mockResolvedValueOnce({ address: '127.0.0.1', family: 4 });
    await expect(validateWebhookUrl('https://evil.com/webhook'))
      .rejects.toThrow('private IP');
  });

  it('blocks 127.0.0.53 (loopback range)', async () => {
    mockLookup.mockResolvedValueOnce({ address: '127.0.0.53', family: 4 });
    await expect(validateWebhookUrl('https://evil.com/webhook'))
      .rejects.toThrow('private IP');
  });

  it('blocks 10.0.0.1 (RFC 1918 10/8)', async () => {
    mockLookup.mockResolvedValueOnce({ address: '10.0.0.1', family: 4 });
    await expect(validateWebhookUrl('https://evil.com/webhook'))
      .rejects.toThrow('private IP');
  });

  it('blocks 10.255.255.255 (RFC 1918 10/8 end)', async () => {
    mockLookup.mockResolvedValueOnce({ address: '10.255.255.255', family: 4 });
    await expect(validateWebhookUrl('https://evil.com/webhook'))
      .rejects.toThrow('private IP');
  });

  it('blocks 172.16.0.1 (RFC 1918 172.16/12)', async () => {
    mockLookup.mockResolvedValueOnce({ address: '172.16.0.1', family: 4 });
    await expect(validateWebhookUrl('https://evil.com/webhook'))
      .rejects.toThrow('private IP');
  });

  it('blocks 172.31.255.255 (RFC 1918 172.16/12 end)', async () => {
    mockLookup.mockResolvedValueOnce({ address: '172.31.255.255', family: 4 });
    await expect(validateWebhookUrl('https://evil.com/webhook'))
      .rejects.toThrow('private IP');
  });

  it('blocks 192.168.1.1 (RFC 1918 192.168/16)', async () => {
    mockLookup.mockResolvedValueOnce({ address: '192.168.1.1', family: 4 });
    await expect(validateWebhookUrl('https://evil.com/webhook'))
      .rejects.toThrow('private IP');
  });

  it('blocks 169.254.169.254 (AWS/GCP/Azure metadata)', async () => {
    mockLookup.mockResolvedValueOnce({ address: '169.254.169.254', family: 4 });
    await expect(validateWebhookUrl('https://evil.com/webhook'))
      .rejects.toThrow('private IP');
  });

  it('blocks 169.254.0.1 (link-local)', async () => {
    mockLookup.mockResolvedValueOnce({ address: '169.254.0.1', family: 4 });
    await expect(validateWebhookUrl('https://evil.com/webhook'))
      .rejects.toThrow('private IP');
  });

  it('blocks 0.0.0.0 (current network)', async () => {
    mockLookup.mockResolvedValueOnce({ address: '0.0.0.0', family: 4 });
    await expect(validateWebhookUrl('https://evil.com/webhook'))
      .rejects.toThrow('private IP');
  });
});

// ---------------------------------------------------------------------------
// Additional reserved IPv4 ranges (RFC 6598, IETF, benchmark, reserved)
// ---------------------------------------------------------------------------

describe('additional reserved IPv4 ranges', () => {
  it('blocks 100.64.0.1 (RFC 6598 CGNAT)', async () => {
    mockLookup.mockResolvedValueOnce({ address: '100.64.0.1', family: 4 });
    await expect(validateWebhookUrl('https://evil.com/webhook'))
      .rejects.toThrow('private IP');
  });

  it('blocks 100.127.255.255 (RFC 6598 end)', async () => {
    mockLookup.mockResolvedValueOnce({ address: '100.127.255.255', family: 4 });
    await expect(validateWebhookUrl('https://evil.com/webhook'))
      .rejects.toThrow('private IP');
  });

  it('allows 100.63.255.255 (just below CGNAT range)', async () => {
    mockLookup.mockResolvedValueOnce({ address: '100.63.255.255', family: 4 });
    await expect(validateWebhookUrl('https://example.com/webhook'))
      .resolves.toBeUndefined();
  });

  it('allows 100.128.0.1 (just above CGNAT range)', async () => {
    mockLookup.mockResolvedValueOnce({ address: '100.128.0.1', family: 4 });
    await expect(validateWebhookUrl('https://example.com/webhook'))
      .resolves.toBeUndefined();
  });

  it('blocks 192.0.0.1 (IETF protocol assignments)', async () => {
    mockLookup.mockResolvedValueOnce({ address: '192.0.0.1', family: 4 });
    await expect(validateWebhookUrl('https://evil.com/webhook'))
      .rejects.toThrow('private IP');
  });

  it('blocks 198.18.0.1 (benchmark testing)', async () => {
    mockLookup.mockResolvedValueOnce({ address: '198.18.0.1', family: 4 });
    await expect(validateWebhookUrl('https://evil.com/webhook'))
      .rejects.toThrow('private IP');
  });

  it('blocks 198.19.255.255 (benchmark testing end)', async () => {
    mockLookup.mockResolvedValueOnce({ address: '198.19.255.255', family: 4 });
    await expect(validateWebhookUrl('https://evil.com/webhook'))
      .rejects.toThrow('private IP');
  });

  it('allows 198.20.0.1 (just above benchmark range)', async () => {
    mockLookup.mockResolvedValueOnce({ address: '198.20.0.1', family: 4 });
    await expect(validateWebhookUrl('https://example.com/webhook'))
      .resolves.toBeUndefined();
  });

  it('blocks 240.0.0.1 (reserved/future use)', async () => {
    mockLookup.mockResolvedValueOnce({ address: '240.0.0.1', family: 4 });
    await expect(validateWebhookUrl('https://evil.com/webhook'))
      .rejects.toThrow('private IP');
  });

  it('blocks 255.255.255.255 (broadcast)', async () => {
    mockLookup.mockResolvedValueOnce({ address: '255.255.255.255', family: 4 });
    await expect(validateWebhookUrl('https://evil.com/webhook'))
      .rejects.toThrow('private IP');
  });
});

// ---------------------------------------------------------------------------
// Private IPv6 ranges
// ---------------------------------------------------------------------------

describe('private IPv6 blocking', () => {
  it('blocks ::1 (loopback)', async () => {
    mockLookup.mockResolvedValueOnce({ address: '::1', family: 6 });
    await expect(validateWebhookUrl('https://evil.com/webhook'))
      .rejects.toThrow('private IP');
  });

  it('blocks :: (unspecified)', async () => {
    mockLookup.mockResolvedValueOnce({ address: '::', family: 6 });
    await expect(validateWebhookUrl('https://evil.com/webhook'))
      .rejects.toThrow('private IP');
  });

  it('blocks fe80:: (link-local)', async () => {
    mockLookup.mockResolvedValueOnce({ address: 'fe80::1', family: 6 });
    await expect(validateWebhookUrl('https://evil.com/webhook'))
      .rejects.toThrow('private IP');
  });

  it('blocks fd00:: (unique local)', async () => {
    mockLookup.mockResolvedValueOnce({ address: 'fd12:3456::1', family: 6 });
    await expect(validateWebhookUrl('https://evil.com/webhook'))
      .rejects.toThrow('private IP');
  });

  it('blocks ::ffff:127.0.0.1 (IPv4-mapped loopback)', async () => {
    mockLookup.mockResolvedValueOnce({ address: '::ffff:127.0.0.1', family: 6 });
    await expect(validateWebhookUrl('https://evil.com/webhook'))
      .rejects.toThrow('private IP');
  });

  it('blocks ::ffff:10.0.0.1 (IPv4-mapped RFC 1918)', async () => {
    mockLookup.mockResolvedValueOnce({ address: '::ffff:10.0.0.1', family: 6 });
    await expect(validateWebhookUrl('https://evil.com/webhook'))
      .rejects.toThrow('private IP');
  });

  it('blocks ::ffff:169.254.169.254 (IPv4-mapped metadata)', async () => {
    mockLookup.mockResolvedValueOnce({ address: '::ffff:169.254.169.254', family: 6 });
    await expect(validateWebhookUrl('https://evil.com/webhook'))
      .rejects.toThrow('private IP');
  });
});

// ---------------------------------------------------------------------------
// Public IPs — should be allowed
// ---------------------------------------------------------------------------

describe('public IPs allowed', () => {
  it('allows a public IPv4 address', async () => {
    mockLookup.mockResolvedValueOnce({ address: '93.184.216.34', family: 4 });
    await expect(validateWebhookUrl('https://example.com/webhook'))
      .resolves.toBeUndefined();
  });

  it('allows 172.32.0.1 (just outside RFC 1918 172.16/12)', async () => {
    mockLookup.mockResolvedValueOnce({ address: '172.32.0.1', family: 4 });
    await expect(validateWebhookUrl('https://example.com/webhook'))
      .resolves.toBeUndefined();
  });

  it('allows 11.0.0.1 (just outside 10/8)', async () => {
    mockLookup.mockResolvedValueOnce({ address: '11.0.0.1', family: 4 });
    await expect(validateWebhookUrl('https://example.com/webhook'))
      .resolves.toBeUndefined();
  });

  it('allows a public IPv6 address', async () => {
    mockLookup.mockResolvedValueOnce({ address: '2606:4700::1', family: 6 });
    await expect(validateWebhookUrl('https://example.com/webhook'))
      .resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// DNS failure — fail closed
// ---------------------------------------------------------------------------

describe('DNS resolution failures', () => {
  it('rejects when hostname cannot be resolved (ENOTFOUND)', async () => {
    mockLookup.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND evil.test'));
    await expect(validateWebhookUrl('https://evil.test/webhook'))
      .rejects.toThrow('could not be resolved');
  });

  it('rejects on transient DNS failure (EAI_AGAIN)', async () => {
    mockLookup.mockRejectedValueOnce(new Error('getaddrinfo EAI_AGAIN evil.test'));
    await expect(validateWebhookUrl('https://evil.test/webhook'))
      .rejects.toThrow('could not be resolved');
  });
});
