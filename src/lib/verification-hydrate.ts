/**
 * Verification hydration helper.
 *
 * Looks up active verified identifiers for a set of targets (organizations
 * or persons) in one query and returns a Map keyed by target_id with the
 * primary verification block — the most recent active identifier.
 *
 * Used by all read endpoints that surface a `verification` field.
 */

import { supabaseAdmin } from './supabase.js';

export type VerificationBlock = {
  method: string;
  verifiedVia: string | null;
  verifiedAt: string;
  verifiedByApp: string;
};

export type VerificationByTarget = Map<string, VerificationBlock>;

/**
 * Returns a map of target_id → primary verification block (most recent active).
 * Empty map if no targets passed.
 */
export async function hydrateVerificationsFor(
  targetType: 'organization' | 'person',
  ids: string[]
): Promise<VerificationByTarget> {
  const result = new Map<string, VerificationBlock>();
  if (ids.length === 0) return result;

  const { data, error } = await supabaseAdmin
    .from('account_verified_identifiers')
    .select('target_id, method, evidence, verified_at, approved_by_app')
    .eq('target_type', targetType)
    .eq('status', 'active')
    .in('target_id', ids)
    .order('verified_at', { ascending: false });

  if (error) {
    console.error('[VERIFICATION:HYDRATE] Query error:', error.message);
    return result;
  }

  // Most recent first → keep first per target_id
  for (const row of data || []) {
    const tid = row.target_id as string;
    if (result.has(tid)) continue;
    const evidence = (row.evidence || {}) as Record<string, unknown>;
    result.set(tid, {
      method: row.method as string,
      verifiedVia: (evidence.verifiedVia as string) || null,
      verifiedAt: row.verified_at as string,
      verifiedByApp: row.approved_by_app as string,
    });
  }

  return result;
}
