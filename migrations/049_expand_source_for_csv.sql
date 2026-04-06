-- ============================================================================
-- Migration 049: Add 'csv' to events source CHECK constraint
-- ============================================================================
-- CSV uploads via the portal contribution flow get their own source type,
-- distinct from 'import' (iCal feeds) and 'api' (programmatic contribute).

ALTER TABLE events DROP CONSTRAINT IF EXISTS events_source_check;
ALTER TABLE events ADD CONSTRAINT events_source_check
  CHECK (source IN ('portal', 'admin', 'import', 'api', 'newsletter', 'csv'));
