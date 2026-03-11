-- ============================================================================
-- Migration 006: Align audit_logs and event_series with application code
-- ============================================================================
-- The code writes columns that don't exist in the original schema.
-- This migration adds the missing columns.

-- --------------------------------------------------------------------------
-- audit_logs: add columns the audit module writes
-- --------------------------------------------------------------------------

-- resource_hash (text) — code hashes the resource ID, not a raw UUID
-- The original schema had resource_id (uuid); code writes resource_hash (text)
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS resource_hash text;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS result text;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS reason text;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS ip_hash text;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS user_agent text;

-- Index on resource_hash for activity log queries
CREATE INDEX IF NOT EXISTS idx_audit_logs_resource_hash
  ON audit_logs(resource_hash, created_at DESC);

-- Index on actor_hash for activity log queries
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_hash
  ON audit_logs(actor_hash, created_at DESC);

-- --------------------------------------------------------------------------
-- event_series: add columns the portal code writes
-- --------------------------------------------------------------------------

-- Code writes user_id (the admin user creating the series)
ALTER TABLE event_series ADD COLUMN IF NOT EXISTS user_id uuid;

-- Code writes recurrence_rule (jsonb with frequency + count)
-- The original schema has recurrence (text enum) which is different
ALTER TABLE event_series ADD COLUMN IF NOT EXISTS recurrence_rule jsonb;
