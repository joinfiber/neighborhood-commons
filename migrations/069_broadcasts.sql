-- ============================================================================
-- Migration 069: broadcasts + expiry function
--
-- Ephemeral signals from organizations, pinned to places. Maximum 24h
-- lifetime, auto-expired by cron. No Schema.org analog (SpecialAnnouncement
-- targets civic crisis communications, not commercial broadcasts);
-- conventions borrowed: datePosted ← created_at, expires ← expires_at.
--
-- Verification gate: broadcast creation does NOT require verified status.
-- Apps filter on verified status when surfacing broadcasts in their feeds.
-- The Commons stores the atom; consumer apps editorialize.
-- ============================================================================

CREATE TABLE IF NOT EXISTS broadcasts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  place_id          uuid NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  message           text NOT NULL CHECK (length(message) BETWEEN 1 AND 280),
  expires_at        timestamptz NOT NULL,
  status            text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'expired', 'retracted')),
  retracted_at      timestamptz,
  source            jsonb NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_broadcasts_active_place
  ON broadcasts(place_id) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_broadcasts_active_expires
  ON broadcasts(expires_at) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_broadcasts_org ON broadcasts(organization_id);

ALTER TABLE broadcasts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS broadcasts_public_read ON broadcasts;
CREATE POLICY broadcasts_public_read
  ON broadcasts FOR SELECT
  TO anon, authenticated
  USING (status = 'active');

-- ----------------------------------------------------------------------------
-- expire_broadcasts: cron-runnable function that flips active → expired
-- when expires_at has passed. Called every minute or so by the cron that
-- already runs cleanup_browse_dedup, cleanup_old_audit_logs, etc.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION expire_broadcasts()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  expired_count integer;
BEGIN
  UPDATE broadcasts
    SET status = 'expired'
    WHERE status = 'active' AND expires_at < now();
  GET DIAGNOSTICS expired_count = ROW_COUNT;
  RETURN expired_count;
END;
$$;

REVOKE ALL ON FUNCTION expire_broadcasts() FROM PUBLIC, authenticated, anon;

COMMENT ON TABLE broadcasts IS 'Ephemeral signals from organizations, pinned to places. Max 24h lifetime, auto-expired by expire_broadcasts() cron.';
COMMENT ON COLUMN broadcasts.message IS '1-280 chars. Plain text. Apps may render with link autolinking but the Commons stores raw text.';
COMMENT ON COLUMN broadcasts.expires_at IS 'Application enforces max 24h from created_at; the column itself accepts any future time.';
COMMENT ON COLUMN broadcasts.source IS 'Provenance: { publisher, method, contributor, collected_at, license }.';
COMMENT ON FUNCTION expire_broadcasts IS 'Marks active broadcasts as expired when expires_at has passed. Run via cron every minute.';
