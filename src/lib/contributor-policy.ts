/**
 * Contributor policy — who can contribute what to the Commons.
 *
 * Today this is single-axis: can this account contribute photos? Only
 * accounts with a real auth user behind them (`auth_user_id IS NOT NULL`)
 * qualify. Synthetic/scraper-created accounts cannot, by design.
 *
 * Phase 2 will introduce a `verified` flag on `portal_accounts` for
 * verified businesses; the helper will then accept either claimed
 * (auth_user_id NOT NULL) OR verified = true. The verified path lets
 * a business be a legitimate photo source even without an individual
 * user login behind it.
 *
 * This is fact-correctness, not editorial: the Commons should not
 * accept media bytes from anonymous shells. Consumer apps (Fiber,
 * Merrie, etc.) may layer additional editorial filters on top.
 */

import { supabaseAdmin } from './supabase.js';

export async function canContributePhotos(creatorAccountId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('portal_accounts')
    .select('auth_user_id') // Phase 2: also select 'verified'
    .eq('id', creatorAccountId)
    .maybeSingle();

  if (error || !data) return false;
  return data.auth_user_id != null; // Phase 2: || data.verified === true
}
