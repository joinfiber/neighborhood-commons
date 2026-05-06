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

/**
 * Resolves verified / verified_by / not_verified_by query params into an
 * include/exclude set of target IDs that the caller can apply to the main
 * SQL query. This pushes verification filtering INTO SQL instead of doing
 * it post-fetch, so meta.total reflects the filtered count and pagination
 * is correct.
 *
 * Returns:
 *   - { empty: true }                     — filters guarantee zero results
 *   - { includeIds: [...] }               — caller does query.in('id', ids)
 *   - { excludeIds: [...] }               — caller does query.not('id','in',...)
 *   - {}                                  — no verification filters set
 *
 * Caller passes target_type ('organization' | 'person') and the three
 * query params (any may be undefined).
 */
export type VerificationIdFilter =
  | { empty: true }
  | { includeIds: string[] }
  | { excludeIds: string[] }
  | Record<string, never>;

export async function resolveVerificationIdFilter(
  targetType: 'organization' | 'person',
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
    .from('account_verified_identifiers')
    .select('target_id, approved_by_app')
    .eq('target_type', targetType)
    .eq('status', 'active');

  // Map of target_id → set of approving apps
  const verifiersByTarget = new Map<string, Set<string>>();
  for (const r of rows || []) {
    const tid = r.target_id as string;
    if (!verifiersByTarget.has(tid)) verifiersByTarget.set(tid, new Set());
    verifiersByTarget.get(tid)!.add(r.approved_by_app as string);
  }

  // Start from "all verified targets" if verified=true, else "all targets"
  // (we represent "all targets" as a sentinel — applied at the SQL layer
  // via no .in() call, then refined by exclusions).
  let allowed: Set<string> | 'all' = 'all';
  if (params.verified === 'true') {
    allowed = new Set(verifiersByTarget.keys());
  }

  // Inclusive verified_by — narrows the allowed set to targets verified by
  // at least one of the listed apps.
  if (hasVerifiedBy) {
    const allowedApps = new Set(params.verified_by!.split(',').map(s => s.trim()).filter(Boolean));
    const narrowed = new Set<string>();
    for (const [tid, apps] of verifiersByTarget) {
      if (allowed === 'all' || allowed.has(tid)) {
        for (const a of apps) {
          if (allowedApps.has(a)) { narrowed.add(tid); break; }
        }
      }
    }
    allowed = narrowed;
  }

  // Exclusive — verified=false drops everything in verifiersByTarget;
  // not_verified_by drops targets whose approving-apps set intersects the
  // blocked apps.
  const exclude = new Set<string>();
  if (params.verified === 'false') {
    for (const tid of verifiersByTarget.keys()) exclude.add(tid);
  }
  if (hasNotVerifiedBy) {
    const blockedApps = new Set(params.not_verified_by!.split(',').map(s => s.trim()).filter(Boolean));
    for (const [tid, apps] of verifiersByTarget) {
      for (const a of apps) {
        if (blockedApps.has(a)) { exclude.add(tid); break; }
      }
    }
  }

  // Combine. If we have a concrete allowed set, intersect with exclude.
  if (allowed !== 'all') {
    for (const tid of exclude) allowed.delete(tid);
    if (allowed.size === 0) return { empty: true };
    return { includeIds: Array.from(allowed) };
  }

  // allowed === 'all' and we have exclusions → tell caller to .not('id','in',...)
  if (exclude.size > 0) {
    return { excludeIds: Array.from(exclude) };
  }

  // No filters effective.
  return {};
}
