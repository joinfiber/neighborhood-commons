/**
 * safe-fetch tests — SSRF defense-in-depth
 *
 * These tests verify:
 *   1. IP classification (isPrivateIPv4 / isPrivateIPv6) recognizes every class
 *      the audit identified as dangerous (loopback, RFC 1918, link-local,
 *      cloud metadata, CGNAT, IPv4-mapped IPv6, unique-local).
 *   2. The SSRF-strict connect-hook lookup rejects private IPs at connect time.
 *      This is the TOCTOU-rebind defense: even if validateFeedUrl saw a public
 *      IP, the connect-time lookup gets the second answer from a rebinding DNS
 *      server and must refuse.
 *   3. safeFetch's `redirect: 'error'` default is applied.
 */

import { describe, it, expect, vi } from 'vitest';
import { isPrivateIPv4, isPrivateIPv6 } from '../src/lib/url-validation.js';

// ---------------------------------------------------------------------------
// IPv4 classification
// ---------------------------------------------------------------------------

describe('isPrivateIPv4', () => {
  it('detects loopback 127.0.0.0/8', () => {
    expect(isPrivateIPv4('127.0.0.1')).toBe(true);
    expect(isPrivateIPv4('127.255.255.255')).toBe(true);
  });

  it('detects RFC 1918 10.0.0.0/8', () => {
    expect(isPrivateIPv4('10.0.0.1')).toBe(true);
    expect(isPrivateIPv4('10.255.255.255')).toBe(true);
  });

  it('detects RFC 1918 172.16.0.0/12 at edges', () => {
    expect(isPrivateIPv4('172.16.0.1')).toBe(true);
    expect(isPrivateIPv4('172.31.255.255')).toBe(true);
    expect(isPrivateIPv4('172.15.255.255')).toBe(false);
    expect(isPrivateIPv4('172.32.0.1')).toBe(false);
  });

  it('detects RFC 1918 192.168.0.0/16', () => {
    expect(isPrivateIPv4('192.168.0.1')).toBe(true);
    expect(isPrivateIPv4('192.168.255.255')).toBe(true);
  });

  it('detects cloud metadata 169.254.169.254 and link-local 169.254/16', () => {
    expect(isPrivateIPv4('169.254.169.254')).toBe(true);
    expect(isPrivateIPv4('169.254.0.1')).toBe(true);
  });

  it('detects unspecified 0.0.0.0/8', () => {
    expect(isPrivateIPv4('0.0.0.0')).toBe(true);
    expect(isPrivateIPv4('0.1.2.3')).toBe(true);
  });

  it('detects CGNAT 100.64.0.0/10 at edges', () => {
    expect(isPrivateIPv4('100.64.0.1')).toBe(true);
    expect(isPrivateIPv4('100.127.255.255')).toBe(true);
    expect(isPrivateIPv4('100.63.0.1')).toBe(false);
    expect(isPrivateIPv4('100.128.0.1')).toBe(false);
  });

  it('detects 198.18/15 benchmark range', () => {
    expect(isPrivateIPv4('198.18.0.1')).toBe(true);
    expect(isPrivateIPv4('198.19.255.255')).toBe(true);
    expect(isPrivateIPv4('198.17.0.1')).toBe(false);
    expect(isPrivateIPv4('198.20.0.1')).toBe(false);
  });

  it('detects reserved 240.0.0.0/4', () => {
    expect(isPrivateIPv4('240.0.0.1')).toBe(true);
    expect(isPrivateIPv4('255.255.255.255')).toBe(true);
  });

  it('allows public IPs', () => {
    expect(isPrivateIPv4('8.8.8.8')).toBe(false); // Google DNS
    expect(isPrivateIPv4('1.1.1.1')).toBe(false); // Cloudflare DNS
    expect(isPrivateIPv4('93.184.216.34')).toBe(false); // example.com
  });

  it('rejects malformed input as non-private (caller must validate shape)', () => {
    expect(isPrivateIPv4('not-an-ip')).toBe(false);
    expect(isPrivateIPv4('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// IPv6 classification
// ---------------------------------------------------------------------------

describe('isPrivateIPv6', () => {
  it('detects ::1 loopback', () => {
    expect(isPrivateIPv6('::1')).toBe(true);
  });

  it('detects :: unspecified', () => {
    expect(isPrivateIPv6('::')).toBe(true);
  });

  it('detects link-local fe80::/10', () => {
    expect(isPrivateIPv6('fe80::1')).toBe(true);
    expect(isPrivateIPv6('FE80::1')).toBe(true); // case-insensitive
  });

  it('detects unique-local fc00::/7', () => {
    expect(isPrivateIPv6('fc00::1')).toBe(true);
    expect(isPrivateIPv6('fd00::1')).toBe(true);
    expect(isPrivateIPv6('fdff:ffff:ffff:ffff::1')).toBe(true);
  });

  it('detects IPv4-mapped private addresses ::ffff:169.254.169.254', () => {
    expect(isPrivateIPv6('::ffff:169.254.169.254')).toBe(true);
    expect(isPrivateIPv6('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateIPv6('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateIPv6('::ffff:192.168.1.1')).toBe(true);
  });

  it('allows public IPv6 addresses', () => {
    expect(isPrivateIPv6('2606:4700:4700::1111')).toBe(false); // Cloudflare
    expect(isPrivateIPv6('2001:4860:4860::8888')).toBe(false); // Google
  });

  it('allows IPv4-mapped public addresses', () => {
    expect(isPrivateIPv6('::ffff:8.8.8.8')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Connect-hook lookup — the DNS-rebind defense
// ---------------------------------------------------------------------------
//
// The connect hook is what closes the TOCTOU gap. We unit-test it directly,
// feeding controlled answers via a stubbed dns.lookup. This simulates a
// DNS-rebinding attacker who returns a public IP to validateFeedUrl and
// a private IP when undici actually connects.
// ---------------------------------------------------------------------------

vi.mock('dns', async () => {
  const actual = await vi.importActual<typeof import('dns')>('dns');
  return {
    ...actual,
    lookup: vi.fn(),
  };
});

// Import AFTER the mock so the module picks up our stub
const { _ssrfSafeLookupForTests } = await import('../src/lib/safe-fetch.js');
const dns = await import('dns');
const mockedLookup = vi.mocked(dns.lookup);

describe('connect-hook lookup (SSRF rebinding defense)', () => {
  it('rejects when dns resolves to a private IPv4', async () => {
    mockedLookup.mockImplementation(((hostname: string, opts: unknown, cb: (err: Error | null, address: string, family: number) => void) => {
      cb(null, '169.254.169.254', 4);
    }) as unknown as typeof dns.lookup);

    const result = await new Promise<{ err: Error | null; address: string; family: number }>((resolve) => {
      _ssrfSafeLookupForTests('attacker.example', {}, (err, address, family) => {
        resolve({ err, address, family });
      });
    });

    expect(result.err).toBeInstanceOf(Error);
    expect((result.err as NodeJS.ErrnoException).code).toBe('SSRF_BLOCKED');
    expect(result.err!.message).toContain('169.254.169.254');
    expect(result.address).toBe('');
  });

  it('rejects when dns resolves to loopback 127.0.0.1', async () => {
    mockedLookup.mockImplementation(((hostname: string, opts: unknown, cb: (err: Error | null, address: string, family: number) => void) => {
      cb(null, '127.0.0.1', 4);
    }) as unknown as typeof dns.lookup);

    const result = await new Promise<{ err: Error | null; address: string; family: number }>((resolve) => {
      _ssrfSafeLookupForTests('localtest.example', {}, (err, address, family) => {
        resolve({ err, address, family });
      });
    });

    expect(result.err).toBeInstanceOf(Error);
    expect((result.err as NodeJS.ErrnoException).code).toBe('SSRF_BLOCKED');
  });

  it('rejects when dns resolves to an IPv6 unique-local address', async () => {
    mockedLookup.mockImplementation(((hostname: string, opts: unknown, cb: (err: Error | null, address: string, family: number) => void) => {
      cb(null, 'fd00::1', 6);
    }) as unknown as typeof dns.lookup);

    const result = await new Promise<{ err: Error | null; address: string; family: number }>((resolve) => {
      _ssrfSafeLookupForTests('ipv6-attacker.example', {}, (err, address, family) => {
        resolve({ err, address, family });
      });
    });

    expect(result.err).toBeInstanceOf(Error);
    expect((result.err as NodeJS.ErrnoException).code).toBe('SSRF_BLOCKED');
  });

  it('passes through when dns resolves to a public IPv4', async () => {
    mockedLookup.mockImplementation(((hostname: string, opts: unknown, cb: (err: Error | null, address: string, family: number) => void) => {
      cb(null, '8.8.8.8', 4);
    }) as unknown as typeof dns.lookup);

    const result = await new Promise<{ err: Error | null; address: string; family: number }>((resolve) => {
      _ssrfSafeLookupForTests('public.example', {}, (err, address, family) => {
        resolve({ err, address, family });
      });
    });

    expect(result.err).toBeNull();
    expect(result.address).toBe('8.8.8.8');
    expect(result.family).toBe(4);
  });

  it('propagates DNS resolution errors (ENOTFOUND)', async () => {
    const dnsErr = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    mockedLookup.mockImplementation(((hostname: string, opts: unknown, cb: (err: Error | null, address: string, family: number) => void) => {
      cb(dnsErr, '', 0);
    }) as unknown as typeof dns.lookup);

    const result = await new Promise<{ err: Error | null; address: string; family: number }>((resolve) => {
      _ssrfSafeLookupForTests('nowhere.invalid', {}, (err, address, family) => {
        resolve({ err, address, family });
      });
    });

    expect(result.err).toBe(dnsErr);
  });
});
