-- ============================================================================
-- Migration 083: restore developer_otps
--
-- Migration 082 dropped developer_otps with the comment "no longer needed in
-- the current flow," which was incorrect — both the v2 service-key registration
-- flow (`/v1/service/register/*`) and the legacy developer-tier registration
-- flow (`/v1/developers/register/*`) use this table via lib/developer-otp.ts
-- to store short-lived numeric verification codes.
--
-- This migration restores the table to its 043-era schema. Idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS developer_otps (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL,
  code        text NOT NULL,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_developer_otps_email   ON developer_otps (email);
CREATE INDEX IF NOT EXISTS idx_developer_otps_expires ON developer_otps (expires_at);

ALTER TABLE developer_otps ENABLE ROW LEVEL SECURITY;
-- No public policies — server-only access via supabaseAdmin (service role).
