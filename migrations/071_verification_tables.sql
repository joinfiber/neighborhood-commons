-- ============================================================================
-- Migration 071: verification tables
--
-- Identifier-based verification system. Identifiers (currently emails) attach
-- to typed targets (organization or person). The presence of any active
-- identifier means verified=true; the identifier set itself is what enables
-- cross-app portability — apps can re-prove control of the same identifier
-- without re-doing the full verification process.
--
-- Tables:
--   account_verified_identifiers  — verified facts (the truth of who controls what)
--   verification_challenges       — in-flight email-loop codes (hashed)
--   verification_pending_reviews  — manual-review queue
-- ============================================================================

-- ----------------------------------------------------------------------------
-- account_verified_identifiers: the canonical verified-identifier records.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS account_verified_identifiers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Polymorphic target
  target_type       text NOT NULL CHECK (target_type IN ('organization', 'person')),
  target_id         uuid NOT NULL,
  -- The identifier itself
  identifier_type   text NOT NULL,                     -- v1: 'email'
  identifier_value  text NOT NULL,
  identifier_domain text,                              -- denormalized for fast-track lookups
  -- How it was verified
  method            text NOT NULL CHECK (method IN ('domain_email_loop', 'manual_review')),
  verified_at       timestamptz NOT NULL DEFAULT now(),
  evidence          jsonb,
  -- Reputation graph fields
  approved_by_app   text NOT NULL,
  approved_by_key   uuid REFERENCES api_keys(id) ON DELETE SET NULL,
  -- Lifecycle
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  revoked_at        timestamptz,
  revoked_reason    text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (target_type, target_id, identifier_type, identifier_value)
);

CREATE INDEX IF NOT EXISTS idx_avi_target
  ON account_verified_identifiers(target_type, target_id) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_avi_domain
  ON account_verified_identifiers(identifier_domain) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_avi_approver
  ON account_verified_identifiers(approved_by_app) WHERE status = 'active';

ALTER TABLE account_verified_identifiers ENABLE ROW LEVEL SECURITY;
-- No public policies. The Verification block on Organization/Person reads
-- exposes verified state without leaking identifier values; service-tier
-- queries via supabaseAdmin bypass RLS.

-- ----------------------------------------------------------------------------
-- verification_challenges: in-flight email-loop challenges. Code stored
-- hashed (never raw). Consumed challenges retained for audit window before
-- cleanup_expired_challenges() purges them.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS verification_challenges (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type       text NOT NULL CHECK (target_type IN ('organization', 'person')),
  target_id         uuid NOT NULL,
  identifier_type   text NOT NULL,
  identifier_value  text NOT NULL,
  code_hash         text NOT NULL,
  expires_at        timestamptz NOT NULL,
  consumed_at       timestamptz,
  attempts          integer NOT NULL DEFAULT 0,
  brand_key_id      uuid NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vc_active
  ON verification_challenges(target_type, target_id) WHERE consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_vc_expires
  ON verification_challenges(expires_at) WHERE consumed_at IS NULL;

ALTER TABLE verification_challenges ENABLE ROW LEVEL SECURITY;
-- Service-only access.

-- ----------------------------------------------------------------------------
-- verification_pending_reviews: manual-review queue. Submissions land here
-- if the submitting key lacks verification_authority for the matching method;
-- otherwise the submit endpoint inserts directly into account_verified_identifiers.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS verification_pending_reviews (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type       text NOT NULL CHECK (target_type IN ('organization', 'person')),
  target_id         uuid NOT NULL,
  identifier_type   text NOT NULL,
  identifier_value  text NOT NULL,
  method            text NOT NULL,
  submitted_by_key  uuid NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  evidence          jsonb NOT NULL,
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by_key   uuid REFERENCES api_keys(id) ON DELETE SET NULL,
  reviewed_at       timestamptz,
  decision_reason   text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vpr_pending
  ON verification_pending_reviews(created_at) WHERE status = 'pending';

ALTER TABLE verification_pending_reviews ENABLE ROW LEVEL SECURITY;
-- Service-only access.

-- ----------------------------------------------------------------------------
-- cleanup_expired_challenges: cron-runnable cleanup function for stale
-- challenge rows (older than 24h). Keeps the table small.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION cleanup_expired_challenges()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  deleted_count integer;
BEGIN
  DELETE FROM verification_challenges
    WHERE expires_at < now() - interval '24 hours';
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

REVOKE ALL ON FUNCTION cleanup_expired_challenges() FROM PUBLIC, authenticated, anon;

COMMENT ON TABLE account_verified_identifiers IS 'The truth of who controls what. Polymorphic via target_type + target_id. The identifier set is what enables cross-app verification portability.';
COMMENT ON COLUMN account_verified_identifiers.identifier_domain IS 'Denormalized at insert from email value (post-@). Enables fast-track lookups (e.g., "this domain is already trusted for this account") without parsing identifier_value.';
COMMENT ON COLUMN account_verified_identifiers.approved_by_app IS 'Snapshot of the approving key''s brand_config.app_name at approval time. Stable across key rotation. Drives the public reputation graph.';
COMMENT ON TABLE verification_challenges IS 'In-flight email-loop verification challenges. code_hash stores SHA-256 of the one-time code; raw codes are never persisted.';
COMMENT ON TABLE verification_pending_reviews IS 'Manual-review queue. Auto-approved by apps with verification_authority for the matching method; otherwise queued for is_admin review.';
COMMENT ON FUNCTION cleanup_expired_challenges IS 'Removes verification_challenges older than 24h past expiry. Run via cron daily.';
