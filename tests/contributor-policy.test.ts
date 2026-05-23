/**
 * Contributor policy — photo-eligibility predicate
 *
 * canContributePhotos is the single predicate shared by the create gate,
 * the PATCH gate, and the attach worker. It MUST accept both warrantor
 * shapes: an auth-backed account (auth_user_id) OR a service-key-claimed
 * tenant (claimed_at). The two diverged once — the gate accepted claimed_at
 * but this helper required auth_user_id — which silently dropped covers for
 * tenant-umbrella consumers (Merrie). This test locks the predicate so that
 * regression can't return.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockMaybeSingle = vi.hoisted(() => vi.fn());

vi.mock('../src/lib/supabase.js', () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: mockMaybeSingle }),
      }),
    }),
  },
}));

import { canContributePhotos } from '../src/lib/contributor-policy.js';

describe('canContributePhotos', () => {
  beforeEach(() => mockMaybeSingle.mockReset());

  it('true for an auth-backed account (auth_user_id set)', async () => {
    mockMaybeSingle.mockResolvedValue({ data: { auth_user_id: 'auth-1', claimed_at: null }, error: null });
    expect(await canContributePhotos('acct')).toBe(true);
  });

  it('true for a service-key-claimed tenant (claimed_at set, no auth_user_id) — the trusted-tenant fix', async () => {
    mockMaybeSingle.mockResolvedValue({ data: { auth_user_id: null, claimed_at: '2026-01-01T00:00:00Z' }, error: null });
    expect(await canContributePhotos('acct')).toBe(true);
  });

  it('false for an unclaimed, non-auth shell (both null)', async () => {
    mockMaybeSingle.mockResolvedValue({ data: { auth_user_id: null, claimed_at: null }, error: null });
    expect(await canContributePhotos('acct')).toBe(false);
  });

  it('false when the account row is missing', async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await canContributePhotos('acct')).toBe(false);
  });

  it('false on a query error', async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: { message: 'boom' } });
    expect(await canContributePhotos('acct')).toBe(false);
  });
});
