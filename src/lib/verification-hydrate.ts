/**
 * Verification hydration helper (v2).
 *
 * Looks up active verifications for a set of organizations in one query and
 * returns a Map keyed by organization_id with the primary verification
 * block — the most recent active record.
 *
 * Used by read endpoints that surface a `verification` field on
 * organizations or `verified` on event organizers.
 *
 * v2 changes from v1:
 *   - Queries `organization_verifications` (the simplified v2 table) instead
 *     of `account_verified_identifiers` (which was dropped in migration 082).
 *   - Drops the polymorphic target_type abstraction; only organizations verify.
 *   - The function signature no longer takes a target_type parameter.
 */

import { supabaseAdmin } from './supabase.js';

export type VerificationBlock = {
  method: string;
  verifiedAt: string;
  verifiedByApp: string;
};

export type VerificationByTarget = Map<string, VerificationBlock>;

/**
 * Returns a map of organization_id → primary verification block (most recent active).
 * Empty map if no organization ids passed.
 */
export async function hydrateVerificationsFor(
  organizationIds: string[]
): Promise<VerificationByTarget> {
  const result = new Map<string, VerificationBlock>();
  if (organizationIds.length === 0) return result;

  const { data, error } = await supabaseAdmin
    .from('organization_verifications')
    .select('organization_id, method, verified_at, approved_by_app')
    .eq('status', 'active')
    .in('organization_id', organizationIds)
    .order('verified_at', { ascending: false });

  if (error) {
    console.error('[VERIFICATION:HYDRATE] Query error:', error.message);
    return result;
  }

  // Most recent first → keep first per organization_id
  for (const row of data || []) {
    const orgId = row.organization_id as string;
    if (result.has(orgId)) continue;
    result.set(orgId, {
      method: row.method as string,
      verifiedAt: row.verified_at as string,
      verifiedByApp: row.approved_by_app as string,
    });
  }

  return result;
}

/**
 * Resolves verified / verified_by / not_verified_by query params into an
 * include/exclude set of organization IDs that the caller can apply to the
 * main SQL query. Pushes verification filtering INTO SQL so meta.total
 * reflects the filtered count and pagination is correct.
 *
 * Returns:
 *   - { empty: true }                     — filters guarantee zero results
 *   - { includeIds: [...] }               — caller does query.in('id', ids)
 *   - { excludeIds: [...] }               — caller does query.not('id','in',...)
 *   - {}                                  — no verification filters set
 */
export type VerificationIdFilter =
  | { empty: true }
  | { includeIds: string[] }
  | { excludeIds: string[] }
  | Record<string, never>;

export async function resolveVerificationIdFilter(
  params: {
    verified?: 'true' | 'false';
    verified_by?: string;
    not_verified_by?: string;
  }
): Promise<VerificationIdFilter> {
  const hasVerified = params.verified !== undefined;
  const hasVerifiedBy = !!params.verified_by;
  const hasNotVerifiedBy = !!params.not_verified_by;

  if (!hasVerified && !hasVerifiedBy && !hasNotVerifiedBy) return {};

  const { data: rows } = await supabaseAdmin
    .from('organization_verifications')
    .select('organization_id, approved_by_app')
    .eq('status', 'active');

  // Map of organization_id → set of approving apps
  const verifiersByOrg = new Map<string, Set<string>>();
  for (const r of rows || []) {
    const orgId = r.organization_id as string;
    if (!verifiersByOrg.has(orgId)) verifiersByOrg.set(orgId, new Set());
    verifiersByOrg.get(orgId)!.add(r.approved_by_app as string);
  }

  // Start from "all verified orgs" if verified=true, else "all orgs"
  let allowed: Set<string> | 'all' = 'all';
  if (params.verified === 'true') {
    allowed = new Set(verifiersByOrg.keys());
  }

  // Inclusive verified_by — narrows the allowed set to orgs verified by
  // at least one of the listed apps.
  if (hasVerifiedBy) {
    const allowedApps = new Set(params.verified_by!.split(',').map(s => s.trim()).filter(Boolean));
    const narrowed = new Set<string>();
    for (const [orgId, apps] of verifiersByOrg) {
      if (allowed === 'all' || allowed.has(orgId)) {
        for (const a of apps) {
          if (allowedApps.has(a)) { narrowed.add(orgId); break; }
        }
      }
    }
    allowed = narrowed;
  }

  // Exclusive — verified=false drops everything in verifiersByOrg;
  // not_verified_by drops orgs whose approving-apps set intersects.
  const exclude = new Set<string>();
  if (params.verified === 'false') {
    for (const orgId of verifiersByOrg.keys()) exclude.add(orgId);
  }
  if (hasNotVerifiedBy) {
    const blockedApps = new Set(params.not_verified_by!.split(',').map(s => s.trim()).filter(Boolean));
    for (const [orgId, apps] of verifiersByOrg) {
      for (const a of apps) {
        if (blockedApps.has(a)) { exclude.add(orgId); break; }
      }
    }
  }

  // Combine. If we have a concrete allowed set, intersect with exclude.
  if (allowed !== 'all') {
    for (const orgId of exclude) allowed.delete(orgId);
    if (allowed.size === 0) return { empty: true };
    return { includeIds: Array.from(allowed) };
  }

  // allowed === 'all' and we have exclusions → tell caller to .not('id','in',...)
  if (exclude.size > 0) {
    return { excludeIds: Array.from(exclude) };
  }

  return {};
}

/**
 * Returns true if the given organization has at least one active verification.
 * Used by event write paths to compute first_party server-side: an event is
 * first-party iff its organizer is verified at insert time.
 *
 * v2 simplification: only organizations are verifiable (persons primitive gone).
 */
export async function isFirstPartyByOrganizer(
  organizerOrgId: string | null | undefined,
): Promise<boolean> {
  if (!organizerOrgId) return false;

  const { count } = await supabaseAdmin
    .from('organization_verifications')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizerOrgId)
    .eq('status', 'active');
  return (count ?? 0) > 0;
}
