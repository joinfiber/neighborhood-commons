/**
 * Operator-only one-shot: provision the Merrie tenant portal_account.
 *
 * NOT the canonical onboarding path for consumer apps. Third-party consumers
 * should use `POST /service/accounts/link` after their service key is
 * activated — that endpoint creates the tenant account, links the calling
 * key, and returns the UUID in a single self-service call. See
 * `docs/consumer-guide.md` → "Consumer patterns" for the developer-facing
 * setup flow.
 *
 * This script exists for the Merrie case specifically (the Commons operator
 * is also the Merrie operator, so direct DB access is faster than the API
 * round-trip) and for the rare situation where a tenant must be
 * pre-provisioned before its service key is activated (which would otherwise
 * 403 the /accounts/link call). For any other case, prefer the public API.
 *
 * Creates a tenant-umbrella portal_account row and links the named service-
 * tier API key to it. Merrie publishes events on behalf of many community
 * groups under one shared account_id — this row is that shared account.
 *
 * Idempotent: re-running won't duplicate the account or the link.
 *
 * Usage:
 *   # With env vars in shell:
 *   npx tsx scripts/provision-merrie-tenant.ts
 *   # Or with a Node env-file:
 *   node --env-file=portal/.env --import tsx scripts/provision-merrie-tenant.ts
 *   # Add --dry-run to print what would happen without writing:
 *   npx tsx scripts/provision-merrie-tenant.ts --dry-run
 *
 * Env:
 *   SUPABASE_URL                  required
 *   SUPABASE_SERVICE_ROLE_KEY     required
 *   MERRIE_API_KEY_ID             optional — explicit key UUID (preferred)
 *   MERRIE_API_KEY_NAME           optional — exact name match
 *                                 (default: lookup by 'name ILIKE %merrie%')
 *   MERRIE_TENANT_EMAIL           optional — sentinel email
 *                                 (default: merrie-tenant@no-reply.neighborhood-commons.org)
 *
 * The sentinel email is intentionally a no-reply address nobody will try to
 * OTP-claim. claimed_at is set to now() so any future /accounts/link attempt
 * with the same email lands on a pre-claimed row.
 */

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env.');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceRoleKey);

const TENANT_EMAIL = (process.env.MERRIE_TENANT_EMAIL
  || 'merrie-tenant@no-reply.neighborhood-commons.org').toLowerCase().trim();
const CLAIMED_BY = 'merrie';

const dryRun = process.argv.includes('--dry-run');

async function findMerrieApiKey(): Promise<{ id: string; name: string }> {
  if (process.env.MERRIE_API_KEY_ID) {
    const { data } = await supabase
      .from('api_keys')
      .select('id, name, contributor_tier, status')
      .eq('id', process.env.MERRIE_API_KEY_ID)
      .maybeSingle();
    if (!data) throw new Error(`No api_keys row with id=${process.env.MERRIE_API_KEY_ID}`);
    if (data.contributor_tier !== 'service') {
      throw new Error(`Key ${data.id} is tier=${data.contributor_tier}, expected service`);
    }
    return { id: data.id, name: data.name };
  }

  if (process.env.MERRIE_API_KEY_NAME) {
    const { data } = await supabase
      .from('api_keys')
      .select('id, name, contributor_tier, status')
      .eq('name', process.env.MERRIE_API_KEY_NAME)
      .eq('contributor_tier', 'service')
      .maybeSingle();
    if (!data) throw new Error(`No service-tier api_keys row with name="${process.env.MERRIE_API_KEY_NAME}"`);
    return { id: data.id, name: data.name };
  }

  // Fuzzy lookup
  const { data: candidates } = await supabase
    .from('api_keys')
    .select('id, name, contributor_tier, status, contact_email, created_at')
    .ilike('name', '%merrie%')
    .eq('contributor_tier', 'service');

  if (!candidates || candidates.length === 0) {
    throw new Error('No service-tier api_keys found matching name ILIKE %merrie%. Set MERRIE_API_KEY_ID or MERRIE_API_KEY_NAME.');
  }
  if (candidates.length > 1) {
    console.error('Multiple candidate keys — set MERRIE_API_KEY_ID to disambiguate:');
    for (const c of candidates) {
      console.error(`  id=${c.id} name="${c.name}" status=${c.status} contact=${c.contact_email} created=${c.created_at}`);
    }
    throw new Error('Ambiguous key lookup.');
  }
  return { id: candidates[0]!.id, name: candidates[0]!.name };
}

async function main() {
  console.log('=== Merrie tenant provisioning ===');
  console.log(`Mode:           ${dryRun ? 'DRY-RUN' : 'LIVE'}`);
  console.log(`Tenant email:   ${TENANT_EMAIL}`);
  console.log();

  // 1. Find Merrie's service key
  const merrieKey = await findMerrieApiKey();
  console.log(`Found Merrie API key: ${merrieKey.id} ("${merrieKey.name}")`);

  // 2. Find or create the tenant portal_account (operational shell — v2
  //    narrowed portal_accounts to email + claim + status; business
  //    profile lives on organizations).
  const { data: existing } = await supabase
    .from('portal_accounts')
    .select('id, email, status, claimed_at, claimed_by, auth_user_id')
    .ilike('email', TENANT_EMAIL)
    .maybeSingle();

  let accountId: string;
  let accountCreated = false;

  if (existing) {
    accountId = existing.id;
    console.log(`Existing portal_account found: ${accountId}`);
    console.log(`  status:        ${existing.status}`);
    console.log(`  claimed_at:    ${existing.claimed_at}`);
    console.log(`  claimed_by:    ${existing.claimed_by}`);
    console.log(`  auth_user_id:  ${existing.auth_user_id ?? '(null — good)'}`);

    if (existing.auth_user_id) {
      throw new Error(
        `Tenant row already has auth_user_id set — refusing to mutate. Investigate manually.`,
      );
    }
  } else {
    if (dryRun) {
      console.log('Would insert portal_accounts row (dry-run skipped).');
      accountId = '<dry-run-pending-uuid>';
    } else {
      const nowIso = new Date().toISOString();
      const { data: created, error } = await supabase
        .from('portal_accounts')
        .insert({
          email: TENANT_EMAIL,
          status: 'active',
          claimed_at: nowIso,
          claimed_by: CLAIMED_BY,
        })
        .select('id')
        .single();
      if (error) throw new Error(`Insert failed: ${error.message}`);
      accountId = created.id;
      accountCreated = true;
      console.log(`Created portal_account: ${accountId}`);
    }
  }

  // v2.1 trusted-tenant pattern (migration 084): bind Merrie's API key to
  // the tenant portal_account via api_keys.tenant_account_id. After this,
  // every Organization Merrie creates auto-derives owner_account_id from
  // this account, which satisfies the photo-eligibility gate.
  if (dryRun) {
    console.log(`Would set api_keys.tenant_account_id=${accountId} on key ${merrieKey.id} (dry-run skipped).`);
  } else {
    const { error: bindError } = await supabase
      .from('api_keys')
      .update({ tenant_account_id: accountId })
      .eq('id', merrieKey.id);
    if (bindError) throw new Error(`Failed to bind tenant_account_id on api_keys: ${bindError.message}`);
    console.log(`Bound Merrie key → tenant_account_id=${accountId}`);
  }

  // Writeable scope (which orgs Merrie can publish for) is separate — set
  // up via POST /service/organizations/link or auto-linked when Merrie's
  // key creates an organization. The tenant binding above is purely about
  // ownership-derivation on org create, not about write authorization.

  console.log();
  console.log('=== DONE ===');
  console.log(`COMMONS_PORTAL_ACCOUNT_ID=${accountId}`);
  console.log();
  console.log('Operator next steps:');
  console.log('  1. Set COMMONS_PORTAL_ACCOUNT_ID in Merrie\'s environment (informational; the server auto-derives it now).');
  console.log('  2. Backfill ownership on Merrie\'s existing orgs (replace ORG_IDS with the actual list):');
  console.log('       UPDATE organizations SET owner_account_id = \'' + accountId + '\'');
  console.log('         WHERE id IN (\'org-uuid-1\', \'org-uuid-2\', ...) AND owner_account_id IS NULL;');
  console.log('  3. Promote those orgs to method = \'self_asserted\' (post-085 doctrine — owner = first-party):');
  console.log('       UPDATE organizations SET method = \'self_asserted\'');
  console.log('         WHERE owner_account_id = \'' + accountId + '\' AND method = \'seeded\';');
  console.log('  4. Confirm Merrie\'s key is linked to its orgs via /service/organizations/link if it hasn\'t been already.');
}

main().catch((err) => {
  console.error('FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
