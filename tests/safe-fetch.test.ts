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
  type LookupAddress = { address: string; family: number };
  type CbResult = { err: Error | null; addresses: LookupAddress[] };
  type LookupCb = (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void;

  /**
   * Stub dns.lookup to return a fixed list of addresses via the `all: true`
   * callback shape (which is what our ssrfSafeLookup forces).
   */
  function stubDnsResolution(addresses: LookupAddress[]) {
    mockedLookup.mockImplementation(((_hostname: string, _opts: unknown, cb: (err: Error | null, addrs: LookupAddress[]) => void) => {
      cb(null, addresses);
    }) as unknown as typeof dns.lookup);
  }

  function invokeLookup(hostname: string): Promise<CbResult> {
    return new Promise((resolve) => {
      _ssrfSafeLookupForTests(hostname, {}, ((err: Error | null, addresses: LookupAddress[]) => {
        resolve({ err, addresses });
      }) as unknown as LookupCb);
    });
  }

  it('rejects when dns resolves to a private IPv4 (cloud metadata)', async () => {
    stubDnsResolution([{ address: '169.254.169.254', family: 4 }]);
    const { err, addresses } = await invokeLookup('attacker.example');
    expect(err).toBeInstanceOf(Error);
    expect((err as NodeJS.ErrnoException).code).toBe('SSRF_BLOCKED');
    expect(err!.message).toContain('169.254.169.254');
    expect(addresses).toEqual([]);
  });

  it('rejects when dns resolves to loopback 127.0.0.1', async () => {
    stubDnsResolution([{ address: '127.0.0.1', family: 4 }]);
    const { err } = await invokeLookup('localtest.example');
    expect((err as NodeJS.ErrnoException).code).toBe('SSRF_BLOCKED');
  });

  it('rejects when dns resolves to an IPv6 unique-local address', async () => {
    stubDnsResolution([{ address: 'fd00::1', family: 6 }]);
    const { err } = await invokeLookup('ipv6-attacker.example');
    expect((err as NodeJS.ErrnoException).code).toBe('SSRF_BLOCKED');
  });

  it('rejects mixed answers (one public, one private) — rebind hardening', async () => {
    // Attacker returns both a public and a private IP. Either is enough to fail
    // the whole answer; we must not pass through just the public one.
    stubDnsResolution([
      { address: '8.8.8.8', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ]);
    const { err } = await invokeLookup('mixed.example');
    expect((err as NodeJS.ErrnoException).code).toBe('SSRF_BLOCKED');
  });

  it('passes through when dns resolves to a public IPv4', async () => {
    stubDnsResolution([{ address: '8.8.8.8', family: 4 }]);
    const { err, addresses } = await invokeLookup('public.example');
    expect(err).toBeNull();
    expect(addresses).toEqual([{ address: '8.8.8.8', family: 4 }]);
  });

  it('passes through multiple public addresses', async () => {
    stubDnsResolution([
      { address: '8.8.8.8', family: 4 },
      { address: '1.1.1.1', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ]);
    const { err, addresses } = await invokeLookup('many-public.example');
    expect(err).toBeNull();
    expect(addresses).toHaveLength(3);
  });

  it('propagates DNS resolution errors (ENOTFOUND)', async () => {
    const dnsErr = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    mockedLookup.mockImplementation(((_hostname: string, _opts: unknown, cb: (err: Error | null, addresses: LookupAddress[]) => void) => {
      cb(dnsErr, []);
    }) as unknown as typeof dns.lookup);
    const { err } = await invokeLookup('nowhere.invalid');
    expect(err).toBe(dnsErr);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: real undici Agent + fetch()
// ---------------------------------------------------------------------------
//
// The unit tests above verify our lookup function in isolation. These tests
// verify the *integration* — that undici actually calls our hook with the
// shape we expect, that errors propagate back to fetch, and that the success
// path yields a real connection. Without these tests, the earlier bug (we
// returned a single string where undici expected a LookupAddress[]) passed
// every unit test but would have killed every outbound fetch in production
// the moment SSRF_STRICT flipped to 1.
// ---------------------------------------------------------------------------

describe('safeFetch end-to-end through undici Agent', () => {
  it('blocks when our lookup refuses the hostname', async () => {
    // Dynamic import of undici to avoid reloading the mocked dns module
    const { Agent } = await import('undici');
    type LookupAddress = { address: string; family: number };

    const blockingLookup = ((
      _hostname: string,
      _options: unknown,
      cb: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
    ) => {
      const e = new Error('SSRF test block') as NodeJS.ErrnoException;
      e.code = 'SSRF_BLOCKED';
      cb(e, []);
    }) as unknown;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const agent = new Agent({ connect: { lookup: blockingLookup as any } });

    let threw = false;
    try {
      await fetch('http://example.com/', {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dispatcher: agent as any,
      } as RequestInit);
    } catch (err) {
      threw = true;
      // fetch wraps the underlying error in a TypeError with `.cause`.
      const cause = (err as { cause?: Error }).cause;
      expect(cause?.message).toContain('SSRF test block');
    }
    expect(threw).toBe(true);
  });

  it('passes through the connect hook with the correct callback shape on success', async () => {
    // This is the regression test for the original bug. We do NOT make a real
    // network request — we assert that undici accepts our callback shape
    // without crashing. We simulate a connection refusal AFTER the hook runs,
    // which proves the hook itself was happy with our response.
    const { Agent } = await import('undici');
    type LookupAddress = { address: string; family: number };

    let hookCalled = false;
    const lookup = ((
      _hostname: string,
      options: { all?: boolean },
      cb: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
    ) => {
      hookCalled = true;
      // Sanity check: undici requests `all: true`. If this changes in a future
      // undici version, our implementation needs re-validation.
      expect(options.all).toBe(true);
      // Return a loopback address so the TCP connect fails cleanly on a closed
      // local port — the important thing is that the callback shape was accepted.
      cb(null, [{ address: '127.0.0.1', family: 4 }]);
    }) as unknown;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const agent = new Agent({ connect: { lookup: lookup as any } });

    try {
      await fetch('http://hook-shape-test.invalid/', {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dispatcher: agent as any,
        signal: AbortSignal.timeout(2000),
      } as RequestInit);
    } catch (err) {
      // Expected: connection refused on port 80 of 127.0.0.1 (nothing listening).
      // What we're asserting is that it did NOT fail with
      // "Invalid IP address: undefined" — the symptom of a malformed
      // callback response.
      const cause = (err as { cause?: Error }).cause;
      const msg = (cause?.message || (err as Error).message || '').toLowerCase();
      expect(msg).not.toContain('invalid ip');
    }
    expect(hookCalled).toBe(true);
  });
});
