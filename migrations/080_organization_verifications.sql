-- ============================================================================
-- Migration 080: organization_verifications (simplified verification table)
--
-- Under v2, the verification system narrows to its load-bearing job:
-- anchor Type A authority for organizations. The polymorphic target_type
-- abstraction (organization | person) collapses because persons no longer
-- exist as a separate primitive (migration 079).
--
-- This migration:
--   1. Creates organization_verifications with the simpler shape:
--      - No polymorphic target_type (only organizations)
--      - No identifier_domain (the cross-app fast-track lookup that
--        supported the retired reputation graph)
--      - Adds stewardship_attestation as a future method value
--   2. Copies active rows from account_verified_identifiers
--      (by this point all are target_type='organization', post-079)
--   3. Leaves account_verified_identifiers in place for now; migration
--      082 drops it after the API code switches over.
--
-- Idempotent. Reports counts via RAISE NOTICE.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Create organization_verifications
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS organization_verifications (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Identifier used to verify (kept operationally for re-verification;
  -- never exposed publicly)
  identifier_type   text NOT NULL,                              -- v1: 'email'
  identifier_value  text NOT NULL,
  -- How verification happened
  method            text NOT NULL CHECK (method IN (
                      'domain_email_loop',
                      'manual_review',
                      'stewardship_attestation'                  -- v2: community-body vouching
                    )),
  evidence          jsonb,
  verified_at       timestamptz NOT NULL DEFAULT now(),
  -- Attestation provenance
  approved_by_app   text NOT NULL,                              -- brand_config.app_name snapshot
  approved_by_key   uuid REFERENCES api_keys(id) ON DELETE SET NULL,
  -- Lifecycle
  status            text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'revoked')),
  revoked_at        timestamptz,
  revoked_reason    text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- One active verification per (org, method, app) combination
  UNIQUE (organization_id, method, approved_by_app)
);

CREATE INDEX IF NOT EXISTS idx_org_verif_active
  ON organization_verifications(organization_id) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_org_verif_approver
  ON organization_verifications(approved_by_app) WHERE status = 'active';

ALTER TABLE organization_verifications ENABLE ROW LEVEL SECURITY;
-- No public policies. The verified boolean on organization responses
-- exposes verified state without leaking identifier values; service-tier
-- queries via supabaseAdmin bypass RLS.

DROP TRIGGER IF EXISTS organization_verifications_updated_at ON organization_verifications;
-- (no updated_at column on this table; verifications are immutable except
-- for revocation, which sets revoked_at directly. No trigger needed.)

COMMENT ON TABLE organization_verifications IS 'V2 verification storage. Replaces account_verified_identifiers with a simpler, organization-only shape. The narrow Type A authority anchor.';
COMMENT ON COLUMN organization_verifications.identifier_value IS 'Identifier (typically email) used to verify. Held operationally for re-verification; never exposed publicly via API.';
COMMENT ON COLUMN organization_verifications.method IS 'How verification happened. domain_email_loop is the default for businesses; manual_review for community groups without clean email-loop access; stewardship_attestation for community-body vouching (future).';
COMMENT ON COLUMN organization_verifications.approved_by_app IS 'Snapshot of the approving service-key brand_config.app_name at approval time. Stable across key rotation.';

-- ----------------------------------------------------------------------------
-- Migrate from account_verified_identifiers
-- ----------------------------------------------------------------------------
-- By this point in the migration sequence (post-079), all rows in
-- account_verified_identifiers should have target_type='organization'.
-- We copy them into the new table, preserving the original row ids so
-- any in-flight references stay valid through the cutover.

DO $$
DECLARE
  v_source_count    integer;
  v_migrated_count  integer;
  v_skipped         integer;
BEGIN
  SELECT COUNT(*) INTO v_source_count
    FROM account_verified_identifiers
    WHERE target_type = 'organization';

  IF v_source_count = 0 THEN
    RAISE NOTICE 'account_verified_identifiers has no organization rows to migrate';
    RETURN;
  END IF;

  RAISE NOTICE 'Migrating % rows from account_verified_identifiers to organization_verifications', v_source_count;

  -- ON CONFLICT DO NOTHING (no target) suppresses ANY unique violation:
  -- both id collisions (re-run safety) AND the new
  -- UNIQUE (organization_id, method, approved_by_app) constraint.
  -- The old account_verified_identifiers table had a different unique
  -- shape (UNIQUE on identifier_value), so an org with two verified
  -- emails through the same app would be two rows there but collapse
  -- to one row here. First-wins semantics; verified_at ordering by
  -- the source query (newest verified_at first) keeps the most recent.
  INSERT INTO organization_verifications (
    id, organization_id,
    identifier_type, identifier_value,
    method, evidence, verified_at,
    approved_by_app, approved_by_key,
    status, revoked_at, revoked_reason,
    created_at
  )
  SELECT
    avi.id,
    avi.target_id,
    avi.identifier_type,
    avi.identifier_value,
    avi.method,
    avi.evidence,
    avi.verified_at,
    avi.approved_by_app,
    avi.approved_by_key,
    avi.status,
    avi.revoked_at,
    avi.revoked_reason,
    avi.created_at
  FROM account_verified_identifiers avi
  WHERE avi.target_type = 'organization'
    AND EXISTS (SELECT 1 FROM organizations o WHERE o.id = avi.target_id)
  ORDER BY avi.verified_at DESC  -- ensure first-wins is the most recent
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS v_migrated_count = ROW_COUNT;

  SELECT COUNT(*) INTO v_skipped
    FROM account_verified_identifiers avi
    WHERE avi.target_type = 'organization'
      AND NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = avi.target_id);

  IF v_skipped > 0 THEN
    RAISE WARNING '% rows skipped (target organization does not exist)', v_skipped;
  END IF;

  RAISE NOTICE '=== Migration 080 complete ===';
  RAISE NOTICE 'Source rows: %', v_source_count;
  RAISE NOTICE 'Migrated: %', v_migrated_count;
  RAISE NOTICE 'Skipped (missing org): %', v_skipped;

  -- account_verified_identifiers is NOT dropped here. The API code still
  -- references it; the cutover happens in migration 082 after the routes
  -- have been updated to read from organization_verifications.
END $$;
