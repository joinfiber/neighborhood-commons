/**
 * Contributor policy — who can contribute what to the Commons.
 *
 * Today this is single-axis: can this account contribute photos? Photos
 * carry a contributor-warranty boundary — someone has to be on the hook
 * for the rights claim — so an account qualifies only if it has a
 * warrantor behind it. Two shapes count as a warrantor:
 *
 *   (a) a real Supabase Auth user (`auth_user_id IS NOT NULL`); or
 *   (b) a service-key claim (`claimed_at IS NOT NULL`) — the trusted-tenant
 *       pattern, where a consumer app (Merrie etc.) provisions one tenant
 *       `portal_account` and is named in `claimed_by`. The tenant IS the
 *       on-the-hook party for everything its key publishes.
 *
 * This predicate MUST stay identical to the create/PATCH route-level photo
 * gate in service/events.ts — both call this function. They diverged once
 * (the gate accepted `claimed_at`, this helper required `auth_user_id`),
 * which silently dropped covers for tenant-umbrella consumers whose tenant
 * accounts only ever carry `claimed_at`. One predicate, one place.
 *
 * Synthetic/scraper-created shells — neither auth-backed nor claimed —
 * still cannot contribute media bytes, by design.
 *
 * Phase 2 will add a `verified` flag on `portal_accounts` for verified
 * businesses; the helper will then also accept `verified = true`.
 *
 * This is fact-correctness, not editorial. Consumer apps (Fiber, Merrie,
 * etc.) may layer additional editorial filters on top.
 */

import { supabaseAdmin } from './supabase.js';

export async function canContributePhotos(creatorAccountId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('portal_accounts')
    .select('auth_user_id, claimed_at') // Phase 2: also select 'verified'
    .eq('id', creatorAccountId)
    .maybeSingle();

  if (error || !data) return false;
  // auth-backed OR service-key-claimed. Phase 2: || data.verified === true
  return data.auth_user_id != null || data.claimed_at != null;
}
