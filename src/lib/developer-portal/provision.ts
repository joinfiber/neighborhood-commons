/**
 * Atomic provisioning at OTP-verify time.
 *
 * When the developer enters their OTP, this single function does all the
 * DB work in tight sequence:
 *
 *   1. Derive a unique slug from app_name.
 *   2. Create the `contributor_profiles` row (status='pending').
 *   3. Create the tenant `portal_accounts` row (sentinel email, claimed).
 *   4. Issue a pending service-tier `api_keys` row with:
 *        - contributor_profile_id → the new profile
 *        - tenant_account_id → the new portal_account
 *        - application_metadata → operator-review fields
 *        - brand_config → derived from app_name + app_url
 *   5. Clear the `pending_registrations` row.
 *   6. Create a `developer_sessions` row for the new key.
 *
 * Returns the raw service key (only available once — caller surfaces in
 * UI) and the raw session token (caller sets cookie).
 *
 * Postgres doesn't expose multi-statement transactions through PostgREST,
 * so this is "best-effort atomic" — each insert runs in its own
 * statement. On failure mid-way, the caller should run the cleanup
 * helper to roll back partial state. Per docs/onboarding-redesign.md §4.2.
 */

import { createHash, randomBytes } from 'crypto';
import { supabaseAdmin } from '../supabase.js';
import { deriveUniqueSlug } from './slugify.js';
import { createSession } from './sessions.js';

const KEY_PREFIX = 'nc_';
const KEY_BODY_BYTES = 24;

export interface RegistrationFormData {
  email: string;
  app_name: string;
  tagline: string;
  description: string;
  who_its_for: string | null;
  app_url: string;
  category: string | null;
  what_youre_building: string;
  verification_process: string;
}

export interface ProvisionResult {
  /** The new contributor_profiles row id. */
  profileId: string;
  /** The slug derived for the new profile. */
  profileSlug: string;
  /** The new portal_accounts row id (the tenant). */
  portalAccountId: string;
  /** The new api_keys row id. */
  apiKeyId: string;
  /**
   * The raw API key string. Shown ONCE to the developer; never recoverable.
   * Format: nc_<48-hex>.
   */
  rawApiKey: string;
  /** Raw session token (set as cookie by caller). */
  rawSessionToken: string;
  /** Session expiry timestamp. */
  sessionExpiresAt: Date;
}

/**
 * Generate a fresh raw API key + its hash. The hash is what's stored.
 * Key format mirrors existing prod keys.
 */
function generateApiKey(): { rawKey: string; keyHash: string; keyPrefix: string } {
  const bodyHex = randomBytes(KEY_BODY_BYTES).toString('hex');
  const rawKey = `${KEY_PREFIX}${bodyHex}`;
  const keyHash = createHash('sha256').update(rawKey).digest('hex');
  // 12 chars is enough to disambiguate operator-side without exposing the rest.
  const keyPrefix = rawKey.slice(0, 12);
  return { rawKey, keyHash, keyPrefix };
}

/**
 * Run the full provisioning sequence. Caller has already validated the
 * OTP and read the registration form data from `pending_registrations`.
 *
 * Returns the artifacts the developer needs (the raw key + the session
 * token). The caller surfaces the key in HTML and sets the session cookie.
 */
export async function provisionDeveloper(form: RegistrationFormData): Promise<ProvisionResult> {
  // ── 1. Derive a unique slug
  const slug = await deriveUniqueSlug(form.app_name);

  // ── 2. Create the contributor profile
  const { data: profile, error: profileErr } = await supabaseAdmin
    .from('contributor_profiles')
    .insert({
      slug,
      name: form.app_name,
      tagline: form.tagline || null,
      description: form.description || null,
      who_its_for: form.who_its_for || null,
      app_url: form.app_url || null,
      category: form.category || null,
      status: 'pending',
    })
    .select('id, slug')
    .single();

  if (profileErr || !profile) {
    console.error('[DEV_PORTAL] Profile insert failed:', profileErr?.message);
    throw new Error('Failed to create contributor profile');
  }

  // ── 3. Create the tenant portal_account
  const tenantEmail = `${slug}-tenant@no-reply.neighborhood-commons.org`;
  const nowIso = new Date().toISOString();
  const { data: portalAccount, error: accountErr } = await supabaseAdmin
    .from('portal_accounts')
    .insert({
      email: tenantEmail,
      status: 'active',
      claimed_at: nowIso,
      claimed_by: slug,
    })
    .select('id')
    .single();

  if (accountErr || !portalAccount) {
    console.error('[DEV_PORTAL] Tenant account insert failed:', accountErr?.message);
    // Roll back the profile we just created so the slug frees up.
    await supabaseAdmin.from('contributor_profiles').delete().eq('id', profile.id);
    throw new Error('Failed to create tenant account');
  }

  // ── 4. Issue the pending api_key
  const { rawKey, keyHash, keyPrefix } = generateApiKey();
  // Extracted to locals so the schema-alignment scanner doesn't misread the
  // nested JSONB-field keys (what_youre_building, app_name) as top-level
  // api_keys column references.
  const applicationMetadata = {
    what_youre_building: form.what_youre_building,
    verification_process: form.verification_process,
  };
  const brandConfig = {
    app_name: form.app_name,
    from_email: 'verify@neighborhood-commons.org',
    from_name: form.app_name,
  };
  const { data: apiKey, error: keyErr } = await supabaseAdmin
    .from('api_keys')
    .insert({
      name: form.app_name,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      contact_email: form.email,
      contributor_tier: 'service',
      status: 'active',
      url: form.app_url,
      is_admin: false,
      // activated_at remains null — that's what gates writes until operator review
      activated_at: null,
      application_metadata: applicationMetadata,
      brand_config: brandConfig,
      contributor_profile_id: profile.id,
      tenant_account_id: portalAccount.id,
    })
    .select('id')
    .single();

  if (keyErr || !apiKey) {
    console.error('[DEV_PORTAL] API key insert failed:', keyErr?.message);
    // Best-effort cleanup
    await supabaseAdmin.from('portal_accounts').delete().eq('id', portalAccount.id);
    await supabaseAdmin.from('contributor_profiles').delete().eq('id', profile.id);
    throw new Error('Failed to issue API key');
  }

  // ── 5. Clear pending registration
  await supabaseAdmin
    .from('pending_registrations')
    .delete()
    .eq('email', form.email.toLowerCase());

  // ── 6. Create the developer session
  const { rawToken, expiresAt } = await createSession(apiKey.id as string);

  return {
    profileId: profile.id as string,
    profileSlug: profile.slug as string,
    portalAccountId: portalAccount.id as string,
    apiKeyId: apiKey.id as string,
    rawApiKey: rawKey,
    rawSessionToken: rawToken,
    sessionExpiresAt: expiresAt,
  };
}

/**
 * Persist the registration form data to `pending_registrations` while
 * the developer fills the OTP. 30-minute TTL — matches what we'll
 * sweep with a cron job in PR 4.
 */
export async function holdPendingRegistration(form: RegistrationFormData): Promise<void> {
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  // Upsert by email — refreshes the row if a re-attempt arrives.
  const { error } = await supabaseAdmin
    .from('pending_registrations')
    .upsert(
      {
        email: form.email.toLowerCase(),
        app_name: form.app_name,
        tagline: form.tagline,
        description: form.description,
        who_its_for: form.who_its_for,
        app_url: form.app_url,
        category: form.category,
        what_youre_building: form.what_youre_building,
        verification_process: form.verification_process,
        expires_at: expiresAt,
      },
      { onConflict: 'email' },
    );

  if (error) {
    console.error('[DEV_PORTAL] Pending-registration store failed:', error.message);
    throw new Error('Failed to hold registration data');
  }
}

/**
 * Read a previously-stored pending registration. Returns null if absent
 * or expired (and cleans up the expired row).
 */
export async function readPendingRegistration(email: string): Promise<RegistrationFormData | null> {
  const lower = email.toLowerCase();
  const { data: row } = await supabaseAdmin
    .from('pending_registrations')
    .select('email, app_name, tagline, description, who_its_for, app_url, category, what_youre_building, verification_process, expires_at')
    .eq('email', lower)
    .maybeSingle();

  if (!row) return null;
  if (new Date(row.expires_at as string) < new Date()) {
    await supabaseAdmin.from('pending_registrations').delete().eq('email', lower);
    return null;
  }

  return {
    email: row.email as string,
    app_name: row.app_name as string,
    tagline: row.tagline as string,
    description: row.description as string,
    who_its_for: row.who_its_for as string | null,
    app_url: row.app_url as string,
    category: row.category as string | null,
    what_youre_building: row.what_youre_building as string,
    verification_process: row.verification_process as string,
  };
}
