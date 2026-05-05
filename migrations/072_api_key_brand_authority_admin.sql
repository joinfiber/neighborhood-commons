-- ============================================================================
-- Migration 072: api_keys gains brand_config, verification_authority, is_admin
--
-- Operator-issued per-key configuration:
--   brand_config           — sender identity for verification emails (per app)
--   verification_authority — methods this key may auto-approve manual reviews for
--   is_admin               — operator-tier (currently Studio); bypasses scoping
--
-- Also: deactivate any non-service-tier api_keys. Per user, none in production,
-- but the safe thing to do as the contribute tier dies is to ensure no
-- non-service keys are accidentally still active.
-- ============================================================================

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS brand_config             jsonb,
  ADD COLUMN IF NOT EXISTS verification_authority   jsonb,
  ADD COLUMN IF NOT EXISTS is_admin                 boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_api_keys_admin
  ON api_keys(is_admin) WHERE is_admin = true;

-- Deactivate any non-service tier keys.
-- Note: api_keys uses a `status` text column ('active' / 'revoked'); the
-- legacy `is_active` boolean was dropped in migration 007.
-- Wrapped in a DO block so operator can see how many were affected.
DO $$
DECLARE
  affected integer;
BEGIN
  UPDATE api_keys
    SET status = 'revoked'
    WHERE contributor_tier IS DISTINCT FROM 'service' AND status = 'active';
  GET DIAGNOSTICS affected = ROW_COUNT;
  RAISE NOTICE 'Deactivated % non-service api_keys', affected;
END $$;

COMMENT ON COLUMN api_keys.brand_config IS 'App-branded verification email sender identity. JSONB shape: { app_name, from_email, from_name, subjects: { verification: ... } }. Set by operator at issuance; immutable at runtime. Per-app domains must be verified in the shared Resend account.';
COMMENT ON COLUMN api_keys.verification_authority IS 'JSONB array of method:context strings this key may auto-approve, e.g. ["manual_review:in_person", "manual_review:video_call"]. Empty/null means submissions queue for admin review. Granted by operator after onboarding review.';
COMMENT ON COLUMN api_keys.is_admin IS 'Operator/admin tier. Currently set only for Studio. Bypasses api_key_organization_links scoping; can access verification review queue; can revoke verifications.';
