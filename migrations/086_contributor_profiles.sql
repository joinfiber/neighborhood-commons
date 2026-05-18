-- ============================================================================
-- Migration 086: contributor profiles + developer-dashboard primitives
--
-- PR 1 of the onboarding-redesign build (docs/onboarding-redesign.md §12).
-- Lays the schema foundation for the developer portal at /developers:
--
--   contributor_profiles   — public-facing identity of each contributing app.
--                            Stable across api_key rotation. The "splash card"
--                            data Fiber renders when a reader taps "via Merrie".
--   developer_sessions     — DB-backed sessions for the dashboard. Revocable.
--   magic_login_tokens     — single-use email links for returning logins.
--                            Separate from developer_otps (which is for
--                            registration only).
--   pending_registrations  — holds the form data between OTP-send and
--                            OTP-verify so refresh doesn't lose context.
--
-- Also adds:
--   api_keys.contributor_profile_id   — links key to its public identity
--   api_keys.mfa_*                     — TOTP secret + enrollment + backup codes
--   events.contributor_profile_id      — snapshot at write time for read-side
--                                        attribution lookup (survives key rotation
--                                        the same way source_contributor_name does)
--
-- Idempotent.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- contributor_profiles
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS contributor_profiles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text UNIQUE NOT NULL,
  name            text NOT NULL,
  tagline         text,
  description     text,
  who_its_for     text,
  app_url         text,
  logo_url        text,
  category        text,
  status          text NOT NULL DEFAULT 'pending',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE contributor_profiles DROP CONSTRAINT IF EXISTS contributor_profiles_status_check;
ALTER TABLE contributor_profiles
  ADD CONSTRAINT contributor_profiles_status_check
  CHECK (status IN ('pending', 'active', 'suspended'));

-- Slug-format guard: lowercase, alphanumeric + hyphens, 1-100 chars.
ALTER TABLE contributor_profiles DROP CONSTRAINT IF EXISTS contributor_profiles_slug_format;
ALTER TABLE contributor_profiles
  ADD CONSTRAINT contributor_profiles_slug_format
  CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,99}$');

CREATE INDEX IF NOT EXISTS idx_contributor_profiles_status
  ON contributor_profiles(status);

COMMENT ON TABLE contributor_profiles IS
  'Public-facing identity of each contributing app (the consumer apps that route data into the Commons). Slug is the stable cross-key identifier; survives api_key rotation. Status: pending until operator activation, active once approved, suspended on revocation. See docs/onboarding-redesign.md §3.1 and docs/four-roles.md for the contributor role in event provenance.';

-- updated_at trigger (reuses the existing update_updated_at function)
DROP TRIGGER IF EXISTS contributor_profiles_updated_at ON contributor_profiles;
CREATE TRIGGER contributor_profiles_updated_at
  BEFORE UPDATE ON contributor_profiles
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- ---------------------------------------------------------------------------
-- api_keys additions
-- ---------------------------------------------------------------------------

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS contributor_profile_id uuid
    REFERENCES contributor_profiles(id) ON DELETE SET NULL;

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS mfa_secret_encrypted bytea;

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS mfa_enrolled_at timestamptz;

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS mfa_backup_codes_hashed text[];

CREATE INDEX IF NOT EXISTS idx_api_keys_contributor_profile
  ON api_keys(contributor_profile_id)
  WHERE contributor_profile_id IS NOT NULL;

COMMENT ON COLUMN api_keys.contributor_profile_id IS
  'Links this key to its public-facing contributor identity. The same profile survives across key rotations. Set during /developers/register flow (PR 2). Null on pre-3.1 keys until retrofit (PR 5).';

COMMENT ON COLUMN api_keys.mfa_secret_encrypted IS
  'TOTP shared secret, encrypted at rest. Null until the developer enrolls MFA via /developers/security/enroll-mfa. Per docs/onboarding-redesign.md §3.2.';

-- ---------------------------------------------------------------------------
-- events.contributor_profile_id
-- ---------------------------------------------------------------------------
-- Snapshot of the contributing app's profile at event write time. Enables
-- the read API to surface source.contributor.{slug, logo_url, description,
-- profile_url} on each event without joining through api_keys (which can
-- be rotated). Populated by the service-event POST handler starting in
-- PR 2; pre-3.1 events have NULL until retrofit in PR 5.

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS contributor_profile_id uuid
    REFERENCES contributor_profiles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_events_contributor_profile
  ON events(contributor_profile_id)
  WHERE contributor_profile_id IS NOT NULL;

COMMENT ON COLUMN events.contributor_profile_id IS
  'Snapshot of contributing app at write time. Survives api_key rotation. Backfilled retroactively when a consumer is retrofitted (PR 5 of the onboarding-redesign build).';

-- ---------------------------------------------------------------------------
-- developer_sessions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS developer_sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key_id        uuid NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  token_hash        text NOT NULL,
  mfa_verified_at   timestamptz,
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_developer_sessions_token_hash
  ON developer_sessions(token_hash);

CREATE INDEX IF NOT EXISTS idx_developer_sessions_api_key
  ON developer_sessions(api_key_id);

-- Plain index on expires_at (no predicate). A partial `WHERE expires_at >
-- now()` would be tempting but Postgres rejects it — now() is STABLE, not
-- IMMUTABLE, and only IMMUTABLE functions are allowed in index predicates.
-- A full index is cheap enough for the session-cleanup query pattern.
CREATE INDEX IF NOT EXISTS idx_developer_sessions_expires_at
  ON developer_sessions(expires_at);

COMMENT ON TABLE developer_sessions IS
  'DB-backed sessions for the developer dashboard. Token cookie carries the raw value; the DB stores only the hash. 24-hour hard expiry; revocable instantly by deleting the row. mfa_verified_at gates writes; null or older-than-15min means a step-up is required.';

-- ---------------------------------------------------------------------------
-- magic_login_tokens
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS magic_login_tokens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL,
  token_hash      text NOT NULL,
  expires_at      timestamptz NOT NULL,
  consumed_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_magic_login_tokens_token_hash
  ON magic_login_tokens(token_hash);

CREATE INDEX IF NOT EXISTS idx_magic_login_tokens_email
  ON magic_login_tokens(email);

COMMENT ON TABLE magic_login_tokens IS
  'Single-use magic-link tokens for the /developers/login flow. 15-minute expiry; single-use (consumed_at). Distinct from developer_otps (which handles registration). Per docs/onboarding-redesign.md §3.4.';

-- ---------------------------------------------------------------------------
-- pending_registrations
-- ---------------------------------------------------------------------------
-- Holds the registration form data between OTP-send and OTP-verify so a
-- page refresh during the OTP step doesn't lose context. Cleared on
-- successful verify or on TTL expiry.

CREATE TABLE IF NOT EXISTS pending_registrations (
  email                   text PRIMARY KEY,
  app_name                text NOT NULL,
  tagline                 text,
  description             text,
  who_its_for             text,
  app_url                 text,
  logo_url                text,
  category                text,
  what_youre_building     text,
  verification_process    text,
  expires_at              timestamptz NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pending_registrations_expires_at
  ON pending_registrations(expires_at);

COMMENT ON TABLE pending_registrations IS
  'Holds developer-registration form data between OTP issuance and OTP verification. Keyed by normalized email. 30-minute TTL via expires_at; cleared on successful verify. Per docs/onboarding-redesign.md §3 (data model) and §4.1 (registration flow).';

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
-- All four new tables are operational (no public read policy). Defense in
-- depth: enable RLS with no policies so any non-service-role query fails
-- closed. Service role bypasses RLS, which is how the application accesses
-- these tables.

ALTER TABLE contributor_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE developer_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE magic_login_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_registrations ENABLE ROW LEVEL SECURITY;

-- contributor_profiles is the one new table that has a public read surface.
-- The public read goes through /v1/contributors, which uses the service
-- role connection (bypassing RLS). That's consistent with how every other
-- public-fact table (events, organizations, places, etc.) is read.

COMMIT;
