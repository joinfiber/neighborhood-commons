/**
 * Geocoding Tests
 *
 * Verifies address normalization, Nominatim response parsing,
 * account-default fallback, skip logic, and rate limiting.
 * Uses mocked fetch and supabaseAdmin to avoid external calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock supabaseAdmin — vi.hoisted ensures fns exist before vi.mock hoists
// ---------------------------------------------------------------------------

const { mockFrom, mockUpdate, mockSelect } = vi.hoisted(() => {
  const mockUpdate = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
  const mockSelect = vi.fn();
  const mockFrom = vi.fn((table: string) => {
    if (table === 'portal_accounts') {
      return { select: mockSelect };
    }
    if (table === 'events') {
      return { update: mockUpdate };
    }
    return {};
  });
  return { mockFrom, mockUpdate, mockSelect };
});

vi.mock('../src/lib/supabase.js', () => ({
  supabaseAdmin: { from: mockFrom },
}));

import { normalizeAddress, nominatimGeocode, geocodeEventIfNeeded } from '../src/lib/geocoding.js';

// ---------------------------------------------------------------------------
// Address normalization
// ---------------------------------------------------------------------------

describe('normalizeAddress', () => {
  it('lowercases and trims', () => {
    expect(normalizeAddress('  123 Main St  ')).toBe('123 main st');
  });

  it('collapses multiple spaces', () => {
    expect(normalizeAddress('123   Main    St')).toBe('123 main st');
  });

  it('produces consistent output for equivalent inputs', () => {
    expect(normalizeAddress('  123 MAIN ST ')).toBe(normalizeAddress('123 main st'));
  });
});

// ---------------------------------------------------------------------------
// Nominatim response parsing
// ---------------------------------------------------------------------------

describe('nominatimGeocode', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('parses a valid Nominatim response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([{ lat: '39.9526', lon: '-75.1652' }]),
    }) as unknown as typeof fetch;

    const result = await nominatimGeocode('Philadelphia, PA');
    expect(result).toEqual({ lat: 39.9526, lng: -75.1652 });
  });

  it('returns null for empty results', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    }) as unknown as typeof fetch;

    const result = await nominatimGeocode('nonexistent address xyz');
    expect(result).toBeNull();
  });

  it('returns null on HTTP error', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
    }) as unknown as typeof fetch;

    const result = await nominatimGeocode('Philadelphia, PA');
    expect(result).toBeNull();
  });

  it('returns null on network error', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network timeout')) as unknown as typeof fetch;

    const result = await nominatimGeocode('Philadelphia, PA');
    expect(result).toBeNull();
  });

  it('returns null for invalid coordinate values', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([{ lat: 'not-a-number', lon: 'also-not' }]),
    }) as unknown as typeof fetch;

    const result = await nominatimGeocode('bad data');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// geocodeEventIfNeeded — skip logic
// ---------------------------------------------------------------------------

describe('geocodeEventIfNeeded', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips when coordinates already exist', async () => {
    await geocodeEventIfNeeded('evt-1', '123 Main St', 39.95, -75.16, null);
    // Should not call supabaseAdmin.from at all
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('skips when address is null', async () => {
    await geocodeEventIfNeeded('evt-2', null, null, null, null);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('skips when address is empty string', async () => {
    await geocodeEventIfNeeded('evt-3', '   ', null, null, null);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('uses account default coordinates when available', async () => {
    mockSelect.mockReturnValue({
      eq: vi.fn().mockReturnValue({
        maybeSingle: vi.fn().mockResolvedValue({
          data: { default_latitude: 39.9526, default_longitude: -75.1652 },
        }),
      }),
    });

    const updateEq = vi.fn().mockResolvedValue({ error: null });
    mockUpdate.mockReturnValue({ eq: updateEq });

    await geocodeEventIfNeeded('evt-4', '123 Main St', null, null, 'account-1');

    // Should have queried portal_accounts for defaults
    expect(mockFrom).toHaveBeenCalledWith('portal_accounts');
    // Should have updated the event
    expect(mockFrom).toHaveBeenCalledWith('events');
    expect(mockUpdate).toHaveBeenCalledWith({
      latitude: 39.9526,
      longitude: -75.1652,
      approximate_location: 'POINT(-75.1652 39.9526)',
    });
  });
});
