/**
 * Contribute URL Validation Tests
 *
 * Covers validateContributeUrl: hard-reject normalcy checks (scheme, credentials,
 * IP literals, blocked hostnames) and the approved-domain soft-reject path.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';

// Mock the supabase client so the approved-domains lookup returns a fixed set.
const APPROVED = new Set(['eventbrite.com', 'merrie.co', 'phillybiketrain.org']);

vi.mock('../src/lib/supabase.js', () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => Promise.resolve({
        data: [...APPROVED].map((domain) => ({ domain })),
        error: null,
      }),
      insert: () => Promise.resolve({ error: null }),
    }),
  },
}));

let validateContributeUrl: typeof import('../src/lib/url-sanitizer.js').validateContributeUrl;
let invalidateApprovedDomainsCache: typeof import('../src/lib/url-sanitizer.js').invalidateApprovedDomainsCache;

beforeAll(async () => {
  const mod = await import('../src/lib/url-sanitizer.js');
  validateContributeUrl = mod.validateContributeUrl;
  invalidateApprovedDomainsCache = mod.invalidateApprovedDomainsCache;
  invalidateApprovedDomainsCache();
});

describe('hard-reject normalcy checks', () => {
  it('rejects malformed URLs', async () => {
    const r = await validateContributeUrl('not a url');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('INVALID_URL');
  });

  it('rejects javascript: scheme', async () => {
    const r = await validateContributeUrl('javascript:alert(1)');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('INVALID_SCHEME');
  });

  it('rejects data: scheme', async () => {
    const r = await validateContributeUrl('data:text/html,<script>alert(1)</script>');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('INVALID_SCHEME');
  });

  it('rejects ftp: scheme', async () => {
    const r = await validateContributeUrl('ftp://eventbrite.com/foo');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('INVALID_SCHEME');
  });

  it('rejects URLs with embedded credentials', async () => {
    const r = await validateContributeUrl('https://user:pass@eventbrite.com/foo');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('URL_CREDENTIALS');
  });

  it('rejects IPv4 literals', async () => {
    const r = await validateContributeUrl('https://192.168.1.1/foo');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('IP_LITERAL');
  });

  it('rejects IPv6 literals', async () => {
    const r = await validateContributeUrl('https://[::1]/foo');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('IP_LITERAL');
  });

  it('rejects localhost', async () => {
    const r = await validateContributeUrl('https://localhost/foo');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('BLOCKED_HOSTNAME');
  });

  it('rejects .local hostnames', async () => {
    const r = await validateContributeUrl('https://printer.local/foo');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('BLOCKED_HOSTNAME');
  });
});

describe('approved domain check', () => {
  it('accepts an exact approved domain', async () => {
    const r = await validateContributeUrl('https://eventbrite.com/e/123');
    expect(r.ok).toBe(true);
  });

  it('accepts subdomains of approved domains', async () => {
    const r = await validateContributeUrl('https://www.eventbrite.com/e/123');
    expect(r.ok).toBe(true);
  });

  it('soft-rejects unknown domains with DOMAIN_PENDING_REVIEW', async () => {
    const r = await validateContributeUrl('https://random-new-site.example/event');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('DOMAIN_PENDING_REVIEW');
      expect(r.domain).toBe('random-new-site.example');
    }
  });

  it('previously-rejected community sites pass when allowlisted', async () => {
    const r = await validateContributeUrl('https://phillybiketrain.org/rides');
    expect(r.ok).toBe(true);
  });
});

describe('normalization', () => {
  it('coerces http to https', async () => {
    const r = await validateContributeUrl('http://eventbrite.com/e/123');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url.startsWith('https://')).toBe(true);
  });

  it('strips tracking params on success', async () => {
    const r = await validateContributeUrl('https://eventbrite.com/e/123?utm_source=fb&fbclid=abc&keep=yes');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.url).not.toContain('utm_source');
      expect(r.url).not.toContain('fbclid');
      expect(r.url).toContain('keep=yes');
    }
  });
});
